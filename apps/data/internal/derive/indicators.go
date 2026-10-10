package derive

import "math"

// This file holds the pure price indicators. Every function maps an input
// slice to an output slice of the SAME length, index-for-index. Where the
// lookback window is not yet full the output is math.NaN() - padded, never
// truncated and never zero-filled. A NaN inside a lookback window poisons
// that window's output: absent input propagates to absent output instead of
// silently becoming 0 (never-fake). Except where a definition forces it
// (true range at bar 0, OBV's first bar) outputs before the warmup are NaN.

// nanLike allocates the NaN-padded output slice for an input of len n.
func nanLike(x []float64) []float64 {
	out := make([]float64, len(x))
	for i := range out {
		out[i] = math.NaN()
	}
	return out
}

// SMA is the simple moving average over the last n values. A window
// containing any NaN yields NaN for that position.
func SMA(x []float64, n int) []float64 {
	out := nanLike(x)
	if n <= 0 {
		return out
	}
	for i := n - 1; i < len(x); i++ {
		sum := 0.0
		ok := true
		for j := i - n + 1; j <= i; j++ {
			if math.IsNaN(x[j]) {
				ok = false
				break
			}
			sum += x[j]
		}
		if ok {
			out[i] = sum / float64(n)
		}
	}
	return out
}

// EMA is the exponential moving average with smoothing factor 2/(n+1),
// seeded with the SMA of the first n values. Indices 0..n-1 stay NaN; a NaN
// input position is passed through as NaN and does not update the average.
func EMA(x []float64, n int) []float64 {
	out := nanLike(x)
	if n <= 0 {
		return out
	}
	alpha := 2.0 / (float64(n) + 1.0)
	sum := 0.0
	seen := 0
	seeded := false
	prev := math.NaN()
	for i, v := range x {
		if math.IsNaN(v) {
			continue
		}
		if !seeded {
			sum += v
			seen++
			if seen == n {
				prev = sum / float64(n)
				out[i] = prev
				seeded = true
			}
			continue
		}
		prev = alpha*v + (1-alpha)*prev
		out[i] = prev
	}
	return out
}

// wilderAvg is Wilder's smoothed average: seed with the mean of the first n
// values, then prev += (v-prev)/n. add returns false until the seed exists;
// NaN inputs are skipped by the caller.
type wilderAvg struct {
	n      int
	sum    float64
	seen   int
	seeded bool
	prev   float64
}

func (w *wilderAvg) add(v float64) bool {
	if !w.seeded {
		w.sum += v
		w.seen++
		if w.seen == w.n {
			w.prev = w.sum / float64(w.n)
			w.seeded = true
		}
		return w.seeded
	}
	w.prev += (v - w.prev) / float64(w.n)
	return true
}

// RSI is Wilder's relative strength index over n periods. It needs the mean
// of n deltas, so it needs n+1 points: indices 0..n-1 are NaN. A flat window
// (all deltas zero) is 50, an all-gain window is 100, an all-loss window is 0.
func RSI(x []float64, n int) []float64 {
	out := nanLike(x)
	if n <= 0 || len(x) < n+1 {
		return out
	}
	var gains, losses wilderAvg
	gains.n, losses.n = n, n
	seeded := false
	for i := 1; i < len(x); i++ {
		d := x[i] - x[i-1]
		if math.IsNaN(d) {
			continue
		}
		gain, loss := 0.0, 0.0
		if d > 0 {
			gain = d
		} else {
			loss = -d
		}
		if !seeded {
			// Both seed averages complete on the same delta, so one flag
			// covers the pair.
			g := gains.add(gain)
			l := losses.add(loss)
			if g && l {
				seeded = true
				out[i] = rsiOf(gains.prev, losses.prev)
			}
			continue
		}
		gains.add(gain)
		losses.add(loss)
		out[i] = rsiOf(gains.prev, losses.prev)
	}
	return out
}

// rsiOf maps average gain/loss to the 0..100 RSI value.
func rsiOf(avgGain, avgLoss float64) float64 {
	switch {
	case avgGain == 0 && avgLoss == 0:
		return 50
	case avgLoss == 0:
		return 100
	default:
		rs := avgGain / avgLoss
		return 100 - 100/(1+rs)
	}
}

// MACD is the moving-average convergence/divergence: fast-slow EMA line, its
// signal line (EMA of the MACD) and the histogram (MACD - signal). The
// convention here: both EMAs seed on their own window, so the MACD line is
// valid from index slow-1, the signal from slow-1+signal-1.
func MACD(x []float64, fast, slow, signal int) (macd, sig, hist []float64) {
	fastE := EMA(x, fast)
	slowE := EMA(x, slow)
	macd = nanLike(x)
	for i := range x {
		if !math.IsNaN(fastE[i]) && !math.IsNaN(slowE[i]) {
			macd[i] = fastE[i] - slowE[i]
		}
	}
	sig = EMA(macd, signal)
	hist = nanLike(x)
	for i := range x {
		if !math.IsNaN(macd[i]) && !math.IsNaN(sig[i]) {
			hist[i] = macd[i] - sig[i]
		}
	}
	return macd, sig, hist
}

