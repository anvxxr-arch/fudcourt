package derive

import (
	"math"
	"testing"
)

// eqSlice reports whether got matches want elementwise: both NaN, or both
// finite within tol.
func eqSlice(got, want []float64, tol float64) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range want {
		gn, wn := math.IsNaN(got[i]), math.IsNaN(want[i])
		if gn != wn {
			return false
		}
		if !gn && math.Abs(got[i]-want[i]) > tol {
			return false
		}
	}
	return true
}

func assertSlice(t *testing.T, name string, got, want []float64) {
	t.Helper()
	if !eqSlice(got, want, 1e-9) {
		t.Fatalf("%s mismatch\n got: %v\nwant: %v", name, got, want)
	}
}

// TestSMA pins the hand-computed moving average: NaN head of n-1, then the
// window means, and NaN propagation when a window contains an absent value.
func TestSMA(t *testing.T) {
	got := SMA([]float64{2, 4, 6, 8, 10}, 3)
	want := []float64{math.NaN(), math.NaN(), 4, 6, 8}
	assertSlice(t, "SMA(2,4,6,8,10;3)", got, want)

	gotNaN := SMA([]float64{1, math.NaN(), 3, 4, 5}, 2)
	wantNaN := []float64{math.NaN(), math.NaN(), math.NaN(), 3.5, 4.5}
	assertSlice(t, "SMA(NaN window)", gotNaN, wantNaN)
}

// TestEMA pins the SMA-seeded exponential average on a ramp: EMA(1..5;3) is
// exactly 2,3,4 (seed 2, alpha 0.5).
func TestEMA(t *testing.T) {
	got := EMA([]float64{1, 2, 3, 4, 5}, 3)
	want := []float64{math.NaN(), math.NaN(), 2, 3, 4}
	assertSlice(t, "EMA(1..5;3)", got, want)

	gotNaN := EMA([]float64{math.NaN(), 1, 2, 3, 4}, 2)
	wantNaN := []float64{math.NaN(), math.NaN(), 1.5, 2.5, 3.5}
	assertSlice(t, "EMA(NaN head input)", gotNaN, wantNaN)
}

// TestRSI pins Wilder RSI on 12 closes with n=5 (indices 5..11 are finite,
// 0..4 NaN) plus the flat-window corner case (50) and the all-gain window
// (100).
func TestRSI(t *testing.T) {
	got := RSI([]float64{10, 11, 12, 11, 10, 12, 13, 14, 13, 12, 13, 14}, 5)
	want := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), math.NaN(),
		66.66666666666666, 72.41379310344828, 77.30496453900709,
		63.280116110304796, 51.58237207926649, 60.670310529160915,
		68.14439133554689,
	}
	assertSlice(t, "RSI(n=5)", got, want)

	flat := RSI([]float64{5, 5, 5, 5, 5, 5, 5}, 5)
	if !math.IsNaN(flat[4]) {
		t.Fatalf("RSI flat window: index 4 = %v, want NaN", flat[4])
	}
	if flat[5] != 50 {
		t.Fatalf("RSI flat window: index 5 = %v, want 50", flat[5])
	}

	up := RSI([]float64{1, 2, 3, 4, 5, 6, 7}, 5)
	if up[5] != 100 {
		t.Fatalf("RSI all-gain window: index 5 = %v, want 100", up[5])
	}

	short := RSI([]float64{1, 2, 3}, 5)
	for i, v := range short {
		if !math.IsNaN(v) {
			t.Fatalf("RSI(len=3,n=5): index %d = %v, want NaN", i, v)
		}
	}
}

// TestRSIWilderClassic pins the textbook Wilder seed fixture (15 closes,
// n=14): the first finite value is the 14-period simple average of the first
// 14 deltas' gains and losses.
func TestRSIWilderClassic(t *testing.T) {
	closes := []float64{
		44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
		45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
	}
	got := RSI(closes, 14)
	for i := 0; i < 14; i++ {
		if !math.IsNaN(got[i]) {
			t.Fatalf("RSI classic: index %d = %v, want NaN", i, got[i])
		}
	}
	if math.Abs(got[14]-70.46413502109705) > 1e-6 {
		t.Fatalf("RSI classic: index 14 = %v, want 70.46413502109705", got[14])
	}
}

