package risk

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
)

// ---------------------------------------------------------------------------
// exact decimal helpers (internal/platform/decimal is the arithmetic owner; these are
// thin big.Rat conveniences so the formulas below read like the TS source)
// ---------------------------------------------------------------------------

func radd(a, b *big.Rat) *big.Rat { return new(big.Rat).Add(a, b) }
func rsub(a, b *big.Rat) *big.Rat { return new(big.Rat).Sub(a, b) }
func rmul(a, b *big.Rat) *big.Rat { return new(big.Rat).Mul(a, b) }
func rquo(a, b *big.Rat) *big.Rat { return new(big.Rat).Quo(a, b) }
func rabs(a *big.Rat) *big.Rat    { return new(big.Rat).Abs(a) }
func rneg(a *big.Rat) *big.Rat    { return new(big.Rat).Neg(a) }
func rstr(a *big.Rat) string      { return decimal.Trim(a) }
func rzero() *big.Rat             { return new(big.Rat) }
func rone() *big.Rat              { return big.NewRat(1, 1) }

// readNum is the nullable read for warning-carrying flows: a malformed value is
// a numeric edge, never a throw (mirror of risk.ts readNum's non-finite path —
// decimal strings have no NaN/Infinity, so "malformed" covers the same cases).
func readNum(v, name string, warnings *[]string) *big.Rat {
	r, err := decimal.Parse(v)
	if err != nil {
		*warnings = append(*warnings, fmt.Sprintf("%s must be finite; got %q", name, v))
		return nil
	}
	return r
}

// requiredNum refuses a missing figure outright (TS `num` on a non-number).
func requiredNum(v, name string) (*big.Rat, error) {
	if strings.TrimSpace(v) == "" {
		return nil, errCode(CodeInvalidNumber, name, "%s is required", name)
	}
	r, err := decimal.Parse(v)
	if err != nil {
		return nil, errCode(CodeInvalidNumber, name, "%s must be a finite number", name)
	}
	return r, nil
}

// clampNeg mirrors risk.ts clampNeg: negative numeric edges are clamped to 0
// with a visible warning — never silently.
func clampNeg(d *big.Rat, name string, warnings *[]string) *big.Rat {
	if d.Sign() < 0 {
		*warnings = append(*warnings, fmt.Sprintf("%s was negative; clamped to 0", name))
		return rzero()
	}
	return d
}

func requireInstrument(instrument InstrumentMetadata) error {
	if instrument.Symbol == "" {
		return errCode(CodeInvalidInstrument, "instrument", "instrument metadata is required")
	}
	return nil
}

// checkPrices rejects non-positive prices and a stop on the wrong side of entry.
func checkPrices(entry, stop, target *big.Rat, side execution.Side, warnings *[]string) bool {
	ok := true
	if entry.Sign() <= 0 {
		*warnings = append(*warnings, "entry price must be > 0")
		ok = false
	}
	if stop != nil && stop.Sign() <= 0 {
		*warnings = append(*warnings, "stop price must be > 0")
		ok = false
	}
	if target != nil && target.Sign() <= 0 {
		*warnings = append(*warnings, "target price must be > 0")
		ok = false
	}
	if !ok {
		return false
	}
	if stop != nil {
		if side == execution.SideBuy && stop.Cmp(entry) >= 0 {
			*warnings = append(*warnings, "stop must be on the loss side of entry for a long (S < E for long, S > E for short)")
			return false
		}
		if side == execution.SideSell && stop.Cmp(entry) <= 0 {
			*warnings = append(*warnings, "stop must be on the loss side of entry for a short (S < E for long, S > E for short)")
			return false
		}
	}
	return true
}

