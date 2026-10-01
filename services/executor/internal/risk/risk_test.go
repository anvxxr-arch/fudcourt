package risk

import (
	"math/big"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/decimal"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
)

// Parity gate for package risk: every named vector of
// apps/web/scripts/tests/executor-risk-tests.ts is ported here and asserted on
// normalized decimals (exact equality after decimal normalization).

var (
	btc  = InstrumentMetadata{Symbol: "BTC/USDT", MarketType: executor.MarketLinearPerp, Exchange: executor.ExchangeBinance,
		BaseAsset: "BTC", QuoteAsset: "USDT", SettlementAsset: "USDT",
		TickSize: "0.01", StepSize: "0.001", ContractMultiplier: "1",
		MaxLeverage: strPtr("125"), MaintenanceMarginRate: strPtr("0.005")}
	unit = withStep(btc, "UNIT/USDT", "1", "0.01")
	// NO_FEES / NO_SLIP: the PRD worked examples' zero-cost model.
	noFees = FeeModel{MakerBps: "0", TakerBps: "0"}
	noSlip = SlippageModel{SlippageBps: "0", SafetyReservePct: "0"}
	fees   = FeeModel{MakerBps: "10", TakerBps: "25"}
	slip   = SlippageModel{SlippageBps: "5", SafetyReservePct: "0.01"}
)

func withStep(in InstrumentMetadata, symbol, step, tick string) InstrumentMetadata {
	out := in
	out.Symbol = symbol
	out.BaseAsset = "UNIT"
	out.StepSize = step
	out.TickSize = tick
	return out
}

func s(v string) *string { return &v }

// eqDec asserts exact equality as normalized decimals (house comparison rule).
func eqDec(t *testing.T, got, want, label string) {
	t.Helper()
	cmp, err := decimal.Cmp(got, want)
	if err != nil || cmp != 0 {
		t.Errorf("%s = %q, want %q (normalized decimal equality)", label, got, want)
	}
}

func hasSub(list []string, sub string) bool {
	for _, item := range list {
		if strings.Contains(item, sub) {
			return true
		}
	}
	return false
}

func mustRisk(t *testing.T, in RiskPositionInput) SizedPosition {
	t.Helper()
	out, err := CalculateRiskPosition(in)
	if err != nil {
		t.Fatalf("CalculateRiskPosition: %v", err)
	}
	return out
}

// ---------------------------------------------------------------------------
// PRD worked examples (the spec)
// ---------------------------------------------------------------------------

func TestPRD8RiskSizing(t *testing.T) {
	pos := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100000", Stop: "98000",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: btc})
	eqDec(t, pos.Quantity, "0.01", "quantity")
	eqDec(t, pos.UnroundedQuantity, "0.01", "unrounded")
	eqDec(t, pos.Notional, "1000", "notional")
	eqDec(t, pos.Risk.PriceRisk, "20", "priceRisk")
	eqDec(t, pos.Risk.TotalRisk, "20", "totalRisk")
	if len(pos.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", pos.Warnings)
	}
}

func TestPRD9PercentageBudget(t *testing.T) {
	balances := BalanceSnapshot{
		SpotAvailable: s("200"), SpotEquity: s("250"), FuturesAvailable: s("4900"),
		FuturesEquity: s("5000"), TotalExchangeEquity: s("5250"), AssetEquity: s("3000"), Custom: s("777"),
	}
	basis := ResolveBalanceBasis(executor.BasisFuturesEquity, balances)
	if basis == nil {
		t.Fatal("futures_equity basis must resolve")
	}
	eqDec(t, *basis, "5000", "basis")
	budget, _ := decimal.Mul(*basis, "0.01") // 1% of 5,000
	eqDec(t, budget, "50", "budget")
	pos := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100000", Stop: "98000",
		RiskBudget: budget, FeeModel: noFees, SlippageModel: noSlip, Instrument: btc})
	eqDec(t, pos.Quantity, "0.025", "quantity")
	eqDec(t, pos.Notional, "2500", "notional")
}

func TestPRD13ProfitSizing(t *testing.T) {
	res, err := CalculateProfitPosition(ProfitPositionInput{Side: executor.SideBuy, Entry: "100000",
		Target: "105000", DesiredProfit: "50", FeeModel: noFees, SlippageModel: noSlip, Instrument: btc})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, res.Quantity, "0.01", "quantity")
	eqDec(t, res.UnroundedQuantity, "0.01", "unrounded")
	eqDec(t, res.Notional, "1000", "notional")
	eqDec(t, res.EstimatedProfit, "50", "estimatedProfit")
	if len(res.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", res.Warnings)
	}
}