// TestMACD pins the three MACD outputs on a ramp with fast=2, slow=4,
// signal=2: a linear ramp has a constant EMA difference of 1 from index 3.
func TestMACD(t *testing.T) {
	x := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	macd, sig, hist := MACD(x, 2, 4, 2)
	wantMACD := []float64{
		math.NaN(), math.NaN(), math.NaN(), 1, 1, 1, 1, 1, 1, 1,
	}
	wantSig := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), 1, 1, 1, 1, 1, 1,
	}
	wantHist := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), 0, 0, 0, 0, 0, 0,
	}
	assertSlice(t, "macd", macd, wantMACD)
	assertSlice(t, "macd signal", sig, wantSig)
	assertSlice(t, "macd hist", hist, wantHist)
}

// TestBollingerBands pins the population-stddev bands on 5 points with n=5
// and n=3.
func TestBollingerBands(t *testing.T) {
	x := []float64{2, 4, 6, 8, 10}

	upper, mid, lower := BollingerBands(x, 5, 2)
	assertSlice(t, "bb upper n=5", upper, []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), 11.65685424949238,
	})
	assertSlice(t, "bb mid n=5", mid, []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), 6,
	})
	assertSlice(t, "bb lower n=5", lower, []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), 0.3431457505076194,
	})

	upper3, mid3, lower3 := BollingerBands(x, 3, 2)
	assertSlice(t, "bb upper n=3", upper3, []float64{
		math.NaN(), math.NaN(), 7.265986323710904, 9.265986323710905, 11.265986323710905,
	})
	assertSlice(t, "bb mid n=3", mid3, []float64{
		math.NaN(), math.NaN(), 4, 6, 8,
	})
	assertSlice(t, "bb lower n=3", lower3, []float64{
		math.NaN(), math.NaN(), 0.7340136762890959, 2.734013676289096, 4.734013676289096,
	})
}

// The OHLC fixture shared by the range-based indicators: 10 bars of a
// hand-checkable uptrend with one pullback.
var (
	atrHigh  = []float64{10, 11, 12, 11, 12, 13, 14, 13, 14, 15}
	atrLow   = []float64{9, 10, 10, 9, 10, 11, 12, 11, 12, 13}
	atrClose = []float64{9.5, 10.5, 11.5, 10.5, 11.5, 12.5, 13.5, 12.5, 13.5, 14.5}
	atrVol   = []float64{100, 150, 120, 80, 200, 210, 160, 90, 140, 220}
)

// TestATR pins Wilder ATR(n=3): TR[0] is the plain range, TR[i] includes the
// gap against the previous close, seeding is the mean of the first 3 TRs and
// the update is prev + (tr-prev)/3.
func TestATR(t *testing.T) {
	got := ATR(atrHigh, atrLow, atrClose, 3)
	want := []float64{
		math.NaN(), math.NaN(), 1.5, 1.8333333333333333, 1.8888888888888888,
		1.9259259259259258, 1.9506172839506173, 2.133744855967078,
		2.0891632373113853, 2.0594421582075904,
	}
	assertSlice(t, "ATR(n=3)", got, want)
}

// TestTrueRangeCornerCases pins the TR definition: bar 0 has no previous
// close, and a gap makes the gap dominate.
func TestTrueRangeCornerCases(t *testing.T) {
	h := []float64{10, 12}
	l := []float64{9, 11}
	c := []float64{9.5, 11.5}
	if got := trueRange(h, l, c, 0); got != 1 {
		t.Fatalf("trueRange bar 0 = %v, want 1 (plain range)", got)
	}
	// Bar 1: h-l = 1, |h-prevC| = 2.5, |l-prevC| = 1.5 → 2.5.
	if got := trueRange(h, l, c, 1); got != 2.5 {
		t.Fatalf("trueRange bar 1 = %v, want 2.5", got)
	}
}

// TestStochastic pins %K (SMA-3 of raw) and %D (SMA-3 of %K) on the shared
// OHLC fixture with n=5, k=3, d=3.
func TestStochastic(t *testing.T) {
	k, d := Stochastic(atrHigh, atrLow, atrClose, 5, 3, 3)
	wantK := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), math.NaN(), math.NaN(),
		86.94444444444444, 82.5, 82.5, 81.66666666666667,
	}
	wantD := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), math.NaN(), math.NaN(),
		math.NaN(), math.NaN(), 83.98148148148148, 82.22222222222223,
	}
	assertSlice(t, "stoch %K", k, wantK)
	assertSlice(t, "stoch %D", d, wantD)
}