// FeeRates resolves entry/exit fee rates as fractions of notional. A limit
// entry pays maker; everything else pays taker. Negative rates clamp to 0.
func FeeRates(f FeeModel, entryType EntryType) (rE, rX *big.Rat, err error) {
	maker, err := requiredNum(f.MakerBps, "feeBps")
	if err != nil {
		return nil, nil, err
	}
	taker, err := requiredNum(f.TakerBps, "takerBps")
	if err != nil {
		return nil, nil, err
	}
	entryBps := taker
	if entryType == EntryLimit {
		entryBps = maker
	}
	rE = rquo(entryBps, bpsDenom)
	if rE.Sign() < 0 {
		rE = rzero()
	}
	rX = rquo(taker, bpsDenom)
	if rX.Sign() < 0 {
		rX = rzero()
	}
	return rE, rX, nil
}

// SlipRates resolves entry slippage + safety reserve. Limit entries pay no
// entry slippage; negative slippage clamps to 0.
func SlipRates(s SlippageModel, entryType EntryType) (slip, reservePct *big.Rat, err error) {
	slipBps, err := requiredNum(s.SlippageBps, "slippageBps")
	if err != nil {
		return nil, nil, err
	}
	slip = rquo(slipBps, bpsDenom)
	if slip.Sign() < 0 || entryType == EntryLimit {
		slip = rzero()
	}
	reserveRaw, err := requiredNum(s.SafetyReservePct, "safetyReservePct")
	if err != nil {
		return nil, nil, err
	}
	reservePct = reserveRaw
	if reservePct.Sign() < 0 {
		reservePct = rzero() // mirror risk.ts: clamped, warning channel discarded there
	}
	return slip, reservePct, nil
}

// MultOf returns the contract multiplier; absent or non-positive means the
// linear default of 1 (mirror of `contractMultiplier ?? 1`).
func MultOf(instrument InstrumentMetadata) (*big.Rat, error) {
	if strings.TrimSpace(instrument.ContractMultiplier) == "" {
		return rone(), nil
	}
	m, err := decimal.Parse(instrument.ContractMultiplier)
	if err != nil {
		return nil, errCode(CodeInvalidNumber, "contractMultiplier", "contractMultiplier must be a finite number")
	}
	if m.Sign() <= 0 {
		return rone(), nil
	}
	return m, nil
}

// stepOf returns the quantity grid; an unusable grid is refused, never guessed.
func stepOf(instrument InstrumentMetadata) (*big.Rat, error) {
	step, err := requiredNum(instrument.StepSize, "stepSize")
	if err != nil {
		return nil, err
	}
	if step.Sign() <= 0 {
		return nil, errCode(CodeInvalidStepSize, "stepSize", "instrument stepSize must be > 0")
	}
	return step, nil
}

// floorStep floors a quantity to the step grid via internal/platform/decimal (the money
// math owner). Negative input clamps to 0 like the TS floorStep+lte(0) tail.
func floorStep(q, step *big.Rat) (*big.Rat, error) {
	out, ok, err := decimal.FloorToStep(rstr(q), rstr(step))
	if err != nil || !ok {
		return rzero(), nil // clamped to 0 — see roundQuantityDown
	}
	return decimal.MustParse(out), nil
}

// usdTrim renders a 2-dp display figure, dropping a bare ".00" (risk.ts usd).
func usdTrim(r *big.Rat) string {
	s := fmtFixed(roundHalfUp(r, 2), 2)
	if strings.HasSuffix(s, ".00") {
		s = s[:len(s)-3]
	}
	return "$" + s
}

// USD2 renders a display figure with exactly two decimals (plan.ts usd — the
// planner's conflict messages print "$40.00", not "$40").
func USD2(r *big.Rat) string {
	return "$" + fmtFixed(roundHalfUp(r, 2), 2)
}

// Wire is the result-boundary conversion mirroring risk.ts toWire: 12 decimals,
// ties half-up ("12 dp kills float dust", PRD §71). Every number that leaves
// the risk/sizing/planner packages passes through it, so the Go outputs match
// the TS wire numbers as normalized decimals.
func Wire(r *big.Rat) string {
	return rstr(roundHalfUp(r, 12))
}

