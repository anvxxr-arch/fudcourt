package sizing

import (
	"math/big"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/risk"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
)

// Parity gate for package sizing: the sizePosition vectors of
// frontend/web/scripts/tests/executor-plan-tests.ts (§8/§9/§11/§13/§16/§33/§37)
// plus the nine-mode contract (objective §8.13). Decimal strings compare as
// normalized decimals — exact.

var (
	instr = risk.InstrumentMetadata{Symbol: "BTC/USDT", MarketType: execution.MarketLinearPerp,
		Exchange: execution.ExchangeBinance, BaseAsset: "BTC", QuoteAsset: "USDT", SettlementAsset: "USDT",
		TickSize: "0.01", StepSize: "0.0001", MinQuantity: sp("0.0001"),
		MinNotional: sp("5"), ContractMultiplier: "1", MaxLeverage: sp("125"),
		MaintenanceMarginRate: sp("0.004")}
	bals = risk.BalanceSnapshot{
		SpotAvailable: sp("2500"), SpotEquity: sp("2600"), FuturesAvailable: sp("4800"),
		FuturesEquity: sp("5000"), TotalExchangeEquity: sp("7500"),
	}
	profile = execution.RiskProfile{DefaultRiskMode: "risk_percent", DefaultRisk: "1",
		MaxRiskPerTradePct: "2", MaxOpenRiskPct: "5", MaxDailyLossPct: "5",
		MaxLeverage: "10", DefaultMarginMode: execution.MarginIsolated,
		DefaultExecutionUrgency: execution.UrgencyBalanced}
	zeroFees = risk.FeeModel{MakerBps: "0", TakerBps: "0"}
	zeroSlip = risk.SlippageModel{SlippageBps: "0", SafetyReservePct: "0"}
	// §33 skewed ladder: 50% @ 99,000 + 50% @ 93,000 → VWAP 96,000,
	// fraction-weighted distance to the 98,000 stop = 0.5·1000 + 0.5·5000 = 3000.
	skewed = []execution.ScaleLevel{{Price: "99000", Fraction: "0.5"}, {Price: "93000", Fraction: "0.5"}}
	// §33 within-budget ladder: weighted distance = .25·2000 + .25·0 + .25·2000 + .25·4000 = 2000.
	even = []execution.ScaleLevel{
		{Price: "100000", Fraction: "0.25"}, {Price: "98000", Fraction: "0.25"},
		{Price: "96000", Fraction: "0.25"}, {Price: "94000", Fraction: "0.25"},
	}
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

func ltDec(t *testing.T, got, bound, label string) {
	t.Helper()
	if c, err := decimal.Cmp(got, bound); err != nil || c >= 0 {
		t.Errorf("%s = %q, want < %q", label, got, bound)
	}
}

// baseIn mirrors the TS `inputs()` fixture: risk_usd $20 at 100,000 with the
// 98,000 stop, manual 5x, zero fees.
func baseIn() SizeInputs {
	return SizeInputs{
		Sizing:         execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "20"},
		Symbol:         "BTC/USDT",
		MarketType:     execution.MarketLinearPerp,
		Side:           execution.SideBuy,
		EntryType:      risk.EntryLimit,
		ReferenceEntry: "100000",
		Stop:           sp("98000"),
		TakeProfits:    []execution.TakeProfitLevel{{Price: "106000"}},
		FeeModel:       zeroFees,
		SlippageModel:  zeroSlip,
		Instrument:     instr,
		Balances:       &bals,
		RiskProfile:    &profile,
		Leverage:       LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"},
	}
}

func hasWarn(warnings []string, sub string) bool {
	for _, w := range warnings {
		if strings.Contains(w, sub) {
			return true
		}
	}
	return false
}

