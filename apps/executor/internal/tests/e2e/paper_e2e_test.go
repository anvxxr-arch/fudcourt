// Package e2e is the composed Go paper harness the cutover gate needs
// (docs/architecture/parity-matrix.md, PRD §127). The pieces it composes are
// each unit-tested in their own packages — internal/exchanges/paper (the
// simulator), internal/runtime/worker (the runtime loop), internal/platform/lock (the lease) —
// but nothing until now drove them TOGETHER, so "the Go worker executes a
// paper trade end to end" was an untested claim.
//
// WHY A NEW PACKAGE, NOT A _test.go NEXT TO THE CODE: the harness must exercise
// the PUBLIC surface of the worker, the lease and the paper venue exactly as a
// composition root does (cmd/executor). Keeping it in internal/tests/e2e means it can
// only use exported symbols — if a refactor unexports something the harness
// needs, this test fails to compile, which is the boundary telling the truth.
//
// HERMETIC: no Postgres, no Valkey, no network, no credentials, no sleeping.
// Persistence is worker.MemoryStore, the lease is lock.MemoryLock, the venue is
// exchange/paper, and time is a lock.FixedClock the test advances by hand. This
// is what makes the §127 scenario runnable in `go test` on any machine, which
// is precisely what the executor-cutover definition-of-done asks for.
package e2e

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/planner"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/risk"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/sizing"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges/paper"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/lock"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/runtime/worker"
)

const baseMs = 1_700_000_000_000

// leaseAdapter bridges lock.ExecutionLock (context + Duration) to worker.Lock
// (context + TTL in ms). cmd/executor has an identical adapter; the worker
// deliberately does not import internal/platform/lock, so the composition root supplies
// the seam. Duplicating the four lines here keeps the harness on the PUBLIC
// boundary instead of reaching into package main.
type leaseAdapter struct{ lock lock.ExecutionLock }

func (a leaseAdapter) Acquire(ctx context.Context, id, owner string, ttlMs int64) (bool, error) {
	return a.lock.Acquire(ctx, id, owner, time.Duration(ttlMs)*time.Millisecond)
}
func (a leaseAdapter) Renew(ctx context.Context, id, owner string, ttlMs int64) (bool, error) {
	return a.lock.Renew(ctx, id, owner, time.Duration(ttlMs)*time.Millisecond)
}
func (a leaseAdapter) Release(ctx context.Context, id, owner string) error {
	return a.lock.Release(ctx, id, owner)
}

var _ worker.Lock = leaseAdapter{}

// harness is one composed stack: store + lease + venue + clock + worker.
type harness struct {
	store *worker.MemoryStore
	lease *lock.MemoryLock
	venue *paper.Paper
	clock *lock.FixedClock
	w     *worker.Worker
}

func newHarness(t *testing.T, owner string, mut func(*paper.PaperConfig)) *harness {
	t.Helper()
	clk := lock.NewFixedClock(baseMs)
	pcfg := paper.PaperConfig{
		MarketType: execution.MarketLinearPerp,
		Clock:      exchanges.FixedClock{Millis: baseMs},
		Balances:   []execution.Balance{{Asset: "USDT", Free: "1000000", Used: "0"}},
		Marks:      map[string]string{"BTC/USDT": "100000"},
		FillRate:   "1", // full fill per pass: deterministic for the harness
		// SpreadBps 0 defaults to no bid/ask (honest nil touch), which makes a
		// TWAP slice fall back to a market order that fills at once.
	}
	if mut != nil {
		mut(&pcfg)
	}
	venue, err := paper.NewPaper(pcfg)
	if err != nil {
		t.Fatalf("paper.NewPaper: %v", err)
	}
	st := worker.NewMemoryStore()
	lease := lock.NewMemoryLock(lock.MemoryConfig{Clock: clk})
	w, err := worker.New(worker.Config{
		Owner:        owner,
		Tick:         0, // manual Tick() only — the deterministic mode
		LockTTL:      time.Minute,
		MaxInFlight:  4,
		Clock:        clk,
		Store:        st,
		Lock:         leaseAdapter{lease},
		Exchanges:    func(execution.ExecutionRecord) (exchanges.Exchange, error) { return venue, nil },
		QuantityStep: func(execution.ExecutionRecord) string { return "0.0001" },
	})
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}
	return &harness{store: st, lease: lease, venue: venue, clock: clk, w: w}
}

