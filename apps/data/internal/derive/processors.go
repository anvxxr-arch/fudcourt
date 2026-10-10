package derive

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// This file wires the pure indicator/quant functions into Processors. Each
// processor reads its integer/float parameters from MetricSpec.Params with a
// documented key and default, runs one pure function, and stamps the output
// points with its parameter set. All of them share the single-value adapter:
// one float64 slice in, one out, one metric suffix.

// intParam reads an integer parameter, falling back to def when absent or
// unparseable (callers validate their own specs; defaults keep the registry
// wiring boring).
func intParam(params map[string]string, key string, def int) int {
	v, ok := params[key]
	if !ok || v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// floatParam is intParam for floats.
func floatParam(params map[string]string, key string, def float64) float64 {
	v, ok := params[key]
	if !ok || v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return def
	}
	return f
}

// paramsAdapter is a Processor over a pure value function, carrying its own
// parameter map (set at registration time, not per call).
type paramsAdapter struct {
	name   string
	params map[string]string
	fn     func(x []float64, params map[string]string) []float64
	window int
}

func (a *paramsAdapter) Name() string { return a.name }

// Window reports the warmup length baked at construction.
func (a *paramsAdapter) Window() int { return a.window }

func (a *paramsAdapter) Compute(_ context.Context, in []canon.MetricPoint) ([]canon.MetricPoint, error) {
	x := pointsToFloats(in)
	out := a.fn(x, a.params)
	ts := make([]time.Time, len(in))
	for i := range in {
		ts[i] = in[i].At
	}
	return attachValues(in, ts, out, a.name, a.params), nil
}

// attachValues copies computed values onto the input points' timestamps. The
// returned points share the input's slice backing for timestamps but own
// their Value pointers.
func attachValues(in []canon.MetricPoint, ts []time.Time, x []float64, proc string, params map[string]string) []canon.MetricPoint {
	if len(x) != len(in) {
		// Pure functions are same-length by construction; this is a wiring
		// bug, not a data condition.
		panic(fmt.Sprintf("derive: processor %q returned %d values for %d inputs", proc, len(x), len(in)))
	}
	return floatsToPoints(ts, x, proc, params, "")
}

// multiValueAdapter turns one pure function with several outputs (MACD's
// line/signal/histogram, Bollinger's bands, Ichimoku's four lines) into a
// set of Processors sharing one computation. Compute runs the function once
// per output metric, so each registered metric stays an independent,
// pure Processor.
type multiValueAdapter struct {
	name    string
	params  map[string]string
	window  int
	compute func(x []float64, params map[string]string) [][]float64
	index   int
}

func (a *multiValueAdapter) Name() string { return a.name }

// Window reports the warmup length baked at construction.
func (a *multiValueAdapter) Window() int { return a.window }

func (a *multiValueAdapter) Compute(_ context.Context, in []canon.MetricPoint) ([]canon.MetricPoint, error) {
	x := pointsToFloats(in)
	rows := a.compute(x, a.params)
	if a.index >= len(rows) {
		return nil, fmt.Errorf("derive: processor %q has no output %d", a.name, a.index)
	}
	out := rows[a.index]
	if len(out) != len(in) {
		return nil, fmt.Errorf("derive: processor %q returned %d values for %d inputs", a.name, len(out), len(in))
	}
	ts := make([]time.Time, len(in))
	for i := range in {
		ts[i] = in[i].At
	}
	return attachValues(in, ts, out, a.name, a.params), nil
}

// windowOf returns the read-back window the processor wants: the largest of
// its declared lookback and its explicit "window" param.
func windowOf(params map[string]string, lookback int) int {
	if w := intParam(params, "window", 0); w > lookback {
		return w
	}
	return lookback
}

// single builds a one-output Processor over a pure value function.
func single(name string, params map[string]string, lookback int, fn func(x []float64) []float64) Processor {
	return &paramsAdapter{
		name:   name,
		params: params,
		window: windowOf(params, lookback),
		fn: func(x []float64, _ map[string]string) []float64 {
			return fn(x)
		},
	}
}

// NewSMAProcessor registers "sma": params period (default 20).
func NewSMAProcessor(params map[string]string) Processor {
	n := intParam(params, "period", 20)
	return single("sma", params, n, func(x []float64) []float64 { return SMA(x, n) })
}

// NewEMAProcessor registers "ema": params period (default 20).
func NewEMAProcessor(params map[string]string) Processor {
	n := intParam(params, "period", 20)
	return single("ema", params, n, func(x []float64) []float64 { return EMA(x, n) })
}

// NewRSIProcessor registers "rsi": params period (default 14).
func NewRSIProcessor(params map[string]string) Processor {
	n := intParam(params, "period", 14)
	return single("rsi", params, n+1, func(x []float64) []float64 { return RSI(x, n) })
}

