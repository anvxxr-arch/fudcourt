package planner

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/risk"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/sizing"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// DefaultSlippageModel is the house-default slippage model (plan.ts). The API
// may override per venue after measurement.
var DefaultSlippageModel = risk.SlippageModel{SlippageBps: "5", SafetyReservePct: "0.01"}

// DefaultRiskProfile mirrors types.ts DEFAULT_RISK_PROFILE for callers with no
// account profile.
var DefaultRiskProfile = execution.RiskProfile{
	DefaultRiskMode:         "risk_percent",
	DefaultRisk:             "1",
	MaxRiskPerTradePct:      "2",
	MaxOpenRiskPct:          "5",
	MaxDailyLossPct:         "5",
	MaxLeverage:             "10",
	DefaultMarginMode:       execution.MarginIsolated,
	DefaultExecutionUrgency: execution.UrgencyBalanced,
}

// PlanExecution is the deterministic request → plan transformation
// (objective §8.11; plan.ts planExecution). Validation failures return a
// PlanError carrying EVERY field-named message; a non-empty Conflicts slice
// BLOCKS creation (PRD §117) while still showing Requested vs Possible.
func PlanExecution(inputs PlanInputs) (PlanResult, error) {
	req := inputs.Request
	entryType := risk.EntryMarket
	if req.Entry.Kind == "limit" {
		entryType = risk.EntryLimit
	}
	// 1. reference price first: a market entry with no snapshot cannot be priced.
	refPrice, err := ResolveEstimatedEntry(req, inputs.Market)
	if err != nil {
		return PlanResult{}, err
	}
	// A Scale In ladder fills at several prices, so its realized entry is the
	// fraction-weighted average, not the top-level limit (§33): one economic
	// price feeds liquidation (§17/§21), notional, the profit projection (§13)
	// and the R:R the user reads (§84).
	estimatedEntry := refPrice
	if req.Execution.Type == execution.StrategyScaleIn {
		vwap, err := sizing.LadderVWAP(req.Execution.Levels)
		if err != nil {
			return PlanResult{}, err
		}
		estimatedEntry = vwap
	}
	if validation := unique(ValidatePlanInputs(inputs, refPrice)); len(validation) > 0 {
		return PlanResult{}, &PlanError{
			Code: CodeValidationFailed, Field: firstField(validation),
			Message: validation[0], Validation: validation,
		}
	}
	warnings := []string{}
	var conflicts []Conflict
	mult, err := risk.MultOf(inputs.Instrument)
	if err != nil {
		return PlanResult{}, err
	}
	stop := (*string)(nil)
	if req.StopLoss != nil {
		stop = &req.StopLoss.Price
	}
	tps := req.TakeProfits
	var primaryTp *string
	if len(tps) > 0 {
		primaryTp = &tps[0].Price
	}
	// 2. size.
	sized, err := sizing.SizePosition(sizingInputs(inputs, refPrice, entryType))
	if err != nil {
		return PlanResult{}, err
	}
	if len(sized.Errors) > 0 {
		messages := make([]string, 0, len(sized.Errors))
		for _, fe := range sized.Errors {
			messages = append(messages, fe.Error())
		}
		return PlanResult{}, &PlanError{
			Code: CodeValidationFailed, Field: firstField(messages),
			Message: messages[0], Validation: messages,
		}
	}
	warnings = append(warnings, sized.Warnings...)
	quantity := sized.Quantity
	unroundedQuantity := sized.UnroundedQuantity
	notional := sized.Notional
	priceRisk := sized.PriceRisk
	entryFee := sized.EntryFee
	exitFee := sized.ExitFee
	safetyReserve := sized.SafetyReserve
	totalRisk := sized.TotalRisk
	riskBound := req.MaxRisk
	if riskBound == nil {
		riskBound = sized.Budget
	}
	// 3. dual-bound validation (§14): the risk bound is HARD, profit is a target.
	if req.TargetProfit != nil && primaryTp != nil {
		achievableStr, err := risk.EstimateNetProfit(risk.EstimateNetProfitInput{
			Side: req.Side, Entry: estimatedEntry, Quantity: quantity, TakeProfits: tps,
			FeeModel: inputs.FeeModel, SlippageModel: inputs.SlippageModel,
			Instrument: inputs.Instrument, EntryType: entryType,
		})
		if err != nil {
			return PlanResult{}, err
		}
		achievable := mustRat(achievableStr)
		target := mustRat(*req.TargetProfit)
		tol := maxRat(big.NewRat(1, 1_000_000_000), new(big.Rat).Quo(target, big.NewRat(1_000_000_000, 1)))
		if achievable.Cmp(new(big.Rat).Sub(target, tol)) < 0 {
			// What it would take to hit the target (the PRD's "Required Risk ≈ $Y").
			qProfit, err := risk.CalculateProfitPosition(risk.ProfitPositionInput{
				Side: req.Side, Entry: refPrice, Target: *primaryTp, DesiredProfit: *req.TargetProfit,
				FeeModel: inputs.FeeModel, SlippageModel: inputs.SlippageModel,
				Instrument: inputs.Instrument, EntryType: entryType,
			})
			if err != nil {
				return PlanResult{}, err
			}
			var requiredRisk *big.Rat
			if stop != nil {
				pr, err := risk.ProjectedRisk(risk.ProjectedRiskInput{
					Side: req.Side, AverageEntry: refPrice, Quantity: qProfit.Quantity, Stop: *stop,
					FeeModel: inputs.FeeModel, SlippageModel: inputs.SlippageModel,
					Instrument: inputs.Instrument,
				})
				if err != nil {
					return PlanResult{}, err
				}
				requiredRisk = mustRat(pr.TotalRisk)
			} else {
				requiredRisk = new(big.Rat).Mul(new(big.Rat).Mul(mustRat(qProfit.Quantity), mustRat(refPrice)), mult)
			}
			requestedMaxLoss := big.NewRat(0, 1)
			if riskBound != nil {
				requestedMaxLoss = mustRat(*riskBound)
			} else if totalRisk != nil {
				requestedMaxLoss = mustRat(*totalRisk)
			}
			shownLoss := requestedMaxLoss
			if totalRisk != nil {
				shownLoss = mustRat(*totalRisk)
			}
			code := "target_profit_unreachable"
			if riskBound != nil {
				code = "risk_vs_profit"
			}
			conflicts = append(conflicts, Conflict{
				Code: code,
				Message: fmt.Sprintf(
					"Requested: max loss %s, target profit %s. Possible using current SL/TP: max loss %s, profit %s. To achieve %s target: required risk ≈ %s.",
					risk.USD2(requestedMaxLoss), risk.USD2(target), risk.USD2(shownLoss), risk.USD2(achievable),
					risk.USD2(target), risk.USD2(requiredRisk)),
				Detail: map[string]string{
					"requestedMaxLoss":      risk.Wire(requestedMaxLoss),
					"requestedTargetProfit": risk.Wire(target),
					"achievableProfit":      risk.Wire(achievable),
					"requiredRisk":          risk.Wire(requiredRisk),
				},
			})
		}
	}
	// 4. hard risk bound (§37/§117): a request whose projected risk exceeds the
	//    bound is RESIZED to the safe quantity and BLOCKED from creation.
	if riskBound != nil && stop != nil && totalRisk != nil &&
		mustRat(*totalRisk).Cmp(addTol(mustRat(*riskBound))) > 0 {
		requestedRisk := mustRat(*totalRisk)
		if req.Execution.Type == execution.StrategyScaleIn {
			// `MaxSafeQuantity` prices from a single reference entry, so feeding
			// it a ladder's VWAP would UNDER-count the per-unit risk
			// (Σfᵢ|levelᵢ − stop|) and hand back a quantity that breaches the
			// very bound being enforced. Re-solve the ladder against the bound.
			safe, err := sizing.SizeScaleInRisk(sizingInputs(inputs, refPrice, entryType), riskBound)
			if err != nil {
				return PlanResult{}, err
			}
			quantity = safe.Quantity
			unroundedQuantity = safe.UnroundedQuantity
			notional = safe.Notional
			priceRisk = safe.PriceRisk
			entryFee = safe.EntryFee
			exitFee = safe.ExitFee
			safetyReserve = safe.SafetyReserve
			totalRisk = safe.TotalRisk
		} else {
			maxSafe, err := risk.MaxSafeQuantity(risk.MaxSafeQuantityInput{
				Side: req.Side, ReferenceEntry: refPrice, Stop: *stop,
				RemainingBudget: *riskBound, FilledQuantity: "0",
				FeeModel: inputs.FeeModel, SlippageModel: inputs.SlippageModel,
				Instrument: inputs.Instrument,
			})
			if err != nil {
				return PlanResult{}, err
			}
			quantity = maxSafe.MaxAdditionalQuantity
			unroundedQuantity = maxSafe.UnroundedAdditionalQuantity
			notional = risk.Wire(new(big.Rat).Mul(new(big.Rat).Mul(mustRat(quantity), mustRat(refPrice)), mult))
			priceRisk = strPtr(maxSafe.ProjectedRiskAfter.PriceRisk)
			entryFee = maxSafe.ProjectedRiskAfter.EntryFee
			exitFee = maxSafe.ProjectedRiskAfter.ExitFee
			safetyReserve = strPtr(maxSafe.ProjectedRiskAfter.SafetyReserve)
			totalRisk = strPtr(maxSafe.ProjectedRiskAfter.TotalRisk)
		}
		conflicts = append(conflicts, Conflict{
			Code: "risk_bound_exceeded",
			Message: fmt.Sprintf(
				"Projected risk %s exceeds the %s bound — creation is blocked (PRD §117). Safe quantity at the bound: %s.",
				risk.USD2(requestedRisk), risk.USD2(mustRat(*riskBound)), quantity),
			Detail: map[string]string{
				"maxRisk":       *riskBound,
				"projectedRisk": risk.Wire(requestedRisk),
				"safeQuantity":  quantity,
			},
		})
		warnings = append(warnings, fmt.Sprintf("quantity resized %s → %s to hold the %s risk bound (§37)",
			unroundedQuantity, quantity, risk.USD2(mustRat(*riskBound))))
	}
	// 5. balance sufficiency (§79) — block, don't hope.
	marginRes, err := sizing.ResolveLeverageAndMargin(sizingInputs(inputs, refPrice, entryType), mustRat(notional), &warnings)
	if err != nil {
		return PlanResult{}, err
	}
	warnings = append(warnings, marginRes.Warnings...)
	if inputs.Balances != nil {
		avail := inputs.Balances.FuturesAvailable
		which := "futures"
		if req.MarketType == execution.MarketSpot {
			avail = inputs.Balances.SpotAvailable
			which = "spot"
		}
		if avail != nil && marginRes.Margin != nil && mustRat(*marginRes.Margin).Cmp(addTol(mustRat(*avail))) > 0 {
			conflicts = append(conflicts, Conflict{
				Code: "insufficient_balance",
				Message: fmt.Sprintf("Required margin %s exceeds available %s balance %s.",
					risk.USD2(mustRat(*marginRes.Margin)), which, risk.USD2(mustRat(*avail))),
				Detail: map[string]string{
					"requiredMargin":   *marginRes.Margin,
					"availableBalance": *avail,
				},
			})
		}
	}
	// 6. plan + preview figures (§80/§84).
	durationMs := (*int64)(nil)
	if req.Execution.Type == execution.StrategyTWAP || req.Execution.Type == execution.StrategyAdaptiveTWAP {
		durationMs = req.Execution.DurationMs
	} else if req.Constraints != nil && req.Constraints.MaxDurationMs != nil {
		durationMs = req.Constraints.MaxDurationMs
	}
	slices, err := EstimateSlices(req, quantity)
	if err != nil {
		return PlanResult{}, err
	}
	leverageMode := execution.LeverageAutoSafe
	if req.MarketType == execution.MarketSpot {
		leverageMode = execution.LeverageManual
	} else if req.Leverage != nil {
		leverageMode = req.Leverage.Mode
	}
	budget := sized.Budget
	if budget == nil {
		budget = req.MaxRisk
	}
	estimatedFees := risk.Wire(new(big.Rat).Add(mustRat(entryFee), mustRat(exitFee)))
	result := PlanResult{
		Quantity:         quantity,
		Notional:         notional,
		RequiredMargin:   marginRes.Margin,
		EstimatedEntry:   estimatedEntry,
		LiquidationPrice: marginRes.LiquidationPrice,
		Conflicts:        conflicts,
		Warnings:         warnings,

		UnroundedQuantity: unroundedQuantity,
		StopLoss:          stop,
		TakeProfits:       tps,
		Risk: PlanRisk{
			Budget: budget, EstimatedTotalRisk: totalRisk, PriceRisk: priceRisk,
			EstimatedFees: estimatedFees, SlippageBudget: sized.SlippageBudget, SafetyReserve: safetyReserve,
		},
		Leverage:          PlanLeverage{Mode: leverageMode, Selected: marginRes.Leverage},
		LiquidationBuffer: marginRes.StopToLiquidationBuffer,
		LiquidationSafe:   marginRes.LiquidationSafe,
		EstimatedSlices:   slices,
		DurationMs:        durationMs,
		SizingMode:        req.Sizing.Mode,
		RiskBasis:         sized.RiskBasis,
		BalanceReference:  sized.BalanceReference,
	}
	expectedLossAtStop := (*string)(nil)
	if totalRisk != nil {
		loss := new(big.Rat).Neg(mustRat(*totalRisk))
		expectedLossAtStop = strPtr(risk.Wire(loss))
	}
	if primaryTp != nil {
		profitStr, err := risk.EstimateNetProfit(risk.EstimateNetProfitInput{
			Side: req.Side, Entry: refPrice, Quantity: quantity, TakeProfits: tps,
			FeeModel: inputs.FeeModel, SlippageModel: inputs.SlippageModel,
			Instrument: inputs.Instrument, EntryType: entryType,
		})
		if err != nil {
			return PlanResult{}, err
		}
		result.ExpectedProfitAtTarget = strPtr(profitStr)
		result.TargetPrice = primaryTp
		if expectedLossAtStop != nil && mustRat(*expectedLossAtStop).Sign() < 0 {
			rr := new(big.Rat).Quo(mustRat(profitStr), absRat(mustRat(*expectedLossAtStop)))
			result.RiskReward = strPtr(risk.Wire(rr))
		}
		if mustRat(profitStr).Sign() < 0 {
			warnings = append(warnings, fmt.Sprintf("fees and slippage exceed the gross target profit — the target would realize %s", risk.USD2(mustRat(profitStr))))
			result.Warnings = warnings
		}
	}
	result.ExpectedLossAtStop = expectedLossAtStop
	return result, nil
}