// tick advances the clock one second and runs one scheduler pass. The clock
// move is load-bearing: the strategy ledger frees a phantom child's room only
// once its CreatedAt is strictly older than the tick's now, so two passes at
// the same instant would look like one.
func (h *harness) tick() {
	h.clock.Advance(time.Second)
	h.w.Tick(context.Background())
}

func execRec(id string, strat execution.ExecutionStrategy, planned string,
	entry execution.EntryDefinition, xcfg execution.ExecutionConfig) execution.ExecutionRecord {
	return execution.ExecutionRecord{
		ID:                id,
		UserID:            "u1",
		AccountID:         "acct1",
		Exchange:          execution.ExchangeBinance,
		Symbol:            "BTC/USDT",
		MarketType:        execution.MarketLinearPerp,
		Side:              execution.SideBuy,
		Intent:            execution.IntentOpen,
		Status:            execution.StatusReady,
		Mode:              execution.ModePaper,
		SizingMode:        execution.SizingRiskUSD,
		SizingValue:       "40",
		EntryDefinition:   entry,
		TakeProfit:        []execution.TakeProfitLevel{},
		ExecutionStrategy: strat,
		ExecutionConfig:   xcfg,
		PlannedQuantity:   planned,
		CreatedAt:         baseMs,
		StartedAt:         baseMs,
	}
}

func (h *harness) children(t *testing.T, id string) []execution.ChildOrderRecord {
	t.Helper()
	rows, err := h.store.ListChildOrders(context.Background(), id)
	if err != nil {
		t.Fatalf("ListChildOrders(%s): %v", id, err)
	}
	return rows
}

func (h *harness) events() []execution.ExecutionEventRecord {
	return h.store.Events()
}

func hasEvent(evs []execution.ExecutionEventRecord, name execution.ExecutionEventName) bool {
	for _, e := range evs {
		if e.Name == name {
			return true
		}
	}
	return false
}

func gtZero(t *testing.T, s, label string) {
	t.Helper()
	c, err := decimal.Cmp(s, "0")
	if err != nil || c <= 0 {
		t.Fatalf("%s = %q, want > 0 (err=%v)", label, s, err)
	}
}

func leDec(t *testing.T, got, bound, label string) {
	t.Helper()
	c, err := decimal.Cmp(got, bound)
	if err != nil || c > 0 {
		t.Fatalf("%s = %q, want <= %q (err=%v)", label, got, bound, err)
	}
}