// roundHalfUp rounds |r| to dp decimals, ties away from zero (decimal.js
// ROUND_HALF_UP), and re-attaches the sign. Exact — no float conversion.
func roundHalfUp(r *big.Rat, dp int) *big.Rat {
	sign := r.Sign()
	a := rabs(r)
	pow := new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dp)), nil))
	scaled := rmul(a, pow)
	scaled = radd(scaled, big.NewRat(1, 2))
	floored := new(big.Rat).SetInt(new(big.Int).Quo(scaled.Num(), scaled.Denom()))
	out := rquo(floored, pow)
	if sign < 0 {
		out = rneg(out)
	}
	return out
}

// fmtFixed renders r with exactly dp decimals (r must be a multiple of 10^-dp).
func fmtFixed(r *big.Rat, dp int) string {
	if dp == 0 {
		return rstr(r)
	}
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dp)), nil)
	scaled := rmul(r, new(big.Rat).SetInt(pow))
	if !scaled.IsInt() {
		return rstr(r) // defensive: never fabricate digits
	}
	abs := new(big.Int).Abs(scaled.Num())
	s := abs.String()
	for len(s) <= dp {
		s = "0" + s
	}
	head, tail := s[:len(s)-dp], s[len(s)-dp:]
	if scaled.Sign() < 0 {
		head = "-" + head
	}
	return head + "." + tail
}

// unitRisk (contract): mult·[|E−S|·(1+safetyPct) + E·rE + S·rX + E·slip] — linear in Q.
func unitRisk(e, s, mult, rE, rX, slip, reservePct *big.Rat) *big.Rat {
	inner := rmul(rabs(rsub(e, s)), radd(rone(), reservePct))
	inner = radd(inner, rmul(e, rE))
	inner = radd(inner, rmul(s, rX))
	inner = radd(inner, rmul(e, slip))
	return rmul(mult, inner)
}

// unitProfit (contract): mult·[|T−E| − E·rE − T·rX − E·slip] — NET per unit at the target.
func unitProfit(e, t, mult, rE, rX, slip *big.Rat) *big.Rat {
	inner := rabs(rsub(t, e))
	inner = rsub(inner, rmul(e, rE))
	inner = rsub(inner, rmul(t, rX))
	inner = rsub(inner, rmul(e, slip))
	return rmul(mult, inner)
}

// breakdownAt splits the cost model by leg: qRisk pays price risk + exit fee
// (position size), qEntry pays entry fee + entry slippage (the newly-opened
// size). Equal for whole-position views; the split makes fill reconciliation
// (PRD §36–§37) exact.
func breakdownAt(qRisk, qEntry, e, s, mult, rE, rX, slip, reservePct *big.Rat) RiskBreakdown {
	priceRisk := rmul(rmul(qRisk, mult), rabs(rsub(e, s)))
	entryFee := rmul(rmul(rmul(qEntry, mult), e), rE)
	exitFee := rmul(rmul(rmul(qRisk, mult), s), rX)
	slippage := rmul(rmul(rmul(qEntry, mult), e), slip)
	safetyReserve := rmul(priceRisk, reservePct)
	total := radd(radd(radd(priceRisk, entryFee), radd(exitFee, slippage)), safetyReserve)
	return RiskBreakdown{
		PriceRisk:     Wire(priceRisk),
		EntryFee:      Wire(entryFee),
		ExitFee:       Wire(exitFee),
		SlippageRisk:  Wire(slippage),
		SafetyReserve: Wire(safetyReserve),
		TotalRisk:     Wire(total),
	}
}

// ---------------------------------------------------------------------------
// Rounding (PRD §70–§71)
// ---------------------------------------------------------------------------

