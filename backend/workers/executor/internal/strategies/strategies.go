package strategies

import (
	"fmt"
	"math/big"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/runtime/idempotency"
)

// Child is one strategy-planned child order's footprint (the engine.ts ledger
// entry): it exists so the over-order room is never double-committed and so a
// child the venue never acknowledged releases its room on a later tick.
type Child struct {
	ClientOrderID string
	Quantity      string
	Filled        string
	IsExit        bool
	Live          bool
	CreatedAt     int64
}

// Slice is one TWAP slice: quantity at a millisecond offset from the start.
type Slice struct {
	Quantity   string
	AtOffsetMs int64
}

// StrategyState is the opaque strategy state (objective §8.15): JSON-round-
// trippable so a worker can persist it across restarts (PRD §130) and rebuilt
// identically from (ExecutionRecord, seed) so child ids are stable across
// restarts (PRD §66/§114). Implements State.
type StrategyState struct {
	Version     int
	ExecutionID string
	Strategy    execution.ExecutionStrategy
	Side        execution.Side
	Intent      execution.Intent
	Symbol      string
	OrderType   string // "market" | "limit"
	Planned     string // target quantity (exact decimal)
	Price       string // limit/peg price for limit, iceberg and scale strategies
	Display     string // iceberg display quantity; empty elsewhere
	PostOnly    bool
	// Sequence is the next ClientOrderID sequence (idempotency.ClientOrderID).
	// It only ever increases, so re-derived ids after a restart collide with —
	// and therefore adopt — this worker's own earlier children (PRD §66/§114).
	Sequence   int
	RngState   uint32
	StartedAt  int64 // stamped on the first Step (engine.ts semantics)
	Done       bool
	Filled     string // entry-side filled quantity known to the strategy
	ExitFilled string // this execution's OWN exit fills (a close never reads entry fills)
	Children   []Child
	Slices     []Slice // TWAP schedule (empty for other strategies)
	SliceIdx   int
	Levels     []execution.ScaleLevel // scale ladder
	LevelDone  []bool
	DurationMs int64
}

// isState marks StrategyState as the package's opaque state.
func (*StrategyState) isState() {}

// coreFor extracts the placement facts shared by every strategy from the
// execution record. Nothing exchange-specific is read here (objective §8.16).
func coreFor(rec execution.ExecutionRecord) StrategyState {
	return StrategyState{
		Version:     1,
		ExecutionID: rec.ID,
		Strategy:    rec.ExecutionStrategy,
		Side:        rec.Side,
		Intent:      rec.Intent,
		Symbol:      rec.Symbol,
		Planned:     rec.PlannedQuantity,
		Filled:      "0",
		ExitFilled:  "0",
	}
}

// initialState builds the deterministic initial state for one execution
// (PRD §28 reproducibility). The TWAP schedule is planned here — with the
// seeded PRNG — so identical inputs yield identical slices and identical first
// child ids.
func initialState(rec execution.ExecutionRecord, core StrategyState, seed uint32) (*StrategyState, error) {
	core.RngState = seed
	core.DurationMs = rec.ExecutionConfig.DurationMs
	core.PostOnly = rec.EntryDefinition.PostOnly
	switch rec.ExecutionStrategy {
	case execution.StrategyLimit:
		if rec.EntryDefinition.Price == "" {
			return nil, fmt.Errorf("%w: limit strategy needs an entry price", ErrInvalidStrategy)
		}
		core.OrderType = "limit"
		core.Price = rec.EntryDefinition.Price
	case execution.StrategyMarket:
		core.OrderType = "market"
	case execution.StrategyTWAP:
		core.OrderType = "limit" // slices rest at the touch; see touch()
		if core.DurationMs <= 0 {
			return nil, fmt.Errorf("%w: twap needs a positive durationMs", ErrInvalidStrategy)
		}
		slices, err := planSlices(&core, rec)
		if err != nil {
			return nil, err
		}
		core.Slices = slices
	case execution.StrategyIceberg:
		core.OrderType = "limit"
		if rec.EntryDefinition.Price == "" {
			return nil, fmt.Errorf("%w: iceberg needs an entry price", ErrInvalidStrategy)
		}
		core.Price = rec.EntryDefinition.Price
		d, err := decimal.Parse(rec.ExecutionConfig.DisplayQty)
		if err != nil || d.Sign() <= 0 {
			return nil, fmt.Errorf("%w: iceberg needs a positive display quantity", ErrInvalidStrategy)
		}
		core.Display = rec.ExecutionConfig.DisplayQty
	case execution.StrategyScaleIn, execution.StrategyScaleOut:
		core.OrderType = "limit"
		levels := rec.ExecutionConfig.ScaleLevels
		if len(levels) == 0 {
			return nil, fmt.Errorf("%w: scale strategy needs levels", ErrInvalidStrategy)
		}
		sum := "0"
		for _, l := range levels {
			if _, err := decimal.Parse(l.Price); err != nil {
				return nil, fmt.Errorf("%w: scale level price %q", ErrInvalidStrategy, l.Price)
			}
			if _, err := decimal.Parse(l.Fraction); err != nil {
				return nil, fmt.Errorf("%w: scale level fraction %q", ErrInvalidStrategy, l.Fraction)
			}
			var err error
			sum, err = decimal.Add(sum, l.Fraction)
			if err != nil {
				return nil, err
			}
		}
		// PRD §33: a ladder whose fractions do not cover the whole quantity is a
		// plan error — refused at construction, never half-executed.
		if c, err := decimal.Cmp(sum, "1"); err != nil || c != 0 {
			return nil, fmt.Errorf("%w: scale fractions sum to %s, not 1", ErrInvalidStrategy, sum)
		}
		core.Levels = levels
		core.LevelDone = make([]bool, len(levels))
	}
	return &core, nil
}

