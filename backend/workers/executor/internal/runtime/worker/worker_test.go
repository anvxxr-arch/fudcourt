package worker

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/exchanges"
)

// ---- fakes -----------------------------------------------------------------

type fakeClock struct{ ms int64 }

func (f *fakeClock) Now() int64 { return f.ms }

// fakeLock is the lease fake: outcomes are controllable and every call counted
// so "fail-closed, untouched" assertions can prove a negative.
type fakeLock struct {
	mu       sync.Mutex
	acquire  bool
	renew    bool
	acquires int
	renews   int
	releases int
}

func (f *fakeLock) Acquire(ctx context.Context, executionID, owner string, ttlMs int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acquires++
	return f.acquire, nil
}

func (f *fakeLock) Renew(ctx context.Context, executionID, owner string, ttlMs int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renews++
	return f.renew, nil
}

func (f *fakeLock) Release(ctx context.Context, executionID, owner string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.releases++
	return nil
}

// fakeExchange is a deterministic venue: CreateOrder is idempotent by
// ClientOrderID (objective §23) and open orders are settable per scenario.
type fakeExchange struct {
	mu        sync.Mutex
	orders    map[string]execution.NormalizedOrder // by client order id
	created   int
	cancelled []string
	seq       int
	onOpen    func()
}

func newFakeExchange() *fakeExchange {
	return &fakeExchange{orders: map[string]execution.NormalizedOrder{}}
}

func (f *fakeExchange) GetAccount(context.Context) (execution.AccountMetadata, error) {
	return execution.AccountMetadata{}, nil
}

func (f *fakeExchange) GetBalance(context.Context) (execution.AccountEquity, error) {
	return execution.AccountEquity{}, nil
}

func (f *fakeExchange) GetPosition(context.Context, string) (execution.Position, error) {
	return execution.Position{}, nil
}

func (f *fakeExchange) GetTicker(_ context.Context, symbol string) (execution.Ticker, error) {
	return execution.Ticker{Symbol: symbol}, nil
}

func (f *fakeExchange) CreateOrder(_ context.Context, req execution.OrderRequest) (execution.NormalizedOrder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if existing, dup := f.orders[req.ClientOrderID]; dup {
		return existing, nil // venue idempotency: resubmit returns the SAME order
	}
	f.seq++
	f.created++
	o := execution.NormalizedOrder{
		ExchangeOrderID: "v" + itoa(f.seq),
		ClientOrderID:   req.ClientOrderID,
		Symbol:          req.Symbol,
		Side:            req.Side,
		Type:            req.OrderType,
		Quantity:        req.Quantity,
		FilledQuantity:  "0",
		Status:          execution.ChildOpen,
		IsExit:          req.ReduceOnly || req.Intent == execution.IntentClose || req.Intent == execution.IntentReduce,
	}
	f.orders[req.ClientOrderID] = o
	return o, nil
}

func (f *fakeExchange) CancelOrder(_ context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelled = append(f.cancelled, exchangeOrderID)
	for id, o := range f.orders {
		if o.ExchangeOrderID == exchangeOrderID {
			o.Status = execution.ChildCancelled
			f.orders[id] = o
			return o, nil
		}
	}
	return execution.NormalizedOrder{ExchangeOrderID: exchangeOrderID, Status: execution.ChildCancelled}, nil
}

func (f *fakeExchange) GetOrder(_ context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, o := range f.orders {
		if o.ExchangeOrderID == exchangeOrderID {
			return o, nil
		}
	}
	return execution.NormalizedOrder{}, errors.New("not found")
}

func (f *fakeExchange) GetOpenOrders(context.Context, string) ([]execution.NormalizedOrder, error) {
	if f.onOpen != nil {
		f.onOpen()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]execution.NormalizedOrder, 0, len(f.orders))
	for _, o := range f.orders {
		if o.Status == execution.ChildOpen || o.Status == execution.ChildPartial ||
			o.Status == execution.ChildSubmitting || o.Status == execution.ChildCancelling {
			out = append(out, o)
		}
	}
	return out, nil
}

func (f *fakeExchange) GetFills(context.Context, string) ([]execution.Fill, error) {
	return nil, nil
}

// GetMarkets/GetFees complete the canonical venue interface for the fake: the
// worker loop never calls them (they are the API-tier plan path), so they are
// honest "not available" answers rather than fabricated venue data.
func (f *fakeExchange) GetMarkets(context.Context) ([]exchanges.Market, error) {
	return nil, exchanges.ErrMarketsUnavailable
}

func (f *fakeExchange) GetFees(context.Context, string) (exchanges.FeeModel, error) {
	return exchanges.FeeModel{}, exchanges.ErrFeesUnavailable
}

func (f *fakeExchange) createCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.created
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// ---- fixtures --------------------------------------------------------------