// RoundQuantityDown floors a quantity to the step grid (PRD §71: 0.012583 @
// 0.001 → 0.012). Exposure never rounds up; non-positive results are 0.
func RoundQuantityDown(quantity string, instrument InstrumentMetadata) (string, error) {
	if err := requireInstrument(instrument); err != nil {
		return "", err
	}
	step, err := stepOf(instrument)
	if err != nil {
		return "", err
	}
	q, err := requiredNum(quantity, "quantity")
	if err != nil {
		return "", err
	}
	rounded, err := floorStep(q, step)
	if err != nil {
		return "", err
	}
	if rounded.Sign() <= 0 {
		return "0", nil
	}
	return Wire(rounded), nil
}

// RoundPrice snaps a price to the tick size, ties half-up.
func RoundPrice(price string, instrument InstrumentMetadata) (string, error) {
	if err := requireInstrument(instrument); err != nil {
		return "", err
	}
	tick, err := requiredNum(instrument.TickSize, "tickSize")
	if err != nil {
		return "", err
	}
	if tick.Sign() <= 0 {
		return "", errCode(CodeInvalidTickSize, "tickSize", "instrument tickSize must be > 0")
	}
	if _, err := requiredNum(price, "price"); err != nil {
		return "", err
	}
	out, err := decimal.RoundToTick(price, rstr(tick))
	if err != nil {
		return "", err
	}
	return Wire(decimal.MustParse(out)), nil
}

// ---------------------------------------------------------------------------
// Balance basis (PRD §10)
// ---------------------------------------------------------------------------

// ResolveBalanceBasis maps an explicit basis to the snapshot figure. An unknown
// or absent basis is nil — NEVER "0": a missing balance is not a zero balance.
func ResolveBalanceBasis(basis execution.BalanceBasis, balances BalanceSnapshot) *string {
	switch basis {
	case execution.BasisSpotAvailable:
		return balances.SpotAvailable
	case execution.BasisSpotEquity:
		return balances.SpotEquity
	case execution.BasisFuturesAvailable:
		return balances.FuturesAvailable
	case execution.BasisFuturesEquity:
		return balances.FuturesEquity
	case execution.BasisTotalExchange:
		return balances.TotalExchangeEquity
	case execution.BasisAssetEquity:
		return balances.AssetEquity
	case execution.BasisCustom:
		return balances.Custom
	default:
		return nil
	}
}

// ---------------------------------------------------------------------------
// Risk sizing (PRD §8, §22)
// ---------------------------------------------------------------------------