// TestStochasticFlatWindow pins the flat-window convention: zero high-low
// range maps raw %K to 50, not a division by zero.
func TestStochasticFlatWindow(t *testing.T) {
	h := []float64{10, 10, 10, 10, 10, 10}
	l := []float64{10, 10, 10, 10, 10, 10}
	c := []float64{10, 10, 10, 10, 10, 10}
	k, _ := Stochastic(h, l, c, 5, 1, 1)
	if k[4] != 50 || k[5] != 50 {
		t.Fatalf("stoch flat window: k[4]=%v k[5]=%v, want 50/50", k[4], k[5])
	}
}

// TestADX pins ADX(n=3) on the shared OHLC fixture: valid from index 2n-1
// (first full DX window at 3, ADX seed needs 3 DX values), NaN head.
func TestADX(t *testing.T) {
	got := ADX(atrHigh, atrLow, atrClose, 3)
	want := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), math.NaN(),
		53.08641975308643, 62.13991769547326, 48.148148148148145,
		47.69090077732053, 53.29980185947264,
	}
	assertSlice(t, "ADX(n=3)", got, want)
}

// TestOBV pins the signed-volume running sum on the shared fixture: up bars
// add volume, down bars subtract, unchanged bars carry forward. OBV[0] is 0,
// not NaN (the sum starts at the first bar).
func TestOBV(t *testing.T) {
	got := OBV(atrClose, atrVol)
	want := []float64{0, 150, 270, 190, 390, 600, 760, 670, 810, 1030}
	assertSlice(t, "OBV", got, want)

	// A NaN close poisons the running sum from that bar on.
	broken := OBV([]float64{1, 2, math.NaN(), 3, 4}, []float64{10, 10, 10, 10, 10})
	if !math.IsNaN(broken[2]) || !math.IsNaN(broken[3]) || !math.IsNaN(broken[4]) {
		t.Fatalf("OBV NaN poisoning: got %v, want NaN from index 2", broken)
	}
	if broken[1] != 10 {
		t.Fatalf("OBV before poison: got %v at 1, want 10", broken[1])
	}
}

// TestRollingVWAP pins the session-anchored VWAP on two 5-bar sessions: each
// session restarts the accumulation, bars in a session without volume yet
// are NaN.
func TestRollingVWAP(t *testing.T) {
	sessions := []int{1, 1, 1, 1, 1, 2, 2, 2, 2, 2}
	got := rollingVWAP(atrHigh, atrLow, atrClose, atrVol, sessions)
	want := []float64{
		9.5, 10.1, 10.445945945945946, 10.396296296296295, 10.633333333333333,
		12.166666666666666, 12.599099099099098, 12.514492753623188,
		12.666666666666664, 13.06910569105691,
	}
	assertSlice(t, "session VWAP", got, want)
}

// TestSupertrend pins the ATR trailing band on the shared fixture with
// n=3, mult=2: NaN until the first ATR, then the finalized lower band while
// the uptrend holds.
func TestSupertrend(t *testing.T) {
	got := Supertrend(atrHigh, atrLow, atrClose, 3, 2)
	want := []float64{
		math.NaN(), math.NaN(), 8, 8, 8, 8.148148148148149,
		9.098765432098766, 9.098765432098766, 9.098765432098766,
		9.88111568358482,
	}
	assertSlice(t, "supertrend", got, want)
}

// TestIchimoku pins the four lines on the shared fixture with tenkan=3,
// kijun=5, senkouB=9 (periods small enough for a 10-bar fixture). Senkou A
// needs both tenkan and kijun, senkou B its own window.
func TestIchimoku(t *testing.T) {
	ten, kij, sa, sb := Ichimoku(atrHigh, atrLow, 3, 5, 9)
	assertSlice(t, "tenkan", ten, []float64{
		math.NaN(), math.NaN(), 10.5, 10.5, 10.5, 11, 12, 12.5, 12.5, 13,
	})
	assertSlice(t, "kijun", kij, []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), 10.5, 11, 11.5, 11.5, 12, 13,
	})
	assertSlice(t, "senkou A", sa, []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), 10.5, 11, 11.75, 12, 12.25, 13,
	})
	assertSlice(t, "senkou B", sb, []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(), math.NaN(), math.NaN(),
		math.NaN(), math.NaN(), 11.5, 12,
	})
}