// mulberry32 is the deterministic PRNG (engine.ts prngNext): a plain uint32
// carried in the state — no closures, so the state stays JSON-serializable and
// every run reproduces exactly (PRD §28).
func mulberry32(state uint32) (uint32, float64) {
	t := state + 0x6d2b79f5
	t = (t ^ (t >> 15)) * (t | 1)
	t ^= t + ((t ^ (t >> 7)) * (t | 61))
	return t, float64(t^(t>>14)) / 4294967296
}

// planSlices builds the TWAP schedule (engine.ts planSlices): equal slices over
// DurationMs by default; jitter ONLY when TwapConfig opts in (DR-021 §2g).
//
// INVARIANT: Σ slice quantities == Planned exactly. The jittered quantities are
// NORMALIZED back to the target before flooring and the final slice absorbs the
// rounding residue — randomizing without normalizing would drift the total and
// breach §107. Offsets are monotonic and clamped to the duration; the first
// slice is immediate.
func planSlices(st *StrategyState, rec execution.ExecutionRecord) ([]Slice, error) {
	cfg := rec.ExecutionConfig.Twap
	count := DefaultSlices(st.DurationMs)
	if cfg != nil && cfg.Slices > 0 {
		count = cfg.Slices
	}
	qJit, iJit := 0.0, 0.0
	if cfg != nil {
		qJit = float64(cfg.QuantityJitterBps) / 10_000
		iJit = float64(cfg.IntervalJitterBps) / 10_000
	}
	target, err := decimal.Parse(st.Planned)
	if err != nil {
		return nil, fmt.Errorf("%w: planned quantity %q", ErrInvalidStrategy, st.Planned)
	}
	base := new(big.Rat).Quo(target, big.NewRat(int64(count), 1))
	interval := st.DurationMs / int64(count)
	raw := make([]*big.Rat, count)
	rawSum := new(big.Rat)
	for i := range count {
		raw[i] = new(big.Rat).Set(base)
		if qJit > 0 {
			var r float64
			st.RngState, r = mulberry32(st.RngState)
			raw[i] = new(big.Rat).Mul(raw[i], new(big.Rat).SetFloat64(1+(r*2-1)*qJit))
		}
		rawSum.Add(rawSum, raw[i])
	}
	norm := new(big.Rat)
	if rawSum.Sign() > 0 {
		norm.Quo(target, rawSum) // normalize so Σ slices == target exactly (§107)
	}
	out := make([]Slice, 0, count)
	placed := new(big.Rat)
	var previous int64
	for i := range count {
		var offset int64
		if i == 0 {
			offset = 0 // the first slice is immediate
		} else {
			offset = int64(i) * interval
			if iJit > 0 {
				var r float64
				st.RngState, r = mulberry32(st.RngState)
				offset = int64(float64(offset) * (1 + (r*2-1)*iJit))
			}
			if offset < previous {
				offset = previous // monotonic: jitter never reorders the schedule
			}
			if offset > st.DurationMs {
				offset = st.DurationMs // no slice lands past the duration
			}
		}
		previous = offset
		if i == count-1 {
			// The final slice absorbs the rounding residue so Σ == Planned exactly.
			out = append(out, Slice{Quantity: decimal.Trim(decimal.FloorToScale(new(big.Rat).Sub(target, placed), 8)), AtOffsetMs: offset})
			continue
		}
		q := decimal.Trim(decimal.FloorToScale(new(big.Rat).Mul(raw[i], norm), 8))
		qq, _ := decimal.Parse(q)
		placed.Add(placed, qq)
		out = append(out, Slice{Quantity: q, AtOffsetMs: offset})
	}
	return out, nil
}

