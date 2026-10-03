package sizing

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/risk"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// tiny exact-decimal conveniences; the formulas live in package risk (the ONE
// canonical owner) — these only shape arithmetic around them.
func radd(a, b *big.Rat) *big.Rat { return new(big.Rat).Add(a, b) }
func rsub(a, b *big.Rat) *big.Rat { return new(big.Rat).Sub(a, b) }
func rmul(a, b *big.Rat) *big.Rat { return new(big.Rat).Mul(a, b) }
func rquo(a, b *big.Rat) *big.Rat { return new(big.Rat).Quo(a, b) }
func rabs(a *big.Rat) *big.Rat    { return new(big.Rat).Abs(a) }
func rzero() *big.Rat             { return new(big.Rat) }
func rone() *big.Rat              { return big.NewRat(1, 1) }
func rstr(a *big.Rat) string      { return decimal.Trim(a) }

func parse(s, field string) (*big.Rat, error) {
	if strings.TrimSpace(s) == "" {
		return nil, fieldErr(CodeInvalidSizing, field, "must be a decimal value")
	}
	r, err := decimal.Parse(s)
	if err != nil {
		return nil, fieldErr(CodeInvalidSizing, field, "must be a decimal value")
	}
	return r, nil
}

// ValueOf returns the mode's single sizing figure (TS `sizing.value`).
func ValueOf(s execution.SizingDefinition) string {
	switch s.Mode {
	case execution.SizingRiskPercent, execution.SizingAllocationPercent, execution.SizingTargetProfitPercent:
		return s.Percent
	case execution.SizingFixedQuantity:
		return s.Quantity
	case execution.SizingFixedMargin:
		return s.Margin
	default:
		return s.Amount
	}
}

// IsPercentMode reports whether the mode sizes off a percentage — every such
// mode MUST name its basis (PRD §10).
func IsPercentMode(mode execution.SizingMode) bool {
	return mode == execution.SizingRiskPercent || mode == execution.SizingAllocationPercent ||
		mode == execution.SizingTargetProfitPercent
}

// IsRiskMode reports whether the mode is risk-oriented (requires a stop, §38).
func IsRiskMode(mode execution.SizingMode) bool {
	return mode == execution.SizingRiskUSD || mode == execution.SizingRiskPercent
}

// IsProfitMode reports whether the mode is outcome-oriented (requires a
// take-profit to price, §13).
func IsProfitMode(mode execution.SizingMode) bool {
	return mode == execution.SizingTargetProfitUSD || mode == execution.SizingTargetProfitPercent
}

// LadderVWAP is the fraction-weighted realized entry of a scale ladder (§33):
// 50% @ 99,000 + 50% @ 93,000 fills at 96,000 — NOT at the top level. Every
// downstream figure keyed to the entry (liquidation §17/§21, notional, the
// profit projection §13, the R:R the user reads §84) uses this one price.
func LadderVWAP(levels []execution.ScaleLevel) (string, error) {
	if len(levels) == 0 {
		// An empty ladder has no realized entry — an error, never a fabricated 0.
		return "", fieldErr(CodeInvalidSizing, "execution.levels", "cannot price an empty ladder")
	}
	acc := rzero()
	for _, l := range levels {
		price, err := parse(l.Price, "execution.levels[].price")
		if err != nil {
			return "", err
		}
		f, err := parse(l.Fraction, "execution.levels[].fraction")
		if err != nil {
			return "", err
		}
		acc = radd(acc, rmul(price, f))
	}
	return risk.Wire(acc), nil
}

