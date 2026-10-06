package planner

import (
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/risk"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/sizing"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
)

// Parity gate for package planner: every named vector of
// frontend/web/scripts/tests/executor-plan-tests.ts (PRD §8/§9/§13/§14/§16/§33/
// §37/§38/§116) as Go table tests. Decimal strings compare as normalized
// decimals — exact.

var (
	instr = risk.InstrumentMetadata{Symbol: "BTC/USDT", MarketType: execution.MarketLinearPerp,
		Exchange: execution.ExchangeBinance, BaseAsset: "BTC", QuoteAsset: "USDT", SettlementAsset: "USDT",
		TickSize: "0.01", StepSize: "0.0001", MinQuantity: sp("0.0001"),
		MinNotional: sp("5"), ContractMultiplier: "1", MaxLeverage: sp("125"),
		MaintenanceMarginRate: sp("0.004")}
	noFees  = risk.FeeModel{MakerBps: "0", TakerBps: "0"}
	noSlip  = risk.SlippageModel{SlippageBps: "0", SafetyReservePct: "0"}
	defSlip = risk.SlippageModel{SlippageBps: "5", SafetyReservePct: "0.01"} // plan.ts DEFAULT_SLIPPAGE_MODEL
	bals    = risk.BalanceSnapshot{
		SpotAvailable: sp("2500"), SpotEquity: sp("2600"), FuturesAvailable: sp("4800"),
		FuturesEquity: sp("5000"), TotalExchangeEquity: sp("7500"),
	}
	profile = execution.RiskProfile{DefaultRiskMode: "risk_percent", DefaultRisk: "1",
		MaxRiskPerTradePct: "2", MaxOpenRiskPct: "5", MaxDailyLossPct: "5",
		MaxLeverage: "10", DefaultMarginMode: execution.MarginIsolated,
		DefaultExecutionUrgency: execution.UrgencyBalanced}
	snapshot = MarketSnapshot{
		Symbol: "BTC/USDT", Bid: sp("99995"), Ask: sp("100005"), Mid: "100000",
		SpreadBps: "1", Last: "100000", Timestamp: 1_760_000_000_000,
	}
	skewed = []execution.ScaleLevel{{Price: "99000", Fraction: "0.5"}, {Price: "93000", Fraction: "0.5"}}
)

func sp(v string) *string { return &v }

func eqDec(t *testing.T, got, want, label string) {
	t.Helper()
	if c, err := decimal.Cmp(got, want); err != nil || c != 0 {
		t.Errorf("%s = %q, want %q (normalized decimal equality)", label, got, want)
	}
}

func leDec(t *testing.T, got, bound, label string) {
	t.Helper()
	if c, err := decimal.Cmp(got, bound); err != nil || c > 0 {
		t.Errorf("%s = %q, want <= %q", label, got, bound)
	}
}

// baseRequest mirrors the TS `baseRequest()`: risk_usd $20 at limit 100,000,
// stop 98,000, one TP at 106,000, manual 5x, limit execution at the entry.
func baseRequest() ExecutionRequest {
	return ExecutionRequest{
		AccountID:   "acc-1",
		Symbol:      "BTC/USDT",
		MarketType:  execution.MarketLinearPerp,
		Side:        execution.SideBuy,
		Intent:      execution.IntentOpen,
		Entry:       execution.EntryDefinition{Kind: "limit", Price: "100000"},
		StopLoss:    &execution.PriceDefinition{Kind: "stop", Price: "98000"},
		TakeProfits: []execution.TakeProfitLevel{{Price: "106000"}},
		Sizing:      execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "20"},
		Leverage:    &sizing.LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"},
		Execution:   ExecutionSpec{Type: execution.StrategyLimit, Price: "100000"},
	}
}

func baseInputs() PlanInputs {
	return PlanInputs{
		Request:       baseRequest(),
		Market:        &snapshot,
		Exchange:      execution.ExchangeBinance,
		Instrument:    instr,
		FeeModel:      noFees,
		SlippageModel: noSlip,
		Balances:      &bals,
		RiskProfile:   &profile,
	}
}