func TestPRD14ConflictVector(t *testing.T) {
	res, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip,
		Known: SolveKnown{Entry: s("100"), Stop: s("95"), Target: s("110"), Risk: s("20"), Profit: s("100")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Conflicts) != 1 {
		t.Fatalf("conflicts = %v, want exactly 1", res.Conflicts)
	}
	c := res.Conflicts[0]
	if c.Code != "risk_vs_profit" {
		t.Errorf("code = %q, want risk_vs_profit", c.Code)
	}
	for key, want := range map[string]string{"maxLoss": "20", "targetProfit": "100", "achievableProfit": "40", "requiredRisk": "50"} {
		eqDec(t, c.Detail[key], want, "detail."+key)
	}
	for _, part := range []string{
		"Requested: Max Loss $20, Target Profit $100",
		"Possible using current SL/TP: Max Loss $20, Profit $40",
		"To achieve $100 target, Required Risk ≈ $50",
	} {
		if !strings.Contains(c.Message, part) {
			t.Errorf("message %q missing %q", c.Message, part)
		}
	}
	// Risk cap binds: the risk-derived quantity is what stays feasible.
	eqDec(t, res.Solved["quantity"], "4", "solved.quantity")
}

func TestPRD15SolverVector(t *testing.T) {
	res, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip,
		Known: SolveKnown{Entry: s("100"), Target: s("120"), Profit: s("200"), Margin: s("250")}})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"entry": "100", "target": "120", "quantity": "10", "profit": "200",
		"margin": "250", "notional": "1000", "leverage": "4",
	}
	if len(res.Solved) != len(want) {
		t.Errorf("solved = %v, want exactly %v", res.Solved, want)
	}
	for k, v := range want {
		eqDec(t, res.Solved[k], v, "solved."+k)
	}
	if len(res.Unsatisfied) != 2 || res.Unsatisfied[0] != SolveStop || res.Unsatisfied[1] != SolveRisk {
		t.Errorf("unsatisfied = %v, want [stop risk]", res.Unsatisfied)
	}
	if len(res.Conflicts) != 0 {
		t.Errorf("conflicts = %v, want none", res.Conflicts)
	}
}

func TestPRD16SpotFlow(t *testing.T) {
	balances := BalanceSnapshot{SpotAvailable: s("2500"), SpotEquity: s("2500"),
		TotalExchangeEquity: s("2500")}
	basis := ResolveBalanceBasis(executor.BasisSpotAvailable, balances)
	if basis == nil {
		t.Fatal("spot_available basis must resolve")
	}
	eqDec(t, *basis, "2500", "basis")
	budget, _ := decimal.Mul(*basis, "0.01")
	pos := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "95",
		RiskBudget: budget, FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	eqDec(t, pos.Quantity, "5", "quantity")
	eqDec(t, pos.Notional, "500", "notional")
}

func TestPRD2021LiquidationBuffer(t *testing.T) {
	// Margin feasible at L=10 (N=1000, available=100): liq = 100·(1−1/10+0) = 90 ≤ 94 → safe.
	safe, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideBuy, Entry: "100", Stop: s("95"),
		Notional: "1000", AvailableBalance: "100", MaxLeverage: "125",
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0")})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, safe.Selected, "10", "selected")
	eqDec(t, *safe.LiquidationPrice, "90", "liquidationPrice")
	if !safe.LiquidationSafe {
		t.Error("liquidationSafe = false, want true")
	}
	// Margin forces L=50: liq = 100·(1−1/50+0) = 98 > 94 → the flag must say so.
	tight, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideBuy, Entry: "100", Stop: s("95"),
		Notional: "1000", AvailableBalance: "20", MaxLeverage: "125",
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0")})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, tight.Selected, "50", "selected")
	eqDec(t, *tight.LiquidationPrice, "98", "liquidationPrice")
	if tight.LiquidationSafe {
		t.Error("liquidationSafe = true, want false")
	}
	if !hasSub(tight.Warnings, "SL-to-liquidation buffer") {
		t.Errorf("warnings %v missing the SL-to-liquidation buffer warning", tight.Warnings)
	}
}

// ---------------------------------------------------------------------------
// Rounding (PRD §71) + balance basis (PRD §10)
// ---------------------------------------------------------------------------

func TestRoundQuantityDown(t *testing.T) {
	cases := []struct{ in, want string }{
		{"0.012583", "0.012"}, // PRD §71 vector
		{"0.013", "0.013"},    // boundary preserved
		{"0.0129999", "0.012"},
		{"0.0009", "0"},
		{"-0.005", "0"},
	}
	for _, c := range cases {
		got, err := RoundQuantityDown(c.in, btc)
		if err != nil {
			t.Fatalf("RoundQuantityDown(%q): %v", c.in, err)
		}
		eqDec(t, got, c.want, "RoundQuantityDown("+c.in+")")
	}
}