// SizePosition resolves one of the nine SizingMode values into a SizedPosition
// (objective §8.13; plan.ts sizePosition). Percentage modes without a resolved
// basis are refused naming the basis — never a fabricated 0. Quantities floor
// DOWN to the grid; a minimum-notional refusal prints both figures.
func SizePosition(in SizeInputs) (SizedPosition, error) {
	warnings := []string{}
	var errs []FieldError
	stop := in.Stop
	entryType := in.EntryType
	mult, err := risk.MultOf(in.Instrument)
	if err != nil {
		return SizedPosition{}, err
	}
	// Percentage bases (§10): an unresolved basis is an error, never a 0.
	var basis *execution.BalanceBasis
	var basisVal *string
	if IsPercentMode(in.Sizing.Mode) {
		b := in.Sizing.Basis
		basis = &b
		if b == "" {
			errs = append(errs, fieldErr(CodeSizingBasisMissing, "sizing.balanceBasis",
				"percentage sizing requires an explicit balance basis (PRD §10)"))
		} else if in.Balances == nil {
			errs = append(errs, fieldErr(CodeSizingBasisUnresolved, "sizing.balanceBasis", "'%s' could not be resolved from the account snapshot", b))
		} else if resolved := risk.ResolveBalanceBasis(b, *in.Balances); resolved == nil {
			errs = append(errs, fieldErr(CodeSizingBasisUnresolved, "sizing.balanceBasis", "'%s' could not be resolved from the account snapshot", b))
		} else {
			basisVal = resolved
		}
	}
	rE, rX, err := risk.FeeRates(in.FeeModel, entryType)
	if err != nil {
		return SizedPosition{}, err
	}
	slip, reservePct, err := risk.SlipRates(in.SlippageModel, entryType)
	if err != nil {
		return SizedPosition{}, err
	}
	value := ValueOf(in.Sizing)
	var primaryExit string
	switch {
	case stop != nil:
		primaryExit = *stop
	case len(in.TakeProfits) > 0:
		primaryExit = in.TakeProfits[0].Price
	default:
		primaryExit = in.ReferenceEntry
	}
	// §33: a scale-in builds the position at SEVERAL prices, so the budgeted
	// risk must cover EVERY potential fill. Ladder routing mirrors plan.ts:
	// risk modes with a stop and levels present.
	if IsRiskMode(in.Sizing.Mode) && len(in.Levels) > 0 && stop != nil {
		return SizeScaleInRisk(in, nil)
	}
	empty := SizedPosition{
		Quantity: "0", UnroundedQuantity: "0", Notional: "0",
		EntryFee: "0", ExitFee: "0", SlippageBudget: "0",
		EstimatedEntry: in.ReferenceEntry, Warnings: warnings, Errors: errs,
	}
	fillEstimatedEntry := func(s *SizedPosition) error {
		if len(in.Levels) > 0 {
			v, err := LadderVWAP(in.Levels)
			if err != nil {
				return err
			}
			s.EstimatedEntry = v
		} else {
			s.EstimatedEntry = in.ReferenceEntry
		}
		return nil
	}
	var out SizedPosition
	switch in.Sizing.Mode {
	case execution.SizingRiskUSD, execution.SizingRiskPercent:
		if len(errs) > 0 || stop == nil {
			return empty, nil
		}
		budget := value
		if in.Sizing.Mode == execution.SizingRiskPercent {
			pct, err := parse(value, "sizing.value")
			if err != nil {
				return SizedPosition{}, err
			}
			budget = risk.Wire(rquo(rmul(decimal.MustParse(*basisVal), pct), big.NewRat(100, 1)))
		}
		r, err := risk.CalculateRiskPosition(risk.RiskPositionInput{
			Side: in.Side, Entry: in.ReferenceEntry, Stop: *stop, RiskBudget: budget,
			FeeModel: in.FeeModel, SlippageModel: in.SlippageModel,
			Instrument: in.Instrument, EntryType: entryType,
		})
		if err != nil {
			return SizedPosition{}, err
		}
		bd := r.Risk
		out = SizedPosition{
			Quantity: r.Quantity, UnroundedQuantity: r.UnroundedQuantity, Notional: r.Notional,
			Budget: strPtr(budget), RiskBasis: basis, BalanceReference: basisVal,
			PriceRisk: strPtr(bd.PriceRisk), EntryFee: bd.EntryFee, ExitFee: bd.ExitFee,
			SlippageBudget: bd.SlippageRisk, SafetyReserve: strPtr(bd.SafetyReserve),
			TotalRisk: strPtr(bd.TotalRisk),
			Warnings:  append(warnings, r.Warnings...), Errors: errs,
		}
	case execution.SizingTargetProfitUSD, execution.SizingTargetProfitPercent:
		if len(errs) > 0 || len(in.TakeProfits) == 0 {
			return empty, nil
		}
		desired := value
		if in.Sizing.Mode == execution.SizingTargetProfitPercent {
			pct, err := parse(value, "sizing.value")
			if err != nil {
				return SizedPosition{}, err
			}
			desired = risk.Wire(rquo(rmul(decimal.MustParse(*basisVal), pct), big.NewRat(100, 1)))
		}
		r, err := risk.CalculateProfitPosition(risk.ProfitPositionInput{
			Side: in.Side, Entry: in.ReferenceEntry, Target: in.TakeProfits[0].Price, DesiredProfit: desired,
			FeeModel: in.FeeModel, SlippageModel: in.SlippageModel,
			Instrument: in.Instrument, EntryType: entryType,
		})
		if err != nil {
			return SizedPosition{}, err
		}
		// Outcome sizing re-prices the stop-based figures at the plan's entry
		// reference (plan.ts's outcome branch): the profit solve priced the exit
		// at the TARGET, but the risk block must show the STOP view.
		q, err := parse(r.Quantity, "quantity")
		if err != nil {
			return SizedPosition{}, err
		}
		ref, err := parse(in.ReferenceEntry, "entry")
		if err != nil {
			return SizedPosition{}, err
		}
		notional := rmul(rmul(q, ref), mult)
		entryFee := rmul(notional, rE)
		exitNotional := rmul(rmul(q, parseMust(primaryExit)), mult)
		exitFee := rmul(exitNotional, rX)
		slipBudget := rzero()
		if entryType != risk.EntryLimit {
			slipBudget = rmul(notional, slip)
		}
		var priceRisk, safetyReserve, totalRisk *big.Rat
		if stop != nil {
			st, err := parse(*stop, "stop")
			if err != nil {
				return SizedPosition{}, err
			}
			pr := rmul(rmul(q, mult), rabs(rsub(ref, st)))
			sr := rmul(pr, reservePct)
			tr := radd(radd(radd(pr, entryFee), radd(exitFee, slipBudget)), sr)
			priceRisk, safetyReserve, totalRisk = pr, sr, tr
		}
		out = SizedPosition{
			Quantity: r.Quantity, UnroundedQuantity: r.UnroundedQuantity,
			Notional: risk.Wire(notional),
			Budget:   nil, RiskBasis: basis, BalanceReference: basisVal,
			EntryFee: risk.Wire(entryFee), ExitFee: risk.Wire(exitFee), SlippageBudget: risk.Wire(slipBudget),
			Warnings: append(warnings, r.Warnings...), Errors: errs,
		}
		if priceRisk != nil {
			out.PriceRisk = strPtr(risk.Wire(priceRisk))
			out.SafetyReserve = strPtr(risk.Wire(safetyReserve))
			out.TotalRisk = strPtr(risk.Wire(totalRisk))
		}
	case execution.SizingAllocationUSD, execution.SizingAllocationPercent, execution.SizingNotionalUSD,
		execution.SizingFixedQuantity, execution.SizingFixedMargin:
		if len(errs) > 0 {
			return empty, nil
		}
		ref, err := parse(in.ReferenceEntry, "entry")
		if err != nil {
			return SizedPosition{}, err
		}
		denom := rmul(ref, mult)
		var raw *big.Rat
		switch in.Sizing.Mode {
		case execution.SizingAllocationUSD, execution.SizingAllocationPercent:
			capital := value
			if in.Sizing.Mode == execution.SizingAllocationPercent {
				pct, err := parse(value, "sizing.value")
				if err != nil {
					return SizedPosition{}, err
				}
				capital = risk.Wire(rquo(rmul(decimal.MustParse(*basisVal), pct), big.NewRat(100, 1)))
			}
			raw = rquo(parseMust(capital), denom)
		case execution.SizingNotionalUSD:
			raw = rquo(parseMust(value), denom)
		case execution.SizingFixedQuantity:
			raw = parseMust(value)
		case execution.SizingFixedMargin:
			lev := rone()
			if in.MarketType == execution.MarketLinearPerp && in.Leverage.Mode == execution.LeverageManual {
				lv, err := parse(in.Leverage.Leverage, "leverage.leverage")
				if err != nil {
					return SizedPosition{}, err
				}
				lev = lv
			}
			raw = rquo(rmul(parseMust(value), lev), denom)
		}
		out, err = finishCapital(in, primaryExit, raw, mult, rE, rX, slip, reservePct, empty)
		if err != nil {
			return SizedPosition{}, err
		}
	default:
		return SizedPosition{}, fieldErr(CodeInvalidSizing, "sizing.mode", "unknown sizing mode %q", in.Sizing.Mode)
	}
	if err := fillEstimatedEntry(&out); err != nil {
		return SizedPosition{}, err
	}
	// Populate the leverage/margin/liquidation columns of the sizing shape
	// (objective §8.13) with the §17–§21 policy.
	notional := parseMust(out.Notional)
	mres, err := ResolveLeverageAndMargin(in, notional, &out.Warnings)
	if err != nil {
		return SizedPosition{}, err
	}
	out.RequiredMargin = mres.Margin
	out.RequiredLeverage = mres.Leverage
	out.LiquidationPrice = mres.LiquidationPrice
	return out, nil
}

