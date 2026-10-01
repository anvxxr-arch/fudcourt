package orders

import (
	"fmt"
	"sync"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/decimal"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/executor"
)

const step = "0.001"

func track(t *testing.T, l *Ledger, id, qty, filled string, isExit bool, status executor.ChildOrderStatus) {
	t.Helper()
	l.Track(Child{ClientOrderID: id, Quantity: qty, FilledQuantity: filled, IsExit: isExit, Status: status})
}

// PRD §107 / engine-tests.ts "Σ planned entry quantities never exceeds the
// target, across fills": a double-submit cannot exceed planned — the second
// child is clamped to the room the first one has not used, and Clamped=true
// tells the caller to emit PLAN_RESIZED.
func TestClampChildDoubleSubmitCannotExceedPlanned(t *testing.T) {
	l := NewLedger()
	first, err := ClampChild(Request{ClientOrderID: "fud_e1_0", Quantity: "0.008", StepSize: step}, l, "0.01")
	if err != nil {
		t.Fatal(err)
	}
	if first.Quantity != "0.008" || first.Clamped {
		t.Fatalf("first child = %+v, want full 0.008 unclamped", first)
	}
	track(t, l, "fud_e1_0", "0.008", "0", false, executor.ChildOpen)

	second, err := ClampChild(Request{ClientOrderID: "fud_e1_1", Quantity: "0.008", StepSize: step}, l, "0.01")
	if err != nil {
		t.Fatal(err)
	}
	if second.Quantity != "0.002" {
		t.Fatalf("second child = %s, want the 0.002 room", second.Quantity)
	}
	if !second.Clamped {
		t.Fatal("a shrunk clamp must report Clamped=true (PLAN_RESIZED)")
	}
	track(t, l, "fud_e1_1", "0.002", "0", false, executor.ChildOpen)

	third, err := ClampChild(Request{ClientOrderID: "fud_e1_2", Quantity: "0.002", StepSize: step}, l, "0.01")
	if err != nil {
		t.Fatal(err)
	}
	if third.Quantity != "0" || !third.Clamped {
		t.Fatalf("third child = %+v, want zero room refused with Clamped=true", third)
	}
}

// PRD §107 "freed room after a rejected child": a REJECTED/CANCELLED/EXPIRED
// child releases its room for a later placement.
func TestClampChildFreedRoomAfterRejected(t *testing.T) {
	for _, dead := range []executor.ChildOrderStatus{
		executor.ChildRejected, executor.ChildCancelled, executor.ChildExpired,
	} {
		t.Run(string(dead), func(t *testing.T) {
			l := NewLedger()
			track(t, l, "fud_e1_0", "0.01", "0", false, dead)
			// The dead child used to occupy the whole plan; its room is free now.
			got, err := ClampChild(Request{ClientOrderID: "fud_e1_1", Quantity: "0.01", StepSize: step}, l, "0.01")
			if err != nil {
				t.Fatal(err)
			}
			if got.Quantity != "0.01" || got.Clamped {
				t.Fatalf("after %s: %+v, want full room restored", dead, got)
			}
		})
	}
}

// A partially filled child that is then CANCELLED/REJECTED releases exactly its
// unfilled remainder: filled stays consumed (real exposure), the working room
// returns. While it is still working, its remainder HOLDS the room (§107).
func TestClampChildPartialFillShrinksRoom(t *testing.T) {
	l := NewLedger()
	track(t, l, "fud_e1_0", "0.01", "0.004", false, executor.ChildPartial)
	// Still working: the unfilled 0.006 keeps the room — no double exposure.
	got, err := ClampChild(Request{ClientOrderID: "fud_e1_1", Quantity: "0.01", StepSize: step}, l, "0.01")
	if err != nil {
		t.Fatal(err)
	}
	if got.Quantity != "0" {
		t.Fatalf("working remainder must hold room: got %s, want 0", got.Quantity)
	}
	// The leg dies partially filled: room = planned − filled = 0.006.
	track(t, l, "fud_e1_0", "0.01", "0.004", false, executor.ChildCancelled)
	got2, err := ClampChild(Request{ClientOrderID: "fud_e1_2", Quantity: "0.01", StepSize: step}, l, "0.01")
	if err != nil {
		t.Fatal(err)
	}
	if got2.Quantity != "0.006" {
		t.Fatalf("after partial-cancel: got %s, want 0.006 (planned 0.01 − filled 0.004)", got2.Quantity)
	}
}