// openEntryChildren counts entry children still resting at the venue.
func openEntryChildren(rows []execution.ChildOrderRecord) int {
	n := 0
	for _, c := range rows {
		if c.IsExit {
			continue
		}
		switch c.Status {
		case execution.ChildOpen, execution.ChildPartial, execution.ChildSubmitting:
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// §127.2–§127.3 — create → recovery → place → fill → complete
// ---------------------------------------------------------------------------

// TestPaperMarketLifecycle is the core PRD §127 scenario: a market execution
// runs through the real worker against the real paper venue, places exactly one
// child, fills it, and lands FILLED via EXECUTION_COMPLETED.
func TestPaperMarketLifecycle(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", nil)
	rec := execRec("e1", execution.StrategyMarket, "0.01",
		execution.EntryDefinition{Kind: "market"}, execution.ExecutionConfig{})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}

	// §127.2 — the start intent is applied through the worker (READY → RUNNING).
	started, err := h.w.StartExecution(ctx, "e1")
	if err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	if started.Status != execution.StatusRunning {
		t.Fatalf("status after start = %s, want RUNNING", started.Status)
	}
	if !hasEvent(h.events(), execution.EventExecutionStarted) {
		t.Fatal("start must emit EXECUTION_STARTED")
	}

	// Pass 1 is recovery (PRD §114): reconcile with the venue, place NOTHING.
	h.tick()
	if n := len(h.children(t, "e1")); n != 0 {
		t.Fatalf("recovery pass created %d children, want 0", n)
	}

	// Pass 2 drives one strategy step: one market child, filled immediately.
	h.tick()
	rows := h.children(t, "e1")
	if len(rows) != 1 {
		t.Fatalf("children = %d, want exactly 1", len(rows))
	}
	if rows[0].ClientOrderID != "fud_e1_0" {
		t.Fatalf("client order id = %q, want fud_e1_0 (deterministic §23)", rows[0].ClientOrderID)
	}
	if rows[0].Status != execution.ChildFilled {
		t.Fatalf("child status = %s, want FILLED (paper fills a market order at once)", rows[0].Status)
	}
	if c, err := decimal.Cmp(rows[0].FilledQuantity, "0.01"); err != nil || c != 0 {
		t.Fatalf("filled quantity = %q, want 0.01", rows[0].FilledQuantity)
	}
	if !hasEvent(h.events(), execution.EventOrderSubmitted) {
		t.Fatal("placement must emit ORDER_SUBMITTED")
	}

	// Pass 3 sees the fill and completes the execution.
	h.tick()
	after, ok := h.store.Execution("e1")
	if !ok {
		t.Fatal("execution e1 vanished")
	}
	if after.Status != execution.StatusFilled {
		t.Fatalf("final status = %s, want FILLED", after.Status)
	}
	if !hasEvent(h.events(), execution.EventExecutionCompleted) {
		t.Fatal("completion must emit EXECUTION_COMPLETED")
	}
	if n := openEntryChildren(h.children(t, "e1")); n != 0 {
		t.Fatalf("%d entry children left open after completion, want 0", n)
	}
}

// ---------------------------------------------------------------------------
// §127.4 — the lease: a second worker cannot double-drive
// ---------------------------------------------------------------------------

// TestPaperLeaseContention proves the §65 fail-closed lease on the real
// MemoryLock: while one owner holds the lease a second is refused, and the
// lease becomes re-acquirable once released.
func TestPaperLeaseContention(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", nil)
	ttl := time.Minute

	ok, err := h.lease.Acquire(ctx, "e1", "worker-a", ttl)
	if err != nil || !ok {
		t.Fatalf("first acquire = (%v,%v), want (true,nil)", ok, err)
	}
	ok, err = h.lease.Acquire(ctx, "e1", "worker-b", ttl)
	if err != nil || ok {
		t.Fatalf("second acquire = (%v,%v), want (false,nil) — the lease is held", ok, err)
	}
	if err := h.lease.Release(ctx, "e1", "worker-a"); err != nil {
		t.Fatalf("release: %v", err)
	}
	ok, err = h.lease.Acquire(ctx, "e1", "worker-b", ttl)
	if err != nil || !ok {
		t.Fatalf("re-acquire after release = (%v,%v), want (true,nil)", ok, err)
	}
}

// ---------------------------------------------------------------------------
// §127.5 — worker restart never duplicates a venue order
// ---------------------------------------------------------------------------

// TestPaperRestartNoDuplicateOrder drives an execution to a filled child, then
// restarts the worker over the SAME store (a fresh Worker = a fresh process) and
// proves recovery ADOPTS the existing child instead of re-placing it (§66/§114).
func TestPaperRestartNoDuplicateOrder(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", nil)
	rec := execRec("e2", execution.StrategyMarket, "0.01",
		execution.EntryDefinition{Kind: "market"}, execution.ExecutionConfig{})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.StartExecution(ctx, "e2"); err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	h.tick() // recovery
	h.tick() // place + fill
	before := h.children(t, "e2")
	if len(before) != 1 {
		t.Fatalf("pre-restart children = %d, want 1", len(before))
	}
	beforeID := before[0].ClientOrderID

	// Restart: a brand-new worker over the same durable store.
	h.w = func() *worker.Worker {
		w, err := worker.New(worker.Config{
			Owner: "w2", Tick: 0, LockTTL: time.Minute, MaxInFlight: 4,
			Clock: h.clock, Store: h.store, Lock: leaseAdapter{h.lease},
			Exchanges:    func(execution.ExecutionRecord) (exchanges.Exchange, error) { return h.venue, nil },
			QuantityStep: func(execution.ExecutionRecord) string { return "0.0001" },
		})
		if err != nil {
			t.Fatalf("restart worker.New: %v", err)
		}
		return w
	}()

	h.tick() // restarted recovery pass: adopt, place nothing
	rows := h.children(t, "e2")
	if len(rows) != 1 || rows[0].ClientOrderID != beforeID {
		t.Fatalf("after restart children = %+v, want exactly the adopted %s", rows, beforeID)
	}
	seen := map[string]bool{}
	for _, c := range rows {
		if seen[c.ClientOrderID] {
			t.Fatalf("duplicate client order id %s after restart", c.ClientOrderID)
		}
		seen[c.ClientOrderID] = true
	}
	h.tick() // restarted placement pass: no room, no re-create
	rows = h.children(t, "e2")
	if len(rows) != 1 {
		t.Fatalf("post-restart placement created a duplicate: %d children, want 1", len(rows))
	}
	after, _ := h.store.Execution("e2")
	if after.Status != execution.StatusFilled {
		t.Fatalf("status after restart = %s, want FILLED", after.Status)
	}
}

// ---------------------------------------------------------------------------
// §127.6 — cancel a resting entry safely
// ---------------------------------------------------------------------------

// TestPaperCancelRestingOrder rests a limit child, requests a cancel, and proves
// the worker cancels the entry and lands CANCELLED with no open entry left.
func TestPaperCancelRestingOrder(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", nil)
	// A buy limit well below the mark never crosses, so the child rests OPEN.
	rec := execRec("e3", execution.StrategyLimit, "0.01",
		execution.EntryDefinition{Kind: "limit", Price: "90000"}, execution.ExecutionConfig{})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.StartExecution(ctx, "e3"); err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	h.tick() // recovery
	h.tick() // place the resting limit
	rows := h.children(t, "e3")
	if len(rows) != 1 || rows[0].Status != execution.ChildOpen {
		t.Fatalf("want one OPEN resting child, got %+v", rows)
	}

	// The cancel intent arrives as a status transition, exactly as the API does.
	cur, _ := h.store.Execution("e3")
	cur.Status = execution.StatusCancelRequested
	if err := h.store.SaveExecution(ctx, cur); err != nil {
		t.Fatal(err)
	}
	h.tick()

	after, _ := h.store.Execution("e3")
	if after.Status != execution.StatusCancelled {
		t.Fatalf("status after cancel = %s, want CANCELLED", after.Status)
	}
	if n := openEntryChildren(h.children(t, "e3")); n != 0 {
		t.Fatalf("%d entry children left open after cancel, want 0", n)
	}
	if !hasEvent(h.events(), execution.EventExecutionCancelled) {
		t.Fatal("cancel must emit EXECUTION_CANCELLED")
	}
}

// ---------------------------------------------------------------------------
// §23 — duplicate start is a no-op
// ---------------------------------------------------------------------------

func TestPaperDuplicateStartIsNoOp(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", nil)
	rec := execRec("e4", execution.StrategyMarket, "0.01",
		execution.EntryDefinition{Kind: "market"}, execution.ExecutionConfig{})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.StartExecution(ctx, "e4"); err != nil {
		t.Fatal(err)
	}
	n1 := len(h.events())
	if _, err := h.w.StartExecution(ctx, "e4"); err != nil {
		t.Fatalf("duplicate start returned error: %v", err)
	}
	if n2 := len(h.events()); n2 != n1 {
		t.Fatalf("duplicate start appended %d events, want 0 (no-op §23)", n2-n1)
	}
	if _, err := h.w.StartExecution(ctx, "nope"); err == nil {
		t.Fatal("start of an unknown execution must be refused")
	}
}

// ---------------------------------------------------------------------------
// §76/§127 — a transport failure degrades to no-placement, then recovers
// ---------------------------------------------------------------------------

// TestPaperDisconnectDegradesThenRecovers arms the paper venue to fail the next
// exchange call: the worker must place NOTHING while degraded and record an
// EXTERNAL_STATE_CHANGE, then place normally on the next pass.
func TestPaperDisconnectDegradesThenRecovers(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", func(c *paper.PaperConfig) { c.TimeoutCalls = 1 })
	rec := execRec("e5", execution.StrategyMarket, "0.01",
		execution.EntryDefinition{Kind: "market"}, execution.ExecutionConfig{})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.StartExecution(ctx, "e5"); err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	h.tick() // recovery pass: the armed timeout fires on the first venue call
	if n := len(h.children(t, "e5")); n != 0 {
		t.Fatalf("degraded pass created %d children, want 0", n)
	}
	if !hasEvent(h.events(), execution.EventExternalStateChange) {
		t.Fatal("a failed venue call must surface as EXTERNAL_STATE_CHANGE")
	}
	h.tick() // timeout slot consumed: the venue answers, placement proceeds
	if n := len(h.children(t, "e5")); n != 1 {
		t.Fatalf("recovered pass created %d children, want 1", n)
	}
}

// ---------------------------------------------------------------------------
// §8.15/§28 — TWAP releases its plan as slices over the window
// ---------------------------------------------------------------------------

// TestPaperTwapSlices drives a TWAP execution across several ticks and proves
// the schedule releases the plan as multiple children (never one lump), that the
// sum never exceeds the plan (§107), and that it lands FILLED.
func TestPaperTwapSlices(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", nil)
	// initialState/planSlices read the schedule from the TOP-LEVEL
	// ExecutionConfig.DurationMs; Twap.Slices overrides the slice count.
	rec := execRec("e6", execution.StrategyTWAP, "0.03",
		execution.EntryDefinition{Kind: "market"},
		execution.ExecutionConfig{DurationMs: 3000, Twap: &execution.TwapConfig{Slices: 3, DurationMs: 3000}})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.StartExecution(ctx, "e6"); err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	// Recovery, then enough passes to release every slice and complete. With no
	// touch price each slice falls back to a market order that fills at once.
	for range 6 {
		h.tick()
	}
	rows := h.children(t, "e6")
	if len(rows) < 2 {
		t.Fatalf("TWAP placed %d children, want >= 2 slices", len(rows))
	}
	ids := map[string]bool{}
	sum := "0"
	for _, c := range rows {
		if ids[c.ClientOrderID] {
			t.Fatalf("duplicate slice id %s", c.ClientOrderID)
		}
		ids[c.ClientOrderID] = true
		sum, _ = decimal.Add(sum, c.Quantity)
	}
	leDec(t, sum, "0.03", "sum(slice quantities) vs planned (§107)")
	after, _ := h.store.Execution("e6")
	if after.Status != execution.StatusFilled {
		t.Fatalf("TWAP final status = %s, want FILLED", after.Status)
	}
	if n := openEntryChildren(rows); n != 0 {
		t.Fatalf("%d TWAP slices left open, want 0", n)
	}
}

// ---------------------------------------------------------------------------
// Phase 10 — a venue rejection is recorded and the plan recovers
// ---------------------------------------------------------------------------

// TestPaperRejectedOrderThenReplaces arms one simulated venue rejection: the
// first placement lands REJECTED with an ORDER_REJECTED event, the room is freed
// (§107), and a later pass re-places and fills.
func TestPaperRejectedOrderThenReplaces(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", func(c *paper.PaperConfig) {
		c.RejectOrders = 1
		c.RejectCode = "MIN_NOTIONAL"
		c.RejectCategory = execution.ErrInvalidOrder
	})
	rec := execRec("e7", execution.StrategyMarket, "0.01",
		execution.EntryDefinition{Kind: "market"}, execution.ExecutionConfig{})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.StartExecution(ctx, "e7"); err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	h.tick() // recovery
	h.tick() // placement: the armed rejection fires
	if !hasEvent(h.events(), execution.EventOrderRejected) {
		t.Fatal("a venue rejection must emit ORDER_REJECTED")
	}
	rows := h.children(t, "e7")
	if len(rows) != 1 || rows[0].Status != execution.ChildRejected {
		t.Fatalf("after rejection children = %+v, want one REJECTED", rows)
	}
	// The rejection released the room (§107): a later pass re-places and fills.
	h.tick()
	h.tick()
	after, _ := h.store.Execution("e7")
	if after.Status != execution.StatusFilled {
		t.Fatalf("final status = %s, want FILLED after the rejection cleared", after.Status)
	}
}