func TestRoundPriceTiesHalfUp(t *testing.T) {
	cases := []struct{ in, want string }{
		{"1.005", "1.01"},   // exact tie rounds up
		{"1.004", "1"},
		{"100.0049", "100"},
		{"98000.126", "98000.13"},
	}
	for _, c := range cases {
		got, err := RoundPrice(c.in, btc)
		if err != nil {
			t.Fatalf("RoundPrice(%q): %v", c.in, err)
		}
		eqDec(t, got, c.want, "RoundPrice("+c.in+")")
	}
}

func TestResolveBalanceBasis(t *testing.T) {
	full := BalanceSnapshot{SpotAvailable: s("1"), SpotEquity: s("2"), FuturesAvailable: s("3"),
		FuturesEquity: s("4"), TotalExchangeEquity: s("5"), AssetEquity: s("6"), Custom: s("7")}
	cases := []struct {
		basis executor.BalanceBasis
		want  string // "" = honest nil
	}{
		{executor.BasisSpotAvailable, "1"}, {executor.BasisSpotEquity, "2"},
		{executor.BasisFuturesAvailable, "3"}, {executor.BasisFuturesEquity, "4"},
		{executor.BasisTotalExchange, "5"}, {executor.BasisAssetEquity, "6"},
		{executor.BasisCustom, "7"}, {"nonsense", ""},
	}
	for _, c := range cases {
		got := ResolveBalanceBasis(c.basis, full)
		if c.want == "" {
			if got != nil {
				t.Errorf("ResolveBalanceBasis(%q) = %q, want nil", c.basis, *got)
			}
		} else if got == nil {
			t.Errorf("ResolveBalanceBasis(%q) = nil, want %q", c.basis, c.want)
		} else {
			eqDec(t, *got, c.want, "ResolveBalanceBasis(string(c.basis))")
		}
	}
	bare := BalanceSnapshot{}
	for _, basis := range []executor.BalanceBasis{executor.BasisFuturesEquity, executor.BasisAssetEquity, executor.BasisCustom} {
		if got := ResolveBalanceBasis(basis, bare); got != nil {
			t.Errorf("bare snapshot %q = %q, want nil (absent is not zero)", basis, *got)
		}
	}
}

// ---------------------------------------------------------------------------
// Sizing behavior: LONG + SHORT, fees, slippage, edges
// ---------------------------------------------------------------------------

func TestRiskSizingShortMirrored(t *testing.T) {
	long := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "95",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	short := mustRisk(t, RiskPositionInput{Side: executor.SideSell, Entry: "100", Stop: "105",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	eqDec(t, long.Quantity, "4", "long quantity")
	eqDec(t, short.Quantity, "4", "short quantity")
	eqDec(t, short.Notional, "400", "short notional")
	eqDec(t, short.Risk.TotalRisk, "20", "short totalRisk")
	shortProfit, err := CalculateProfitPosition(ProfitPositionInput{Side: executor.SideSell, Entry: "100",
		Target: "90", DesiredProfit: "50", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, shortProfit.Quantity, "5", "short profit quantity")
	eqDec(t, shortProfit.EstimatedProfit, "50", "short profit")
}

func TestFeesAndSlippageShrinkQuantity(t *testing.T) {
	base := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100000", Stop: "98000",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: btc})
	market := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100000", Stop: "98000",
		RiskBudget: "20", FeeModel: fees, SlippageModel: slip, Instrument: btc, EntryType: EntryMarket})
	limit := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100000", Stop: "98000",
		RiskBudget: "20", FeeModel: fees, SlippageModel: slip, Instrument: btc, EntryType: EntryLimit})
	eqDec(t, base.Quantity, "0.01", "zero-fee quantity")
	eqDec(t, market.Quantity, "0.007", "market quantity")
	eqDec(t, limit.Quantity, "0.008", "limit quantity") // maker fee, zero entry slippage
	// unitRisk = 2020 + 250 + 245 + 50 = 2565 per BTC → 20/2565 = 0.00779727… (within 1e-12, as in the TS test)
	wantUnrounded := decimal.Trim(new(big.Rat).Quo(big.NewRat(20, 1), big.NewRat(2565, 1)))
	diff, err := decimal.Sub(market.UnroundedQuantity, wantUnrounded)
	if err != nil {
		t.Fatal(err)
	}
	if diff == "-" || strings.HasPrefix(diff, "-") {
		diff, _ = decimal.Sub(wantUnrounded, market.UnroundedQuantity)
	}
	if c, _ := decimal.Cmp(diff, "0.000000000001"); c > 0 {
		t.Errorf("market unrounded = %q, want within 1e-12 of %q", market.UnroundedQuantity, wantUnrounded)
	}
	// Breakdown sums exactly: 0.007 × [2000·1.01 + 250 + 245 + 50] = 17.955
	eqDec(t, market.Risk.PriceRisk, "14", "priceRisk")
	eqDec(t, market.Risk.EntryFee, "1.75", "entryFee")
	eqDec(t, market.Risk.ExitFee, "1.715", "exitFee")
	eqDec(t, market.Risk.SlippageRisk, "0.35", "slippageRisk")
	eqDec(t, market.Risk.SafetyReserve, "0.14", "safetyReserve")
	eqDec(t, market.Risk.TotalRisk, "17.955", "totalRisk")
}