func wantValidation(t *testing.T, err error, prefix string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected a refusal with prefix %q, got success", prefix)
	}
	pe, ok := err.(*PlanError)
	if !ok {
		t.Fatalf("err = %v (%T), want *PlanError", err, err)
	}
	for _, v := range pe.Validation {
		if strings.HasPrefix(v, prefix) {
			return
		}
	}
	t.Errorf("validation %v has no message with prefix %q", pe.Validation, prefix)
}

func hasWarn(warnings []string, sub string) bool {
	for _, w := range warnings {
		if strings.Contains(w, sub) {
			return true
		}
	}
	return false
}

func hasConflict(conflicts []Conflict, code string) bool {
	for _, c := range conflicts {
		if c.Code == code {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// The PRD worked examples
// ---------------------------------------------------------------------------

func TestPRD8RiskUSD(t *testing.T) {
	out, err := PlanExecution(baseInputs())
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Quantity, "0.01", "quantity") // 20/2000
	eqDec(t, out.Notional, "1000", "notional")
	eqDec(t, *out.Risk.PriceRisk, "20", "priceRisk")
	eqDec(t, *out.Risk.EstimatedTotalRisk, "20", "estimatedTotalRisk")
	eqDec(t, *out.ExpectedLossAtStop, "-20", "expectedLossAtStop")
}

func TestPRD16SpotFlow(t *testing.T) {
	in := baseInputs()
	instrument := instr
	instrument.MinNotional = sp("0")
	in.Instrument = instrument
	in.Request = baseRequest()
	in.Request.MarketType = execution.MarketSpot
	in.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "1", Basis: execution.BasisSpotAvailable}
	in.Request.Entry = execution.EntryDefinition{Kind: "limit", Price: "100"}
	in.Request.Execution = ExecutionSpec{Type: execution.StrategyLimit, Price: "100"}
	in.Request.StopLoss = &execution.PriceDefinition{Kind: "stop", Price: "95"}
	in.Request.TakeProfits = []execution.TakeProfitLevel{{Price: "110"}}
	in.Request.Leverage = nil
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, *out.Risk.Budget, "25", "budget") // 1% of 2,500 spot available
	eqDec(t, out.Quantity, "5", "quantity")
	eqDec(t, out.Notional, "500", "notional")
	// Spot: no leverage, margin IS the required capital (§16).
	if out.Leverage.Selected != nil {
		t.Errorf("leverage.selected = %q, want nil", *out.Leverage.Selected)
	}
	eqDec(t, *out.RequiredMargin, "500", "requiredMargin")
	if out.LiquidationPrice != nil {
		t.Errorf("liquidation.priceApprox = %q, want nil", *out.LiquidationPrice)
	}
}

func TestPRD14DualConstraintConflict(t *testing.T) {
	in := baseInputs()
	in.Request.Entry = execution.EntryDefinition{Kind: "limit", Price: "100"}
	in.Request.Execution = ExecutionSpec{Type: execution.StrategyLimit, Price: "100"}
	in.Request.StopLoss = &execution.PriceDefinition{Kind: "stop", Price: "95"}
	in.Request.TakeProfits = []execution.TakeProfitLevel{{Price: "110"}}
	in.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "20"}
	in.Request.TargetProfit = sp("100")
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Conflicts) != 1 {
		t.Fatalf("conflicts = %v, want exactly 1", out.Conflicts)
	}
	c := out.Conflicts[0]
	if c.Code != "risk_vs_profit" {
		t.Errorf("code = %q, want risk_vs_profit", c.Code)
	}
	if !strings.Contains(c.Message, "$40.00") {
		t.Errorf("message %q must print the $40.00 achievable profit", c.Message)
	}
	if !strings.Contains(c.Message, "$50.00") {
		t.Errorf("message %q must print the $50.00 required risk", c.Message)
	}
	eqDec(t, c.Detail["achievableProfit"], "40", "detail.achievableProfit")
	eqDec(t, c.Detail["requiredRisk"], "50", "detail.requiredRisk")
	// The risk bound wins: the plan carries the safe quantity, never the ask.
	eqDec(t, out.Quantity, "4", "quantity")
}

