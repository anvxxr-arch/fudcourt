package strategy

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/decimal"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/executor"
)

// baseRec is the minimal execution record every vector mutates.
func baseRec(s executor.ExecutionStrategy) executor.ExecutionRecord {
	return executor.ExecutionRecord{
		ID:                "e1",
		Symbol:            "BTC/USDT",
		Side:              executor.SideBuy,
		Intent:            executor.IntentOpen,
		Status:            executor.StatusRunning,
		ExecutionStrategy: s,
		PlannedQuantity:   "1",
	}
}

// tickStrategy runs one Step and asserts the PRD §114 contract: a recovery pass
// (PlacementEnabled=false) never emits a placement.
func tickStrategy(t *testing.T, strat Strategy, st State, ctx StrategyContext) (State, []Action) {
	t.Helper()
	newState, actions := strat.Step(st, ctx)
	if !ctx.PlacementEnabled {
		for _, a := range actions {
			if a.Kind == ActionSubmit {
				t.Fatalf("PlacementEnabled=false emitted a placement: %+v", a)
			}
		}
	}
	return newState, actions
}

func submits(actions []Action) []executor.OrderRequest {
	out := []executor.OrderRequest{}
	for _, a := range actions {
		if a.Kind == ActionSubmit {
			out = append(out, a.Order)
		}
	}
	return out
}

func hasComplete(actions []Action) bool {
	for _, a := range actions {
		if a.Kind == ActionComplete {
			return true
		}
	}
	return false
}

func filledFrom(open []executor.NormalizedOrder) string {
	sum := "0"
	for _, o := range open {
		sum, _ = decimal.Add(sum, o.FilledQuantity)
	}
	return sum
}

func fq(s string) *string { return &s }

// engine-tests.ts: market emits ONE immediate child for the whole plan and
// nothing else while it works.
func TestMarketSingleChild(t *testing.T) {
	strat, st, err := New(baseRec(executor.StrategyMarket), 0)
	if err != nil {
		t.Fatal(err)
	}
	st, actions := tickStrategy(t, strat, st, StrategyContext{Now: 1000, FilledQuantity: "0", PlacementEnabled: true})
	orders := submits(actions)
	if len(orders) != 1 {
		t.Fatalf("got %d submits, want 1", len(orders))
	}
	o := orders[0]
	if o.ClientOrderID != "fud_e1_0" || o.Quantity != "1" || o.OrderType != "market" {
		t.Fatalf("child = %+v, want fud_e1_0 market 1", o)
	}
	// The child still works at the venue: nothing new is placed.
	_, actions = tickStrategy(t, strat, st, StrategyContext{
		Now: 2000, FilledQuantity: "0", PlacementEnabled: true,
		OpenOrders: []executor.NormalizedOrder{{
			ClientOrderID: "fud_e1_0", Quantity: "1", FilledQuantity: "0", Status: executor.ChildOpen,
		}},
	})
	if len(submits(actions)) != 0 {
		t.Fatalf("working child must block re-placement, got %+v", submits(actions))
	}
}

// engine-tests.ts §107: "a leg the venue never acknowledged frees the room on a
// later tick" — the room returns and a NEW deterministic id is minted (the
// sequence only ever increases, PRD §66).
func TestMarketPhantomFreesRoomOnLaterTick(t *testing.T) {
	strat, st, err := New(baseRec(executor.StrategyMarket), 0)
	if err != nil {
		t.Fatal(err)
	}
	st, actions := tickStrategy(t, strat, st, StrategyContext{Now: 1000, FilledQuantity: "0", PlacementEnabled: true})
	if len(submits(actions)) != 1 {
		t.Fatalf("first tick: %d submits", len(submits(actions)))
	}
	st, actions = tickStrategy(t, strat, st, StrategyContext{Now: 2000, FilledQuantity: "0", PlacementEnabled: true})
	orders := submits(actions)
	if len(orders) != 1 || orders[0].ClientOrderID != "fud_e1_1" {
		t.Fatalf("phantom re-place = %+v, want fud_e1_1", orders)
	}
	if orders[0].Quantity != "1" {
		t.Fatalf("freed room must restore the plan, got %s", orders[0].Quantity)
	}
}