func TestStopDistanceExtremes(t *testing.T) {
	huge := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100000", Stop: "0.01",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: btc})
	eqDec(t, huge.Quantity, "0", "huge quantity")
	if !hasSub(huge.Warnings, "rounds to 0") {
		t.Errorf("warnings %v missing 'rounds to 0'", huge.Warnings)
	}
	tiny := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "99.99999999",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	if c, _ := decimal.Cmp(tiny.Quantity, "0"); c <= 0 {
		t.Errorf("tiny quantity = %q, want > 0", tiny.Quantity)
	}
}

func TestMinimumNotionalRejects(t *testing.T) {
	inst := unit
	inst.MinNotional = s("150")
	pos := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "95",
		RiskBudget: "5", FeeModel: noFees, SlippageModel: noSlip, Instrument: inst})
	eqDec(t, pos.Quantity, "0", "risk quantity")
	eqDec(t, pos.Notional, "0", "risk notional")
	if !hasSub(pos.Warnings, "minNotional") {
		t.Errorf("warnings %v missing 'minNotional'", pos.Warnings)
	}
	profit, err := CalculateProfitPosition(ProfitPositionInput{Side: executor.SideBuy, Entry: "100",
		Target: "110", DesiredProfit: "10", FeeModel: noFees, SlippageModel: noSlip, Instrument: inst})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, profit.Quantity, "0", "profit quantity")
	if !hasSub(profit.Warnings, "minNotional") {
		t.Errorf("warnings %v missing 'minNotional'", profit.Warnings)
	}
}

func TestTinyQuantityRoundsToZero(t *testing.T) {
	inst := withStep(unit, "UNIT/USDT", "0.1", "0.01")
	pos := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "95",
		RiskBudget: "0.4", FeeModel: noFees, SlippageModel: noSlip, Instrument: inst})
	eqDec(t, pos.Quantity, "0", "quantity")
	if !hasSub(pos.Warnings, "rounds to 0") {
		t.Errorf("warnings %v missing 'rounds to 0'", pos.Warnings)
	}
}

func TestHugeQuantitiesExactCents(t *testing.T) {
	pos := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100000", Stop: "98000",
		RiskBudget: "123456789012.35", FeeModel: noFees, SlippageModel: noSlip, Instrument: btc})
	eqDec(t, pos.Quantity, "61728394.506", "quantity")        // floored to step 0.001
	eqDec(t, pos.UnroundedQuantity, "61728394.506175", "unrounded")
	eqDec(t, pos.Notional, "6172839450600", "notional")
	eqDec(t, pos.Risk.TotalRisk, "123456789012", "totalRisk") // 0.35 budget slack < one step of risk
	got, err := RoundQuantityDown("123456789012.345", btc)
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, got, "123456789012.345", "RoundQuantityDown 1e12-scale")
	gotPrice, err := RoundPrice("123456789012.345", withStep(btc, "BTC/USDT", "0.001", "0.001"))
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, gotPrice, "123456789012.345", "RoundPrice 1e12-scale")
}

func TestInvalidSLAndStructuralRefusals(t *testing.T) {
	longWrong := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "101",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	eqDec(t, longWrong.Quantity, "0", "wrong-side long quantity")
	if !hasSub(longWrong.Warnings, "loss side") {
		t.Errorf("warnings %v missing 'loss side'", longWrong.Warnings)
	}
	shortWrong := mustRisk(t, RiskPositionInput{Side: executor.SideSell, Entry: "100", Stop: "99",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	eqDec(t, shortWrong.Quantity, "0", "wrong-side short quantity")
	if !hasSub(shortWrong.Warnings, "loss side") {
		t.Errorf("warnings %v missing 'loss side'", shortWrong.Warnings)
	}
	zeroStop := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "0",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	eqDec(t, zeroStop.Quantity, "0", "zero-stop quantity")
	if !hasSub(zeroStop.Warnings, "stop price must be > 0") {
		t.Errorf("warnings %v missing 'stop price must be > 0'", zeroStop.Warnings)
	}
	nanEntry := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "NaN", Stop: "95",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	eqDec(t, nanEntry.Quantity, "0", "NaN entry quantity")
	if !hasSub(nanEntry.Warnings, "entry must be finite") {
		t.Errorf("warnings %v missing 'entry must be finite'", nanEntry.Warnings)
	}
	if _, err := CalculateRiskPosition(RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "95",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip}); err == nil {
		t.Error("missing instrument must be a structural error")
	}
	noSymbol := unit
	noSymbol.Symbol = ""
	if _, err := CalculateRiskPosition(RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "95",
		RiskBudget: "20", FeeModel: noFees, SlippageModel: noSlip, Instrument: noSymbol}); err == nil {
		t.Error("instrument without a symbol must be a structural error")
	}
}