// finishCapital is the shared tail for the capital/outcome-neutral modes: round
// the raw quantity DOWN (§71 risk-safe), price it, and produce the
// stop-less-or-full fee figures (plan.ts finishCapital).
func finishCapital(in SizeInputs, primaryExit string, raw, mult, rE, rX, slip, reservePct *big.Rat, base SizedPosition) (SizedPosition, error) {
	stop := in.Stop
	entryType := in.EntryType
	warnings := base.Warnings
	quantity, err := risk.RoundQuantityDown(rstr(raw), in.Instrument)
	if err != nil {
		return SizedPosition{}, err
	}
	unrounded := risk.Wire(raw)
	q := parseMust(quantity)
	ref := parseMust(in.ReferenceEntry)
	if quantity == "0" && raw.Sign() > 0 {
		warnings = append(warnings, fmt.Sprintf("quantity rounds to zero at step size %s — nothing to send (§70/§71)", in.Instrument.StepSize))
	} else if q.Cmp(raw) < 0 {
		warnings = append(warnings, fmt.Sprintf("quantity %s rounded DOWN to %s (step %s, §71 risk-safe)", unrounded, quantity, in.Instrument.StepSize))
	}
	notional := rmul(rmul(q, ref), mult)
	if q.Sign() > 0 && in.Instrument.MinNotional != nil {
		min := parseMust(*in.Instrument.MinNotional)
		if notional.Cmp(min) < 0 {
			warnings = append(warnings, fmt.Sprintf("notional %s is below the venue minimum %s — the venue will reject this order (§70)", risk.USD2(notional), risk.USD2(min)))
		}
	}
	entryFee := rmul(notional, rE)
	exitNotional := rmul(rmul(q, parseMust(primaryExit)), mult)
	exitFee := rmul(exitNotional, rX)
	slipBudget := rzero()
	if entryType != risk.EntryLimit {
		slipBudget = rmul(notional, slip)
	}
	out := base
	out.Quantity = quantity
	out.UnroundedQuantity = unrounded
	out.Notional = risk.Wire(notional)
	out.EntryFee = risk.Wire(entryFee)
	out.ExitFee = risk.Wire(exitFee)
	out.SlippageBudget = risk.Wire(slipBudget)
	out.Warnings = warnings
	if stop != nil {
		st := parseMust(*stop)
		priceRisk := rmul(rmul(q, mult), rabs(rsub(ref, st)))
		safetyReserve := rmul(priceRisk, reservePct)
		totalRisk := radd(radd(radd(priceRisk, entryFee), radd(exitFee, slipBudget)), safetyReserve)
		out.PriceRisk = strPtr(risk.Wire(priceRisk))
		out.SafetyReserve = strPtr(risk.Wire(safetyReserve))
		out.TotalRisk = strPtr(risk.Wire(totalRisk))
	}
	return out, nil
}

