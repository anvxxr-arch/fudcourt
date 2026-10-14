package derived

import "github.com/anvxxr-arch/fudcourt/apps/data/internal/derive"

// btcSubject is the subject key every BTC-price derived series is about.
const btcSubject = "asset:btcusd"

// specs returns the P0 chart set: the derived metrics computed from the BTC
// daily close. Domain "market", subject asset:btcusd. Pi Cycle is a two-series
// composition (sma_111 + sma_350) — the cross is computed by the chart card,
// not here — so it needs no dedicated processor.
func specs() []derive.MetricSpec {
	s := func(metric string, params map[string]string) derive.MetricSpec {
		return derive.MetricSpec{Domain: "market", Metric: metric, SubjectKey: btcSubject, Params: params}
	}
	return []derive.MetricSpec{
		s("sma", map[string]string{"period": "200"}),
		s("sma", map[string]string{"period": "1400"}), // 200-week MA
		s("sma", map[string]string{"period": "350"}),
		s("sma", map[string]string{"period": "111"}),
		s("sma", map[string]string{"period": "471"}),
		s("ema", map[string]string{"period": "150"}),
		s("rsi", map[string]string{"period": "14"}),
		s("macd_macd", map[string]string{"fast": "12", "slow": "26", "signal": "9"}),
		s("macd_signal", map[string]string{"fast": "12", "slow": "26", "signal": "9"}),
		s("macd_hist", map[string]string{"fast": "12", "slow": "26", "signal": "9"}),
		s("bb_upper", map[string]string{"period": "20", "mult": "2"}),
		s("bb_mid", map[string]string{"period": "20", "mult": "2"}),
		s("bb_lower", map[string]string{"period": "20", "mult": "2"}),
		s("log_returns", nil),
		s("simple_returns", nil),
		s("supply", nil),
		s("s2f", nil),
		s("halving", nil),
		s("power_law", nil),
		s("power_law_osc", nil),
		s("drawdown", nil),
	}
}