func TestPRD13TargetProfitSizing(t *testing.T) {
	in := baseInputs()
	in.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingTargetProfitUSD, Amount: "50"}
	in.Request.TakeProfits = []execution.TakeProfitLevel{{Price: "105000"}}
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Quantity, "0.01", "quantity") // $50 / 5,000 points
	if out.Risk.Budget != nil {
		t.Errorf("risk.budget = %q, want nil (outcome mode carries no budget)", *out.Risk.Budget)
	}
	eqDec(t, *out.ExpectedProfitAtTarget, "50", "expectedProfitAtTarget")
}

// ---------------------------------------------------------------------------
// Honest nulls (PRD §38/§116) + risk % vs allocation % (§11)
// ---------------------------------------------------------------------------

func TestRiskSizingWithoutStopRefused(t *testing.T) {
	in := baseInputs()
	in.Request.StopLoss = nil
	_, err := PlanExecution(in)
	wantValidation(t, err, "stopLoss:")
}

func TestNoStopCapitalModeHonestNulls(t *testing.T) {
	in := baseInputs()
	in.Request.StopLoss = nil
	in.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingNotionalUSD, Amount: "1000"}
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Risk.Budget != nil {
		t.Errorf("risk.budget = %q, want nil", *out.Risk.Budget)
	}
	if out.Risk.PriceRisk != nil {
		t.Errorf("risk.priceRisk = %q, want nil (never 0)", *out.Risk.PriceRisk)
	}
	if out.Risk.EstimatedTotalRisk != nil {
		t.Errorf("risk.estimatedTotalRisk = %q, want nil", *out.Risk.EstimatedTotalRisk)
	}
	if out.Risk.SafetyReserve != nil {
		t.Errorf("risk.safetyReserve = %q, want nil", *out.Risk.SafetyReserve)
	}
	if out.ExpectedLossAtStop != nil {
		t.Errorf("preview.expectedLossAtStop = %q, want nil", *out.ExpectedLossAtStop)
	}
	if out.RiskReward != nil {
		t.Errorf("preview.riskReward = %q, want nil", *out.RiskReward)
	}
}

func TestRiskPercentAndAllocationPercentDistinct(t *testing.T) {
	riskIn := baseInputs()
	riskIn.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "1", Basis: execution.BasisFuturesEquity}
	riskOut, err := PlanExecution(riskIn)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, *riskOut.Risk.Budget, "50", "risk budget") // 1% of 5,000 = the loss bound

	allocIn := baseInputs()
	allocIn.Request.StopLoss = nil
	allocIn.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingAllocationPercent, Percent: "20", Basis: execution.BasisFuturesEquity}
	allocOut, err := PlanExecution(allocIn)
	if err != nil {
		t.Fatal(err)
	}
	if allocOut.Risk.Budget != nil {
		t.Errorf("allocation budget = %q, want nil", *allocOut.Risk.Budget)
	}
	eqDec(t, allocOut.Notional, "1000", "allocation notional") // 20% of 5,000
	eqDec(t, allocOut.Quantity, "0.01", "allocation quantity")
}

func TestUnresolvedBasisNamesTheBasis(t *testing.T) {
	in := baseInputs()
	bare := risk.BalanceSnapshot{}
	in.Balances = &bare
	in.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "1", Basis: execution.BasisFuturesEquity}
	_, err := PlanExecution(in)
	if err == nil {
		t.Fatal("expected a basis refusal")
	}
	pe := err.(*PlanError)
	found := false
	for _, v := range pe.Validation {
		if strings.Contains(v, "'futures_equity'") {
			found = true
		}
	}
	if !found {
		t.Errorf("validation %v must name 'futures_equity'", pe.Validation)
	}
}

// ---------------------------------------------------------------------------
// Fees, slippage, venue floors, rounding
// ---------------------------------------------------------------------------