// NewMACDProcessor registers one of macd|macd_signal|macd_hist: params fast
// (default 12), slow (default 26), signal (default 9). The three metrics are
// three registrations; the suffix builder turns the params into macd_12_26_9.
func NewMACDProcessor(params map[string]string, line string) Processor {
	fast := intParam(params, "fast", 12)
	slow := intParam(params, "slow", 26)
	signal := intParam(params, "signal", 9)
	idx := map[string]int{"macd": 0, "signal": 1, "hist": 2}[line]
	return &multiValueAdapter{
		name:   "macd_" + line,
		params: params,
		window: windowOf(params, slow+signal),
		index:  idx,
		compute: func(x []float64, _ map[string]string) [][]float64 {
			macd, sig, hist := MACD(x, fast, slow, signal)
			return [][]float64{macd, sig, hist}
		},
	}
}

// NewBollingerProcessor registers one of bb_upper|bb_mid|bb_lower: params
// period (default 20), mult (default 2). The three bands are three
// registrations over one computation.
func NewBollingerProcessor(params map[string]string, band string) Processor {
	n := intParam(params, "period", 20)
	k := floatParam(params, "mult", 2)
	idx := map[string]int{"upper": 0, "mid": 1, "lower": 2}[band]
	return &multiValueAdapter{
		name:   "bb_" + band,
		params: params,
		window: windowOf(params, n),
		index:  idx,
		compute: func(x []float64, _ map[string]string) [][]float64 {
			upper, mid, lower := BollingerBands(x, n, k)
			return [][]float64{upper, mid, lower}
		},
	}
}

// NewATRProcessor registers "atr": params period (default 14).
func NewATRProcessor(params map[string]string) Processor {
	n := intParam(params, "period", 14)
	return single("atr", params, n, func(x []float64) []float64 { return ATR(x, x, x, n) })
}

// NewStochasticProcessor registers one of stoch_k|stoch_d: params period
// (default 14), k (default 3), d (default 3). The two lines are two
// registrations over one computation.
func NewStochasticProcessor(params map[string]string, line string) Processor {
	n := intParam(params, "period", 14)
	k := intParam(params, "k", 3)
	d := intParam(params, "d", 3)
	idx := map[string]int{"k": 0, "d": 1}[line]
	return &multiValueAdapter{
		name:   "stoch_" + line,
		params: params,
		window: windowOf(params, n+k+d),
		index:  idx,
		compute: func(x []float64, _ map[string]string) [][]float64 {
			kk, dd := Stochastic(x, x, x, n, k, d)
			return [][]float64{kk, dd}
		},
	}
}

// NewADXProcessor registers "adx": params period (default 14).
func NewADXProcessor(params map[string]string) Processor {
	n := intParam(params, "period", 14)
	return single("adx", params, 2*n, func(x []float64) []float64 { return ADX(x, x, x, n) })
}

// NewOBVProcessor registers "obv" (no params).
func NewOBVProcessor(params map[string]string) Processor {
	return single("obv", params, 0, func(x []float64) []float64 { return OBV(x, ones(len(x))) })
}

// NewVWAPProcessor registers "vwap" (rolling session VWAP): params session
// (default 1, i.e. the whole input is one session).
func NewVWAPProcessor(params map[string]string) Processor {
	n := intParam(params, "session", 0)
	return single("vwap", params, 0, func(x []float64) []float64 { return rollingVWAP(x, x, x, ones(len(x)), sessionChunks(len(x), n)) })
}

// NewSupertrendProcessor registers "supertrend": params period (default 10),
// mult (default 3).
func NewSupertrendProcessor(params map[string]string) Processor {
	n := intParam(params, "period", 10)
	mult := floatParam(params, "mult", 3)
	return single("supertrend", params, n, func(x []float64) []float64 { return Supertrend(x, x, x, n, mult) })
}

// NewIchimokuProcessor registers one of ichimoku_tenkan|kijun|senkou_a|
// senkou_b: params tenkan (default 9), kijun (default 26), senkoub (default
// 52).
func NewIchimokuProcessor(params map[string]string, line string) Processor {
	t := intParam(params, "tenkan", 9)
	k := intParam(params, "kijun", 26)
	sb := intParam(params, "senkoub", 52)
	idx := map[string]int{"tenkan": 0, "kijun": 1, "senkou_a": 2, "senkou_b": 3}[line]
	return &multiValueAdapter{
		name:   "ichimoku_" + line,
		params: params,
		window: windowOf(params, sb),
		index:  idx,
		compute: func(x []float64, _ map[string]string) [][]float64 {
			ten, kij, sa, sbb := Ichimoku(x, x, t, k, sb)
			return [][]float64{ten, kij, sa, sbb}
		},
	}
}

// ones is a volume slice of all 1s, for close-only adapters that run
// h+l+c/v formulas over a single series (the pipeline feeds one series per
// processor; multi-input processors are future work).
func ones(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = 1
	}
	return out
}

// sessionChunks builds the session index slice for rollingVWAP: chunks of n
// input points (0 = one session for the whole input).
func sessionChunks(n, size int) []int {
	out := make([]int, n)
	if size <= 0 {
		return out
	}
	for i := range out {
		out[i] = i / size
	}
	return out
}