// SizeScaleInRisk sizes a scale-in ladder against EVERY potential fill (§33).
// Per unit the risk is the fraction-weighted Σfᵢ|levelᵢ − stop| — NOT the top
// level and NOT the VWAP — plus fees on each level's own notional and one exit
// fee on the whole filled position. A level sitting ON the stop means unbounded
// risk and is refused, never traded. boundOverride carries the §37/§117 hard
// bound when it is tighter than the sizing budget.
func SizeScaleInRisk(in SizeInputs, boundOverride *string) (SizedPosition, error) {
	warnings := []string{}
	var errs []FieldError
	instrument := in.Instrument
	mult, err := risk.MultOf(instrument)
	if err != nil {
		return SizedPosition{}, err
	}
	entryType := in.EntryType
	empty := SizedPosition{
		Quantity: "0", UnroundedQuantity: "0", Notional: "0",
		EntryFee: "0", ExitFee: "0", SlippageBudget: "0",
		Warnings: warnings, Errors: errs,
	}
	if len(in.Levels) == 0 {
		empty.Warnings = append(warnings, "scale_in has no levels")
		return empty, nil
	}
	var basis *execution.BalanceBasis
	var basisVal *string
	if IsPercentMode(in.Sizing.Mode) {
		b := in.Sizing.Basis
		basis = &b
		if b == "" {
			errs = append(errs, fieldErr(CodeSizingBasisMissing, "sizing.balanceBasis",
				"percentage sizing requires an explicit balance basis (PRD §10)"))
			empty.Errors = errs
			return empty, nil
		}
		if in.Balances == nil {
			errs = append(errs, fieldErr(CodeSizingBasisUnresolved, "sizing.balanceBasis", "'%s' could not be resolved from the account snapshot", b))
			empty.Errors = errs
			return empty, nil
		}
		resolved := risk.ResolveBalanceBasis(b, *in.Balances)
		if resolved == nil {
			errs = append(errs, fieldErr(CodeSizingBasisUnresolved, "sizing.balanceBasis", "'%s' could not be resolved from the account snapshot", b))
			empty.Errors = errs
			return empty, nil
		}
		basisVal = resolved
	}
	// boundOverride carries the §37/§117 hard bound, which may be tighter than
	// the sizing mode's own budget (§8).
	var budget *big.Rat
	if boundOverride != nil {
		budget = parseMust(*boundOverride)
	} else {
		value := ValueOf(in.Sizing)
		if in.Sizing.Mode == execution.SizingRiskUSD {
			budget = parseMust(value)
		} else {
			pct := parseMust(value)
			budget = rquo(rmul(parseMust(*basisVal), pct), big.NewRat(100, 1))
		}
	}
	rE, rX, err := risk.FeeRates(in.FeeModel, entryType)
	if err != nil {
		return SizedPosition{}, err
	}
	slip, reservePct, err := risk.SlipRates(in.SlippageModel, entryType)
	if err != nil {
		return SizedPosition{}, err
	}
	stop := parseMust(*in.Stop)
	// Per-unit risk of the whole ladder, weighted by each level's fraction.
	weightedDistance := rzero()
	entryNotionalPerUnit := rzero()
	for _, level := range in.Levels {
		f := parseMust(level.Fraction)
		price := parseMust(level.Price)
		weightedDistance = radd(weightedDistance, rmul(f, rabs(rsub(price, stop))))
		entryNotionalPerUnit = radd(entryNotionalPerUnit, rmul(rmul(f, price), mult))
	}
	// Fees per unit: each level pays its own entry fee, the whole position pays
	// one exit fee at the stop, and a market entry pays slippage on its own
	// notional (exactly once).
	perUnitFees := rmul(entryNotionalPerUnit, rE)
	perUnitFees = radd(perUnitFees, rmul(rmul(stop, mult), rX))
	if entryType != risk.EntryLimit {
		perUnitFees = radd(perUnitFees, rmul(entryNotionalPerUnit, slip))
	}
	perUnitTotal := radd(radd(rmul(weightedDistance, mult), perUnitFees), rmul(rmul(weightedDistance, mult), reservePct))
	if perUnitTotal.Sign() <= 0 {
		// A level sitting ON the stop makes the loss unbounded — a refusal, not
		// a warning-sized zero (house rule: never trade invalid).
		errs = append(errs, fieldErr(CodeUnboundedRisk, "execution.levels",
			"a level sits on the stop: loss is unbounded, the ladder is refused"))
		empty.Warnings = append(warnings, "scale_in levels sit on the stop: risk is unbounded")
		empty.Errors = errs
		empty.Budget = strPtr(risk.Wire(budget))
		empty.RiskBasis = basis
		empty.BalanceReference = basisVal
		return empty, nil
	}
	raw := rquo(budget, perUnitTotal)
	quantity, err := risk.RoundQuantityDown(rstr(raw), instrument)
	if err != nil {
		return SizedPosition{}, err
	}
	q := parseMust(quantity)
	notional := rmul(q, entryNotionalPerUnit)
	priceRisk := rmul(rmul(q, weightedDistance), mult)
	entryFee := rmul(rmul(q, entryNotionalPerUnit), rE)
	exitFee := rmul(rmul(rmul(q, stop), mult), rX)
	slipBudget := rzero()
	if entryType != risk.EntryLimit {
		slipBudget = rmul(rmul(q, entryNotionalPerUnit), slip)
	}
	safetyReserve := rmul(priceRisk, reservePct)
	totalRisk := radd(radd(radd(priceRisk, entryFee), radd(exitFee, slipBudget)), safetyReserve)
	if totalRisk.Cmp(budget) > 0 {
		// Exact rational compare; the TS float check carried a 1e-9 slack that
		// exact arithmetic does not need.
		errs = append(errs, fieldErr(CodeSizingBudgetExceeded, "riskBudget",
			"risk budget exceeded: the ladder needs %s but the budget is %s", risk.USD2(totalRisk), risk.USD2(budget)))
	}
	vwap, err := LadderVWAP(in.Levels)
	if err != nil {
		return SizedPosition{}, err
	}
	return SizedPosition{
		Quantity: quantity, UnroundedQuantity: risk.Wire(raw), Notional: risk.Wire(notional),
		Budget: strPtr(risk.Wire(budget)), RiskBasis: basis, BalanceReference: basisVal,
		PriceRisk: strPtr(risk.Wire(priceRisk)), EntryFee: risk.Wire(entryFee), ExitFee: risk.Wire(exitFee),
		SlippageBudget: risk.Wire(slipBudget), SafetyReserve: strPtr(risk.Wire(safetyReserve)),
		TotalRisk: strPtr(risk.Wire(totalRisk)), EstimatedEntry: vwap,
		Warnings: warnings, Errors: errs,
	}, nil
}