func TestFeesAndSlippageShrinkQuantity(t *testing.T) {
	in := baseInputs()
	in.FeeModel = risk.FeeModel{MakerBps: "2", TakerBps: "5"}
	in.SlippageModel = risk.SlippageModel{SlippageBps: "5", SafetyReservePct: "0.01"}
	in.Request.Entry = execution.EntryDefinition{Kind: "market"}
	in.Request.Execution = ExecutionSpec{Type: execution.StrategyMarket}
	in.Market = &snapshot
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	// Zero-fee quantity for the same risk is exactly 0.01 (§8) — cost-aware
	// sizing must never exceed it.
	leDec(t, out.Quantity, "0.01", "cost-aware quantity")
	leDec(t, *out.Risk.EstimatedTotalRisk, "20", "estimatedTotalRisk")
	if c, _ := decimal.Cmp(out.Risk.EstimatedFees, "0"); c <= 0 {
		t.Errorf("estimatedFees = %q, want > 0", out.Risk.EstimatedFees)
	}
	if c, _ := decimal.Cmp(out.Risk.SlippageBudget, "0"); c <= 0 {
		t.Errorf("slippageBudget = %q, want > 0 for a market entry", out.Risk.SlippageBudget)
	}
}

func TestLimitEntryZeroSlippage(t *testing.T) {
	in := baseInputs()
	in.FeeModel = risk.FeeModel{MakerBps: "2", TakerBps: "5"}
	in.SlippageModel = defSlip
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Risk.SlippageBudget, "0", "slippageBudget") // maker entry
}

func TestMinNotionalRefusedLoudly(t *testing.T) {
	// $2 of risk at 2,000 points ⇒ 0.001 BTC ⇒ $100 notional under a $500 floor.
	in := baseInputs()
	instrument := instr
	instrument.StepSize = "0.001"
	instrument.MinNotional = sp("500")
	in.Instrument = instrument
	in.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "2"}
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Quantity, "0", "quantity")
	if !hasWarn(out.Warnings, "minNotional") {
		t.Errorf("warnings = %v, want the minNotional refusal", out.Warnings)
	}
}

func TestRoundingNeverOverRisks(t *testing.T) {
	// 25/2000 = 0.0125 → step 0.001 → 0.012 (DOWN), and 0.012×2000 = 24 ≤ 25.
	in := baseInputs()
	instrument := instr
	instrument.StepSize = "0.001"
	in.Instrument = instrument
	in.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "25"}
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Quantity, "0.012", "quantity")
	leDec(t, *out.Risk.EstimatedTotalRisk, "25", "estimatedTotalRisk")
	if !hasWarn(out.Warnings, "rounded DOWN") {
		t.Errorf("warnings = %v, want the rounded-DOWN warning", out.Warnings)
	}
}

// ---------------------------------------------------------------------------
// Validation: every message names its field (never a silent clamp)
// ---------------------------------------------------------------------------

func TestValidationFieldNamedRefusals(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*ExecutionRequest)
		prefix string
	}{
		{"wrong-side stop", func(r *ExecutionRequest) {
			r.StopLoss = &execution.PriceDefinition{Kind: "stop", Price: "101000"}
		}, "stopLoss.price:"},
		{"TP fraction overflow", func(r *ExecutionRequest) {
			r.TakeProfits = []execution.TakeProfitLevel{{Price: "106000", Fraction: "0.7"}, {Price: "108000", Fraction: "0.7"}}
		}, "takeProfits:"},
		{"spot leverage", func(r *ExecutionRequest) {
			r.MarketType = execution.MarketSpot
			r.Leverage = &sizing.LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}
		}, "leverage:"},
		{"makerOnly vs market", func(r *ExecutionRequest) {
			r.Entry = execution.EntryDefinition{Kind: "market"}
			r.Execution = ExecutionSpec{Type: execution.StrategyMarket}
			r.Constraints = &ConstraintSpec{MakerOnly: true}
		}, "execution:"},
		{"non-normalized symbol", func(r *ExecutionRequest) { r.Symbol = "btcusdt" }, "symbol:"},
	}
	for _, c := range cases {
		in := baseInputs()
		c.mutate(&in.Request)
		_, err := PlanExecution(in)
		wantValidation(t, err, c.prefix)
	}
}

