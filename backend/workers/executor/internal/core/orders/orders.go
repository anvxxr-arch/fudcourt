// Package orders is the child-order accounting layer (objective §8.14:
// Execution ≠ Order — one execution produces many child orders). It owns the
// OVER-ORDER CLAMP (PRD §107/§128.15): whatever combination of engine actions,
// partial fills or retry races occurs, the sum of planned child quantities can
// never exceed the execution's planned quantity minus what already filled.
//
// All quantity arithmetic is exact decimal via internal/platform/decimal; every rounding
// is DOWN onto the instrument step grid, because rounding up would round into
// exposure the user never approved (PRD §71).
package orders

import (
	"errors"
	"sync"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// Terminal / non-terminal child-order liveness. A terminal child occupies NO
// room: a REJECTED/CANCELLED/EXPIRED child releases its quantity back to the
// plan (PRD §107 "freed room"), a FILLED child has already paid its quantity
// into FilledQuantity.
func isTerminal(status execution.ChildOrderStatus) bool {
	switch status {
	case execution.ChildFilled, execution.ChildCancelled, execution.ChildRejected, execution.ChildExpired:
		return true
	}
	return false
}

// Child is one tracked child order's quantity footprint. Zero values are
// honest: a child with unknown fill reports FilledQuantity "0".
type Child struct {
	ClientOrderID  string
	Quantity       string // exact decimal; planned child quantity
	FilledQuantity string // exact decimal; portion already filled
	IsExit         bool   // exit/reduce children are not bounded by entry room
	Status         execution.ChildOrderStatus
}

// Request is the quantity + intent slice of a child placement the caller wants
// clamped before it reaches the exchange.
type Request struct {
	ClientOrderID string
	Quantity      string // exact decimal, the requested size
	// StepSize is the instrument quantity step ("0.001"): the clamp floors both
	// the request and the room onto this grid (PRD §71).
	StepSize string
	// IsExit marks an exit child (Intent close/reduce or ReduceOnly): exits are
	// NOT bounded by entry room — a protective stop must cover the full planned
	// entry even while entry children are still working (PRD §40).
	IsExit     bool
	Intent     execution.Intent
	ReduceOnly bool
}

// Result is the clamped placement decision.
type Result struct {
	ClientOrderID string
	// Quantity is what MAY be sent now: the request floored to the step grid and
	// bounded by the entry room. "0" means nothing may be sent.
	Quantity string
	// Clamped is true when the result is smaller than the request (or the
	// request was dropped to zero): the caller MUST emit PLAN_RESIZED.
	Clamped bool
}

// ErrInvalidQuantity is returned for malformed decimal quantities or an
// unusable (non-positive) step size — the clamp refuses to guess.
var ErrInvalidQuantity = errors.New("orders: invalid quantity")

// Ledger tracks the planned/open/filled child quantities of one execution and
// answers ClampChild. It is exact-decimal and safe for concurrent use: every
// method is atomic and methods never leak internal state.
//
// INVARIANT: ClampChild claims its result atomically, so at all times — even
// under unsynchronized concurrent callers — the entry side satisfies
//
//	Σ (quantity − filled) over non-terminal entry children + Σ filled ≤ planned.
//
// Exits never consume entry room.
type Ledger struct {
	mu       sync.Mutex
	children map[string]Child
}

// NewLedger returns an empty ledger for one execution.
func NewLedger() *Ledger {
	return &Ledger{children: map[string]Child{}}
}

// Track records or replaces one child's quantity footprint. Tracking is
// idempotent per ClientOrderID.
func (l *Ledger) Track(c Child) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.children[c.ClientOrderID] = c
}

// SetStatus updates a child's status (and optionally its fill). A terminal
// transition releases the child's remaining room automatically because room is
// derived from live children only.
func (l *Ledger) SetStatus(clientOrderID string, status execution.ChildOrderStatus, filledQuantity string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	c, ok := l.children[clientOrderID]
	if !ok {
		return
	}
	c.Status = status
	if filledQuantity != "" {
		c.FilledQuantity = filledQuantity
	}
	l.children[clientOrderID] = c
}

// Children returns a snapshot of the tracked children.
func (l *Ledger) Children() []Child {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Child, 0, len(l.children))
	for _, c := range l.children {
		out = append(out, c)
	}
	return out
}

// OpenRemaining returns the unfilled quantity still held by non-terminal
// children on the given side of the book (entry vs exit).
func (l *Ledger) OpenRemaining(isExit bool) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.openRemainingLocked(isExit)
}

func (l *Ledger) openRemainingLocked(isExit bool) (string, error) {
	sum := "0"
	for _, c := range l.children {
		if c.IsExit != isExit || isTerminal(c.Status) {
			continue
		}
		rem, err := decimal.Sub(c.Quantity, c.FilledQuantity)
		if err != nil {
			return "", err
		}
		if sign(rem) < 0 {
			rem = "0" // a fill overshoot must never create negative room
		}
		sum, err = decimal.Add(sum, rem)
		if err != nil {
			return "", err
		}
	}
	return sum, nil
}