// PRD §40 "exits exempt": an exit/reduce child is NOT bounded by entry room —
// it covers the FULL planned entry while entry children still work — but is
// still floored to the grid. ReduceOnly/Intent close|reduce/IsExit all qualify.
func TestClampChildExitsExempt(t *testing.T) {
	l := NewLedger()
	// The entry side is completely full: 0.01 planned, 0.01 working.
	track(t, l, "fud_e1_0", "0.01", "0", false, executor.ChildOpen)
	for _, tc := range []struct {
		name string
		req  Request
	}{
		{"isExit", Request{IsExit: true, Intent: executor.IntentOpen}},
		{"reduceOnly", Request{ReduceOnly: true, Intent: executor.IntentOpen}},
		{"intent close", Request{Intent: executor.IntentClose}},
		{"intent reduce", Request{Intent: executor.IntentReduce}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := tc.req
			req.ClientOrderID = "fud_e1_900"
			req.Quantity = "0.01"
			req.StepSize = step
			got, err := ClampChild(req, l, "0.01")
			if err != nil {
				t.Fatal(err)
			}
			if got.Quantity != "0.01" {
				t.Fatalf("exit got %s, want the full planned 0.01 (PRD §40)", got.Quantity)
			}
			if got.Clamped {
				t.Fatal("an untrimmed exit must not report Clamped")
			}
		})
	}
	// ...and an exit is still floored to the grid (PRD §71), never rounded up.
	got, err := ClampChild(Request{ClientOrderID: "fud_e1_901", Quantity: "0.0109", StepSize: step, IsExit: true}, l, "0.01")
	if err != nil {
		t.Fatal(err)
	}
	if got.Quantity != "0.01" || !got.Clamped {
		t.Fatalf("exit grid floor = %+v, want 0.01 + Clamped", got)
	}
}

// Rounding never rounds UP into extra exposure (PRD §71): a room that falls
// between grid points is floored, and the request too.
func TestClampChildFloorsToGrid(t *testing.T) {
	// Scenario A: the request is smaller than the floored room — request wins.
	l := NewLedger()
	track(t, l, "fud_e1_0", "0.0025", "0", false, executor.ChildOpen)
	got, err := ClampChild(Request{ClientOrderID: "fud_e1_1", Quantity: "0.005", StepSize: step}, l, "0.01")
	if err != nil {
		t.Fatal(err)
	}
	// room = 0.01 − 0.0025 = 0.0075 → floored to 0.007, and request 0.005 wins.
	if got.Quantity != "0.005" {
		t.Fatalf("got %s, want 0.005", got.Quantity)
	}
	// Scenario B: the request exceeds the floored room — room floor wins.
	l2 := NewLedger()
	track(t, l2, "fud_e1_0", "0.0025", "0", false, executor.ChildOpen)
	got2, err := ClampChild(Request{ClientOrderID: "fud_e1_2", Quantity: "0.0099", StepSize: step}, l2, "0.01")
	if err != nil {
		t.Fatal(err)
	}
	if got2.Quantity != "0.007" {
		t.Fatalf("got %s, want 0.007 (room floored DOWN, never up)", got2.Quantity)
	}
	if !got2.Clamped {
		t.Fatal("floored room must report Clamped=true")
	}
}

// A malformed quantity or step is refused, never guessed.
func TestClampChildRefusesGarbage(t *testing.T) {
	l := NewLedger()
	if _, err := ClampChild(Request{ClientOrderID: "x", Quantity: "abc", StepSize: step}, l, "0.01"); err == nil {
		t.Fatal("garbage quantity must be refused")
	}
	if _, err := ClampChild(Request{ClientOrderID: "x", Quantity: "0.01", StepSize: "0"}, l, "0.01"); err == nil {
		t.Fatal("non-positive step must be refused")
	}
	if _, err := ClampChild(Request{ClientOrderID: "x", Quantity: "0.01", StepSize: step}, l, "not-a-decimal"); err == nil {
		t.Fatal("garbage planned must be refused")
	}
}

// Ledger ops are concurrency-safe: N goroutines clamping and recording with NO
// external synchronization can never collectively exceed the plan — the clamp
// claims its result atomically, so each claim is visible to the next caller.
// Concurrent readers must not race or deadlock with claimants.
func TestLedgerConcurrentSafety(t *testing.T) {
	l := NewLedger()
	const n = 32
	var wg sync.WaitGroup
	results := make([]Result, n)
	for i := range n {
		wg.Add(2)
		id := "fud_e1_" + fmt.Sprint(i)
		go func() {
			defer wg.Done()
			got, err := ClampChild(Request{ClientOrderID: id, Quantity: "0.01", StepSize: step}, l, "0.01")
			if err != nil {
				t.Error(err)
				return
			}
			l.Track(Child{ClientOrderID: id, Quantity: got.Quantity, FilledQuantity: "0", Status: executor.ChildOpen})
			results[i] = got
		}()
		go func() {
			defer wg.Done()
			if _, err := l.OpenRemaining(false); err != nil {
				t.Error(err)
			}
			_ = l.Children()
		}()
	}
	wg.Wait()
	total := "0"
	for _, r := range results {
		var err error
		total, err = decimal.Add(total, r.Quantity)
		if err != nil {
			t.Fatalf("sum: %v", err)
		}
	}
	if c, _ := decimal.Cmp(total, "0.01"); c > 0 {
		t.Fatalf("Σ clamped = %s exceeds planned 0.01", total)
	}
}