// ---------------------------------------------------------------------------
// Phase 10 — a partial fill is tracked, then the remainder completes
// ---------------------------------------------------------------------------

// TestPaperPartialFillThenComplete paces the venue at half-fill per matching
// pass. The worker's own reconcile sees fill truth only through GetOpenOrders
// (a fully filled order leaves the open book), so final fills arrive through the
// fill-INGESTION seam (PRD §94) — which this test composes by writing the child
// row exactly as the sync service does. It proves both halves: the worker tracks
// a partial fill, and completes once the ingested fill catches up to the plan.
func TestPaperPartialFillThenComplete(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", func(c *paper.PaperConfig) { c.FillRate = "0.5" })
	rec := execRec("e8", execution.StrategyMarket, "0.02",
		execution.EntryDefinition{Kind: "market"}, execution.ExecutionConfig{})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.StartExecution(ctx, "e8"); err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	h.tick() // recovery
	h.tick() // placement: the venue fills half at once
	rows := h.children(t, "e8")
	if len(rows) != 1 {
		t.Fatalf("children = %d, want 1", len(rows))
	}
	if rows[0].Status != execution.ChildPartial {
		t.Fatalf("first pass status = %s, want PARTIAL (FillRate 0.5)", rows[0].Status)
	}
	gtZero(t, rows[0].FilledQuantity, "partial fill quantity")
	leDec(t, rows[0].FilledQuantity, "0.02", "partial fill quantity")
	if mid, _ := h.store.Execution("e8"); mid.Status != execution.StatusPartiallyFilled {
		t.Fatalf("status after a partial fill = %s, want PARTIALLY_FILLED", mid.Status)
	}

	// Fill-ingestion seam (sync service): the remainder of the order filled at
	// the venue, so the child row is advanced to its terminal fill.
	c := rows[0]
	c.FilledQuantity = "0.02"
	c.Status = execution.ChildFilled
	if err := h.store.SaveChildOrder(ctx, c); err != nil {
		t.Fatal(err)
	}
	h.tick() // the worker now sees done == planned and completes
	after, _ := h.store.Execution("e8")
	if after.Status != execution.StatusFilled {
		t.Fatalf("final status = %s, want FILLED once the fill is ingested", after.Status)
	}
}