// availableNonPositive reports whether a balance figure parses to <= 0 — an
// unusable margin basis (plan.ts `availableBalance <= 0`).
func availableNonPositive(v *string) bool {
	r, err := parse(*v, "balances")
	if err != nil {
		return true
	}
	return r.Sign() <= 0
}

// ResolveLeverageAndMargin applies the leverage/margin/liquidation policy
// (PRD §17–§21; plan.ts resolveLeverageAndMargin). Spot: no leverage — the
// margin figure IS the required capital (§16). Futures: manual is user-picked;
// absent means AUTO_SAFE with the profile cap — the product promise of §4 G4:
// risk → size → leverage → margin, never the reverse.
func ResolveLeverageAndMargin(in SizeInputs, notional *big.Rat, warnings *[]string) (MarginResolution, error) {
	none := MarginResolution{}
	if in.MarketType == execution.MarketSpot || notional.Sign() == 0 {
		if in.MarketType == execution.MarketSpot {
			none.Margin = strPtr(risk.Wire(notional))
		}
		return none, nil
	}
	stop := in.Stop
	mmr := in.Instrument.MaintenanceMarginRate
	var lev *big.Rat
	if in.Leverage.Mode == execution.LeverageManual {
		l, err := parse(in.Leverage.Leverage, "leverage.leverage")
		if err != nil {
			return MarginResolution{}, err
		}
		lev = l
	} else {
		available := (*string)(nil)
		if in.Balances != nil {
			if in.Balances.FuturesAvailable != nil {
				available = in.Balances.FuturesAvailable
			} else {
				available = in.Balances.TotalExchangeEquity
			}
		}
		availStr := "0"
		if available != nil {
			availStr = *available
		}
		// The TS warns on a NULL OR non-positive balance — an empty account can
		// no more back a margin calculation than a missing snapshot (plan.ts).
		if available == nil || availableNonPositive(available) {
			*warnings = append(*warnings, "auto_safe: no futures available balance in the snapshot — leverage selection needs one; falling back to 1x with liquidation check only")
		}
		maxLeverage := "10" // DEFAULT_RISK_PROFILE.maxLeverage
		if in.Leverage.MaxLeverage != nil {
			maxLeverage = *in.Leverage.MaxLeverage
		} else {
			profCap := maxLeverage
			if in.RiskProfile != nil && strings.TrimSpace(in.RiskProfile.MaxLeverage) != "" {
				profCap = in.RiskProfile.MaxLeverage
			}
			maxLeverage = profCap
			if in.Instrument.MaxLeverage != nil {
				if cmp, err := decimal.Cmp(*in.Instrument.MaxLeverage, profCap); err == nil && cmp < 0 {
					maxLeverage = *in.Instrument.MaxLeverage
				}
			}
		}
		buffer := "0.2"
		if in.Leverage.LiquidationBufferPct != nil {
			buffer = *in.Leverage.LiquidationBufferPct
		}
		maxMargin := "1"
		if in.Leverage.MaxMarginPct != nil {
			maxMargin = *in.Leverage.MaxMarginPct
		}
		auto, err := risk.AutoSafeLeverage(risk.AutoLeverageInput{
			Side: in.Side, Entry: in.ReferenceEntry, Stop: stop,
			Notional: rstr(notional), AvailableBalance: availStr,
			MaxLeverage: maxLeverage, ExchangeMaxLeverage: in.Instrument.MaxLeverage,
			LiquidationBufferPct: buffer, MaxMarginPct: maxMargin,
			MaintenanceMarginRate: mmr,
		})
		if err != nil {
			return MarginResolution{}, err
		}
		*warnings = append(*warnings, auto.Warnings...)
		if !auto.LiquidationSafe {
			*warnings = append(*warnings, "auto_safe: no leverage satisfies both margin and the SL→liquidation buffer — liquidation is NOT safely beyond the stop (§20)")
		}
		lev = parseMust(auto.Selected)
	}
	margin := rquo(notional, lev)
	priceStr, err := risk.LiquidationPriceApprox(in.Side, in.ReferenceEntry, rstr(lev), mmr)
	if err != nil {
		return MarginResolution{}, err
	}
	priceApprox := parseMust(priceStr)
	out := MarginResolution{
		Leverage:         strPtr(risk.Wire(lev)),
		Margin:           strPtr(risk.Wire(margin)),
		LiquidationPrice: strPtr(priceStr),
	}
	if stop != nil {
		st := parseMust(*stop)
		var buffer *big.Rat
		if in.Side == execution.SideSell {
			b := rsub(priceApprox, st)
			buffer = b
		} else {
			b := rsub(st, priceApprox)
			buffer = b
		}
		safe := buffer.Sign() > 0
		out.StopToLiquidationBuffer = strPtr(risk.Wire(buffer))
		out.LiquidationSafe = &safe
		stopDistance := rabs(rsub(parseMust(in.ReferenceEntry), st))
		if safe && stopDistance.Sign() > 0 && buffer.Cmp(rmul(stopDistance, big.NewRat(2, 10))) < 0 {
			*warnings = append(*warnings, fmt.Sprintf("SL→liquidation buffer %s is under 20%% of the stop distance (§20) — thin protection", risk.USD2(buffer)))
		}
	}
	return out, nil
}

// parseMust parses a validated internal figure; sizing paths only hand it
// values that earlier exact steps produced or that validation already refused.
func parseMust(s string) *big.Rat {
	r, err := decimal.Parse(s)
	if err != nil {
		panic(fmt.Sprintf("sizing: unparseable internal figure %q: %v", s, err))
	}
	return r
}

func strPtr(s string) *string { return &s }