func hasErrCode(errs []FieldError, code string) bool {
	for _, e := range errs {
		if e.Code == code {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// PRD worked-example modes
// ---------------------------------------------------------------------------

func TestRiskUSDVector(t *testing.T) {
	out, err := SizePosition(baseIn())
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Errors) != 0 {
		t.Fatalf("errors = %v, want none", out.Errors)
	}
	eqDec(t, out.Quantity, "0.01", "quantity") // 20/2000
	eqDec(t, out.Notional, "1000", "notional")
	eqDec(t, *out.PriceRisk, "20", "priceRisk")
	eqDec(t, *out.TotalRisk, "20", "totalRisk")
	eqDec(t, *out.RequiredMargin, "200", "requiredMargin") // manual 5x
	eqDec(t, *out.RequiredLeverage, "5", "requiredLeverage")
	eqDec(t, out.EstimatedEntry, "100000", "estimatedEntry")
}

func TestSpotPercentVector(t *testing.T) {
	// §16: $2,500 spot_available, risk 1% = $25 → 5 units / $500 capital.
	in := baseIn()
	in.MarketType = execution.MarketSpot
	in.ReferenceEntry = "100"
	in.Stop = sp("95")
	in.TakeProfits = []execution.TakeProfitLevel{{Price: "110"}}
	in.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "1", Basis: execution.BasisSpotAvailable}
	in.Leverage = LeverageSpec{Mode: execution.LeverageManual}
	instrument := instr
	instrument.StepSize = "0.0001"
	instrument.MinNotional = sp("0")
	in.Instrument = instrument
	out, err := SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Errors) != 0 {
		t.Fatalf("errors = %v, want none", out.Errors)
	}
	eqDec(t, *out.Budget, "25", "budget") // 1% of 2,500
	eqDec(t, out.Quantity, "5", "quantity")
	eqDec(t, out.Notional, "500", "notional")
	// Spot: no leverage, margin IS the required capital (§16).
	if out.RequiredLeverage != nil {
		t.Errorf("requiredLeverage = %q, want nil", *out.RequiredLeverage)
	}
	eqDec(t, *out.RequiredMargin, "500", "requiredMargin")
	if out.LiquidationPrice != nil {
		t.Errorf("liquidationPrice = %q, want nil", *out.LiquidationPrice)
	}
}

func TestRiskPercentVsAllocationPercent(t *testing.T) {
	// §11: risk % is a LOSS bound with a budget; allocation % is CAPITAL with none.
	riskIn := baseIn()
	riskIn.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "1", Basis: execution.BasisFuturesEquity}
	riskOut, err := SizePosition(riskIn)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, *riskOut.Budget, "50", "risk budget") // 1% of 5,000
	eqDec(t, riskOut.Quantity, "0.025", "risk quantity")

	allocIn := baseIn()
	allocIn.Stop = nil
	allocIn.Sizing = execution.SizingDefinition{Mode: execution.SizingAllocationPercent, Percent: "20", Basis: execution.BasisFuturesEquity}
	allocOut, err := SizePosition(allocIn)
	if err != nil {
		t.Fatal(err)
	}
	if allocOut.Budget != nil {
		t.Errorf("allocation budget = %q, want nil (allocation carries no loss bound)", *allocOut.Budget)
	}
	eqDec(t, allocOut.Notional, "1000", "allocation notional") // 20% of 5,000
	eqDec(t, allocOut.Quantity, "0.01", "allocation quantity")
}

func TestTargetProfitUSDVector(t *testing.T) {
	// §13: $50 over 5,000 points = 0.01 BTC.
	in := baseIn()
	in.Stop = sp("98000")
	in.TakeProfits = []execution.TakeProfitLevel{{Price: "105000"}}
	in.Sizing = execution.SizingDefinition{Mode: execution.SizingTargetProfitUSD, Amount: "50"}
	out, err := SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Errors) != 0 {
		t.Fatalf("errors = %v, want none", out.Errors)
	}
	eqDec(t, out.Quantity, "0.01", "quantity")
	eqDec(t, out.Notional, "1000", "notional")
	if out.Budget != nil {
		t.Errorf("budget = %q, want nil (outcome mode carries no budget)", *out.Budget)
	}
}

// ---------------------------------------------------------------------------
// The nine sizing modes (objective §8.13)
// ---------------------------------------------------------------------------

