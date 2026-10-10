package derive

import "math"

// This file holds the pure quant functions over float64 slices. The same
// conventions as indicators.go: same-length outputs, NaN-padded heads, NaN
// input propagates to NaN output (never zero-filled), stdlib only.

// LogReturns is ln(x[i]/x[i-1]). Position 0 has no previous value; a
// non-positive price is absent data (never-fake), not a return, so it and the
// return it would produce are NaN.
func LogReturns(x []float64) []float64 {
	out := nanLike(x)
	for i := 1; i < len(x); i++ {
		if math.IsNaN(x[i]) || math.IsNaN(x[i-1]) || x[i] <= 0 || x[i-1] <= 0 {
			continue
		}
		out[i] = math.Log(x[i]) - math.Log(x[i-1])
	}
	return out
}

// SimpleReturns is x[i]/x[i-1] - 1 with the same NaN conventions.
func SimpleReturns(x []float64) []float64 {
	out := nanLike(x)
	for i := 1; i < len(x); i++ {
		if math.IsNaN(x[i]) || math.IsNaN(x[i-1]) || x[i-1] == 0 {
			continue
		}
		out[i] = x[i]/x[i-1] - 1
	}
	return out
}

// RollingStdDev is the population (divisor n) standard deviation over each
// trailing window of n values. Windows containing NaN are NaN.
func RollingStdDev(x []float64, n int) []float64 {
	out := nanLike(x)
	if n <= 0 {
		return out
	}
	for i := n - 1; i < len(x); i++ {
		w := x[i-n+1 : i+1]
		mean, ok := windowMean(w)
		if !ok {
			continue
		}
		out[i] = windowStdDev(w, mean)
	}
	return out
}

// RollingVolatility is the rolling standard deviation of log returns. Valid
// from index n (needs n returns, i.e. n+1 prices).
func RollingVolatility(x []float64, n int) []float64 {
	return RollingStdDev(LogReturns(x), n)
}

// RollingCorrelation is the Pearson correlation of x and y over each trailing
// window. A constant window (zero variance on either side) has no defined
// correlation: NaN, never 0.
func RollingCorrelation(x, y []float64, n int) []float64 {
	out := nanLike(x)
	if n <= 0 || len(x) != len(y) {
		return out
	}
	for i := n - 1; i < len(x); i++ {
		wx := x[i-n+1 : i+1]
		wy := y[i-n+1 : i+1]
		mx, okx := windowMean(wx)
		my, oky := windowMean(wy)
		if !okx || !oky {
			continue
		}
		vx, vy, cov := 0.0, 0.0, 0.0
		for k := range wx {
			dx := wx[k] - mx
			dy := wy[k] - my
			vx += dx * dx
			vy += dy * dy
			cov += dx * dy
		}
		den := math.Sqrt(vx * vy)
		if den != 0 {
			out[i] = cov / den
		}
	}
	return out
}

// RollingZScore is (x[i] - rolling mean(n)) / rolling stddev(n). A constant
// window (zero stddev) has no z-score: NaN.
func RollingZScore(x []float64, n int) []float64 {
	out := nanLike(x)
	if n <= 0 {
		return out
	}
	for i := n - 1; i < len(x); i++ {
		w := x[i-n+1 : i+1]
		mean, ok := windowMean(w)
		if !ok {
			continue
		}
		sd := windowStdDev(w, mean)
		if sd != 0 {
			out[i] = (x[i] - mean) / sd
		}
	}
	return out
}

// RollingPercentileRank is the fraction of the trailing window (inclusive of
// the current value) that is <= the current value: 1.0 = window high, small
// = near the window low. Uses <= so the current value always ranks against
// itself, keeping the range [1/n, 1].
func RollingPercentileRank(x []float64, n int) []float64 {
	out := nanLike(x)
	if n <= 0 {
		return out
	}
	for i := n - 1; i < len(x); i++ {
		if math.IsNaN(x[i]) {
			continue
		}
		count, ok := 0, true
		for j := i - n + 1; j <= i; j++ {
			if math.IsNaN(x[j]) {
				ok = false
				break
			}
			if x[j] <= x[i] {
				count++
			}
		}
		if ok {
			out[i] = float64(count) / float64(n)
		}
	}
	return out
}

// Drawdown is x[i]/peak(x[0..i]) - 1: 0 at a running high, negative below
// it. The peak scan skips NaN gaps.
func Drawdown(x []float64) []float64 {
	out := nanLike(x)
	peak := math.NaN()
	for i, v := range x {
		if math.IsNaN(v) {
			continue
		}
		if math.IsNaN(peak) || v > peak {
			peak = v
		}
		if peak != 0 {
			out[i] = v/peak - 1
		}
	}
	return out
}

// MaxDrawdown is the most negative drawdown over the series: 0 for an
// always-rising series, NaN when the series has no values.
func MaxDrawdown(x []float64) float64 {
	worst := math.NaN()
	for _, v := range Drawdown(x) {
		if math.IsNaN(v) {
			continue
		}
		if math.IsNaN(worst) || v < worst {
			worst = v
		}
	}
	return worst
}

// RollingSharpe is the rolling mean(log returns over window)/rolling
// stddev(log returns), risk-free rate 0. A window is valid once n returns
// exist (from index n); a zero-stddev window is NaN, never 0.
func RollingSharpe(x []float64, n int) []float64 {
	r := LogReturns(x)
	out := nanLike(x)
	if n <= 0 {
		return out
	}
	for i := n; i < len(x); i++ {
		w := r[i-n+1 : i+1]
		mean, ok := windowMean(w)
		if !ok {
			continue
		}
		sd := windowStdDev(w, mean)
		if sd != 0 {
			out[i] = mean / sd
		}
	}
	return out
}

// RollingSortino is the rolling mean(log returns)/downside deviation, where
// the downside deviation is sqrt(mean(min(r,0)^2)) over the window. Only
// losses contribute to the denominator; a window with no losses is NaN
// (infinite Sharpe is not a number this platform stores).
func RollingSortino(x []float64, n int) []float64 {
	r := LogReturns(x)
	out := nanLike(x)
	if n <= 0 {
		return out
	}
	for i := n; i < len(x); i++ {
		w := r[i-n+1 : i+1]
		mean, ok := windowMean(w)
		if !ok {
			continue
		}
		downside := 0.0
		for _, v := range w {
			if v < 0 {
				downside += v * v
			}
		}
		dd := math.Sqrt(downside / float64(n))
		if dd != 0 {
			out[i] = mean / dd
		}
	}
	return out
}

// Momentum is x[i] - x[i-n]: the absolute change over n bars. Valid from
// index n.
func Momentum(x []float64, n int) []float64 {
	out := nanLike(x)
	if n <= 0 {
		return out
	}
	for i := n; i < len(x); i++ {
		if math.IsNaN(x[i]) || math.IsNaN(x[i-n]) {
			continue
		}
		out[i] = x[i] - x[i-n]
	}
	return out
}

// windowMean reports the mean of w and whether the window is fully observed
// (no NaN).
func windowMean(w []float64) (mean float64, ok bool) {
	sum := 0.0
	for _, v := range w {
		if math.IsNaN(v) {
			return 0, false
		}
		sum += v
	}
	return sum / float64(len(w)), true
}

// windowStdDev is the population (divisor len(w)) standard deviation around
// a precomputed mean.
func windowStdDev(w []float64, mean float64) float64 {
	sumSq := 0.0
	for _, v := range w {
		d := v - mean
		sumSq += d * d
	}
	return math.Sqrt(sumSq / float64(len(w)))
}
