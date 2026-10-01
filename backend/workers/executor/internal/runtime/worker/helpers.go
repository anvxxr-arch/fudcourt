package worker

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/strategies"
)

// terminalChild reports a child-order status that holds no room and needs no
// venue interaction (PRD §58).
func terminalChild(s execution.ChildOrderStatus) bool {
	switch s {
	case execution.ChildFilled, execution.ChildCancelled, execution.ChildRejected, execution.ChildExpired:
		return true
	}
	return false
}

// matchVenue finds the venue order for one child row: by venue order id first,
// then by our client order id (§114 adoption space).
func matchVenue(venueOrders []execution.NormalizedOrder, c execution.ChildOrderRecord) (execution.NormalizedOrder, bool) {
	for _, o := range venueOrders {
		if c.ExchangeOrderID != nil && *c.ExchangeOrderID != "" && o.ExchangeOrderID == *c.ExchangeOrderID {
			return o, true
		}
	}
	for _, o := range venueOrders {
		if o.ClientOrderID != "" && o.ClientOrderID == c.ClientOrderID {
			return o, true
		}
	}
	return execution.NormalizedOrder{}, false
}

// childEventFor maps a venue-reported status onto the child-order lifecycle
// event vocabulary (engine.ts childEventFor).
func childEventFor(s execution.ChildOrderStatus) strategies.ChildOrderEvent {
	switch s {
	case execution.ChildPlanned:
		return strategies.ChildEventSubmit
	case execution.ChildSubmitting, execution.ChildOpen:
		return strategies.ChildEventAccept
	case execution.ChildPartial:
		return strategies.ChildEventPartialFill
	case execution.ChildFilled:
		return strategies.ChildEventFill
	case execution.ChildCancelling:
		return strategies.ChildEventCancelReq
	case execution.ChildCancelled:
		return strategies.ChildEventCancel
	case execution.ChildRejected:
		return strategies.ChildEventReject
	case execution.ChildExpired:
		return strategies.ChildEventExpire
	default:
		return strategies.ChildEventUnknown
	}
}

// childRowID builds the store row key for one child. Child rows are keyed by
// (execution, client order id) — the deterministic pair — so SaveChildOrder
// can upsert a replayed reconcile without forking a row.
func childRowID(executionID, clientOrderID string) string {
	return executionID + ":" + clientOrderID
}

// isRetryable reports whether an error is one of the retryable classes
// (PRD §78: network/rate-limit/overload).
//
// The retry set lives on exchanges.VenueError.Class.Retryable — a *field*, not a
// method — and on the adapter/simulator classes, so the check MUST go through
// exchanges.Classify, which resolves all three shapes (a VenueError carries its
// classification, a retryable signal declares Retryable(), a deadline is a
// network class). Looking only for a `Retryable() bool` METHOD returns the
// fail-safe default true for every venue failure, which silently leaves a
// REJECTED order (invalid_order / permission_error / insufficient_balance)
// stuck SUBMITTING forever instead of rejecting it and freeing the room (§107).
//
// An UNCLASSIFIABLE error (no VenueError, no signal, no timeout → unknown)
// still defaults to retryable: the venue may have taken the order, so the row
// stays SUBMITTING and reconciliation decides (§66). Only an explicit
// non-retryable classification rejects.
func isRetryable(err error) bool {
	if err == nil {
		return false
	}
	class := exchanges.Classify(err)
	if class.Category == execution.ErrUnknown {
		return true // unclassifiable: keep SUBMITTING, let reconciliation decide
	}
	return class.Retryable
}

// strPtr returns a pointer to s, or nil for the empty string — nullable decimal
// strings are honest absent values, never empty-but-present ones (house rule).
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// addDec sums two decimal strings; garbage in counts as zero (quantities are
// validated at placement, so garbage here is a venue echo — dropped, not fatal).
func addDec(a, b string) (string, error) {
	if b == "" {
		b = "0"
	}
	if a == "" {
		a = "0"
	}
	return decimal.Add(a, b)
}