// CalculateRiskPosition sizes from a risk budget via the fee-aware unit risk.
// The exit leg is priced at the STOP and market entries charge slippage exactly
// once. Numeric edges return an empty result with warnings; structural errors
// (missing instrument, unusable grid) are returned as errors.
func CalculateRiskPosition(input RiskPositionInput) (SizedPosition, error) {
	var warnings []string
	if err := requireInstrument(input.Instrument); err != nil {
		return SizedPosition{}, err
	}
	instrument := input.Instrument
	side := input.Side
	if side != execution.SideSell {
		side = execution.SideBuy
	}
	rE, rX, err := FeeRates(input.FeeModel, input.EntryType)
	if err != nil {
		return SizedPosition{}, err
	}
	slip, reservePct, err := SlipRates(input.SlippageModel, input.EntryType)
	if err != nil {
		return SizedPosition{}, err
	}
	mult, err := MultOf(instrument)
	if err != nil {
		return SizedPosition{}, err
	}
	e := readNum(input.Entry, "entry", &warnings)
	s := readNum(input.Stop, "stop", &warnings)
	budgetRaw := readNum(input.RiskBudget, "riskBudget", &warnings)
	empty := func(extra []string) SizedPosition {
		return SizedPosition{
			Quantity: "0", UnroundedQuantity: "0", Notional: "0",
			Risk:     breakdownAt(rzero(), rzero(), orZero(e), orZero(s), mult, rE, rX, slip, reservePct),
			Warnings: append(warnings, extra...),
		}
	}
	if e == nil || s == nil || budgetRaw == nil {
		return empty(nil), nil
	}
	budget := clampNeg(budgetRaw, "riskBudget", &warnings)
	if !checkPrices(e, s, nil, side, &warnings) {
		return empty(nil), nil
	}
	distance := rabs(rsub(e, s))
	if distance.Sign() <= 0 {
		return empty([]string{"entry and stop coincide (|E−S| = 0); risk per unit is 0, quantity 0"}), nil
	}
	unit := unitRisk(e, s, mult, rE, rX, slip, reservePct)
	unrounded := rquo(budget, unit)
	step, err := stepOf(instrument)
	if err != nil {
		return SizedPosition{}, err
	}
	q, err := floorStep(unrounded, step)
	if err != nil {
		return SizedPosition{}, err
	}
	if q.Sign() <= 0 {
		warnings = append(warnings, fmt.Sprintf("quantity rounds to 0 at stepSize %s; nothing to order", rstr(step)))
		q = rzero()
	} else if q.Cmp(unrounded) < 0 {
		// Rounding is a real reduction in exposure: the caller must see it, so
		// the preview never presents a risk-safe size as the exact solve
		// (PRD §71/§116 honesty).
		warnings = append(warnings, fmt.Sprintf("quantity %s rounded DOWN to %s at step %s", rstr(unrounded), rstr(q), rstr(step)))
	}
	notional := rmul(rmul(q, e), mult)
	// Instrument bounds (PRD §70) reject with a warning — never silently.
	if instrument.MinNotional != nil && q.Sign() > 0 {
		if min, err := decimal.Parse(*instrument.MinNotional); err == nil && notional.Sign() > 0 && notional.Cmp(min) < 0 {
			warnings = append(warnings, fmt.Sprintf("notional %s below minNotional %s; order rejected", rstr(notional), rstr(min)))
			q, notional = rzero(), rzero()
		}
	}
	if instrument.MaxNotional != nil {
		if max, err := decimal.Parse(*instrument.MaxNotional); err == nil && notional.Cmp(max) > 0 {
			warnings = append(warnings, fmt.Sprintf("notional %s above maxNotional %s; order rejected", rstr(notional), rstr(max)))
			q, notional = rzero(), rzero()
		}
	}
	if instrument.MinQuantity != nil {
		if min, err := decimal.Parse(*instrument.MinQuantity); err == nil && q.Sign() > 0 && q.Cmp(min) < 0 {
			warnings = append(warnings, fmt.Sprintf("quantity below minQuantity %s; order rejected", rstr(min)))
			q, notional = rzero(), rzero()
		}
	}
	if instrument.MaxQuantity != nil {
		if max, err := decimal.Parse(*instrument.MaxQuantity); err == nil && q.Cmp(max) > 0 {
			warnings = append(warnings, fmt.Sprintf("quantity above maxQuantity %s; clamped down", rstr(max)))
			q, err = floorStep(max, step)
			if err != nil {
				return SizedPosition{}, err
			}
			notional = rmul(rmul(q, e), mult)
		}
	}
	return SizedPosition{
		Quantity:          Wire(q),
		UnroundedQuantity: Wire(unrounded),
		Notional:          Wire(notional),
		Risk:              breakdownAt(q, q, e, s, mult, rE, rX, slip, reservePct),
		Warnings:          warnings,
	}, nil
}

// ---------------------------------------------------------------------------
// Profit sizing (PRD §13) — NET of costs
// ---------------------------------------------------------------------------