// ClampChild returns the child quantity that may legally be sent now
// (PRD §107/§128.15; objective §8.14). Signature: ClampChild(req, ledger,
// planned) — the ledger supplies the room, planned is the execution's planned
// quantity, and the step grid comes from req.StepSize.
//
// INVARIANTS:
//   - Entry children: result ≤ floor(planned − filled − open entry) on the step
//     grid. The grid floor applies to the REQUEST and to the ROOM, so rounding
//     never rounds UP into extra exposure (PRD §71).
//   - Exit / reduce-only children (Intent close|reduce, ReduceOnly, IsExit) are
//     NOT bounded by entry room — they cover the full planned entry and the
//     venue's reduce-only flag bounds their fill (PRD §40) — but are still
//     floored to the grid.
//   - Clamped=true whenever the result is smaller than the request (including
//     dropping to zero): the caller MUST emit PLAN_RESIZED.
//   - Nothing here ever returns a quantity above the request.
//   - The clamp CLAIMS its result in the ledger in the same critical section
//     that computed the room (a provisional PLANNED entry keyed by
//     ClientOrderID), so concurrent callers can never collectively exceed the
//     plan even without external synchronization: the second caller sees the
//     first caller's claim as open remainder. A clamp of zero claims nothing.
//     The caller records the real child with Track/SetStatus under the SAME
//     ClientOrderID — which replaces the provisional claim — and a placement
//     that dies records a terminal status so its room is released.
func ClampChild(req Request, ledger *Ledger, planned string) (Result, error) {
	if _, ok, err := decimal.FloorToStep(req.Quantity, req.StepSize); err != nil || !ok {
		return Result{}, ErrInvalidQuantity
	}
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	floorGrid := func(q string) (string, error) {
		floored, ok, err := decimal.FloorToStep(q, req.StepSize)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", ErrInvalidQuantity
		}
		return floored, nil
	}
	requested, err := floorGrid(req.Quantity)
	if err != nil {
		return Result{}, err
	}
	claim := func(q string, isExit bool) Result {
		if sign(q) > 0 {
			// Provisional PLANNED entry: holds room until the caller records the
			// real outcome under the same id. Non-terminal, so it holds room.
			ledger.children[req.ClientOrderID] = Child{
				ClientOrderID:  req.ClientOrderID,
				Quantity:       q,
				FilledQuantity: "0",
				IsExit:         isExit,
				Status:         execution.ChildPlanned,
			}
		}
		return Result{ClientOrderID: req.ClientOrderID, Quantity: q, Clamped: !equalDecimal(q, req.Quantity)}
	}
	if sign(requested) <= 0 {
		return Result{ClientOrderID: req.ClientOrderID, Quantity: "0", Clamped: true}, nil
	}
	if isExitRequest(req) {
		// Exits are not bounded by entry room (PRD §40): a protective leg covers
		// the full planned entry; the reduce-only flag bounds its actual fill.
		return claim(requested, true), nil
	}
	// Entry room = planned − filled − open entry remainder (PRD §107).
	filled, err := ledger.entryFilledLocked()
	if err != nil {
		return Result{}, err
	}
	open, err := ledger.openRemainingLocked(false)
	if err != nil {
		return Result{}, err
	}
	room, err := decimal.Sub(planned, filled)
	if err != nil {
		return Result{}, err
	}
	room, err = decimal.Sub(room, open)
	if err != nil {
		return Result{}, err
	}
	if sign(room) < 0 {
		room = "0"
	}
	roomFloor, err := floorGrid(room)
	if err != nil {
		return Result{}, err
	}
	if sign(roomFloor) <= 0 {
		return Result{ClientOrderID: req.ClientOrderID, Quantity: "0", Clamped: true}, nil
	}
	q := requested
	if cmp, _ := decimal.Cmp(requested, roomFloor); cmp > 0 {
		q = roomFloor
	}
	return claim(q, false), nil
}

// entryFilledLocked sums the filled quantity across ALL entry children,
// terminal or not: a filled child has consumed plan room permanently.
func (l *Ledger) entryFilledLocked() (string, error) {
	sum := "0"
	for _, c := range l.children {
		if c.IsExit {
			continue
		}
		var err error
		sum, err = decimal.Add(sum, c.FilledQuantity)
		if err != nil {
			return "", err
		}
	}
	return sum, nil
}

// isExitRequest reports whether a request is an exit/reduce child: any of the
// three markers suffices (PRD §40: Intent close/reduce, ReduceOnly).
func isExitRequest(req Request) bool {
	return req.IsExit || req.ReduceOnly ||
		req.Intent == execution.IntentClose || req.Intent == execution.IntentReduce
}

// sign returns -1/0/+1 for a decimal string, treating garbage as an error at
// the parse site (callers always parse first) — here it is a plain helper.
func sign(s string) int {
	c, err := decimal.Cmp(s, "0")
	if err != nil {
		return 0
	}
	return c
}

// equalDecimal reports numeric equality between two decimal spellings
// ("1.50" == "1.5") — clamped-ness is about value, not text.
func equalDecimal(a, b string) bool {
	c, err := decimal.Cmp(a, b)
	return err == nil && c == 0
}