// engine-tests.ts: limit emits ONE pegged child at the entry price.
func TestLimitPeggedSingleChild(t *testing.T) {
	rec := baseRec(executor.StrategyLimit)
	rec.EntryDefinition = executor.EntryDefinition{Kind: "limit", Price: "123.45"}
	strat, st, err := New(rec, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, actions := tickStrategy(t, strat, st, StrategyContext{Now: 1000, FilledQuantity: "0", PlacementEnabled: true})
	orders := submits(actions)
	if len(orders) != 1 {
		t.Fatalf("got %d submits, want 1", len(orders))
	}
	o := orders[0]
	if o.OrderType != "limit" || o.Price != "123.45" || o.Quantity != "1" {
		t.Fatalf("child = %+v, want limit 123.45 x 1", o)
	}
}

// A limit strategy with no price is refused, never silently downgraded.
func TestLimitNeedsPrice(t *testing.T) {
	if _, _, err := New(baseRec(executor.StrategyLimit), 0); !errors.Is(err, ErrInvalidStrategy) {
		t.Fatalf("err = %v, want ErrInvalidStrategy", err)
	}
}

// engine-tests.ts TWAP: without jitter config the schedule is the NAIVE equal
// slicing over DurationMs (DR-021 §2g: jitter is never silent), one due slice
// per tick.
func TestTwapNaiveEqualSlices(t *testing.T) {
	rec := baseRec(executor.StrategyTWAP)
	rec.ExecutionConfig = executor.ExecutionConfig{DurationMs: 400_000, Twap: &executor.TwapConfig{Slices: 4}}
	strat, st, err := New(rec, 0)
	if err != nil {
		t.Fatal(err)
	}
	stt := st.(*StrategyState)
	if len(stt.Slices) != 4 {
		t.Fatalf("planned %d slices, want 4", len(stt.Slices))
	}
	var prev int64
	for i, sl := range stt.Slices {
		if sl.Quantity != "0.25" {
			t.Fatalf("naive slice %d = %s, want the even 0.25", i, sl.Quantity)
		}
		if sl.AtOffsetMs != int64(i)*100_000 {
			t.Fatalf("naive slice %d offset = %d, want %d", i, sl.AtOffsetMs, i*100_000)
		}
		prev = sl.AtOffsetMs
	}
	_ = prev
	// StartedAt stamps at the first Step (1000): slice 0 is immediate.
	st, actions := tickStrategy(t, strat, st, StrategyContext{Now: 1000, FilledQuantity: "0", PlacementEnabled: true})
	orders := submits(actions)
	if len(orders) != 1 || orders[0].Quantity != "0.25" {
		t.Fatalf("tick 0 = %+v, want one 0.25 slice", orders)
	}
	// Slice 1 is due at 1000+100_000: before that, nothing.
	_, actions = tickStrategy(t, strat, st, StrategyContext{Now: 99_000, FilledQuantity: "0.25", PlacementEnabled: true})
	if len(submits(actions)) != 0 {
		t.Fatalf("not due yet must place nothing, got %+v", submits(actions))
	}
	_, actions = tickStrategy(t, strat, st, StrategyContext{Now: 101_000, FilledQuantity: "0.25", PlacementEnabled: true})
	orders = submits(actions)
	if len(orders) != 1 || orders[0].Quantity != "0.25" {
		t.Fatalf("tick 1 = %+v, want the due 0.25 slice", orders)
	}
}

// TWAP invariants: Σ slice quantities == Planned exactly and offsets stay on
// schedule — jitter or not (the over-order clamp upstream depends on it).
func TestTwapSlicesSumToPlanned(t *testing.T) {
	for _, tc := range []struct {
		name string
		twap *executor.TwapConfig
	}{
		{"naive", &executor.TwapConfig{Slices: 4}},
		{"jittered", &executor.TwapConfig{Slices: 4, QuantityJitterBps: 2000, IntervalJitterBps: 2000}},
		{"default count", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := baseRec(executor.StrategyTWAP)
			rec.ExecutionConfig = executor.ExecutionConfig{DurationMs: 400_000, Twap: tc.twap}
			_, st, err := New(rec, 0)
			if err != nil {
				t.Fatal(err)
			}
			total := "0"
			var prev int64
			for i, sl := range st.(*StrategyState).Slices {
				if c, _ := decimal.Cmp(sl.Quantity, "0"); c <= 0 {
					t.Fatalf("slice %d quantity %q must be positive", i, sl.Quantity)
				}
				if sl.AtOffsetMs < prev || sl.AtOffsetMs > rec.ExecutionConfig.DurationMs {
					t.Fatalf("slice %d offset %d out of schedule", i, sl.AtOffsetMs)
				}
				prev = sl.AtOffsetMs
				total, err = decimal.Add(total, sl.Quantity)
				if err != nil {
					t.Fatal(err)
				}
			}
			if c, _ := decimal.Cmp(total, "1"); c != 0 {
				t.Fatalf("Σ slices = %s, want exactly the planned 1", total)
			}
		})
	}
}