// tracksExit reports whether this execution's children are exits: a scale_out
// or any close/reduce execution measures completion by its OWN fills (PRD §40:
// "scale_out never counts the entry side").
func tracksExit(st *StrategyState) bool {
	return st.Strategy == execution.StrategyScaleOut ||
		st.Intent == execution.IntentClose || st.Intent == execution.IntentReduce
}

// sync reconciles the strategy's own ledger with the venue view in ctx
// (engine.ts syncLedger): fills advance monotonically, and a child the venue
// has never acknowledged by a LATER tick releases its room (PRD §107 — a
// phantom leg must not block re-planning forever).
func sync(st *StrategyState, ctx StrategyContext) {
	byID := map[string]execution.NormalizedOrder{}
	for _, o := range ctx.OpenOrders {
		byID[o.ClientOrderID] = o
	}
	for i := range st.Children {
		c := &st.Children[i]
		o, seen := byID[c.ClientOrderID]
		if seen {
			if cmpDec(o.FilledQuantity, c.Filled) > 0 {
				c.Filled = o.FilledQuantity
			}
			c.Live = !isTerminalStatus(o.Status)
			continue
		}
		if c.CreatedAt < ctx.Now {
			c.Live = false // never acknowledged: room is freed on this tick
		}
	}
	if tracksExit(st) {
		// Entry-side fills must never leak into a close's tally (PRD §40).
		exit := "0"
		for _, c := range st.Children {
			if c.IsExit {
				exit, _ = decimal.Add(exit, c.Filled)
			}
		}
		st.ExitFilled = exit
		return
	}
	if cmpDec(ctx.FilledQuantity, st.Filled) > 0 {
		st.Filled = ctx.FilledQuantity
	}
}

// done returns the quantity this execution has actually completed: entry fills
// for openings, its own exit fills for closes/reduces (PRD §40).
func done(st *StrategyState) string {
	if tracksExit(st) {
		return st.ExitFilled
	}
	return st.Filled
}

// remaining returns planned − filled − Σ live unfilled entry children: the
// quantity still to be placed on the entry side (§107's room).
func remaining(st *StrategyState) (string, error) {
	room, err := decimal.Sub(st.Planned, done(st))
	if err != nil {
		return "", err
	}
	for _, c := range st.Children {
		if c.IsExit || !c.Live {
			continue
		}
		rem, err := decimal.Sub(c.Quantity, c.Filled)
		if err != nil {
			return "", err
		}
		if cmpDec(rem, "0") > 0 {
			room, err = decimal.Sub(room, rem)
			if err != nil {
				return "", err
			}
		}
	}
	if cmpDec(room, "0") < 0 {
		return "0", nil
	}
	return room, nil
}

// hasLiveEntry reports whether an entry child is still working — the
// one-at-a-time guard shared by market/limit/iceberg.
func hasLiveEntry(st *StrategyState) bool {
	for _, c := range st.Children {
		if !c.IsExit && c.Live && cmpDec(c.Quantity, c.Filled) > 0 {
			return true
		}
	}
	return false
}

// placeSpec describes one child order to submit.
type placeSpec struct {
	kind      string // "entry" | "exit"
	orderType string // "market" | "limit"
	price     string
	quantity  string
	intent    execution.Intent
	reduce    bool
}

// submit builds one submit action + its ledger entry (engine.ts placeAction).
//
// INVARIANT: every placement carries a deterministic client order id derived
// from (executionID, sequence), minted BEFORE the action leaves this package —
// the same state always mints the same id (objective §23, PRD §66).
func submit(st *StrategyState, ctx StrategyContext, spec placeSpec) Action {
	id := idempotency.ClientOrderID(st.ExecutionID, st.Sequence)
	st.Sequence++
	tif := execution.TIFGTC
	if spec.orderType == "market" {
		tif = execution.TIFIOC
	}
	order := execution.OrderRequest{
		ClientOrderID: id,
		Symbol:        st.Symbol,
		Side:          st.Side,
		Quantity:      spec.quantity,
		Price:         spec.price,
		OrderType:     spec.orderType,
		TimeInForce:   tif,
		ReduceOnly:    spec.reduce,
		Intent:        spec.intent,
		ExecutionID:   st.ExecutionID,
	}
	st.Children = append(st.Children, Child{
		ClientOrderID: id,
		Quantity:      spec.quantity,
		Filled:        "0",
		IsExit:        spec.kind == "exit",
		Live:          true,
		CreatedAt:     ctx.Now,
	})
	return Action{Kind: ActionSubmit, Order: order}
}

