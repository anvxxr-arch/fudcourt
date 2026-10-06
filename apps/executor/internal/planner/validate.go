package planner

import (
	"fmt"
	"math/big"
	"regexp"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/risk"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/sizing"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
)

// symbolPattern is the normalized-symbol grammar (PRD §49): BASE/QUOTE, upper
// alphanumerics, exactly one slash.
var symbolPattern = regexp.MustCompile(`^[A-Z0-9]+/[A-Z0-9]+$`)

// urgencySet is the ExecutionUrgency vocabulary (types.ts).
var urgencySet = map[execution.ExecutionUrgency]bool{
	execution.UrgencyPassive: true, execution.UrgencyBalanced: true,
	execution.UrgencyAggressive: true, execution.UrgencyImmediate: true,
}

func parseOK(s string) (*big.Rat, bool) {
	r, err := decimal.Parse(s)
	if err != nil {
		return nil, false
	}
	return r, true
}

func isPos(s string) bool {
	r, ok := parseOK(s)
	return ok && r.Sign() > 0
}

func isNonNeg(s string) bool {
	r, ok := parseOK(s)
	return ok && r.Sign() >= 0
}

func isPosInt(s string) bool {
	r, ok := parseOK(s)
	return ok && r.Sign() > 0 && r.IsInt()
}

func isNonNegInt(s string) bool {
	r, ok := parseOK(s)
	return ok && r.Sign() >= 0 && r.IsInt()
}

func usd2(s string) string {
	r, ok := parseOK(s)
	if !ok {
		return risk.USD2(new(big.Rat))
	}
	return risk.USD2(r)
}

// ResolveEstimatedEntry returns the price the plan is built around (plan.ts
// resolveEstimatedEntry): a limit entry plans at its own price; a market entry
// plans at the touch — the CONSERVATIVE side of the spread (buy → ask, sell →
// bid), because that is what a market order actually pays (PRD §26). A market
// entry with no snapshot is honestly unpriced; a missing touch is an error
// naming the missing side — never a fabricated price.
func ResolveEstimatedEntry(request ExecutionRequest, snapshot *MarketSnapshot) (string, error) {
	if request.Entry.Kind == "limit" {
		return request.Entry.Price, nil
	}
	if snapshot == nil {
		return "", &PlanError{
			Code: CodeEntryUnpriced, Field: "entry",
			Message: "a market entry requires a market snapshot to price it",
		}
	}
	if request.Side == execution.SideSell {
		if snapshot.Bid == nil {
			return "", &PlanError{
				Code: CodeEntryUnpriced, Field: "entry",
				Message: "market snapshot has no bid to price a sell market entry",
			}
		}
		return *snapshot.Bid, nil
	}
	if snapshot.Ask == nil {
		return "", &PlanError{
			Code: CodeEntryUnpriced, Field: "entry",
			Message: "market snapshot has no ask to price a buy market entry",
		}
	}
	return *snapshot.Ask, nil
}

