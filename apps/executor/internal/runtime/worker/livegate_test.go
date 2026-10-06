package worker

import (
	"context"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
)

// liveRec is runningRec in LIVE mode — the shape the §108 kill switch governs.
func liveRec() execution.ExecutionRecord {
	rec := runningRec()
	rec.Mode = execution.ModeLive
	return rec
}

// §108 parity with the TS worker's liveBlocked(): a LIVE execution whose kill
// switch (FUDCOURT_EXECUTOR_LIVE == "1" ⇒ Config.LiveEnabled) is off must be
// PAUSED with an explanatory event and MUST NOT reach the venue. The recovery
// pass runs first, so the gate is proven on the placement pass.
func TestLiveKillSwitchPausesInsteadOfPlacing(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveExecution(context.Background(), liveRec()); err != nil {
		t.Fatal(err)
	}
	ex := newFakeExchange()
	lock := &fakeLock{acquire: true, renew: true}
	w := newTestWorker(t, store, lock, ex, 2) // LiveEnabled defaults false

	w.Tick(context.Background()) // pass 1: recovery (places nothing regardless)
	if ex.createCount() != 0 {
		t.Fatalf("recovery pass placed %d orders, want 0", ex.createCount())
	}
	w.Tick(context.Background()) // pass 2: the strategy would place — the gate must refuse
	if got := ex.createCount(); got != 0 {
		t.Fatalf("kill switch off placed %d live orders, want 0", got)
	}
	rec, ok := store.Execution(liveRec().ID)
	if !ok {
		t.Fatal("execution row vanished")
	}
	if rec.Status != execution.StatusPaused {
		t.Fatalf("status = %s, want PAUSED", rec.Status)
	}
	if !hasEvent(store, execution.EventExecutionPaused) {
		t.Fatalf("missing EXECUTION_PAUSED event; got %v", eventNames(store))
	}
	ev, _ := findEvent(store, execution.EventExecutionPaused)
	if reason, _ := ev.Payload["reason"].(string); reason == "" {
		t.Fatalf("EXECUTION_PAUSED carries no reason: %#v", ev.Payload)
	}
}

// With the kill switch ON (LiveEnabled true) a LIVE execution places normally —
// the gate must not block legitimate live trading once the operator arms it.
func TestLiveEnabledPlaces(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveExecution(context.Background(), liveRec()); err != nil {
		t.Fatal(err)
	}
	ex := newFakeExchange()
	lock := &fakeLock{acquire: true, renew: true}
	w := newTestWorker(t, store, lock, ex, 2, func(c *Config) { c.LiveEnabled = true })

	w.Tick(context.Background()) // recovery
	w.Tick(context.Background()) // placement — allowed
	if got := ex.createCount(); got != 1 {
		t.Fatalf("live-enabled placement created %d orders, want 1", got)
	}
	if hasEvent(store, execution.EventExecutionPaused) {
		t.Fatal("live-enabled pass must not pause")
	}
}

// The kill switch governs LIVE only. A PAPER execution places with the switch
// off (it never reaches a real venue), so the gate cannot break paper mode.
func TestKillSwitchDoesNotBlockPaper(t *testing.T) {
	store := NewMemoryStore()
	rec := runningRec()
	rec.Mode = execution.ModePaper
	if err := store.SaveExecution(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	ex := newFakeExchange()
	lock := &fakeLock{acquire: true, renew: true}
	w := newTestWorker(t, store, lock, ex, 2) // LiveEnabled false

	w.Tick(context.Background()) // recovery
	w.Tick(context.Background()) // placement — paper is unaffected
	if got := ex.createCount(); got != 1 {
		t.Fatalf("paper placement created %d orders, want 1", got)
	}
	if hasEvent(store, execution.EventExecutionPaused) {
		t.Fatal("paper must never be paused by the live kill switch")
	}
}

// A pause is refused (no rewrite) when the execution has already left a
// pausable state — the gate must not corrupt terminal history.
func TestLiveKillSwitchLeavesTerminalUntouched(t *testing.T) {
	store := NewMemoryStore()
	rec := liveRec()
	rec.Status = execution.StatusFilled
	if err := store.SaveExecution(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	ex := newFakeExchange()
	lock := &fakeLock{acquire: true, renew: true}
	w := newTestWorker(t, store, lock, ex, 2)

	w.Tick(context.Background())
	w.Tick(context.Background())
	if got, _ := store.Execution(rec.ID); got.Status != execution.StatusFilled {
		t.Fatalf("terminal status rewrote to %s, want FILLED", got.Status)
	}
	if ex.createCount() != 0 {
		t.Fatalf("terminal execution placed %d orders, want 0", ex.createCount())
	}
}