// CalculateProfitPosition sizes to a target profit NET of fees and slippage;
// the rounded quantity never overshoots the desired profit.
func CalculateProfitPosition(input ProfitPositionInput) (ProfitPositionResult, error) {
	var warnings []string
	if err := requireInstrument(input.Instrument); err != nil {
		return ProfitPositionResult{}, err
	}
	instrument := input.Instrument
	side := input.Side
	if side != execution.SideSell {
		side = execution.SideBuy
	}
	rE, rX, err := FeeRates(input.FeeModel, input.EntryType)
	if err != nil {
		return ProfitPositionResult{}, err
	}
	slip, reservePct, err := SlipRates(input.SlippageModel, input.EntryType)
	if err != nil {
		return ProfitPositionResult{}, err
	}
	mult, err := MultOf(instrument)
	if err != nil {
		return ProfitPositionResult{}, err
	}
	e := readNum(input.Entry, "entry", &warnings)
	t := readNum(input.Target, "target", &warnings)
	desiredRaw := readNum(input.DesiredProfit, "desiredProfit", &warnings)
	empty := func(extra []string) ProfitPositionResult {
		return ProfitPositionResult{
			Quantity: "0", UnroundedQuantity: "0", Notional: "0", EstimatedProfit: "0",
			Risk:     nil,
			Warnings: append(warnings, extra...),
		}
	}
	if e == nil || t == nil || desiredRaw == nil {
		return empty(nil), nil
	}
	desired := clampNeg(desiredRaw, "desiredProfit", &warnings)
	if !checkPrices(e, nil, t, side, &warnings) {
		return empty(nil), nil
	}
	if side == execution.SideBuy && t.Cmp(e) <= 0 || side == execution.SideSell && t.Cmp(e) >= 0 {
		return empty([]string{"target must be on the profit side of entry (T > E for long, T < E for short)"}), nil
	}
	distance := rabs(rsub(t, e))
	if distance.Sign() <= 0 {
		return empty([]string{"entry and target coincide (|T−E| = 0); profit per unit is −costs, quantity 0"}), nil
	}
	up := unitProfit(e, t, mult, rE, rX, slip)
	if up.Sign() <= 0 {
		return empty([]string{"target move does not cover fees + slippage per unit; desired profit is unachievable, quantity 0"}), nil
	}
	unrounded := rquo(desired, up)
	step, err := stepOf(instrument)
	if err != nil {
		return ProfitPositionResult{}, err
	}
	q, err := floorStep(unrounded, step)
	if err != nil {
		return ProfitPositionResult{}, err
	}
	if q.Sign() <= 0 {
		warnings = append(warnings, fmt.Sprintf("quantity rounds to 0 at stepSize %s; nothing to order", rstr(step)))
		q = rzero()
	}
	// Estimated profit is NET at the rounded quantity, hence always <= desired.
	profit := rmul(q, up)
	notional := rmul(rmul(q, e), mult)
	if instrument.MinNotional != nil {
		if min, err := decimal.Parse(*instrument.MinNotional); err == nil && notional.Sign() > 0 && notional.Cmp(min) < 0 {
			warnings = append(warnings, fmt.Sprintf("notional %s below minNotional %s; order rejected", rstr(notional), rstr(min)))
			q, notional, profit = rzero(), rzero(), rzero()
		}
	}
	if instrument.MinQuantity != nil {
		if min, err := decimal.Parse(*instrument.MinQuantity); err == nil && q.Sign() > 0 && q.Cmp(min) < 0 {
			warnings = append(warnings, fmt.Sprintf("quantity below minQuantity %s; order rejected", rstr(min)))
			q, notional, profit = rzero(), rzero(), rzero()
		}
	}
	bd := breakdownAt(q, q, e, t, mult, rE, rX, slip, reservePct)
	return ProfitPositionResult{
		Quantity:          Wire(q),
		UnroundedQuantity: Wire(unrounded),
		Notional:          Wire(notional),
		EstimatedProfit:   Wire(profit),
		Risk:              &bd,
		Warnings:          warnings,
	}, nil
}