// BollingerBands is the SMA(n) middle band with upper/lower bands k sample
// standard deviations (population divisor n) away. All three outputs share
// the input's length; positions before n-1 are NaN.
func BollingerBands(x []float64, n int, k float64) (upper, mid, lower []float64) {
	mid = SMA(x, n)
	upper = nanLike(x)
	lower = nanLike(x)
	for i := n - 1; i < len(x); i++ {
		if math.IsNaN(mid[i]) {
			continue
		}
		sumSq := 0.0
		for j := i - n + 1; j <= i; j++ {
			d := x[j] - mid[i]
			sumSq += d * d
		}
		sd := math.Sqrt(sumSq / float64(n))
		upper[i] = mid[i] + k*sd
		lower[i] = mid[i] - k*sd
	}
	return upper, mid, lower
}

// trueRange is the per-bar true range: max(high-low, |high-prevClose|,
// |low-prevClose|). Bar 0 has no previous close, so its true range is the
// plain high-low range.
func trueRange(high, low, close []float64, i int) float64 {
	if i == 0 {
		return high[0] - low[0]
	}
	tr := high[i] - low[i]
	if v := math.Abs(high[i] - close[i-1]); v > tr {
		tr = v
	}
	if v := math.Abs(low[i] - close[i-1]); v > tr {
		tr = v
	}
	return tr
}

// ATR is Wilder's average true range over n periods. Needs n true ranges, of
// which the first is bar 0's plain range, so it is valid from index n-1.
func ATR(high, low, close []float64, n int) []float64 {
	out := nanLike(high)
	if n <= 0 || len(high) < n {
		return out
	}
	var w wilderAvg
	w.n = n
	for i := range high {
		tr := trueRange(high, low, close, i)
		if math.IsNaN(tr) {
			continue
		}
		if w.add(tr) {
			out[i] = w.prev
		}
	}
	return out
}

// Stochastic is the %K/%D oscillator: raw %K = 100*(close-lowest low(n)) /
// (highest high(n)-lowest low(n)) smoothed by an SMA(k) of the raw %K, and
// %D an SMA(d) of %K. A zero high-low range uses 50 (flat window). Raw %K is
// valid from n-1, %K from n-1+k-1, %D one more window later.
func Stochastic(high, low, close []float64, n, k, d int) (kLine, dLine []float64) {
	raw := nanLike(high)
	for i := n - 1; i < len(high); i++ {
		hh, ll := windowHighLow(high, low, i-n+1, i)
		if math.IsNaN(hh) || math.IsNaN(ll) {
			continue
		}
		switch span := hh - ll; {
		case span == 0:
			raw[i] = 50
		default:
			raw[i] = 100 * (close[i] - ll) / span
		}
	}
	kLine = SMA(raw, k)
	dLine = SMA(kLine, d)
	return kLine, dLine
}

// windowHighLow scans high[j..i] and low[j..i]; a NaN anywhere makes both
// NaN (the window is not fully observed).
func windowHighLow(high, low []float64, j, i int) (hh, ll float64) {
	hh, ll = math.NaN(), math.NaN()
	for k := j; k <= i; k++ {
		if math.IsNaN(high[k]) || math.IsNaN(low[k]) {
			return math.NaN(), math.NaN()
		}
		if math.IsNaN(hh) || high[k] > hh {
			hh = high[k]
		}
		if math.IsNaN(ll) || low[k] < ll {
			ll = low[k]
		}
	}
	return hh, ll
}

// ADX is Wilder's average directional index over n periods. The smoothed
// +DM/-DM/TR sums start at bar 1 (bar 0 has no previous bar) and DX is valid
// from index n, ADX after a further n DX values, i.e. from index 2n-1.
func ADX(high, low, close []float64, n int) []float64 {
	out := nanLike(high)
	if n <= 0 || len(high) < 2*n+1 {
		return out
	}
	var str, splus, sminus wilderAvg
	str.n, splus.n, sminus.n = n, n, n
	dx := nanLike(high)
	for i := 1; i < len(high); i++ {
		up := high[i] - high[i-1]
		dn := low[i-1] - low[i]
		plusDM, minusDM := 0.0, 0.0
		if up > dn && up > 0 {
			plusDM = up
		}
		if dn > up && dn > 0 {
			minusDM = dn
		}
		// All three smoothed sums warm up together from bar 1; DX exists
		// only once the seed window is complete.
		strOK := str.add(trueRange(high, low, close, i))
		splus.add(plusDM)
		sminus.add(minusDM)
		if !strOK {
			continue
		}
		if str.prev == 0 {
			continue
		}
		plusDI := 100 * splus.prev / str.prev
		minusDI := 100 * sminus.prev / str.prev
		if sum := plusDI + minusDI; sum > 0 {
			dx[i] = 100 * math.Abs(plusDI-minusDI) / sum
		}
	}
	// ADX: Wilder average of the first n DX values, then the running update.
	var w wilderAvg
	w.n = n
	for i := 1; i < len(high); i++ {
		if math.IsNaN(dx[i]) {
			continue
		}
		if w.add(dx[i]) {
			out[i] = w.prev
		}
	}
	return out
}