// stepEntry is the shared pre-placement flow: sync, completion check and the
// §114 placement gate. The bool is false when no placement may happen this tick.
func stepEntry(st *StrategyState, ctx StrategyContext) ([]Action, bool) {
	sync(st, ctx)
	if st.StartedAt == 0 {
		st.StartedAt = ctx.Now // the schedule clock starts at the first Step (PRD §28)
	}
	if st.Done {
		return nil, false
	}
	rem, err := remaining(st)
	if err != nil || cmpDec(rem, "0") <= 0 {
		// Nothing left to place. Complete only when actually FILLED, never on a
		// mere absence of room — a freed phantom re-opens room on the next tick.
		if cmpDec(done(st), st.Planned) >= 0 {
			st.Done = true
			return []Action{{Kind: ActionComplete}}, false
		}
		return nil, false
	}
	if !ctx.PlacementEnabled {
		// Recovery/reconcile pass (PRD §114): zero placements, state resumable.
		return nil, false
	}
	return nil, true
}

// ---- concrete strategies ---------------------------------------------------

// marketStrategy places ONE immediate child for the whole remaining quantity
// (objective §8.15). While that child works nothing else is placed; if the
// venue never saw it, the room is freed and a later tick re-places it.
type marketStrategy struct{}

// Step implements Strategy.
func (marketStrategy) Step(state State, ctx StrategyContext) (State, []Action) {
	st := state.(*StrategyState)
	actions, place := stepEntry(st, ctx)
	if !place || hasLiveEntry(st) {
		return st, actions
	}
	rem, err := remaining(st)
	if err != nil || cmpDec(rem, "0") <= 0 {
		return st, actions
	}
	a := submit(st, ctx, placeSpec{kind: "entry", orderType: "market", quantity: rem, intent: st.Intent})
	return st, append(actions, a)
}

// limitStrategy places ONE pegged limit child at the execution's entry price
// (objective §8.15): a single working order at the user's level, never a stack.
type limitStrategy struct{}

// Step implements Strategy.
func (limitStrategy) Step(state State, ctx StrategyContext) (State, []Action) {
	st := state.(*StrategyState)
	actions, place := stepEntry(st, ctx)
	if !place || hasLiveEntry(st) {
		return st, actions
	}
	rem, err := remaining(st)
	if err != nil || cmpDec(rem, "0") <= 0 {
		return st, actions
	}
	a := submit(st, ctx, placeSpec{kind: "entry", orderType: "limit", price: st.Price, quantity: rem, intent: st.Intent})
	return st, append(actions, a)
}

// twapStrategy releases the plan as naive equal slices over DurationMs
// (objective §8.15): one due slice per tick. Jitter exists ONLY when
// TwapConfig opted in (DR-021 §2g) and is planned at construction time so the
// schedule is reproducible (PRD §28).
type twapStrategy struct{}

// Step implements Strategy.
func (twapStrategy) Step(state State, ctx StrategyContext) (State, []Action) {
	st := state.(*StrategyState)
	actions, place := stepEntry(st, ctx)
	if !place {
		return st, actions
	}
	for st.SliceIdx < len(st.Slices) {
		sl := st.Slices[st.SliceIdx]
		if st.StartedAt+sl.AtOffsetMs > ctx.Now {
			break // not due yet
		}
		st.SliceIdx++
		rem, err := remaining(st)
		if err != nil {
			break
		}
		q := sl.Quantity
		if cmpDec(q, rem) > 0 {
			q = rem // a slice may only shrink (§107)
		}
		if cmpDec(q, "0") <= 0 {
			break
		}
		price, orderType := touch(st, ctx)
		actions = append(actions, submit(st, ctx, placeSpec{kind: "entry", orderType: orderType, price: price, quantity: q, intent: st.Intent}))
		break // one slice per tick keeps the pace predictable
	}
	return st, actions
}

// icebergStrategy reveals only Display at a time (objective §8.15): one
// display-sized child at the pegged price; the next is placed only once the
// previous is gone (filled or dead).
type icebergStrategy struct{}

// Step implements Strategy.
func (icebergStrategy) Step(state State, ctx StrategyContext) (State, []Action) {
	st := state.(*StrategyState)
	actions, place := stepEntry(st, ctx)
	if !place || hasLiveEntry(st) {
		return st, actions
	}
	rem, err := remaining(st)
	if err != nil || cmpDec(rem, "0") <= 0 {
		return st, actions
	}
	q := st.Display
	if cmpDec(q, rem) > 0 {
		q = rem
	}
	a := submit(st, ctx, placeSpec{kind: "entry", orderType: "limit", price: st.Price, quantity: q, intent: st.Intent})
	return st, append(actions, a)
}