func TestNegativeBudgetClamps(t *testing.T) {
	pos := mustRisk(t, RiskPositionInput{Side: executor.SideBuy, Entry: "100", Stop: "95",
		RiskBudget: "-5", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	eqDec(t, pos.Quantity, "0", "quantity")
	eqDec(t, pos.UnroundedQuantity, "0", "unrounded")
	if !hasSub(pos.Warnings, "clamped to 0") {
		t.Errorf("warnings %v missing 'clamped to 0'", pos.Warnings)
	}
}

func TestProfitSizingNetNeverOvershoots(t *testing.T) {
	inst := withStep(unit, "UNIT/USDT", "0.01", "0.01")
	res, err := CalculateProfitPosition(ProfitPositionInput{Side: executor.SideBuy, Entry: "100",
		Target: "110", DesiredProfit: "100", FeeModel: fees, SlippageModel: slip, Instrument: inst, EntryType: EntryMarket})
	if err != nil {
		t.Fatal(err)
	}
	// unitProfit = 10 − 0.25 − 0.275 − 0.05 = 9.425 → Q* = 10.610079… → 10.61
	eqDec(t, res.Quantity, "10.61", "quantity")
	eqDec(t, res.EstimatedProfit, "99.99925", "estimatedProfit")
	if c, _ := decimal.Cmp(res.EstimatedProfit, "100"); c > 0 {
		t.Errorf("estimatedProfit %s overshoots desired 100", res.EstimatedProfit)
	}
	if len(res.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", res.Warnings)
	}
	zeroCosts, err := CalculateProfitPosition(ProfitPositionInput{Side: executor.SideBuy, Entry: "100",
		Target: "110", DesiredProfit: "100", FeeModel: noFees, SlippageModel: noSlip, Instrument: inst})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, zeroCosts.Quantity, "10", "zero-cost quantity")
	impossible, err := CalculateProfitPosition(ProfitPositionInput{Side: executor.SideBuy, Entry: "100",
		Target: "100.001", DesiredProfit: "10", FeeModel: fees, SlippageModel: slip, Instrument: inst, EntryType: EntryMarket})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, impossible.Quantity, "0", "impossible quantity")
	if !hasSub(impossible.Warnings, "does not cover") {
		t.Errorf("warnings %v missing 'does not cover'", impossible.Warnings)
	}
}

// ---------------------------------------------------------------------------
// estimateNetProfit (planner seam)
// ---------------------------------------------------------------------------