// EstimateSlices projects the slice count for the plan block (PRD §56): the
// engine owns the runtime split — the planner only counts it, on the naive
// equal schedule, and NEVER invents jitter (DR-021 §2g).
func EstimateSlices(req ExecutionRequest, quantity string) (*int, error) {
	ex := req.Execution
	switch ex.Type {
	case execution.StrategyTWAP, execution.StrategyAdaptiveTWAP:
		if ex.Slices != nil {
			return ex.Slices, nil
		}
		if ex.DurationMs == nil {
			return nil, nil
		}
		s := defaultSlices(*ex.DurationMs)
		return &s, nil
	case execution.StrategyIceberg:
		q, err := decimal.Parse(quantity)
		if err != nil {
			return nil, err
		}
		visible, err := decimal.Parse(ex.VisibleQuantity)
		if err != nil {
			return nil, err
		}
		n := ceilDivInt(q, visible)
		if n < 1 {
			n = 1
		}
		return &n, nil
	case execution.StrategyScaleIn, execution.StrategyScaleOut:
		n := len(ex.Levels)
		return &n, nil
	default:
		return nil, nil
	}
}

// defaultSlices is the naive TWAP schedule count (engine.ts defaultSlices):
// one slice per 150s of duration, clamped to [1, 40]. Deterministic — the
// jitter knobs opt in at runtime and are never synthesized here.
func defaultSlices(durationMs int64) int {
	n := (durationMs + 149_999) / 150_000
	if n < 1 {
		n = 1
	}
	if n > 40 {
		n = 40
	}
	return int(n)
}