// EstimateNetProfit prices a take-profit plan as given (planner seam). Each
// level closes Quantity × Fraction; the unexited remainder earns no profit but
// still pays its share of the entry fee. Move sign follows the side; negative
// results are returned honestly, never clamped. With one full-close level this
// equals CalculateProfitPosition(...).EstimatedProfit for the same quantity.
func EstimateNetProfit(input EstimateNetProfitInput) (string, error) {
	if err := requireInstrument(input.Instrument); err != nil {
		return "", err
	}
	e, err := requiredNum(input.Entry, "entry")
	if err != nil {
		return "", err
	}
	q, err := requiredNum(input.Quantity, "quantity")
	if err != nil {
		return "", err
	}
	if q.Sign() < 0 {
		q = rzero()
	}
	rE, rX, err := FeeRates(input.FeeModel, input.EntryType)
	if err != nil {
		return "", err
	}
	slip, _, err := SlipRates(input.SlippageModel, input.EntryType)
	if err != nil {
		return "", err
	}
	mult, err := MultOf(input.Instrument)
	if err != nil {
		return "", err
	}
	dir := rone()
	if input.Side == execution.SideSell {
		dir = rneg(dir)
	}
	net := rzero()
	for _, tp := range input.TakeProfits {
		t, err := requiredNum(tp.Price, "takeProfits[].price")
		if err != nil {
			return "", err
		}
		f := rone()
		if strings.TrimSpace(tp.Fraction) != "" {
			raw, err := requiredNum(tp.Fraction, "takeProfits[].fraction")
			if err != nil {
				return "", err
			}
			f = raw
			if f.Sign() < 0 {
				f = rzero()
			}
			if f.Cmp(rone()) > 0 {
				f = rone()
			}
		}
		slice := rmul(q, f)
		net = radd(net, rmul(rmul(rmul(slice, mult), rsub(t, e)), dir))
		net = rsub(net, rmul(rmul(rmul(slice, mult), t), rX))
	}
	net = rsub(net, rmul(rmul(rmul(q, mult), e), rE))
	net = rsub(net, rmul(rmul(rmul(q, mult), e), slip))
	return Wire(net), nil
}

// ---------------------------------------------------------------------------
// Filled-position risk + remaining-budget resize (PRD §36–§37)
// ---------------------------------------------------------------------------

// ProjectedRisk risks a filled position at its average entry. It is exactly
// linear in quantity at that entry.
func ProjectedRisk(input ProjectedRiskInput) (RiskBreakdown, error) {
	if err := requireInstrument(input.Instrument); err != nil {
		return RiskBreakdown{}, err
	}
	side := input.Side
	if side != execution.SideSell {
		side = execution.SideBuy
	}
	e, err := requiredNum(input.AverageEntry, "averageEntry")
	if err != nil {
		return RiskBreakdown{}, err
	}
	s, err := requiredNum(input.Stop, "stop")
	if err != nil {
		return RiskBreakdown{}, err
	}
	q, err := requiredNum(input.Quantity, "quantity")
	if err != nil {
		return RiskBreakdown{}, err
	}
	if q.Sign() < 0 {
		q = rzero()
	}
	if e.Sign() <= 0 || s.Sign() <= 0 {
		return RiskBreakdown{}, errCode(CodeInvalidPrice, "averageEntry", "averageEntry and stop must be > 0")
	}
	if side == execution.SideBuy && s.Cmp(e) >= 0 || side == execution.SideSell && s.Cmp(e) <= 0 {
		return RiskBreakdown{}, errCode(CodeInvalidStop, "stop", "stop must be on the loss side of entry (S < E for long, S > E for short)")
	}
	rE, rX, err := FeeRates(input.FeeModel, EntryMarket)
	if err != nil {
		return RiskBreakdown{}, err
	}
	slip, reservePct, err := SlipRates(input.SlippageModel, EntryMarket)
	if err != nil {
		return RiskBreakdown{}, err
	}
	mult, err := MultOf(input.Instrument)
	if err != nil {
		return RiskBreakdown{}, err
	}
	return breakdownAt(q, q, e, s, mult, rE, rX, slip, reservePct), nil
}