func TestEstimateNetProfit(t *testing.T) {
	profit, err := CalculateProfitPosition(ProfitPositionInput{Side: executor.SideBuy, Entry: "100",
		Target: "110", DesiredProfit: "100", FeeModel: fees, SlippageModel: slip, Instrument: unit, EntryType: EntryMarket})
	if err != nil {
		t.Fatal(err)
	}
	single, err := EstimateNetProfit(EstimateNetProfitInput{Side: executor.SideBuy, Entry: "100",
		Quantity: profit.Quantity, TakeProfits: []executor.TakeProfitLevel{{Price: "110"}},
		FeeModel: fees, SlippageModel: slip, Instrument: unit, EntryType: EntryMarket})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, single, profit.EstimatedProfit, "single full-close equals profit sizing")
	zero, err := EstimateNetProfit(EstimateNetProfitInput{Side: executor.SideBuy, Entry: "100",
		Quantity: "4", TakeProfits: []executor.TakeProfitLevel{{Price: "110"}},
		FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, zero, "40", "PRD §14 arithmetic")

	scaled, err := EstimateNetProfit(EstimateNetProfitInput{Side: executor.SideBuy, Entry: "100",
		Quantity: "10", TakeProfits: []executor.TakeProfitLevel{{Price: "110", Fraction: "0.5"}, {Price: "120", Fraction: "0.5"}},
		FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, scaled, "150", "multi-level 5×10 + 5×20")

	// Half the position exits at 110 with 10bps fees on the FULL entry: 50 − 0.55 − 1 = 48.45
	partial, err := EstimateNetProfit(EstimateNetProfitInput{Side: executor.SideBuy, Entry: "100",
		Quantity: "10", TakeProfits: []executor.TakeProfitLevel{{Price: "110", Fraction: "0.5"}},
		FeeModel: FeeModel{MakerBps: "10", TakerBps: "10"}, SlippageModel: noSlip,
		Instrument: unit, EntryType: EntryMarket})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, partial, "48.45", "unexited remainder pays entry fee only")

	for _, c := range []struct {
		side  executor.Side
		price string
		want  string
	}{
		{executor.SideBuy, "90", "-100"},  // honest negative
		{executor.SideSell, "90", "100"},  // short win
		{executor.SideSell, "110", "-100"}, // short loss
	} {
		got, err := EstimateNetProfit(EstimateNetProfitInput{Side: c.side, Entry: "100", Quantity: "10",
			TakeProfits: []executor.TakeProfitLevel{{Price: c.price}},
			FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
		if err != nil {
			t.Fatal(err)
		}
		eqDec(t, got, c.want, "sign case "+string(c.side)+"@"+c.price)
	}
}

// ---------------------------------------------------------------------------
// Dynamic risk reconciliation (PRD §36–§37)
// ---------------------------------------------------------------------------

func TestProjectedRiskLinear(t *testing.T) {
	one, err := ProjectedRisk(ProjectedRiskInput{Side: executor.SideBuy, AverageEntry: "100", Quantity: "2",
		Stop: "95", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	if err != nil {
		t.Fatal(err)
	}
	two, err := ProjectedRisk(ProjectedRiskInput{Side: executor.SideBuy, AverageEntry: "100", Quantity: "4",
		Stop: "95", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, one.TotalRisk, "10", "q=2 totalRisk")
	eqDec(t, two.TotalRisk, "20", "q=4 totalRisk")
	if _, err := ProjectedRisk(ProjectedRiskInput{Side: executor.SideBuy, AverageEntry: "100", Quantity: "2",
		Stop: "105", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit}); err == nil ||
		!strings.Contains(err.Error(), "loss side") {
		t.Errorf("wrong-side stop must error with 'loss side', got %v", err)
	}
}

func TestMaxSafeQuantity(t *testing.T) {
	plan, err := MaxSafeQuantity(MaxSafeQuantityInput{Side: executor.SideBuy, ReferenceEntry: "100",
		Stop: "95", RemainingBudget: "20", FilledQuantity: "0", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, plan.MaxAdditionalQuantity, "4", "plan add")
	eqDec(t, plan.UnroundedAdditionalQuantity, "4", "plan unrounded")
	eqDec(t, plan.ProjectedRiskAfter.TotalRisk, "20", "plan totalRisk")

	after, err := MaxSafeQuantity(MaxSafeQuantityInput{Side: executor.SideBuy, ReferenceEntry: "100",
		Stop: "95", RemainingBudget: "20", FilledQuantity: "2", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, after.MaxAdditionalQuantity, "2", "after add")
	eqDec(t, after.ProjectedRiskAfter.TotalRisk, "20", "after totalRisk")

	over, err := MaxSafeQuantity(MaxSafeQuantityInput{Side: executor.SideBuy, ReferenceEntry: "100",
		Stop: "95", RemainingBudget: "20", FilledQuantity: "10", FeeModel: noFees, SlippageModel: noSlip, Instrument: unit})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, over.MaxAdditionalQuantity, "0", "over add")
	if !hasSub(over.Warnings, "already consumes") {
		t.Errorf("warnings %v missing 'already consumes'", over.Warnings)
	}
}

func TestMaxSafeQuantityAddedLegPaysEntryCosts(t *testing.T) {
	res, err := MaxSafeQuantity(MaxSafeQuantityInput{Side: executor.SideBuy, ReferenceEntry: "100",
		Stop: "95", RemainingBudget: "25", FilledQuantity: "1",
		FeeModel: FeeModel{MakerBps: "10", TakerBps: "10"}, SlippageModel: noSlip, Instrument: unit})
	if err != nil {
		t.Fatal(err)
	}
	// filled unit: price risk 5 + exit 95·0.001 = 5.095 fixed. added unit: 5 + 0.1 + 0.095 = 5.195.
	// remaining 25 − 5.095 = 19.905 → 3.831… → 3 whole units.
	eqDec(t, res.MaxAdditionalQuantity, "3", "add")
	if c, _ := decimal.Cmp(res.UnroundedAdditionalQuantity, "3"); c <= 0 {
		t.Errorf("unrounded %s want > 3", res.UnroundedAdditionalQuantity)
	}
	if c, _ := decimal.Cmp(res.UnroundedAdditionalQuantity, "4"); c >= 0 {
		t.Errorf("unrounded %s want < 4", res.UnroundedAdditionalQuantity)
	}
	eqDec(t, res.ProjectedRiskAfter.TotalRisk, "20.68", "projected totalRisk") // 5.095 + 5.195·3
}

// ---------------------------------------------------------------------------
// Leverage + liquidation (PRD §18–§21)
// ---------------------------------------------------------------------------

func TestLiquidationPriceApprox(t *testing.T) {
	cases := []struct {
		side  executor.Side
		lev   string
		mmr   *string
		want  string
	}{
		{executor.SideBuy, "2", s("0.005"), "50.5"},
		{executor.SideSell, "2", s("0.005"), "149.5"},
		{executor.SideBuy, "10", nil, "90.5"}, // default mmr 0.005
	}
	for _, c := range cases {
		got, err := LiquidationPriceApprox(c.side, "100", c.lev, c.mmr)
		if err != nil {
			t.Fatal(err)
		}
		eqDec(t, got, c.want, "liq "+string(c.side)+" L="+c.lev)
	}
	if _, err := LiquidationPriceApprox(executor.SideBuy, "100", "0", nil); err == nil {
		t.Error("leverage 0 must be refused")
	}
}

func TestAutoSafeLeverageMinimumFeasible(t *testing.T) {
	res, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideBuy, Entry: "100", Stop: s("95"),
		Notional: "1000", AvailableBalance: "250", MaxLeverage: "50", ExchangeMaxLeverage: s("100"),
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0.005")})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, res.Selected, "4", "selected") // N=1000 avail=250 → 4x
	eqDec(t, res.EstimatedMargin, "250", "estimatedMargin")
	eqDec(t, *res.LiquidationPrice, "75.5", "liquidationPrice")
	if !res.LiquidationSafe {
		t.Error("liquidationSafe = false, want true")
	}
	if len(res.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", res.Warnings)
	}
	low, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideBuy, Entry: "100", Stop: s("95"),
		Notional: "1000", AvailableBalance: "1000", MaxLeverage: "50",
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0.005")})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, low.Selected, "1", "low selected")
	eqDec(t, low.EstimatedMargin, "1000", "low margin")
}

func TestAutoSafeLeverageCaps(t *testing.T) {
	// Margin lower bound 400x exceeds both caps → selected = exchange cap, infeasible, never claimed safe.
	over, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideBuy, Entry: "100", Stop: s("95"),
		Notional: "100000", AvailableBalance: "250", MaxLeverage: "250", ExchangeMaxLeverage: s("200"),
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0.005")})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, over.Selected, "200", "over selected") // min(user 250, exchange 200)
	if over.LiquidationSafe {
		t.Error("over: liquidationSafe must not be claimed")
	}
	if !hasSub(over.Warnings, "insufficient available balance for margin at max leverage") {
		t.Errorf("warnings %v missing infeasibility warning", over.Warnings)
	}
	userCap, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideBuy, Entry: "100", Stop: s("95"),
		Notional: "1000", AvailableBalance: "250", MaxLeverage: "3", ExchangeMaxLeverage: s("200"),
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0.005")})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, userCap.Selected, "3", "userCap selected")
	if userCap.LiquidationSafe {
		t.Error("userCap: liquidationSafe must not be claimed")
	}
	if !hasSub(userCap.Warnings, "insufficient available balance") {
		t.Errorf("warnings %v missing infeasibility warning", userCap.Warnings)
	}
	none, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideBuy, Entry: "100", Stop: s("95"),
		Notional: "1000", AvailableBalance: "250", MaxLeverage: "0",
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0.005")})
	if err != nil {
		t.Fatal(err)
	}
	if none.LiquidationSafe {
		t.Error("cap below 1 must not claim safety")
	}
	if len(none.Warnings) == 0 {
		t.Error("cap below 1 must warn")
	}
}

func TestAutoSafeLeverageHonestUnsafe(t *testing.T) {
	// N=1000 avail=45 → lower bound 23x → liq ≈ 96.152173913043 sits INSIDE the 94 buffer target.
	res, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideBuy, Entry: "100", Stop: s("95"),
		Notional: "1000", AvailableBalance: "45", MaxLeverage: "125",
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0.005")})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, res.Selected, "23", "selected")
	eqDec(t, *res.LiquidationPrice, "96.152173913043", "liquidationPrice") // wire-rounded to 12 dp
	if res.LiquidationSafe {
		t.Error("liquidationSafe = true, want false")
	}
	if !hasSub(res.Warnings, "SL-to-liquidation buffer") {
		t.Errorf("warnings %v missing buffer warning", res.Warnings)
	}
	noStop, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideBuy, Entry: "100", Stop: nil,
		Notional: "1000", AvailableBalance: "250", MaxLeverage: "50",
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0.005")})
	if err != nil {
		t.Fatal(err)
	}
	if noStop.LiquidationSafe {
		t.Error("no stop: safety cannot be verified and must not be claimed")
	}
	if !hasSub(noStop.Warnings, "cannot be verified") {
		t.Errorf("warnings %v missing 'cannot be verified'", noStop.Warnings)
	}
}

func TestAutoSafeLeverageShortBufferMirrored(t *testing.T) {
	res, err := AutoSafeLeverage(AutoLeverageInput{Side: executor.SideSell, Entry: "100", Stop: s("105"),
		Notional: "1000", AvailableBalance: "100", MaxLeverage: "125",
		LiquidationBufferPct: "0.2", MaxMarginPct: "1", MaintenanceMarginRate: s("0")})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, res.Selected, "10", "selected")
	eqDec(t, *res.LiquidationPrice, "110", "liquidationPrice") // 100·(1+1/10−0) ≥ 105 + 5·0.2 = 106
	if !res.LiquidationSafe {
		t.Error("liquidationSafe = false, want true")
	}
}

// ---------------------------------------------------------------------------
// Constraint solver (PRD §15)
// ---------------------------------------------------------------------------

func TestSolvePositionDerived(t *testing.T) {
	res, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip,
		Known: SolveKnown{Entry: s("100"), Stop: s("95"), Target: s("110"), Quantity: s("4")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Conflicts) != 0 {
		t.Errorf("conflicts = %v, want none", res.Conflicts)
	}
	eqDec(t, res.Solved["risk"], "20", "risk")
	eqDec(t, res.Solved["profit"], "40", "profit")
	eqDec(t, res.Solved["notional"], "400", "notional")
	if len(res.Unsatisfied) != 2 || res.Unsatisfied[0] != SolveMargin || res.Unsatisfied[1] != SolveLeverage {
		t.Errorf("unsatisfied = %v, want [margin leverage]", res.Unsatisfied)
	}
}

func TestSolvePositionMarginPropagation(t *testing.T) {
	fromMargin, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip, Known: SolveKnown{Entry: s("100"), Quantity: s("4"), Margin: s("100")}})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, fromMargin.Solved["notional"], "400", "fromMargin notional")
	eqDec(t, fromMargin.Solved["leverage"], "4", "fromMargin leverage")

	fromLeverage, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip, Known: SolveKnown{Leverage: s("4"), Margin: s("250")}})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, fromLeverage.Solved["notional"], "1000", "fromLeverage notional")

	fromNotional, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip, Known: SolveKnown{Notional: s("1000"), Leverage: s("4")}})
	if err != nil {
		t.Fatal(err)
	}
	eqDec(t, fromNotional.Solved["margin"], "250", "fromNotional margin")
}