func TestAllNineModesProducePositions(t *testing.T) {
	cases := []struct {
		name   string
		sizing execution.SizingDefinition
		lev    LeverageSpec
		wantQ  string
	}{
		{"risk_usd", execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "20"},
			LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}, "0.01"},
		{"risk_percent", execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "1", Basis: execution.BasisFuturesEquity},
			LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}, "0.025"},
		{"allocation_usd", execution.SizingDefinition{Mode: execution.SizingAllocationUSD, Amount: "1000"},
			LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}, "0.01"},
		{"allocation_percent", execution.SizingDefinition{Mode: execution.SizingAllocationPercent, Percent: "20", Basis: execution.BasisFuturesEquity},
			LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}, "0.01"},
		{"notional_usd", execution.SizingDefinition{Mode: execution.SizingNotionalUSD, Amount: "1000"},
			LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}, "0.01"},
		{"fixed_quantity", execution.SizingDefinition{Mode: execution.SizingFixedQuantity, Quantity: "0.012583"},
			LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}, "0.0125"}, // floors to the 0.0001 grid
		{"fixed_margin", execution.SizingDefinition{Mode: execution.SizingFixedMargin, Margin: "100"},
			LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}, "0.005"}, // 100×5 leverage
		{"target_profit_usd", execution.SizingDefinition{Mode: execution.SizingTargetProfitUSD, Amount: "50"},
			LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}, "0.01"},
		{"target_profit_percent", execution.SizingDefinition{Mode: execution.SizingTargetProfitPercent, Percent: "1", Basis: execution.BasisFuturesEquity},
			LeverageSpec{Mode: execution.LeverageManual, Leverage: "5"}, "0.01"}, // 1% of 5,000 = $50
	}
	for _, c := range cases {
		in := baseIn()
		in.Sizing = c.sizing
		in.Leverage = c.lev
		in.TakeProfits = []execution.TakeProfitLevel{{Price: "105000"}}
		if IsProfitMode(c.sizing.Mode) {
			in.Stop = sp("98000")
		}
		out, err := SizePosition(in)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if len(out.Errors) != 0 {
			t.Fatalf("%s errors = %v, want none", c.name, out.Errors)
		}
		eqDec(t, out.Quantity, c.wantQ, c.name+" quantity")
		if out.EstimatedEntry == "" {
			t.Errorf("%s estimatedEntry is empty", c.name)
		}
	}
}

func TestPercentageBasisRequirements(t *testing.T) {
	// An absent basis is refused NAMING the field — never fabricated as 0 (PRD §10).
	missing := baseIn()
	missing.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "1"}
	out, err := SizePosition(missing)
	if err != nil {
		t.Fatal(err)
	}
	if !hasErrCode(out.Errors, CodeSizingBasisMissing) {
		t.Fatalf("errors = %v, want %s", out.Errors, CodeSizingBasisMissing)
	}
	if out.Errors[0].Field != "sizing.balanceBasis" {
		t.Errorf("field = %q, want sizing.balanceBasis", out.Errors[0].Field)
	}
	eqDec(t, out.Quantity, "0", "missing-basis quantity")

	// An unresolvable basis names the basis value itself.
	unresolved := baseIn()
	unresolved.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "1", Basis: execution.BasisFuturesEquity}
	bare := risk.BalanceSnapshot{}
	unresolved.Balances = &bare
	out, err = SizePosition(unresolved)
	if err != nil {
		t.Fatal(err)
	}
	if !hasErrCode(out.Errors, CodeSizingBasisUnresolved) {
		t.Fatalf("errors = %v, want %s", out.Errors, CodeSizingBasisUnresolved)
	}
	if !strings.Contains(out.Errors[0].Message, "'futures_equity'") {
		t.Errorf("message %q must name 'futures_equity'", out.Errors[0].Message)
	}
}

func TestFixedMarginRequiresManualLeverage(t *testing.T) {
	// margin alone cannot determine notional without a leverage: sizing uses 1x
	// silently only when the mode isn't manual — the planner refuses it. Pin the
	// sizing arithmetic: margin × leverage / (entry·mult).
	in := baseIn()
	in.Sizing = execution.SizingDefinition{Mode: execution.SizingFixedMargin, Margin: "100"}
	out, err := SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Notional, "500", "fixed-margin notional")
	in.Leverage = LeverageSpec{Mode: execution.LeverageAutoSafe}
	out, err = SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Notional, "100", "fixed-margin notional at implicit 1x")
}