func TestProfileCapsAreHard(t *testing.T) {
	levIn := baseInputs()
	levIn.Request.Leverage = &sizing.LeverageSpec{Mode: execution.LeverageManual, Leverage: "25"} // profile max 10
	_, err := PlanExecution(levIn)
	wantValidation(t, err, "leverage.leverage:")

	riskIn := baseInputs()
	riskIn.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "5", Basis: execution.BasisFuturesEquity} // cap 2%
	_, err = PlanExecution(riskIn)
	wantValidation(t, err, "sizing.value:")
}

// ---------------------------------------------------------------------------
// Hard risk bound (§37/§117): resize + blocking conflict
// ---------------------------------------------------------------------------

func TestOverBudgetPlanResizesAndBlocks(t *testing.T) {
	in := baseInputs()
	in.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingFixedQuantity, Quantity: "1"}
	in.Request.MaxRisk = sp("20")
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	if !hasConflict(out.Conflicts, "risk_bound_exceeded") {
		t.Fatalf("conflicts = %v, want risk_bound_exceeded", out.Conflicts)
	}
	eqDec(t, out.Quantity, "0.01", "resized quantity") // the §8 safe quantity
	leDec(t, *out.Risk.EstimatedTotalRisk, "20", "estimatedTotalRisk")
}

func TestLadderResizePricesPerLevel(t *testing.T) {
	// The bound is tighter than the sizing budget: the ladder re-solves against
	// the bound — per level, never off its VWAP (whose distance is negative).
	in := baseInputs()
	in.Request.Entry = execution.EntryDefinition{Kind: "limit", Price: "100000"}
	in.Request.Execution = ExecutionSpec{Type: execution.StrategyScaleIn, Levels: skewed}
	in.Request.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "1000"}
	in.Request.MaxRisk = sp("50")
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	if !hasConflict(out.Conflicts, "risk_bound_exceeded") {
		t.Fatalf("conflicts = %v, want risk_bound_exceeded", out.Conflicts)
	}
	leDec(t, *out.Risk.EstimatedTotalRisk, "50", "resized risk holds the bound")
	if c, _ := decimal.Cmp(out.Quantity, "0"); c <= 0 {
		t.Errorf("quantity = %q, want > 0", out.Quantity)
	}
}

// ---------------------------------------------------------------------------
// §33 scale-in: VWAP is the estimated entry
// ---------------------------------------------------------------------------

func TestScaleInReportsVWAPAsEstimatedEntry(t *testing.T) {
	in := baseInputs()
	in.Request.Execution = ExecutionSpec{Type: execution.StrategyScaleIn, Levels: skewed}
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.EstimatedEntry, "96000", "estimatedEntry") // 50% @ 99,000 + 50% @ 93,000
	// Notional must agree: qty × VWAP, not qty × the top level.
	qtyVwap, err := decimal.Mul(out.Quantity, "96000")
	if err != nil {
		t.Fatal(err)
	}
	notional, err := decimal.Mul(qtyVwap, "1")
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Notional, notional, "notional at the VWAP")
}

func TestNonLadderReportsItsOwnEntry(t *testing.T) {
	out, err := PlanExecution(baseInputs())
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.EstimatedEntry, "100000", "estimatedEntry")
}

// ---------------------------------------------------------------------------
// Entry resolution (PRD §26): the conservative touch
// ---------------------------------------------------------------------------

