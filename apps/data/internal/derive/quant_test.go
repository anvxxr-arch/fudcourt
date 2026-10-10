package derive

import (
	"math"
	"testing"
)

// The quant fixture: 10 prices of a hand-checkable sawtooth, shared by the
// return-based tests below.
var quantX = []float64{100, 102, 101, 103, 105, 104, 106, 108, 107, 109}

// The second series for correlation: anti-phase around the same length.
var quantY = []float64{100, 98, 101, 100, 103, 105, 104, 107, 109, 110}

// TestLogReturns pins ln ratios with the NaN head and the non-positive
// convention: a non-positive price is absent data, so it and its neighbor
// returns are NaN.
func TestLogReturns(t *testing.T) {
	got := LogReturns(quantX)
	want := []float64{
		math.NaN(),
		0.019802627296178876, -0.009852296443011, 0.01960847138837618,
		0.019231361927887214, -0.009569451016150587, 0.019048194970694432,
		0.018692133012153, -0.00930239266231414, 0.018519047767237673,
	}
	assertSlice(t, "log returns", got, want)

	nonPos := LogReturns([]float64{100, 0, 101})
	if !math.IsNaN(nonPos[1]) || !math.IsNaN(nonPos[2]) {
		t.Fatalf("log returns non-positive: got %v, want NaN at 1,2", nonPos)
	}
}

// TestSimpleReturns pins x[i]/x[i-1]-1 with the same conventions.
func TestSimpleReturns(t *testing.T) {
	got := SimpleReturns(quantX)
	want := []float64{
		math.NaN(),
		0.020000000000000018, -0.009803921568627416, 0.01980198019801982,
		0.01941747572815533, -0.00952380952380949, 0.019230769230769162,
		0.018867924528301883, -0.0092592592592593, 0.01869158878504673,
	}
	assertSlice(t, "simple returns", got, want)
}

// TestRollingVolatility pins the rolling stddev of log returns (window 4:
// valid from index 4, NaN head of 4).
func TestRollingVolatility(t *testing.T) {
	got := RollingVolatility(quantX, 4)
	want := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(),
		0.012732136455662882, 0.01456634867728685, 0.012500743266037312,
		0.012368368723104713, 0.014153917701415799, 0.012149893440462895,
	}
	assertSlice(t, "rolling volatility", got, want)
}

// TestRollingStdDevNaN pins NaN propagation through the windowing.
func TestRollingStdDevNaN(t *testing.T) {
	got := RollingStdDev([]float64{1, 2, math.NaN(), 4, 5}, 3)
	for i, v := range got {
		if !math.IsNaN(v) {
			t.Fatalf("rolling stddev with NaN window: index %d = %v, want NaN", i, v)
		}
	}
}

// TestRollingCorrelation pins the Pearson correlation of the two fixtures'
// log returns over window 4.
func TestRollingCorrelation(t *testing.T) {
	got := RollingCorrelation(LogReturns(quantX), LogReturns(quantY), 4)
	want := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(),
		-0.5904506160105291, -0.4663417768302131, -0.39684453691947136,
		-0.0870632493775841, -0.3398685405006617, -0.2936023244398804,
	}
	assertSlice(t, "rolling correlation", got, want)

	// Perfectly correlated inputs give exactly 1.
	same := RollingCorrelation(LogReturns(quantX), LogReturns(quantX), 4)
	if math.Abs(same[len(same)-1]-1) > 1e-12 {
		t.Fatalf("self-correlation = %v, want 1", same[len(same)-1])
	}
}

// TestRollingZScore pins (x - rolling mean)/rolling stddev on window 4: the
// sawtooth repeats, so the z-scores cycle through 3 values.
func TestRollingZScore(t *testing.T) {
	got := RollingZScore(quantX, 4)
	want := []float64{
		math.NaN(), math.NaN(), math.NaN(),
		1.3416407864998738, 1.52127765851133, 0.50709255283711,
		1.3416407864998738, 1.52127765851133, 0.50709255283711,
		1.3416407864998738,
	}
	assertSlice(t, "rolling zscore", got, want)

	// A constant window has zero stddev: NaN, never 0.
	flat := RollingZScore([]float64{5, 5, 5, 5, 5}, 4)
	if !math.IsNaN(flat[3]) || !math.IsNaN(flat[4]) {
		t.Fatalf("rolling zscore flat window: got %v, want NaN", flat)
	}
}

// TestRollingPercentileRank pins the inclusive rank fraction on window 4.
func TestRollingPercentileRank(t *testing.T) {
	got := RollingPercentileRank(quantX, 4)
	want := []float64{
		math.NaN(), math.NaN(), math.NaN(),
		1, 1, 0.75, 1, 1, 0.75, 1,
	}
	assertSlice(t, "rolling percentile rank", got, want)
}

// TestDrawdown pins the running-peak drawdown and its maximum.
func TestDrawdown(t *testing.T) {
	got := Drawdown(quantX)
	want := []float64{
		0, 0, -0.009803921568627416, 0, 0,
		-0.00952380952380949, 0, 0, -0.0092592592592593, 0,
	}
	assertSlice(t, "drawdown", got, want)

	if got := MaxDrawdown(quantX); math.Abs(got-(-0.009803921568627416)) > 1e-12 {
		t.Fatalf("max drawdown = %v, want -0.009803921568627416", got)
	}

	// An always-rising series never draws down.
	if got := MaxDrawdown([]float64{1, 2, 3, 4}); got != 0 {
		t.Fatalf("max drawdown rising series = %v, want 0", got)
	}
	if got := MaxDrawdown([]float64{}); !math.IsNaN(got) {
		t.Fatalf("max drawdown empty = %v, want NaN", got)
	}
}

// TestRollingSharpe pins the rolling mean/stddev of log returns (window 4,
// valid from index 4) with rf=0.
func TestRollingSharpe(t *testing.T) {
	got := RollingSharpe(quantX, 4)
	want := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(),
		0.958012120340786, 0.3332696183392242, 0.966314087140757,
		0.9581344144041076, 0.3332731739441885, 0.9662015415581695,
	}
	assertSlice(t, "rolling sharpe", got, want)
}

// TestRollingSortino pins the rolling mean over downside deviation (window
// 4). The denominator counts losses only.
func TestRollingSortino(t *testing.T) {
	got := RollingSortino(quantX, 4)
	want := []float64{
		math.NaN(), math.NaN(), math.NaN(), math.NaN(),
		2.4760808026661607, 0.7068985102750796, 2.524626396501682,
		2.47674808171243, 0.7069101315629259, 2.523919640481482,
	}
	assertSlice(t, "rolling sortino", got, want)
}

// TestMomentum pins x[i]-x[i-n]: the sawtooth rises 3 every 3 bars.
func TestMomentum(t *testing.T) {
	got := Momentum(quantX, 3)
	want := []float64{math.NaN(), math.NaN(), math.NaN(), 3, 3, 3, 3, 3, 3, 3}
	assertSlice(t, "momentum", got, want)
}