// DR-021 §2g: jitter exists ONLY when TwapConfig opts in, and it is a seeded
// PRNG — the same seed reproduces the same jittered schedule exactly (PRD §28)
// and really does deviate from the naive one.
func TestTwapJitterOptInAndDeterministic(t *testing.T) {
	rec := baseRec(executor.StrategyTWAP)
	rec.ExecutionConfig = executor.ExecutionConfig{DurationMs: 400_000,
		Twap: &executor.TwapConfig{Slices: 4, QuantityJitterBps: 2000, IntervalJitterBps: 2000}}
	schedule := func() *StrategyState {
		_, st, err := New(rec, 0) // seed 0 → DefaultSeed, always
		if err != nil {
			t.Fatal(err)
		}
		return st.(*StrategyState)
	}
	a, b := schedule(), schedule()
	deviates := false
	for i := range a.Slices {
		if a.Slices[i] != b.Slices[i] {
			t.Fatalf("same seed must reproduce slice %d: %+v vs %+v", i, a.Slices[i], b.Slices[i])
		}
		if a.Slices[i].Quantity != "0.25" || a.Slices[i].AtOffsetMs != int64(i)*100_000 {
			deviates = true
		}
	}
	if !deviates {
		t.Fatal("opt-in jitter must actually perturb the naive schedule (never silent)")
	}
}

// engine-tests.ts iceberg: only the display quantity shows at a time; each next
// child appears only once the previous is gone (1 / 0.2 = 5 children).
func TestIcebergDisplaySlicing(t *testing.T) {
	rec := baseRec(executor.StrategyIceberg)
	rec.EntryDefinition = executor.EntryDefinition{Kind: "limit", Price: "100"}
	rec.ExecutionConfig = executor.ExecutionConfig{DisplayQty: "0.2"}
	strat, st, err := New(rec, 0)
	if err != nil {
		t.Fatal(err)
	}
	venue := []executor.NormalizedOrder{}
	now, placed := int64(1000), 0
	for {
		var actions []Action
		st, actions = tickStrategy(t, strat, st, StrategyContext{
			Now: now, OpenOrders: venue, FilledQuantity: filledFrom(venue), PlacementEnabled: true,
		})
		if hasComplete(actions) {
			break
		}
		orders := submits(actions)
		if len(orders) != 1 {
			t.Fatalf("tick %d: want exactly one display child, got %+v", placed, orders)
		}
		if orders[0].Quantity != "0.2" {
			t.Fatalf("display child = %s, want 0.2", orders[0].Quantity)
		}
		placed++
		// The child fills at the venue before the next one appears.
		venue = append(venue, executor.NormalizedOrder{
			ClientOrderID: orders[0].ClientOrderID, Quantity: "0.2",
			FilledQuantity: "0.2", Status: executor.ChildFilled,
		})
		now += 1000
		if placed > 10 {
			t.Fatal("iceberg never completed")
		}
	}
	if placed != 5 {
		t.Fatalf("planned 5 display children of 0.2, drove %d", placed)
	}
}