func runningRec() execution.ExecutionRecord {
	return execution.ExecutionRecord{
		ID:                "e1",
		Symbol:            "BTC/USDT",
		Side:              execution.SideBuy,
		Intent:            execution.IntentOpen,
		Status:            execution.StatusRunning,
		ExecutionStrategy: execution.StrategyMarket,
		PlannedQuantity:   "0.01",
	}
}

func newTestWorker(t *testing.T, store Store, lock Lock, ex exchanges.Exchange, maxInFlight int, opts ...func(*Config)) *Worker {
	t.Helper()
	cfg := Config{
		Owner:        "worker-1",
		LockTTL:      time.Second,
		MaxInFlight:  maxInFlight,
		Clock:        &fakeClock{ms: 1000},
		Store:        store,
		Lock:         lock,
		Exchanges:    func(execution.ExecutionRecord) (exchanges.Exchange, error) { return ex, nil },
		QuantityStep: func(execution.ExecutionRecord) string { return "0.001" },
	}
	for _, o := range opts {
		o(&cfg)
	}
	w, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func eventNames(store *MemoryStore) []string {
	out := []string{}
	for _, e := range store.Events() {
		out = append(out, string(e.Name))
	}
	return out
}

func hasEvent(store *MemoryStore, name execution.ExecutionEventName) bool {
	for _, e := range store.Events() {
		if e.Name == name {
			return true
		}
	}
	return false
}

func findEvent(store *MemoryStore, name execution.ExecutionEventName) (execution.ExecutionEventRecord, bool) {
	for _, e := range store.Events() {
		if e.Name == name {
			return e, true
		}
	}
	return execution.ExecutionEventRecord{}, false
}

// ---- vectors ---------------------------------------------------------------

// PRD §114: the FIRST pass after start is a recovery pass — reconcile with the
// venue, place NOTHING — and every later pass drives strategies.
func TestRecoveryPassPlacesNothing(t *testing.T) {
	store := NewMemoryStore()
	_ = store.SaveExecution(context.Background(), runningRec())
	ex := newFakeExchange()
	lock := &fakeLock{acquire: true, renew: true}
	w := newTestWorker(t, store, lock, ex, 2)

	w.Tick(context.Background()) // pass 1: recovery
	if ex.createCount() != 0 {
		t.Fatalf("recovery pass placed %d orders, want 0", ex.createCount())
	}
	if lock.releases == 0 {
		t.Fatal("the lease must be released after the pass")
	}
	w.Tick(context.Background()) // pass 2: the strategy may act now
	if ex.createCount() != 1 {
		t.Fatalf("placement pass created %d orders, want 1", ex.createCount())
	}
}

// Restart does not double-submit (PRD §66/§114): the child id is derived
// deterministically from (execution, sequence) and ADOPTED, never re-created.
func TestRestartDoesNotDoubleSubmit(t *testing.T) {
	t.Run("crash window adopted, not re-created", func(t *testing.T) {
		// The crashed worker's order DID reach the venue; the new worker has a
		// store with no row for it (crash before any write survived).
		store := NewMemoryStore()
		_ = store.SaveExecution(context.Background(), runningRec())
		ex := newFakeExchange()
		_, err := ex.CreateOrder(context.Background(), execution.OrderRequest{
			ClientOrderID: "fud_e1_0", Symbol: "BTC/USDT", Quantity: "0.01",
		})
		if err != nil {
			t.Fatal(err)
		}
		w := newTestWorker(t, store, &fakeLock{acquire: true, renew: true}, ex, 2)

		w.Tick(context.Background()) // recovery: ADOPT fud_e1_0, place nothing
		if ex.createCount() != 1 {
			t.Fatalf("recovery pass must not re-create: %d venue orders", ex.createCount())
		}
		if !hasEvent(store, execution.EventOrderSubmitted) {
			t.Fatal("adoption must record the child via ORDER_SUBMITTED")
		}
		rows, _ := store.ListChildOrders(context.Background(), "e1")
		if len(rows) != 1 || rows[0].ClientOrderID != "fud_e1_0" {
			t.Fatalf("adopted rows = %+v, want exactly fud_e1_0", rows)
		}

		w.Tick(context.Background()) // placement pass: room is the adopted child's
		if ex.createCount() != 1 {
			t.Fatalf("placement pass re-created the child: %d venue orders", ex.createCount())
		}
		if ev, ok := findEvent(store, execution.EventPlanResized); !ok {
			t.Fatal("the blocked re-placement must be visible as PLAN_RESIZED")
		} else if ev.Payload["clamped"] != "0" {
			t.Fatalf("PLAN_RESIZED payload = %+v, want clamped 0", ev.Payload)
		}
	})

	t.Run("persisted state resumes the schedule", func(t *testing.T) {
		store := NewMemoryStore()
		_ = store.SaveExecution(context.Background(), runningRec())
		ex := newFakeExchange()
		lock := &fakeLock{acquire: true, renew: true}
		w1 := newTestWorker(t, store, lock, ex, 2)

		w1.Tick(context.Background()) // recovery
		w1.Tick(context.Background()) // places fud_e1_0
		if ex.createCount() != 1 {
			t.Fatalf("first worker placed %d, want 1", ex.createCount())
		}

		// "Crash": a brand-new worker over the same store and venue.
		w2 := newTestWorker(t, store, lock, ex, 2)
		w2.Tick(context.Background()) // recovery: reconcile, adopt/correct, place nothing
		w2.Tick(context.Background()) // placement pass
		if ex.createCount() != 1 {
			t.Fatalf("restart double-submitted: %d venue orders, want 1", ex.createCount())
		}
		rows, _ := store.ListChildOrders(context.Background(), "e1")
		if len(rows) != 1 {
			t.Fatalf("want exactly one child row after restart, got %+v", rows)
		}
	})
}

// MaxInFlight is a HARD cap (objective §8.9): never more than MaxInFlight
// executions driven concurrently, whatever the recoverable load.
func TestMaxInFlightRespected(t *testing.T) {
	const total, capn = 12, 3
	store := NewMemoryStore()
	for i := range total {
		rec := runningRec()
		rec.ID = "e" + itoa(i+1)
		_ = store.SaveExecution(context.Background(), rec)
	}
	ex := newFakeExchange()
	var mu sync.Mutex
	arrived, released, maxConc, conc := 0, 0, 0, 0
	gate := make(chan struct{})
	ex.onOpen = func() {
		mu.Lock()
		arrived++
		conc++
		if conc > maxConc {
			maxConc = conc
		}
		shouldWait := arrived <= capn // the first capn drivers rendezvous at the gate
		if arrived == capn {
			released++
			if released == 1 {
				close(gate)
			}
		}
		mu.Unlock()
		if shouldWait {
			select {
			case <-gate:
			case <-time.After(5 * time.Second):
			}
		}
		mu.Lock()
		conc--
		mu.Unlock()
	}
	w := newTestWorker(t, store, &fakeLock{acquire: true, renew: true}, ex, capn)
	w.Tick(context.Background())
	mu.Lock()
	defer mu.Unlock()
	if arrived != total {
		t.Fatalf("drove %d/%d executions", arrived, total)
	}
	if maxConc > capn {
		t.Fatalf("observed %d concurrent drives, hard cap is %d", maxConc, capn)
	}
}

// Fail-closed leases (§65): no lease = no trading — the execution is not read
// for action, not written, not traded.
func TestLeaseContentionLeavesExecutionUntouched(t *testing.T) {
	store := NewMemoryStore()
	_ = store.SaveExecution(context.Background(), runningRec())
	ex := newFakeExchange()
	lock := &fakeLock{acquire: false, renew: true} // contended
	w := newTestWorker(t, store, lock, ex, 2)

	w.Tick(context.Background())
	w.Tick(context.Background())
	if ex.createCount() != 0 {
		t.Fatalf("contended lease traded: %d venue orders", ex.createCount())
	}
	if lock.renews != 0 {
		t.Fatal("no lease means no renew")
	}
	if len(store.Events()) != 0 {
		t.Fatalf("untouched execution emitted events: %v", eventNames(store))
	}
	rows, _ := store.ListChildOrders(context.Background(), "e1")
	if len(rows) != 0 {
		t.Fatalf("untouched execution grew child rows: %+v", rows)
	}
	rec, _ := store.Execution("e1")
	if rec.Status != execution.StatusRunning {
		t.Fatalf("status moved without a lease: %s", rec.Status)
	}
}

// A lost lease before the money moves stops placement cold (§65): no child row
// is written, so the deterministic id is re-minted on a later owned pass.
func TestLostLeaseStopsPlacement(t *testing.T) {
	store := NewMemoryStore()
	_ = store.SaveExecution(context.Background(), runningRec())
	ex := newFakeExchange()
	lock := &fakeLock{acquire: true, renew: false} // lost between acquire and place
	w := newTestWorker(t, store, lock, ex, 2)

	w.Tick(context.Background()) // recovery
	w.Tick(context.Background()) // placement attempt dies at the renew
	if ex.createCount() != 0 {
		t.Fatalf("lost lease must not trade: %d venue orders", ex.createCount())
	}
	rows, _ := store.ListChildOrders(context.Background(), "e1")
	if len(rows) != 0 {
		t.Fatalf("no row may be written without a renewed lease: %+v", rows)
	}
}

// Objective §39: a risk breach cancels entry children and lands RISK_STOPPED —
// it never silently violates the user's bound, and it never closes positions
// (§75: closing is a separate, explicit user action).
func TestRiskStopPath(t *testing.T) {
	store := NewMemoryStore()
	rec := runningRec()
	_ = store.SaveExecution(context.Background(), rec)
	v1 := "v1"
	_ = store.SaveChildOrder(context.Background(), execution.ChildOrderRecord{
		ID: childRowID("e1", "fud_e1_0"), ExecutionID: "e1",
		ExchangeOrderID: &v1, ClientOrderID: "fud_e1_0", Symbol: "BTC/USDT",
		Side: execution.SideBuy, Type: "limit", Quantity: "0.01",
		FilledQuantity: "0", Status: execution.ChildOpen,
	})
	ex := newFakeExchange()
	ex.orders["fud_e1_0"] = execution.NormalizedOrder{
		ExchangeOrderID: "v1", ClientOrderID: "fud_e1_0", Symbol: "BTC/USDT",
		Quantity: "0.01", Status: execution.ChildOpen,
	}
	w := newTestWorker(t, store, &fakeLock{acquire: true, renew: true}, ex, 2, func(c *Config) {
		c.RiskCheck = func(execution.ExecutionRecord) (bool, string) { return true, "max daily loss" }
	})

	w.Tick(context.Background()) // recovery pass: risk stops even a fresh worker
	if ex.createCount() != 0 {
		t.Fatal("a breached execution must not place")
	}
	got, _ := store.Execution("e1")
	if got.Status != execution.StatusRiskStopped {
		t.Fatalf("status = %s, want RISK_STOPPED", got.Status)
	}
	ev, ok := findEvent(store, execution.EventExecutionRiskStopped)
	if !ok {
		t.Fatalf("want EXECUTION_RISK_STOPPED, events = %v", eventNames(store))
	}
	if ev.Payload["reason"] != "max daily loss" {
		t.Fatalf("event payload = %+v, want the breach reason", ev.Payload)
	}
	if len(ex.cancelled) != 1 || ex.cancelled[0] != "v1" {
		t.Fatalf("entry children must be cancelled at the venue, got %v", ex.cancelled)
	}
	rows, _ := store.ListChildOrders(context.Background(), "e1")
	if rows[0].Status != execution.ChildCancelled {
		t.Fatalf("child row = %s, want CANCELLED", rows[0].Status)
	}
}

// Objective §23: duplicate StartExecution of a RUNNING execution is a no-op —
// no event, no write, no re-drive. An illegal start is refused naming both
// states. Unknown ids are refused.
func TestStartExecutionIdempotent(t *testing.T) {
	store := NewMemoryStore()
	rec := runningRec()
	rec.Status = execution.StatusReady
	_ = store.SaveExecution(context.Background(), rec)
	w := newTestWorker(t, store, &fakeLock{acquire: true, renew: true}, newFakeExchange(), 2)

	got, err := w.StartExecution(context.Background(), "e1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != execution.StatusRunning || got.StartedAt != 1000 {
		t.Fatalf("start = %+v, want RUNNING stamped 1000", got)
	}
	if !hasEvent(store, execution.EventExecutionStarted) {
		t.Fatal("start must emit EXECUTION_STARTED")
	}

	// Duplicate: no-op.
	again, err := w.StartExecution(context.Background(), "e1")
	if err != nil {
		t.Fatalf("duplicate start must be a no-op, got %v", err)
	}
	if again.Status != execution.StatusRunning {
		t.Fatalf("duplicate start moved status: %s", again.Status)
	}
	started := 0
	for _, e := range store.Events() {
		if e.Name == execution.EventExecutionStarted {
			started++
		}
	}
	if started != 1 {
		t.Fatalf("duplicate start emitted %d EXECUTION_STARTED events, want 1", started)
	}

	// Illegal start (non-terminal): refused naming both states (409 contract).
	pending := rec
	pending.Status = execution.StatusCancelRequested
	_ = store.SaveExecution(context.Background(), pending)
	_, err = w.StartExecution(context.Background(), "e1")
	if err == nil {
		t.Fatal("starting a CANCEL_REQUESTED execution must be refused")
	}
	if !strings.Contains(err.Error(), "CANCEL_REQUESTED") || !strings.Contains(err.Error(), "RUNNING") {
		t.Fatalf("error must name both states, got %q", err.Error())
	}
	// A terminal execution is not recoverable at all — refused outright.
	done := rec
	done.Status = execution.StatusFilled
	_ = store.SaveExecution(context.Background(), done)
	if _, err = w.StartExecution(context.Background(), "e1"); !errors.Is(err, ErrUnknownExecution) {
		t.Fatalf("terminal execution must be refused, got %v", err)
	}

	// Unknown id: refused.
	if _, err := w.StartExecution(context.Background(), "nope"); !errors.Is(err, ErrUnknownExecution) {
		t.Fatalf("err = %v, want ErrUnknownExecution", err)
	}
}