// ValidatePlanInputs is the strict field validation (plan.ts validatePlanInputs;
// PRD §38, §79's locally-checkable subset, §89). Every message names its field
// — house rule: bad input is a 400 with the field named, never a clamp and
// never a silent default. refPrice is the resolved entry reference.
func ValidatePlanInputs(inputs PlanInputs, refPrice string) []string {
	req := inputs.Request
	instrument := inputs.Instrument
	var errors []string
	profile := inputs.RiskProfile
	entryType := "market"
	if req.Entry.Kind == "limit" {
		entryType = "limit"
	}
	if !symbolPattern.MatchString(req.Symbol) {
		errors = append(errors, fmt.Sprintf("symbol: '%s' is not a normalized symbol (expected BASE/QUOTE, e.g. BTC/USDT)", req.Symbol))
	}
	if req.Symbol != instrument.Symbol {
		errors = append(errors, fmt.Sprintf("symbol: request '%s' does not match instrument '%s'", req.Symbol, instrument.Symbol))
	}
	limitPrice := ""
	if req.Entry.Kind == "limit" {
		limitPrice = req.Entry.Price
	}
	if req.Entry.Kind == "limit" && !isPos(limitPrice) {
		errors = append(errors, "entry.price: must be a positive number for a limit entry")
	}
	// spot product rules (§89): no leverage, no margin mode, no sell-open.
	if req.MarketType == execution.MarketSpot {
		if req.Leverage != nil {
			errors = append(errors, "leverage: not applicable to spot (PRD §89) — remove it or select a linear perpetual")
		}
		if req.MarginMode != nil {
			errors = append(errors, "marginMode: not applicable to spot (PRD §89)")
		}
		if req.Side == execution.SideSell && req.Intent == execution.IntentOpen {
			errors = append(errors, "intent: spot sell-open requires a margin/short product (PRD §89) — use intent close/reduce to sell held assets")
		}
	}
	// stop / target side rules against the entry reference.
	if stop := req.StopLoss; stop != nil {
		if !isPos(stop.Price) {
			errors = append(errors, "stopLoss.price: must be a positive number")
		} else {
			stopP := mustRat(stop.Price)
			refP := mustRat(refPrice)
			wrongSide := (req.Side == execution.SideBuy && stopP.Cmp(refP) >= 0) ||
				(req.Side == execution.SideSell && stopP.Cmp(refP) <= 0)
			if wrongSide {
				errors = append(errors, fmt.Sprintf("stopLoss.price: %s is not on the loss side of entry %s (buy ⇒ stop below entry, sell ⇒ stop above entry)", usd2(stop.Price), usd2(refPrice)))
			}
		}
	}
	if req.TakeProfits == nil {
		errors = append(errors, "takeProfits: must be an array (use [] for none)")
	}
	fractionSum := new(big.Rat)
	for i, tp := range req.TakeProfits {
		if !isPos(tp.Price) {
			errors = append(errors, fmt.Sprintf("takeProfits[%d].price: must be a positive number", i))
		} else {
			tpP := mustRat(tp.Price)
			refP := mustRat(refPrice)
			wrongSide := (req.Side == execution.SideBuy && tpP.Cmp(refP) <= 0) ||
				(req.Side == execution.SideSell && tpP.Cmp(refP) >= 0)
			if wrongSide {
				errors = append(errors, fmt.Sprintf("takeProfits[%d].price: %s is not on the profit side of entry %s", i, usd2(tp.Price), usd2(refPrice)))
			}
		}
		if strings.TrimSpace(tp.Fraction) != "" {
			if !isPos(tp.Fraction) || mustRat(tp.Fraction).Cmp(big.NewRat(1, 1)) > 0 {
				errors = append(errors, fmt.Sprintf("takeProfits[%d].fraction: must be in (0, 1]", i))
			} else {
				fractionSum.Add(fractionSum, mustRat(tp.Fraction))
			}
		} else {
			fractionSum.Add(fractionSum, big.NewRat(1, 1))
		}
	}
	if fractionSum.Cmp(big.NewRat(1, 1)) > 0 {
		errors = append(errors, fmt.Sprintf("takeProfits: close fractions sum to %s — each level closes quantity×fraction and the sum may not exceed 1", decimal.Trim(fractionSum)))
	}
	// sizing (§12/§52) + its prerequisites (§38).
	value := sizing.ValueOf(req.Sizing)
	if !isPos(value) {
		errors = append(errors, "sizing.value: must be a positive number")
	}
	riskMode := sizing.IsRiskMode(req.Sizing.Mode)
	profitMode := sizing.IsProfitMode(req.Sizing.Mode)
	if riskMode && req.StopLoss == nil {
		errors = append(errors, fmt.Sprintf("stopLoss: required for %s sizing — without a stop the position risk is unbounded (PRD §38)", req.Sizing.Mode))
	}
	if profitMode && len(req.TakeProfits) == 0 {
		errors = append(errors, fmt.Sprintf("takeProfits: at least one take-profit is required for %s sizing", req.Sizing.Mode))
	}
	if req.TargetProfit != nil {
		if !isPos(*req.TargetProfit) {
			errors = append(errors, "targetProfit: must be a positive number")
		}
		if len(req.TakeProfits) == 0 {
			errors = append(errors, "targetProfit: requires at least one take-profit level to price the outcome")
		}
	}
	if req.MaxRisk != nil {
		if !isPos(*req.MaxRisk) {
			errors = append(errors, "maxRisk: must be a positive number")
		}
		if req.StopLoss == nil {
			errors = append(errors, "maxRisk: requires a stop-loss to bound the loss (PRD §38)")
		}
	}
	if req.Sizing.Mode == execution.SizingFixedMargin && req.MarketType == execution.MarketLinearPerp {
		if req.Leverage == nil || req.Leverage.Mode != execution.LeverageManual {
			errors = append(errors, "leverage: fixed_margin sizing requires mode 'manual' — margin alone cannot determine notional without a leverage")
		}
	}
	// leverage (§18/§53) + profile cap (§88).
	if lev := req.Leverage; lev != nil && lev.Mode == execution.LeverageManual {
		if !isPosInt(lev.Leverage) {
			errors = append(errors, "leverage.leverage: must be a positive integer")
		} else {
			lv := mustRat(lev.Leverage)
			if instrument.MaxLeverage != nil && lv.Cmp(mustRat(*instrument.MaxLeverage)) > 0 {
				errors = append(errors, fmt.Sprintf("leverage.leverage: %sx exceeds the exchange maximum %sx", lev.Leverage, *instrument.MaxLeverage))
			}
			if profile != nil && isPos(profile.MaxLeverage) && lv.Cmp(mustRat(profile.MaxLeverage)) > 0 {
				errors = append(errors, fmt.Sprintf("leverage.leverage: %sx exceeds your risk profile maximum %sx (maxLeverage)", lev.Leverage, profile.MaxLeverage))
			}
		}
	}
	if lev := req.Leverage; lev != nil && lev.Mode == execution.LeverageAutoSafe {
		if lev.MaxLeverage != nil && !isPosInt(*lev.MaxLeverage) {
			errors = append(errors, "leverage.maxLeverage: must be a positive integer")
		}
		if lev.LiquidationBufferPct != nil && !isNonNeg(*lev.LiquidationBufferPct) {
			errors = append(errors, "leverage.liquidationBufferPct: must be >= 0")
		}
		if lev.MaxMarginPct != nil && (!isPos(*lev.MaxMarginPct) || mustRat(*lev.MaxMarginPct).Cmp(big.NewRat(1, 1)) > 0) {
			errors = append(errors, "leverage.maxMarginPct: must be in (0, 1]")
		}
	}
	// execution method (§54) — its parameters and its pairing with the entry type.
	ex := req.Execution
	switch ex.Type {
	case execution.StrategyMarket:
		if entryType != "market" {
			errors = append(errors, "execution: a market execution requires entry type market")
		}
	case execution.StrategyLimit:
		if req.Entry.Kind != "limit" {
			errors = append(errors, "execution: a limit execution requires entry type limit")
		} else if isPos(ex.Price) && ex.Price != req.Entry.Price {
			errors = append(errors, "execution.price: must match entry.price — the entry defines the price level, the execution the method")
		}
	case execution.StrategyTWAP, execution.StrategyAdaptiveTWAP:
		if ex.DurationMs == nil || *ex.DurationMs <= 0 {
			errors = append(errors, "execution.durationMs: must be a positive number")
		}
		if ex.Slices != nil && *ex.Slices < 1 {
			errors = append(errors, "execution.slices: must be a positive integer")
		}
		if ex.Type == execution.StrategyAdaptiveTWAP && !urgencySet[ex.Urgency] {
			errors = append(errors, "execution.urgency: must be passive | balanced | aggressive | immediate")
		}
		// Jitter is a bounded perturbation, not a licence to slice 0 or negative
		// quantity: below 1 a slice can be floored away and normalized upwards,
		// and above 100% the schedule becomes unrepresentable. Refuse, never
		// clamp (§55).
		if cfg := ex.Config; cfg != nil {
			if cfg.DurationMs != nil && ex.DurationMs != nil && *cfg.DurationMs != *ex.DurationMs {
				errors = append(errors, "execution.config.durationMs: must match execution.durationMs")
			}
			if cfg.OrderType != "market" && cfg.OrderType != "limit" && cfg.OrderType != "maker" {
				errors = append(errors, "execution.config.orderType: must be market | limit | maker")
			}
			for _, jitter := range []struct {
				key string
				val *string
			}{{"quantityJitterPct", cfg.QuantityJitterPct}, {"intervalJitterPct", cfg.IntervalJitterPct}} {
				if jitter.val == nil {
					continue
				}
				if !isNonNeg(*jitter.val) || mustRat(*jitter.val).Cmp(big.NewRat(1, 1)) >= 0 {
					errors = append(errors, fmt.Sprintf("execution.config.%s: must be a fraction in [0, 1)", jitter.key))
				}
			}
		}
	case execution.StrategyIceberg:
		if !isPos(ex.VisibleQuantity) {
			errors = append(errors, "execution.visibleQuantity: must be a positive number")
		}
	case execution.StrategyChaseLimit:
		if !urgencySet[ex.Urgency] {
			errors = append(errors, "execution.urgency: must be passive | balanced | aggressive | immediate")
		}
		if ex.MaxReplacements != nil && *ex.MaxReplacements < 0 {
			errors = append(errors, "execution.maxReplacements: must be a non-negative integer")
		}
		if ex.MaxChaseDistance != nil && !isNonNeg(*ex.MaxChaseDistance) {
			errors = append(errors, "execution.maxChaseDistance: must be >= 0")
		}
	case execution.StrategyScaleIn, execution.StrategyScaleOut:
		if len(ex.Levels) == 0 {
			errors = append(errors, "execution.levels: must be a non-empty array")
		} else {
			sum := new(big.Rat)
			for i, l := range ex.Levels {
				if !isPos(l.Price) {
					errors = append(errors, fmt.Sprintf("execution.levels[%d].price: must be a positive number", i))
				}
				if !isPos(l.Fraction) || mustRat(l.Fraction).Cmp(big.NewRat(1, 1)) > 0 {
					errors = append(errors, fmt.Sprintf("execution.levels[%d].fraction: must be in (0, 1]", i))
				} else {
					sum.Add(sum, mustRat(l.Fraction))
				}
			}
			if sum.Cmp(big.NewRat(1, 1)) != 0 {
				errors = append(errors, fmt.Sprintf("execution.levels: fractions must sum to 1 (got %s)", decimal.Trim(sum)))
			}
		}
	}
	// constraints (§55) — never clamped; a self-contradicting request is an error.
	if c := req.Constraints; c != nil {
		if c.MaxSlippageBps != nil && !isNonNeg(*c.MaxSlippageBps) {
			errors = append(errors, "constraints.maxSlippageBps: must be >= 0")
		}
		if c.MaxSpreadBps != nil && !isNonNeg(*c.MaxSpreadBps) {
			errors = append(errors, "constraints.maxSpreadBps: must be >= 0")
		}
		if c.MaxPrice != nil && !isPos(*c.MaxPrice) {
			errors = append(errors, "constraints.maxPrice: must be a positive number")
		}
		if c.MinPrice != nil && !isPos(*c.MinPrice) {
			errors = append(errors, "constraints.minPrice: must be a positive number")
		}
		if c.MaxPrice != nil && c.MinPrice != nil && isPos(*c.MaxPrice) && isPos(*c.MinPrice) && mustRat(*c.MinPrice).Cmp(mustRat(*c.MaxPrice)) > 0 {
			errors = append(errors, "constraints: minPrice exceeds maxPrice")
		}
		if c.MaxDurationMs != nil && *c.MaxDurationMs <= 0 {
			errors = append(errors, "constraints.maxDurationMs: must be a positive number")
		}
		if c.MakerOnly && (ex.Type == execution.StrategyMarket || (entryType == "market" && ex.Type != execution.StrategyChaseLimit)) {
			errors = append(errors, "execution: makerOnly cannot be satisfied by a market-taking execution")
		}
		if c.MaxPrice != nil && isPos(*c.MaxPrice) && req.Side == execution.SideBuy && mustRat(refPrice).Cmp(mustRat(*c.MaxPrice)) > 0 {
			errors = append(errors, fmt.Sprintf("constraints.maxPrice: entry estimate %s exceeds the cap %s", usd2(refPrice), usd2(*c.MaxPrice)))
		}
		if c.MinPrice != nil && isPos(*c.MinPrice) && req.Side == execution.SideSell && mustRat(refPrice).Cmp(mustRat(*c.MinPrice)) < 0 {
			errors = append(errors, fmt.Sprintf("constraints.minPrice: entry estimate %s is below the floor %s", usd2(refPrice), usd2(*c.MinPrice)))
		}
		if c.MaxSlippageBps != nil && isNonNeg(*c.MaxSlippageBps) && entryType == "market" {
			if cmp, err := decimal.Cmp(inputs.SlippageModel.SlippageBps, *c.MaxSlippageBps); err == nil && cmp > 0 {
				errors = append(errors, fmt.Sprintf("constraints.maxSlippageBps: the sizing estimate (%s bps) exceeds the configured cap (%s bps)", inputs.SlippageModel.SlippageBps, *c.MaxSlippageBps))
			}
		}
	}
	// risk profile hard cap (§72/§88): max risk per trade, when a basis resolves.
	// TS parity: only risk_percent can be capped here — risk_usd carries no
	// balanceBasis in the SizingDefinition union, so the TS `else if (basisVal)`
	// branch is unreachable and is intentionally not ported as a new refusal.
	if riskMode && isPos(value) && inputs.Balances != nil && profile != nil {
		if req.Sizing.Mode == execution.SizingRiskPercent {
			if cmp, err := decimal.Cmp(value, profile.MaxRiskPerTradePct); err == nil && cmp > 0 {
				errors = append(errors, fmt.Sprintf("sizing.value: %s%% exceeds your risk profile maximum %s%% per trade (maxRiskPerTradePct)", value, profile.MaxRiskPerTradePct))
			}
		}
	}
	return errors
}

// mustRat parses a figure that validation already refused or construction
// guarantees; it is never fed raw user input.
func mustRat(s string) *big.Rat {
	r, err := decimal.Parse(s)
	if err != nil {
		panic(fmt.Sprintf("planner: unparseable internal figure %q: %v", s, err))
	}
	return r
}