// engine-tests.ts scale ladder: one marketable level per tick, sized
// planned×fraction; scale_out children are reduce-only exits and the execution
// completes on its OWN exit fills, never the entry side (PRD §40).
func TestScaleLadder(t *testing.T) {
	rec := baseRec(executor.StrategyScaleOut)
	rec.Intent = executor.IntentClose
	rec.Side = executor.SideSell
	rec.ExecutionConfig = executor.ExecutionConfig{ScaleLevels: []executor.ScaleLevel{
		{Price: "100", Fraction: "0.5"},
		{Price: "101", Fraction: "0.5"},
	}}
	strat, st, err := New(rec, 0)
	if err != nil {
		t.Fatal(err)
	}
	bid, ask := fq("100.5"), fq("100.6")
	tick := StrategyContext{
		Now: 1000, PlacementEnabled: true, OpenPositionQuantity: "1",
		Ticker: executor.Ticker{Symbol: rec.Symbol, Bid: bid, Ask: ask, Ts: 1000},
	}
	// Level 1 (sell ≤ 100.5) is marketable now; level 2 (101) is not.
	_, actions := tickStrategy(t, strat, st, tick)
	orders := submits(actions)
	if len(orders) != 1 {
		t.Fatalf("tick 1 = %+v, want one level child", orders)
	}
	o := orders[0]
	if o.Quantity != "0.5" || !o.ReduceOnly || o.Intent != executor.IntentReduce {
		t.Fatalf("level child = %+v, want reduce-only 0.5", o)
	}
	// Level 2 is not marketable yet: nothing placed.
	tick.Now = 2000
	_, actions = tickStrategy(t, strat, st, tick)
	if len(submits(actions)) != 0 {
		t.Fatalf("unmarketable level must wait, got %+v", submits(actions))
	}
	// Level 1 fills at the venue and the market rises: level 2 fires.
	tick.Now = 3000
	tick.Ticker.Bid = fq("102")
	tick.OpenOrders = []executor.NormalizedOrder{{
		ClientOrderID: "fud_e1_0", Quantity: "0.5", FilledQuantity: "0.5",
		Status: executor.ChildFilled, IsExit: true,
	}}
	tick.OpenPositionQuantity = "0.5"
	_, actions = tickStrategy(t, strat, st, tick)
	orders = submits(actions)
	if len(orders) != 1 || orders[0].Quantity != "0.5" {
		t.Fatalf("level 2 = %+v, want 0.5", orders)
	}
	// Both exits fill (0.5 + 0.5 = planned): the execution completes — even with
	// ENTRY fills reported as zero, which must never drive a close.
	tick.Now = 4000
	tick.OpenOrders = []executor.NormalizedOrder{
		{ClientOrderID: "fud_e1_0", Quantity: "0.5", FilledQuantity: "0.5", Status: executor.ChildFilled, IsExit: true},
		{ClientOrderID: "fud_e1_1", Quantity: "0.5", FilledQuantity: "0.5", Status: executor.ChildFilled, IsExit: true},
	}
	tick.OpenPositionQuantity = "0"
	_, actions = tickStrategy(t, strat, st, tick)
	if !hasComplete(actions) {
		t.Fatalf("filled ladder must complete on its own fills, got %+v", actions)
	}
}

// A ladder whose fractions do not cover the plan is refused at construction
// (PRD §33): never half-executed.
func TestScaleFractionsMustSumTo1(t *testing.T) {
	rec := baseRec(executor.StrategyScaleIn)
	rec.ExecutionConfig = executor.ExecutionConfig{ScaleLevels: []executor.ScaleLevel{
		{Price: "100", Fraction: "0.3"},
	}}
	if _, _, err := New(rec, 0); !errors.Is(err, ErrInvalidStrategy) {
		t.Fatalf("err = %v, want ErrInvalidStrategy", err)
	}
}

// PRD §114: a recovery pass (PlacementEnabled=false) produces ZERO placements
// for EVERY strategy while staying resumable for a later permitted tick.
func TestRecoveryPassPlacesNothing(t *testing.T) {
	for _, rec := range []executor.ExecutionRecord{
		baseRec(executor.StrategyMarket),
		func() executor.ExecutionRecord {
			r := baseRec(executor.StrategyLimit)
			r.EntryDefinition = executor.EntryDefinition{Kind: "limit", Price: "100"}
			return r
		}(),
		func() executor.ExecutionRecord {
			r := baseRec(executor.StrategyTWAP)
			r.ExecutionConfig = executor.ExecutionConfig{DurationMs: 400_000,
				Twap: &executor.TwapConfig{Slices: 4}}
			return r
		}(),
		func() executor.ExecutionRecord {
			r := baseRec(executor.StrategyIceberg)
			r.EntryDefinition = executor.EntryDefinition{Kind: "limit", Price: "100"}
			r.ExecutionConfig = executor.ExecutionConfig{DisplayQty: "0.2"}
			return r
		}(),
		func() executor.ExecutionRecord {
			r := baseRec(executor.StrategyScaleIn)
			r.ExecutionConfig = executor.ExecutionConfig{ScaleLevels: []executor.ScaleLevel{
				{Price: "101", Fraction: "1"}, // marketable at the resumable tick (buy ≥ ask)
			}}
			return r
		}(),
	} {
		t.Run(string(rec.ExecutionStrategy), func(t *testing.T) {
			strat, st, err := New(rec, 0)
			if err != nil {
				t.Fatal(err)
			}
			bid, ask := fq("99"), fq("101")
			for now := int64(1000); now < 500_000; now += 50_000 {
				st, _ = tickStrategy(t, strat, st, StrategyContext{
					Now: now, PlacementEnabled: false,
					Ticker:               executor.Ticker{Symbol: rec.Symbol, Bid: bid, Ask: ask, Ts: now},
					OpenPositionQuantity: "1",
				})
			}
			// ...and resumable: the next permitted tick places again.
			_, actions := tickStrategy(t, strat, st, StrategyContext{
				Now: 600_000, PlacementEnabled: true,
				Ticker:               executor.Ticker{Symbol: rec.Symbol, Bid: bid, Ask: ask},
				OpenPositionQuantity: "1",
			})
			if len(submits(actions)) == 0 {
				t.Fatal("strategy must stay resumable after a recovery pass")
			}
		})
	}
}