func TestSolvePositionUnderdeterminedAndConflicts(t *testing.T) {
	open, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip, Known: SolveKnown{Entry: s("100")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(open.Solved) != 1 {
		t.Errorf("solved = %v, want exactly {entry:100}", open.Solved)
	}
	wantOpen := []SolveKey{SolveStop, SolveTarget, SolveQuantity, SolveRisk, SolveProfit, SolveMargin, SolveNotional, SolveLeverage}
	if len(open.Unsatisfied) != len(wantOpen) {
		t.Fatalf("unsatisfied = %v, want %v", open.Unsatisfied, wantOpen)
	}
	for i := range wantOpen {
		if open.Unsatisfied[i] != wantOpen[i] {
			t.Errorf("unsatisfied[%d] = %q, want %q", i, open.Unsatisfied[i], wantOpen[i])
		}
	}

	bad, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip,
		Known: SolveKnown{Entry: s("100"), Stop: s("95"), Quantity: s("4"), Risk: s("30")}})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range bad.Conflicts {
		if c.Code == "inconsistent_known_values" {
			found = true
		}
	}
	if !found {
		t.Errorf("conflicts = %v, want inconsistent_known_values", bad.Conflicts)
	}

	badStop, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip,
		Known: SolveKnown{Entry: s("100"), Stop: s("105"), Quantity: s("4")}})
	if err != nil {
		t.Fatal(err)
	}
	found = false
	for _, c := range badStop.Conflicts {
		if c.Code == "invalid_stop" {
			found = true
		}
	}
	if !found {
		t.Errorf("conflicts = %v, want invalid_stop", badStop.Conflicts)
	}

	agreeing, err := SolvePosition(SolveInput{Side: executor.SideBuy, Instrument: unit,
		FeeModel: noFees, SlippageModel: noSlip,
		Known: SolveKnown{Entry: s("100"), Stop: s("95"), Target: s("110"), Risk: s("20"), Profit: s("40")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(agreeing.Conflicts) != 0 {
		t.Errorf("agreeing risk+profit conflicts = %v, want none", agreeing.Conflicts)
	}
	eqDec(t, agreeing.Solved["quantity"], "4", "agreeing quantity")
}