func TestResolveEstimatedEntry(t *testing.T) {
	req := baseRequest()
	req.Entry = execution.EntryDefinition{Kind: "market"}
	got, err := ResolveEstimatedEntry(req, &snapshot)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, got, "100005", "buy market → ask") // conservative side

	req.Side = execution.SideSell
	got, err = ResolveEstimatedEntry(req, &snapshot)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, got, "99995", "sell market → bid")

	req.Side = execution.SideBuy
	req.Entry = execution.EntryDefinition{Kind: "limit", Price: "99000"}
	got, err = ResolveEstimatedEntry(req, &snapshot)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, got, "99000", "limit → its own price")

	req.Entry = execution.EntryDefinition{Kind: "market"}
	if _, err := ResolveEstimatedEntry(req, nil); err == nil {
		t.Error("a market entry with no snapshot must be honestly unpriced (error), never fabricated")
	}

	// A missing touch names the missing side.
	noAsk := snapshot
	noAsk.Ask = nil
	req.Entry = execution.EntryDefinition{Kind: "market"}
	if _, err := ResolveEstimatedEntry(req, &noAsk); err == nil || !strings.Contains(err.Error(), "ask") {
		t.Errorf("missing ask must name the missing side, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Leverage/margin/liquidation in the plan (§18–§21)
// ---------------------------------------------------------------------------

func TestAutoSafeLeverageSelectsMinimumFeasible(t *testing.T) {
	in := baseInputs()
	in.Request.Leverage = &sizing.LeverageSpec{
		Mode: execution.LeverageAutoSafe, LiquidationBufferPct: sp("0.2"), MaxMarginPct: sp("1"),
	}
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	sel := out.Leverage.Selected
	if sel == nil {
		t.Fatal("leverage.selected is nil")
	}
	if c, _ := decimal.Cmp(*sel, "10"); c > 0 {
		t.Errorf("selected = %q, want <= profile max 10", *sel)
	}
	if c, _ := decimal.Cmp(*sel, "125"); c > 0 {
		t.Errorf("selected = %q, want <= instrument max 125", *sel)
	}
	// margin = notional / selected exactly.
	wantMargin, err := decimal.Quo(out.Notional, *sel)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, *out.RequiredMargin, wantMargin, "estimatedInitial margin")
	// Long: liquidation below the stop; safe per the 20% buffer rule.
	if out.LiquidationPrice == nil {
		t.Fatal("liquidation.priceApprox is nil")
	}
	if c, _ := decimal.Cmp(*out.LiquidationPrice, "98000"); c >= 0 {
		t.Errorf("liquidation = %q, want < stop 98000", *out.LiquidationPrice)
	}
	if out.LiquidationSafe == nil || !*out.LiquidationSafe {
		t.Error("liquidation.safe = false, want true")
	}
}

func TestAutoSafeWithoutBalancesWarns(t *testing.T) {
	in := baseInputs()
	in.Balances = nil
	in.Request.Leverage = &sizing.LeverageSpec{Mode: execution.LeverageAutoSafe}
	out, err := PlanExecution(in)
	if err != nil {
		t.Fatal(err)
	}
	if !hasWarn(out.Warnings, "auto_safe") {
		t.Errorf("warnings = %v, want an auto_safe warning instead of an invented basis", out.Warnings)
	}
}

// ---------------------------------------------------------------------------
// Slice projection (§56): naive equal schedule, no invented jitter
// ---------------------------------------------------------------------------

func TestEstimateSlices(t *testing.T) {
	cases := []struct {
		name string
		exec ExecutionSpec
		qty  string
		want *int // nil = honest null
	}{
		{"twap explicit slices", ExecutionSpec{Type: execution.StrategyTWAP, Slices: ip(4)}, "10", ip(4)},
		{"twap from duration", ExecutionSpec{Type: execution.StrategyTWAP, DurationMs: lp(900_000)}, "10", ip(6)},
		{"twap 30min default", ExecutionSpec{Type: execution.StrategyTWAP, DurationMs: lp(1_800_000)}, "10", ip(12)},
		{"twap no schedule", ExecutionSpec{Type: execution.StrategyTWAP}, "10", nil},
		{"iceberg ceil", ExecutionSpec{Type: execution.StrategyIceberg, VisibleQuantity: "3"}, "10.5", ip(4)},
		{"scale_in levels", ExecutionSpec{Type: execution.StrategyScaleIn, Levels: skewed}, "10", ip(2)},
		{"limit null", ExecutionSpec{Type: execution.StrategyLimit}, "10", nil},
	}
	for _, c := range cases {
		req := baseRequest()
		req.Execution = c.exec
		got, err := EstimateSlices(req, c.qty)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if c.want == nil {
			if got != nil {
				t.Errorf("%s = %d, want nil", c.name, *got)
			}
		} else if got == nil {
			t.Errorf("%s = nil, want %d", c.name, *c.want)
		} else if *got != *c.want {
			t.Errorf("%s = %d, want %d", c.name, *got, *c.want)
		}
	}
}

func ip(v int) *int     { return &v }
func lp(v int64) *int64 { return &v }