// ---------------------------------------------------------------------------
// §33 scale-in ladders
// ---------------------------------------------------------------------------

func TestScaleInWithinBudget(t *testing.T) {
	// Weighted distance 2000 = the naive figure here; pin the exact numbers.
	in := baseIn()
	in.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "20"}
	in.Levels = even
	out, err := SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Errors) != 0 {
		t.Fatalf("errors = %v, want none", out.Errors)
	}
	eqDec(t, out.Quantity, "0.01", "quantity") // 20/2000 exactly at zero fees
	eqDec(t, *out.PriceRisk, "20", "priceRisk")
	leDec(t, *out.TotalRisk, "20", "totalRisk")          // the budget is hard
	eqDec(t, out.EstimatedEntry, "97000", "ladder VWAP") // 4-level average
}

func TestScaleInSkewedPricesStrictlyBelowNaive(t *testing.T) {
	// Weighted distance 3000 > 2000, so the budgeted quantity must come down
	// from the naive 0.01 and the VWAP is 96,000 (§33).
	in := baseIn()
	in.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "20"}
	in.Levels = skewed
	out, err := SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Errors) != 0 {
		t.Fatalf("errors = %v, want none", out.Errors)
	}
	ltDec(t, out.Quantity, "0.01", "skewed quantity") // strictly smaller
	eqDec(t, out.Quantity, "0.0066", "skewed quantity exact")
	eqDec(t, out.EstimatedEntry, "96000", "VWAP") // 50% @ 99,000 + 50% @ 93,000
	eqDec(t, *out.PriceRisk, "19.8", "priceRisk")
	leDec(t, *out.TotalRisk, "20", "totalRisk")
}

func TestScaleInPercentageUsesLadder(t *testing.T) {
	// 1% of 5,000 futures equity = $50 — sized on the ladder, not the top level.
	in := baseIn()
	in.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskPercent, Percent: "1", Basis: execution.BasisFuturesEquity}
	in.Levels = skewed
	out, err := SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Errors) != 0 {
		t.Fatalf("errors = %v, want none", out.Errors)
	}
	eqDec(t, *out.Budget, "50", "budget")
	eqDec(t, out.Quantity, "0.0166", "quantity") // 50/3000 → floor
	leDec(t, *out.TotalRisk, "50", "totalRisk")
}

func TestScaleInDegenerateLadderRefused(t *testing.T) {
	// Every level ON the stop: the loss is unbounded — refused, never traded.
	in := baseIn()
	in.Levels = []execution.ScaleLevel{{Price: "98000", Fraction: "1"}}
	out, err := SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Quantity, "0", "quantity")
	if !hasErrCode(out.Errors, CodeUnboundedRisk) {
		t.Errorf("errors = %v, want %s", out.Errors, CodeUnboundedRisk)
	}
	if !hasWarn(out.Warnings, "risk is unbounded") {
		t.Errorf("warnings = %v, want the unbounded-risk warning", out.Warnings)
	}
}

func TestScaleInBoundOverrideReSolvesLadder(t *testing.T) {
	// §37: the $50 hard bound is tighter than the $1,000 sizing budget; the
	// ladder must re-solve against the bound — per level, never off the VWAP.
	in := baseIn()
	in.Sizing = execution.SizingDefinition{Mode: execution.SizingRiskUSD, Amount: "1000"}
	in.Levels = skewed
	out, err := SizeScaleInRisk(in, sp("50"))
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, *out.Budget, "50", "budget is the bound")
	eqDec(t, out.Quantity, "0.0166", "quantity")
	leDec(t, *out.TotalRisk, "50", "totalRisk holds the bound")
}

func TestLadderVWAP(t *testing.T) {
	eqDec(t, mustVWAP(t, skewed), "96000", "skewed VWAP")
	eqDec(t, mustVWAP(t, even), "97000", "even VWAP")
	if _, err := LadderVWAP(nil); err == nil {
		t.Error("empty ladder must error")
	}
}