// PRD §28/§66: identical inputs mint identical child ids — that is what lets a
// restarted worker ADOPT its own children instead of re-placing them.
func TestDeterministicChildIDs(t *testing.T) {
	rec := baseRec(executor.StrategyMarket)
	for i := range 2 {
		strat, st, err := New(rec, 0)
		if err != nil {
			t.Fatal(err)
		}
		_, actions := tickStrategy(t, strat, st, StrategyContext{Now: 1000, PlacementEnabled: true})
		orders := submits(actions)
		if len(orders) != 1 || orders[0].ClientOrderID != "fud_e1_0" {
			t.Fatalf("run %d minted %+v, want fud_e1_0", i, orders)
		}
	}
}

// State survives a restart as opaque JSON (PRD §130): the round-trip keeps the
// schedule, sequence and ledger intact.
func TestStateJSONRoundTrip(t *testing.T) {
	rec := baseRec(executor.StrategyTWAP)
	rec.ExecutionConfig = executor.ExecutionConfig{DurationMs: 400_000,
		Twap: &executor.TwapConfig{Slices: 3}}
	strat, st, err := New(rec, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Advance the state past a placement so the round-trip has something to lose.
	st, _ = tickStrategy(t, strat, st, StrategyContext{Now: 1000, PlacementEnabled: true})
	blob, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	var back StrategyState
	if err := json.Unmarshal(blob, &back); err != nil {
		t.Fatal(err)
	}
	if len(back.Slices) != 3 || back.Sequence != 1 || back.ExecutionID != "e1" || len(back.Children) != 1 {
		t.Fatalf("round-trip lost state: %+v", back)
	}
}

// engine-tests.ts §58 child-order lifecycle vectors (ported 1:1).
func TestTransitionChildOrderVectors(t *testing.T) {
	for _, tc := range []struct {
		name    string
		current executor.ChildOrderStatus
		event   ChildOrderEvent
		want    executor.ChildOrderStatus
		refused bool
	}{
		{"PLANNED+submit→SUBMITTING", executor.ChildPlanned, ChildEventSubmit, executor.ChildSubmitting, false},
		{"SUBMITTING+accept→OPEN", executor.ChildSubmitting, ChildEventAccept, executor.ChildOpen, false},
		{"OPEN+partial_fill→PARTIALLY_FILLED", executor.ChildOpen, ChildEventPartialFill, executor.ChildPartial, false},
		{"PARTIALLY_FILLED+fill→FILLED", executor.ChildPartial, ChildEventFill, executor.ChildFilled, false},
		{"OPEN+cancel_request→CANCELLING", executor.ChildOpen, ChildEventCancelReq, executor.ChildCancelling, false},
		{"CANCELLING+cancel→CANCELLED", executor.ChildCancelling, ChildEventCancel, executor.ChildCancelled, false},
		{"OPEN+reject→refused (reject is submit-time only)", executor.ChildOpen, ChildEventReject, "", true},
		{"OPEN+expire→EXPIRED", executor.ChildOpen, ChildEventExpire, executor.ChildExpired, false},
		{"FILLED+cancel refused", executor.ChildFilled, ChildEventCancel, "", true},
		{"CANCELLED+accept refused", executor.ChildCancelled, ChildEventAccept, "", true},
		{"UNKNOWN+fill refused", executor.ChildUnknown, ChildEventFill, "", true},
		{"PLANNED+fill refused", executor.ChildPlanned, ChildEventFill, "", true},
		{"unknown event refused", executor.ChildOpen, ChildOrderEvent("teleport"), "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := TransitionChildOrder(tc.current, tc.event)
			if tc.refused {
				if err == nil {
					t.Fatalf("Transition(%s, %s) = %s, want refusal", tc.current, tc.event, got)
				}
				if !errors.Is(err, ErrIllegalChildTransition) {
					t.Fatalf("err = %v, want ErrIllegalChildTransition", err)
				}
				// The error names the current status and the event (engine parity).
				if !strings.Contains(err.Error(), string(tc.current)) || !strings.Contains(err.Error(), string(tc.event)) {
					t.Fatalf("error must name both states: %q", err.Error())
				}
				if got != tc.current {
					t.Fatal("a refused transition must not move the state")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}