// OBV is on-balance volume: a running sum of volume signed by close-to-close
// direction (+ on an up bar, - on a down bar, 0 on an unchanged bar). The
// first bar contributes 0 (no previous close), so OBV[0] = 0, not NaN: the
// sum starts there. A NaN close or volume poisons the running sum from that
// bar on (absent input cannot silently become 0).
func OBV(close, volume []float64) []float64 {
	out := make([]float64, len(close))
	out[0] = 0
	broken := false
	for i := 1; i < len(close); i++ {
		switch {
		case broken,
			math.IsNaN(close[i]), math.IsNaN(close[i-1]), math.IsNaN(volume[i]):
			out[i] = math.NaN()
			broken = true
		case close[i] > close[i-1]:
			out[i] = out[i-1] + volume[i]
		case close[i] < close[i-1]:
			out[i] = out[i-1] - volume[i]
		default:
			out[i] = out[i-1]
		}
	}
	return out
}

// rollingVWAP is the session-anchored volume-weighted average price: each
// session (consecutive equal sessionIndex values) restarts the
// sum(typicalPrice*volume)/sum(volume) accumulation. Bars before their
// session has volume are NaN; typical price is (h+l+c)/3.
func rollingVWAP(high, low, close, volume []float64, sessionIndex []int) []float64 {
	out := nanLike(high)
	cur := 0
	hasCur := false
	cumPV, cumV := 0.0, 0.0
	for i := range high {
		if !hasCur || sessionIndex[i] != cur {
			cur = sessionIndex[i]
			hasCur = true
			cumPV, cumV = 0, 0
		}
		if math.IsNaN(high[i]) || math.IsNaN(low[i]) || math.IsNaN(close[i]) || math.IsNaN(volume[i]) {
			continue
		}
		tp := (high[i] + low[i] + close[i]) / 3
		cumPV += tp * volume[i]
		cumV += volume[i]
		if cumV != 0 {
			out[i] = cumPV / cumV
		}
	}
	return out
}

// Supertrend is the ATR trailing-stop band: basic bands (h+l)/2 +- mult*ATR,
// finalized against the previous band and close, flipping to the lower band
// on an upside breakout and to the upper band on a downside breakout. Valid
// from index n-1 (first full ATR).
func Supertrend(high, low, close []float64, n int, mult float64) []float64 {
	atr := ATR(high, low, close, n)
	out := nanLike(high)
	finalUpper, finalLower := math.NaN(), math.NaN()
	dir := 0
	for i := range high {
		if math.IsNaN(atr[i]) {
			continue
		}
		mid := (high[i] + low[i]) / 2
		basicUpper := mid + mult*atr[i]
		basicLower := mid - mult*atr[i]
		if dir == 0 {
			finalUpper, finalLower = basicUpper, basicLower
			dir = 1
		} else {
			switch {
			case basicUpper < finalUpper || close[i-1] > finalUpper:
				finalUpper = basicUpper
			}
			switch {
			case basicLower > finalLower || close[i-1] < finalLower:
				finalLower = basicLower
			}
			switch {
			case close[i] > finalUpper:
				dir = 1
			case close[i] < finalLower:
				dir = -1
			}
		}
		if dir == 1 {
			out[i] = finalLower
		} else {
			out[i] = finalUpper
		}
	}
	return out
}

// Ichimoku computes the Tenkan-sen, Kijun-sen, Senkou Span A and Senkou Span
// B midpoints. Each is the (highest high + lowest low)/2 over its window
// (tenkan p1, kijun p2, senkou B p3); Senkou A is the (tenkan+kijun)/2.
// Span values are reported AT their computation bar (no forward projection):
// the pipeline stores one series per line, and consumers shift A/B forward
// themselves if they want the cloud.
func Ichimoku(high, low []float64, tenkan, kijun, senkouB int) (tenkanLine, kijunLine, senkouALine, senkouBLine []float64) {
	tenkanLine = nanLike(high)
	kijunLine = nanLike(high)
	senkouALine = nanLike(high)
	senkouBLine = nanLike(high)
	for i := range high {
		if i >= tenkan-1 {
			hh, ll := windowHighLow(high, low, i-tenkan+1, i)
			if !math.IsNaN(hh) {
				tenkanLine[i] = (hh + ll) / 2
			}
		}
		if i >= kijun-1 {
			hh, ll := windowHighLow(high, low, i-kijun+1, i)
			if !math.IsNaN(hh) {
				kijunLine[i] = (hh + ll) / 2
			}
		}
		if i >= senkouB-1 {
			hh, ll := windowHighLow(high, low, i-senkouB+1, i)
			if !math.IsNaN(hh) {
				senkouBLine[i] = (hh + ll) / 2
			}
		}
		if !math.IsNaN(tenkanLine[i]) && !math.IsNaN(kijunLine[i]) {
			senkouALine[i] = (tenkanLine[i] + kijunLine[i]) / 2
		}
	}
	return tenkanLine, kijunLine, senkouALine, senkouBLine
}