// ---------------------------------------------------------------------------
// Phase 10 — pause/resume: the worker never drives a paused execution
// ---------------------------------------------------------------------------

// TestPaperPauseResume rests a limit child, pauses the execution, and proves the
// worker does NOT drive a PAUSED execution (no events, no placement, status
// unchanged); after the API resumes it (PAUSED → RUNNING) the worker drives
// again without forking a duplicate child.
func TestPaperPauseResume(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", nil)
	rec := execRec("e9", execution.StrategyLimit, "0.01",
		execution.EntryDefinition{Kind: "limit", Price: "90000"}, execution.ExecutionConfig{})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.StartExecution(ctx, "e9"); err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	h.tick() // recovery
	h.tick() // place the resting limit
	if rows := h.children(t, "e9"); len(rows) != 1 {
		t.Fatalf("children = %d, want 1", len(rows))
	}

	// PAUSE: a paused execution must be seen but NOT driven.
	cur, _ := h.store.Execution("e9")
	cur.Status = execution.StatusPaused
	if err := h.store.SaveExecution(ctx, cur); err != nil {
		t.Fatal(err)
	}
	before := len(h.events())
	h.tick()
	if after := len(h.events()); after != before {
		t.Fatalf("a PAUSED execution was driven: %d new events", after-before)
	}
	if s, _ := h.store.Execution("e9"); s.Status != execution.StatusPaused {
		t.Fatalf("status changed while paused: %s", s.Status)
	}

	// RESUME (the API's PAUSED → RUNNING intent): the worker drives again, but
	// the resting child is adopted — no fork, no duplicate.
	cur2, _ := h.store.Execution("e9")
	cur2.Status = execution.StatusRunning
	if err := h.store.SaveExecution(ctx, cur2); err != nil {
		t.Fatal(err)
	}
	h.tick()
	if rows := h.children(t, "e9"); len(rows) != 1 {
		t.Fatalf("resume forked children: %d, want 1", len(rows))
	}
}