func mustVWAP(t *testing.T, levels []execution.ScaleLevel) string {
	t.Helper()
	v, err := LadderVWAP(levels)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// ---------------------------------------------------------------------------
// Rounding + venue floors (PRD §70–§71)
// ---------------------------------------------------------------------------

func TestRoundingWarnings(t *testing.T) {
	// 0.0125 → 0.012 (DOWN) at step 0.0001... pin the 0.001 vector: 0.012583 → 0.012.
	in := baseIn()
	in.Instrument.MinNotional = sp("0")
	in.Sizing = execution.SizingDefinition{Mode: execution.SizingFixedQuantity, Quantity: "0.012583"}
	in.Instrument.StepSize = "0.001"
	out, err := SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Quantity, "0.012", "quantity")
	if !hasWarn(out.Warnings, "rounded DOWN to 0.012") {
		t.Errorf("warnings = %v, want the rounded-DOWN warning", out.Warnings)
	}

	tiny := baseIn()
	tiny.Sizing = execution.SizingDefinition{Mode: execution.SizingFixedQuantity, Quantity: "0.00004"}
	out, err = SizePosition(tiny)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, out.Quantity, "0", "tiny quantity")
	if !hasWarn(out.Warnings, "rounds to zero") {
		t.Errorf("warnings = %v, want the rounds-to-zero warning", out.Warnings)
	}
}

func TestMinimumNotionalRefusedLoudly(t *testing.T) {
	// $100 notional under a $500 venue floor: the warning prints both figures.
	in := baseIn()
	instrument := instr
	instrument.StepSize = "0.001"
	instrument.MinNotional = sp("500")
	in.Instrument = instrument
	in.Sizing = execution.SizingDefinition{Mode: execution.SizingNotionalUSD, Amount: "100"}
	out, err := SizePosition(in)
	if err != nil {
		t.Fatal(err)
	}
	if !hasWarn(out.Warnings, "below the venue minimum") {
		t.Fatalf("warnings = %v, want the venue-minimum refusal", out.Warnings)
	}
	if !hasWarn(out.Warnings, "500") {
		t.Errorf("warnings %v must print the venue floor", out.Warnings)
	}
}

// ---------------------------------------------------------------------------
// Leverage/margin/liquidation policy (PRD §17–§21)
// ---------------------------------------------------------------------------

func TestResolveLeverageAndMargin(t *testing.T) {
	in := baseIn()
	notional := mustParse(t, "1000")
	var warnings []string
	res, err := ResolveLeverageAndMargin(in, notional, &warnings)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, *res.Leverage, "5", "manual leverage")
	eqDec(t, *res.Margin, "200", "margin") // 1000/5
	// liq = 100000·(1 − 1/5 + 0.004) = 80,400; buffer to the 98,000 stop = 17,600.
	eqDec(t, *res.LiquidationPrice, "80400", "liquidationPrice")
	eqDec(t, *res.StopToLiquidationBuffer, "17600", "buffer")
	if res.LiquidationSafe == nil || !*res.LiquidationSafe {
		t.Error("liquidationSafe = false, want true")
	}

	// Spot: no leverage — margin IS the required capital (§16).
	spotIn := baseIn()
	spotIn.MarketType = execution.MarketSpot
	spotRes, err := ResolveLeverageAndMargin(spotIn, notional, &warnings)
	if err != nil {
		t.Fatal(err)
	}
	if spotRes.Leverage != nil {
		t.Errorf("spot leverage = %q, want nil", *spotRes.Leverage)
	}
	eqDec(t, *spotRes.Margin, "1000", "spot margin")
	if spotRes.LiquidationPrice != nil {
		t.Errorf("spot liquidation = %q, want nil", *spotRes.LiquidationPrice)
	}

	// Zero notional on perp: honest nils, never zero-figures.
	zeroRes, err := ResolveLeverageAndMargin(in, mustParse(t, "0"), &warnings)
	if err != nil {
		t.Fatal(err)
	}
	if zeroRes.Margin != nil || zeroRes.Leverage != nil || zeroRes.LiquidationPrice != nil {
		t.Errorf("zero-notional resolution = %+v, want all nil", zeroRes)
	}
}

func mustParse(t *testing.T, s string) *big.Rat {
	t.Helper()
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		t.Fatalf("parse %q", s)
	}
	return r
}