// sizingInputs projects planner inputs onto the sizing package's shape.
func sizingInputs(inputs PlanInputs, refPrice string, entryType risk.EntryType) sizing.SizeInputs {
	req := inputs.Request
	var levels []execution.ScaleLevel
	if req.Execution.Type == execution.StrategyScaleIn {
		levels = req.Execution.Levels
	}
	lev := sizing.LeverageSpec{Mode: execution.LeverageManual}
	if req.Leverage != nil {
		lev = *req.Leverage
	}
	stop := (*string)(nil)
	if req.StopLoss != nil {
		stop = &req.StopLoss.Price
	}
	return sizing.SizeInputs{
		Sizing: req.Sizing, Symbol: req.Symbol, MarketType: req.MarketType, Side: req.Side,
		EntryType: entryType, ReferenceEntry: refPrice, Stop: stop, TakeProfits: req.TakeProfits,
		Levels: levels, FeeModel: inputs.FeeModel, SlippageModel: inputs.SlippageModel,
		Instrument: inputs.Instrument, Balances: inputs.Balances, RiskProfile: inputs.RiskProfile,
		Leverage: lev, MaxRisk: req.MaxRisk,
	}
}

// addTol is the plan.ts float-compare slack `x + max(1e-9, x·1e-9)`: exact
// rationals need no slack, but a strict greater-than against x itself would
// re-pin a TS-accepted equality as a refusal. Kept for literal parity.
func addTol(x *big.Rat) *big.Rat {
	tol := maxRat(big.NewRat(1, 1_000_000_000), new(big.Rat).Quo(x, big.NewRat(1_000_000_000, 1)))
	return new(big.Rat).Add(x, tol)
}

func maxRat(a, b *big.Rat) *big.Rat {
	if a.Cmp(b) > 0 {
		return a
	}
	return b
}

func absRat(a *big.Rat) *big.Rat { return new(big.Rat).Abs(a) }

func rstr(a *big.Rat) string { return decimal.Trim(a) }

func strPtr(s string) *string { return &s }

// ceilDivInt returns ceil(a/b) as an int (iceberg slice count, §31).
func ceilDivInt(a, b *big.Rat) int {
	q := new(big.Rat).Quo(a, b)
	if q.IsInt() {
		return int(q.Num().Int64())
	}
	whole := new(big.Int).Quo(q.Num(), q.Denom())
	if q.Sign() > 0 {
		whole.Add(whole, big.NewInt(1))
	}
	return int(whole.Int64())
}

// unique preserves order while dropping repeats (TS `[...new Set(errors)]`).
func unique(items []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if !seen[item] {
			seen[item] = true
			out = append(out, item)
		}
	}
	return out
}

// firstField extracts the field prefix of a field-named message.
func firstField(messages []string) string {
	for _, m := range messages {
		if i := strings.IndexByte(m, ':'); i > 0 {
			return m[:i]
		}
	}
	return ""
}