// ---------------------------------------------------------------------------
// Phase 10 — reconciliation mismatch: local state diverges from the venue
// ---------------------------------------------------------------------------

// TestPaperReconcileExternalMismatch exercises §94: an entry child recorded
// OPEN locally whose order has vanished from the venue (here, cancelled out of
// band) is marked UNKNOWN with an EXTERNAL_STATE_CHANGE event — the runtime never
// trusts local state over the venue, and it does not silently re-place.
func TestPaperReconcileExternalMismatch(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, "w1", nil)
	rec := execRec("e10", execution.StrategyLimit, "0.01",
		execution.EntryDefinition{Kind: "limit", Price: "90000"}, execution.ExecutionConfig{})
	if err := h.store.SaveExecution(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.w.StartExecution(ctx, "e10"); err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	h.tick() // recovery
	h.tick() // place the resting limit
	rows := h.children(t, "e10")
	if len(rows) != 1 || rows[0].Status != execution.ChildOpen || rows[0].ExchangeOrderID == nil {
		t.Fatalf("want one OPEN child with a venue id, got %+v", rows)
	}
	// The order disappears from the venue between passes (cancelled/filled by
	// someone else — a reconcile mismatch).
	if _, err := h.venue.CancelOrder(ctx, "BTC/USDT", *rows[0].ExchangeOrderID); err != nil {
		t.Fatalf("external cancel: %v", err)
	}
	h.tick()
	after := h.children(t, "e10")
	if len(after) != 1 {
		t.Fatalf("children = %d, want 1", len(after))
	}
	if after[0].Status != execution.ChildUnknown {
		t.Fatalf("mismatched child status = %s, want UNKNOWN", after[0].Status)
	}
	if !hasEvent(h.events(), execution.EventExternalStateChange) {
		t.Fatal("a reconcile mismatch must emit EXTERNAL_STATE_CHANGE")
	}
}