// MaxSafeQuantity returns the largest ADDITIONAL quantity (rounded DOWN) whose
// full-position risk stays within RemainingBudget. The filled leg is already
// inside the budget accounting, so ProjectedRiskAfter charges price risk and
// the exit fee on filled+additional but entry fee and entry slippage only on the
// ADDED leg (market-priced at the planned entry). The clamp is exact because
// total risk is linear in each leg's quantity.
func MaxSafeQuantity(input MaxSafeQuantityInput) (MaxSafeQuantityResult, error) {
	var warnings []string
	if err := requireInstrument(input.Instrument); err != nil {
		return MaxSafeQuantityResult{}, err
	}
	instrument := input.Instrument
	side := input.Side
	if side != execution.SideSell {
		side = execution.SideBuy
	}
	rE, rX, err := FeeRates(input.FeeModel, EntryMarket)
	if err != nil {
		return MaxSafeQuantityResult{}, err
	}
	slip, reservePct, err := SlipRates(input.SlippageModel, EntryMarket)
	if err != nil {
		return MaxSafeQuantityResult{}, err
	}
	mult, err := MultOf(instrument)
	if err != nil {
		return MaxSafeQuantityResult{}, err
	}
	e := readNum(input.ReferenceEntry, "referenceEntry", &warnings)
	s := readNum(input.Stop, "stop", &warnings)
	budgetRaw := readNum(input.RemainingBudget, "remainingBudget", &warnings)
	filledRaw := readNum(input.FilledQuantity, "filledQuantity", &warnings)
	at := func(qAdd, filledQ, ee, ss *big.Rat) RiskBreakdown {
		return breakdownAt(radd(filledQ, qAdd), qAdd, ee, ss, mult, rE, rX, slip, reservePct)
	}
	invalid := func(extra []string) MaxSafeQuantityResult {
		return MaxSafeQuantityResult{
			MaxAdditionalQuantity:       "0",
			UnroundedAdditionalQuantity: "0",
			ProjectedRiskAfter:          at(rzero(), rzero(), orZero(e), orZero(s)),
			Warnings:                    append(warnings, extra...),
		}
	}
	if e == nil || s == nil || budgetRaw == nil || filledRaw == nil {
		return invalid(nil), nil
	}
	budget := clampNeg(budgetRaw, "remainingBudget", &warnings)
	filled := clampNeg(filledRaw, "filledQuantity", &warnings)
	if !checkPrices(e, s, nil, side, &warnings) {
		return invalid(nil), nil
	}
	distance := rabs(rsub(e, s))
	if distance.Sign() <= 0 {
		return invalid([]string{"entry and stop coincide (|E−S| = 0); risk per unit is 0, additional quantity 0"}), nil
	}
	base := radd(rmul(rmul(mult, distance), radd(rone(), reservePct)), rmul(rmul(mult, s), rX))
	perUnitAdd := radd(radd(base, rmul(rmul(mult, e), rE)), rmul(rmul(mult, e), slip))
	remaining := rsub(budget, rmul(filled, base))
	if remaining.Sign() <= 0 {
		return invalid([]string{"filled position already consumes the remaining risk budget; additional quantity 0"}), nil
	}
	unrounded := rquo(remaining, perUnitAdd)
	step, err := stepOf(instrument)
	if err != nil {
		return MaxSafeQuantityResult{}, err
	}
	qAdd, err := floorStep(unrounded, step)
	if err != nil {
		return MaxSafeQuantityResult{}, err
	}
	if qAdd.Sign() <= 0 {
		warnings = append(warnings, fmt.Sprintf("additional quantity rounds to 0 at stepSize %s", rstr(step)))
		qAdd = rzero()
	}
	return MaxSafeQuantityResult{
		MaxAdditionalQuantity:       Wire(qAdd),
		UnroundedAdditionalQuantity: Wire(unrounded),
		ProjectedRiskAfter:          at(qAdd, filled, e, s),
		Warnings:                    warnings,
	}, nil
}

func orZero(r *big.Rat) *big.Rat {
	if r == nil {
		return rzero()
	}
	return r
}