// cmpDec compares two decimal strings; an unparseable operand is less than a
// parseable one so a garbage venue echo can never WIN a max() comparison.
func cmpDec(a, b string) int {
	c, err := decimal.Cmp(a, b)
	if err != nil {
		if _, err2 := decimal.Cmp(b, b); err2 != nil {
			return 0
		}
		return -1
	}
	return c
}

// absDec returns |s| as a decimal string, or "" when s is unparseable.
func absDec(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "-") {
		return s[1:]
	}
	return s
}

// ---------------------------------------------------------------------------
// MemoryStore — the in-test Store implementation (objective §8.9).
// ---------------------------------------------------------------------------

// MemoryStore is a concurrency-safe, in-memory Store for tests and single-
// process harnesses.
//
// INVARIANTS: SaveExecution upserts by ID, SaveChildOrder upserts by
// (ExecutionID, ClientOrderID), AppendEvent is append-only and never rewrites
// history — every append adds exactly one new immutable event (PRD §63). The
// event id is ASSIGNED BY THE STORE from a sequence that lives in the store,
// not in the worker: evt_<executionID>_<seq>, mirroring the durable sequence
// of the Postgres implementation (internal/repository). A restarted worker
// over the same store keeps minting fresh ids instead of replaying a
// per-process counter's ids and silently losing events. A caller-supplied
// event ID is ignored (the store owns id assignment).
type MemoryStore struct {
	mu         sync.Mutex
	executions map[string]execution.ExecutionRecord
	children   map[string]execution.ChildOrderRecord
	events     []execution.ExecutionEventRecord
	seq        uint64 // event id sequence; in the STORE, like the DB sequence it mirrors
}

// NewMemoryStore returns an empty store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		executions: map[string]execution.ExecutionRecord{},
		children:   map[string]execution.ChildOrderRecord{},
	}
}

// SaveExecution implements Store.
func (m *MemoryStore) SaveExecution(_ context.Context, rec execution.ExecutionRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.executions[rec.ID] = rec
	return nil
}

// LoadRecoverable implements Store: every non-terminal execution past DRAFT.
func (m *MemoryStore) LoadRecoverable(_ context.Context) ([]execution.ExecutionRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]execution.ExecutionRecord, 0, len(m.executions))
	for _, rec := range m.executions {
		if rec.Status == execution.StatusDraft {
			continue
		}
		if execution.IsTerminalExecution(rec.Status) {
			continue
		}
		out = append(out, rec)
	}
	return out, nil
}

// SaveChildOrder implements Store.
func (m *MemoryStore) SaveChildOrder(_ context.Context, rec execution.ChildOrderRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.children[childRowID(rec.ExecutionID, rec.ClientOrderID)] = rec
	return nil
}

// ListChildOrders implements Store.
func (m *MemoryStore) ListChildOrders(_ context.Context, executionID string) ([]execution.ChildOrderRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []execution.ChildOrderRecord{}
	for _, c := range m.children {
		if c.ExecutionID == executionID {
			out = append(out, c)
		}
	}
	return out, nil
}

// AppendEvent implements Store: one new immutable event per call, id assigned
// by the store (evt_<executionID>_<seq>, seq from this store's sequence). The
// sequence never rewinds, so two appends can never share an id and history can
// never be rewritten (PRD §63).
func (m *MemoryStore) AppendEvent(_ context.Context, ev execution.ExecutionEventRecord) (execution.ExecutionEventRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	ev.ID = fmt.Sprintf("evt_%s_%d", ev.ExecutionID, m.seq)
	m.events = append(m.events, ev)
	return ev, nil
}

// Events returns every appended event (test surface).
func (m *MemoryStore) Events() []execution.ExecutionEventRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]execution.ExecutionEventRecord, len(m.events))
	copy(out, m.events)
	return out
}

// Execution returns one stored execution (test surface).
func (m *MemoryStore) Execution(id string) (execution.ExecutionRecord, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.executions[id]
	return rec, ok
}
