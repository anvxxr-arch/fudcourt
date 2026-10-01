// Package strategy holds the deterministic execution strategies (objective
// §8.15): given an ExecutionRecord and a tick context, each strategy emits
// child-order actions (submit/cancel/complete). This is the Go port of
// apps/web/src/platform/executor/engine.ts — the parity oracle — minus any
// exchange-specific detail: no venue names, no adapter types, nothing but the
// canonical domain types (objective §8.16).
//
// Determinism contract (PRD §28): all time comes from ctx.Now, all randomness
// from a seeded PRNG whose state lives inside the strategy State, so every run
// is reproducible and the state survives restarts as opaque JSON. Jitter is
// OPT-IN via TwapConfig and never silent (DR-021 §2g): without config a TWAP
// is the naive equal-slice schedule.
//
// Recovery contract (PRD §114): ctx.PlacementEnabled=false means the caller is
// on a reconcile-only pass — the strategy MUST emit ZERO submit actions then
// while staying resumable for a later permitted tick.
package strategy

import (
	"errors"
	"fmt"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
)

// ActionKind names one intent a strategy can express.
type ActionKind string

// The action vocabulary: submit a child order, cancel a child order, complete
// the execution. There is no "place and pray" — every placement is an explicit
// action the worker clamps and audits.
const (
	ActionSubmit   ActionKind = "submit"
	ActionCancel   ActionKind = "cancel"
	ActionComplete ActionKind = "complete"
)

// Action is one child-order intent. Order carries the full OrderRequest for
// submit actions; ClientOrderID is the cancel target for cancel actions.
type Action struct {
	Kind         ActionKind
	Order        executor.OrderRequest
	ClientOrderID string
	Reason       string
}

// StrategyContext is one deterministic tick's inputs (objective §8.15).
//
// INVARIANT: FilledQuantity is the ENTRY-side filled quantity as known by the
// caller (a scale_out/close execution MUST NOT let entry fills drive its
// completion — strategies track their own exit fills from OpenOrders).
type StrategyContext struct {
	// Now is the tick's timestamp in unix milliseconds — the ONLY clock.
	Now int64
	// Ticker is the venue's current quote. Bid/Ask are nullable and honest: a
	// strategy that needs a touch price and sees none emits nothing rather than
	// fabricating one (house rule).
	Ticker executor.Ticker
	// OpenOrders is the caller's view of live child orders (venue truth).
	OpenOrders []executor.NormalizedOrder
	// FilledQuantity is the entry-side filled quantity (exact decimal string).
	FilledQuantity string
	// OpenPositionQuantity bounds reduce-only children (PRD §40: a reduce-only
	// order may never exceed the open position).
	OpenPositionQuantity string
	// PlacementEnabled is false on recovery/reconcile passes (PRD §114): zero
	// placements then. Cancels and completions stay legal.
	PlacementEnabled bool
}

// State is opaque, strategy-owned state. It is JSON-round-trippable so a worker
// can persist it across restarts (PRD §130) and re-derive it deterministically
// from the ExecutionRecord + seed. Only this package may implement it.
type State interface {
	isState()
}

// Strategy is one deterministic execution strategy (objective §8.15).
//
// INVARIANT: Step is a pure function of (state, ctx) — same inputs, same state
// and actions out. It mutates only the state it returns. With
// ctx.PlacementEnabled=false it emits ZERO submit actions and stays resumable.
type Strategy interface {
	Step(state State, ctx StrategyContext) (State, []Action)
}

// ChildOrderEvent is the child-order lifecycle event vocabulary (PRD §58) —
// the event names the engine-tests.ts vectors use.
type ChildOrderEvent string

// The event vocabulary. Each event maps to exactly one target status.
const (
	ChildEventSubmit       ChildOrderEvent = "submit"
	ChildEventAccept       ChildOrderEvent = "accept"
	ChildEventPartialFill  ChildOrderEvent = "partial_fill"
	ChildEventFill         ChildOrderEvent = "fill"
	ChildEventCancelReq    ChildOrderEvent = "cancel_request"
	ChildEventCancel       ChildOrderEvent = "cancel"
	ChildEventReject       ChildOrderEvent = "reject"
	ChildEventExpire       ChildOrderEvent = "expire"
	ChildEventUnknown      ChildOrderEvent = "unknown"
)