// NewLogReturnsProcessor registers "log_returns" (no params).
func NewLogReturnsProcessor(params map[string]string) Processor {
	return single("log_returns", params, 0, LogReturns)
}

// NewSimpleReturnsProcessor registers "simple_returns" (no params).
func NewSimpleReturnsProcessor(params map[string]string) Processor {
	return single("simple_returns", params, 0, SimpleReturns)
}

// NewRollingVolatilityProcessor registers "rolling_volatility": params
// window (default 20).
func NewRollingVolatilityProcessor(params map[string]string) Processor {
	n := intParam(params, "window", 20)
	return single("rolling_volatility", params, n, func(x []float64) []float64 {
		return RollingVolatility(x, n)
	})
}

// NewRollingCorrelationProcessor registers "rolling_correlation": params
// window (default 20). The pipeline feeds one series per processor, so the
// second input is the series itself (autocorrelation of the level, r=1 by
// construction); cross-series correlation needs the two-series entry point
// below.
func NewRollingCorrelationProcessor(params map[string]string) Processor {
	n := intParam(params, "window", 20)
	return single("rolling_correlation", params, n, func(x []float64) []float64 {
		return RollingCorrelation(x, x, n)
	})
}

// NewRollingZScoreProcessor registers "rolling_zscore": params window
// (default 20).
func NewRollingZScoreProcessor(params map[string]string) Processor {
	n := intParam(params, "window", 20)
	return single("rolling_zscore", params, n, func(x []float64) []float64 {
		return RollingZScore(x, n)
	})
}

// NewRollingPercentileRankProcessor registers "rolling_percentile_rank":
// params window (default 20).
func NewRollingPercentileRankProcessor(params map[string]string) Processor {
	n := intParam(params, "window", 20)
	return single("rolling_percentile_rank", params, n, func(x []float64) []float64 {
		return RollingPercentileRank(x, n)
	})
}

// NewRollingSharpeProcessor registers "rolling_sharpe": params window
// (default 20).
func NewRollingSharpeProcessor(params map[string]string) Processor {
	n := intParam(params, "window", 20)
	return single("rolling_sharpe", params, n, func(x []float64) []float64 {
		return RollingSharpe(x, n)
	})
}

// NewRollingSortinoProcessor registers "rolling_sortino": params window
// (default 20).
func NewRollingSortinoProcessor(params map[string]string) Processor {
	n := intParam(params, "window", 20)
	return single("rolling_sortino", params, n, func(x []float64) []float64 {
		return RollingSortino(x, n)
	})
}

// NewMomentumProcessor registers "momentum": params window (default 10).
func NewMomentumProcessor(params map[string]string) Processor {
	n := intParam(params, "window", 10)
	return single("momentum", params, n, func(x []float64) []float64 {
		return Momentum(x, n)
	})
}

// DefaultProcessors returns the full processor set with platform-default
// parameters. Multi-output metrics register one Processor per output metric
// (macd, macd_signal, macd_hist; bb_upper, bb_mid, bb_lower; stoch_k,
// stoch_d; ichimoku_tenkan, ichimoku_kijun, ichimoku_senkou_a,
// ichimoku_senkou_b). The orchestrator may register extra parameterizations
// with the same constructor functions.
func DefaultProcessors() []Processor {
	return []Processor{
		NewSMAProcessor(nil),
		NewEMAProcessor(nil),
		NewRSIProcessor(nil),
		NewMACDProcessor(nil, "macd"),
		NewMACDProcessor(nil, "signal"),
		NewMACDProcessor(nil, "hist"),
		NewBollingerProcessor(nil, "upper"),
		NewBollingerProcessor(nil, "mid"),
		NewBollingerProcessor(nil, "lower"),
		NewATRProcessor(nil),
		NewStochasticProcessor(nil, "k"),
		NewStochasticProcessor(nil, "d"),
		NewADXProcessor(nil),
		NewOBVProcessor(nil),
		NewVWAPProcessor(nil),
		NewSupertrendProcessor(nil),
		NewIchimokuProcessor(nil, "tenkan"),
		NewIchimokuProcessor(nil, "kijun"),
		NewIchimokuProcessor(nil, "senkou_a"),
		NewIchimokuProcessor(nil, "senkou_b"),
		NewLogReturnsProcessor(nil),
		NewSimpleReturnsProcessor(nil),
		NewRollingVolatilityProcessor(nil),
		NewRollingCorrelationProcessor(nil),
		NewRollingZScoreProcessor(nil),
		NewRollingPercentileRankProcessor(nil),
		NewRollingSharpeProcessor(nil),
		NewRollingSortinoProcessor(nil),
		NewMomentumProcessor(nil),
	}
}

// NewDefaultRegistry builds a Registry with DefaultProcessors installed.
func NewDefaultRegistry() *Registry {
	r := NewRegistry()
	for _, p := range DefaultProcessors() {
		r.Register(MetricSpec{Metric: p.Name()}, p)
	}
	return r
}