// scaleStrategy walks a ScaleLevel ladder (objective §8.15): one marketable
// level per tick, sized planned×fraction. scale_out children are reduce-only
// exits and are capped by the open position (PRD §40) — never by entry room.
type scaleStrategy struct{}

// Step implements Strategy.
func (scaleStrategy) Step(state State, ctx StrategyContext) (State, []Action) {
	st := state.(*StrategyState)
	sync(st, ctx)
	if st.StartedAt == 0 {
		st.StartedAt = ctx.Now
	}
	if st.Done {
		return st, nil
	}
	if cmpDec(done(st), st.Planned) >= 0 {
		st.Done = true
		return st, []Action{{Kind: ActionComplete}}
	}
	if !ctx.PlacementEnabled {
		// PRD §114: recovery plans nothing — not even ladder levels.
		return st, nil
	}
	isOut := tracksExit(st)
	for i, l := range st.Levels {
		if st.LevelDone[i] {
			continue
		}
		if !marketable(st.Side, l.Price, ctx) {
			continue
		}
		st.LevelDone[i] = true // one level per tick keeps the pace predictable
		q, err := decimal.Mul(st.Planned, l.Fraction)
		if err != nil {
			break
		}
		if isOut {
			// Reduce-only may never exceed the open position minus what is already
			// working (PRD §40): the venue clamps the fill, we never oversize the ask.
			open, err := decimal.Parse(ctx.OpenPositionQuantity)
			if err != nil {
				break
			}
			working := "0"
			for _, c := range st.Children {
				if c.IsExit && c.Live {
					rem, err := decimal.Sub(c.Quantity, c.Filled)
					if err == nil && cmpDec(rem, "0") > 0 {
						working, _ = decimal.Add(working, rem)
					}
				}
			}
			room, err := decimal.Sub(decimal.Trim(open), working)
			if err != nil || cmpDec(room, "0") <= 0 {
				break
			}
			if cmpDec(q, room) > 0 {
				q = room
			}
		} else {
			rem, err := remaining(st)
			if err != nil || cmpDec(rem, "0") <= 0 {
				break
			}
			if cmpDec(q, rem) > 0 {
				q = rem
			}
		}
		if cmpDec(q, "0") <= 0 {
			break
		}
		spec := placeSpec{kind: "entry", orderType: "limit", price: l.Price, quantity: q, intent: st.Intent}
		if isOut {
			spec = placeSpec{kind: "exit", orderType: "limit", price: l.Price, quantity: q, intent: execution.IntentReduce, reduce: true}
		}
		return st, []Action{submit(st, ctx, spec)}
	}
	return st, nil
}

// touch returns (price, orderType) for a slice: pegged at the touch when the
// venue reports one, market otherwise — a missing touch is honest, never
// fabricated into a price (house rule).
func touch(st *StrategyState, ctx StrategyContext) (string, string) {
	if st.Side == execution.SideBuy && ctx.Ticker.Ask != nil && *ctx.Ticker.Ask != "" {
		return *ctx.Ticker.Ask, "limit"
	}
	if st.Side == execution.SideSell && ctx.Ticker.Bid != nil && *ctx.Ticker.Bid != "" {
		return *ctx.Ticker.Bid, "limit"
	}
	return "", "market"
}

// marketable reports whether a limit at price would execute now: a buy at or
// above the ask, a sell at or below the bid. With no touch reported the level
// is not marketable — we never guess a price (house rule).
func marketable(side execution.Side, price string, ctx StrategyContext) bool {
	if side == execution.SideBuy {
		if ctx.Ticker.Ask == nil || *ctx.Ticker.Ask == "" {
			return false
		}
		return cmpDec(price, *ctx.Ticker.Ask) >= 0
	}
	if ctx.Ticker.Bid == nil || *ctx.Ticker.Bid == "" {
		return false
	}
	return cmpDec(price, *ctx.Ticker.Bid) <= 0
}

// isTerminalStatus reports a child-order status that holds no room.
func isTerminalStatus(s execution.ChildOrderStatus) bool {
	switch s {
	case execution.ChildFilled, execution.ChildCancelled, execution.ChildRejected, execution.ChildExpired:
		return true
	}
	return false
}

// cmpDec compares two decimal strings, treating an unparseable left operand as
// less than anything (quantities are validated at construction).
func cmpDec(a, b string) int {
	c, err := decimal.Cmp(a, b)
	if err != nil {
		return -1
	}
	return c
}