// childEventTarget maps each event to its target status (engine.ts
// TRANSITIONS). The legality of current→target is decided by
// executor.CanTransitionChild — the ONE child-order lifecycle truth.
var childEventTarget = map[ChildOrderEvent]executor.ChildOrderStatus{
	ChildEventSubmit:      executor.ChildSubmitting,
	ChildEventAccept:      executor.ChildOpen,
	ChildEventPartialFill: executor.ChildPartial,
	ChildEventFill:        executor.ChildFilled,
	ChildEventCancelReq:   executor.ChildCancelling,
	ChildEventCancel:      executor.ChildCancelled,
	ChildEventReject:      executor.ChildRejected,
	ChildEventExpire:      executor.ChildExpired,
	ChildEventUnknown:     executor.ChildUnknown,
}

// ErrIllegalChildTransition is returned (never thrown, never swallowed) for an
// illegal child-order transition — it names the current status and the event,
// mirroring the engine's "illegal child order transition" error.
var ErrIllegalChildTransition = errors.New("illegal child order transition")

// TransitionChildOrder applies one lifecycle event to a child-order status by
// wrapping executor.CanTransitionChild (objective §8.15; PRD §58).
//
// INVARIANT: an illegal transition returns an error naming the current status
// and the event — it NEVER silently advances (engine-tests.ts §58 vectors:
// PLANNED+submit→SUBMITTING, SUBMITTING+accept→OPEN, OPEN+cancel_request→
// CANCELLING, CANCELLING+cancel→CANCELLED; FILLED+cancel, CANCELLED+accept and
// UNKNOWN+fill are all refused).
func TransitionChildOrder(current executor.ChildOrderStatus, event ChildOrderEvent) (executor.ChildOrderStatus, error) {
	target, ok := childEventTarget[event]
	if !ok {
		return current, fmt.Errorf("%w: %s + %q (unknown event)", ErrIllegalChildTransition, current, event)
	}
	if !executor.CanTransitionChild(current, target) {
		return current, fmt.Errorf("%w: %s + %q", ErrIllegalChildTransition, current, event)
	}
	return target, nil
}

// DefaultSlices is the documented TWAP cadence: a nominal 150s slice interval,
// clamped to [1, 40] slices (engine.ts defaultSlices; PRD §56). 30 min → 12.
func DefaultSlices(durationMs int64) int {
	if durationMs <= 0 {
		return 1
	}
	n := (durationMs + 149_999) / 150_000 // ceil(durationMs / 150s)
	if n < 1 {
		return 1
	}
	if n > 40 {
		return 40
	}
	return int(n)
}

// DefaultSeed is the deterministic PRNG seed used when the caller supplies
// none (engine.ts DEFAULT_SEED) — reproducibility without configuration.
const DefaultSeed uint32 = 0x9e3779b9

// ErrInvalidStrategy is returned by New when the execution's strategy config
// cannot drive any strategy honestly (missing price, unparseable quantity,
// malformed scale ladder...). The caller fails the execution rather than
// guessing a configuration (house rule).
var ErrInvalidStrategy = errors.New("strategy: invalid execution configuration")

// New builds the strategy and its initial state for one execution record
// (objective §8.15). The initial state is a pure function of (rec, seed): the
// same inputs always produce the same first child-order ids (PRD §28, §66),
// which is what lets a restarted worker ADOPT its own children instead of
// re-placing them (PRD §114).
//
// seed 0 selects DefaultSeed. Unknown strategy names and malformed configs are
// refused with ErrInvalidStrategy — never silently downgraded to another
// strategy.
func New(rec executor.ExecutionRecord, seed uint32) (Strategy, State, error) {
	if seed == 0 {
		seed = DefaultSeed
	}
	st, err := initialState(rec, coreFor(rec), seed)
	if err != nil {
		return nil, nil, err
	}
	switch rec.ExecutionStrategy {
	case executor.StrategyMarket:
		return marketStrategy{}, st, nil
	case executor.StrategyLimit:
		return limitStrategy{}, st, nil
	case executor.StrategyTWAP:
		return twapStrategy{}, st, nil
	case executor.StrategyIceberg:
		return icebergStrategy{}, st, nil
	case executor.StrategyScaleIn, executor.StrategyScaleOut:
		return scaleStrategy{}, st, nil
	default:
		return nil, nil, fmt.Errorf("%w: %q", ErrInvalidStrategy, rec.ExecutionStrategy)
	}
}