// ---------------------------------------------------------------------------
// §127.1 — plan + risk-based sizing (create → size)
// ---------------------------------------------------------------------------

// TestPaperPlanRiskSizing exercises the deterministic planner the executor
// creates an execution from: a $40 risk budget at 100,000 with a 98,000 stop
// sizes ~0.02 BTC and never exceeds the budget.
func TestPaperPlanRiskSizing(t *testing.T) {
	sp := func(v string) *string { return &v }
	instr := risk.InstrumentMetadata{
		Symbol: "BTC/USDT", MarketType: execution.MarketLinearPerp, Exchange: execution.ExchangeBinance,
		BaseAsset: "BTC", QuoteAsset: "USDT", SettlementAsset: "USDT",
		TickSize: "0.01", StepSize: "0.0001", MinQuantity: sp("0.0001"), MinNotional: sp("5"),
		ContractMultiplier: "1", MaxLeverage: sp("125"), MaintenanceMarginRate: sp("0.004"),
	}
	bals := risk.BalanceSnapshot{
		FuturesAvailable: sp("4800"), FuturesEquity: sp("5000"), TotalExchangeEquity: sp("5000"),
	}
	profile := execution.RiskProfile{
		DefaultRiskMode: "risk_usd", DefaultRisk: "40", MaxRiskPerTradePct: "2",
		MaxOpenRiskPct: "5", MaxDailyLossPct: "5", MaxLeverage: "10",
		DefaultMarginMode: execution.MarginIsolated, DefaultExecutionUrgency: execution.UrgencyBalanced,
	}
	res, err := planner.PlanExecution(planner.PlanInputs{
		Request: planner.ExecutionRequest{
			AccountID: "acct1", Symbol: "BTC/USDT", MarketType: execution.MarketLinearPerp,
			Side: execution.SideBuy, Intent: execution.IntentOpen,
			Entry:       execution.EntryDefinition{Kind: "market"},
			StopLoss:    &execution.PriceDefinition{Kind: "stop", Price: "98000"},
			TakeProfits: []execution.TakeProfitLevel{{Price: "106000"}},
			Sizing:      execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "40"},
			Leverage:    &sizing.LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"},
			Execution:   planner.ExecutionSpec{Type: execution.StrategyMarket},
		},
		Market: &planner.MarketSnapshot{
			Symbol: "BTC/USDT", Bid: sp("99999"), Ask: sp("100001"),
			Mid: "100000", Last: "100000", Timestamp: baseMs,
		},
		Exchange:      execution.ExchangeBinance,
		Instrument:    instr,
		FeeModel:      risk.FeeModel{MakerBps: "0", TakerBps: "0"},
		SlippageModel: risk.SlippageModel{SlippageBps: "0", SafetyReservePct: "0"},
		Balances:      &bals,
		RiskProfile:   &profile,
	})
	if err != nil {
		t.Fatalf("PlanExecution: %v", err)
	}
	gtZero(t, res.Quantity, "planned quantity")
	if res.Risk.EstimatedTotalRisk == nil {
		t.Fatal("risk budget present ⇒ estimated total risk must be reported, not nil")
	}
	leDec(t, *res.Risk.EstimatedTotalRisk, "40", "estimated total risk")
}
