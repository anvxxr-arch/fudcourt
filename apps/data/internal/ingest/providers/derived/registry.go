package derived

import (
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/derive"
)

// processorFor builds the derive.Processor a spec names, with the spec's
// Params baked in. The registry keys processors by metric NAME and a default
// registration carries default params, so a parameterized spec (sma period
// 1400) must build its own processor rather than reuse the default sma — the
// orchestrator registers this one under the spec's metric name.
func processorFor(spec derive.MetricSpec) (derive.Processor, bool) {
	switch {
	case spec.Metric == "sma":
		return derive.NewSMAProcessor(spec.Params), true
	case spec.Metric == "ema":
		return derive.NewEMAProcessor(spec.Params), true
	case spec.Metric == "rsi":
		return derive.NewRSIProcessor(spec.Params), true
	case spec.Metric == "macd_macd":
		return derive.NewMACDProcessor(spec.Params, "macd"), true
	case spec.Metric == "macd_signal":
		return derive.NewMACDProcessor(spec.Params, "signal"), true
	case spec.Metric == "macd_hist":
		return derive.NewMACDProcessor(spec.Params, "hist"), true
	case spec.Metric == "bb_upper":
		return derive.NewBollingerProcessor(spec.Params, "upper"), true
	case spec.Metric == "bb_mid":
		return derive.NewBollingerProcessor(spec.Params, "mid"), true
	case spec.Metric == "bb_lower":
		return derive.NewBollingerProcessor(spec.Params, "lower"), true
	case spec.Metric == "log_returns":
		return derive.NewLogReturnsProcessor(spec.Params), true
	case spec.Metric == "simple_returns":
		return derive.NewSimpleReturnsProcessor(spec.Params), true
	case spec.Metric == "drawdown":
		return derive.NewDrawdownProcessor(spec.Params), true
	case spec.Metric == "supply":
		return derive.NewSupplyProcessor(spec.Params), true
	case spec.Metric == "s2f":
		return derive.NewS2FProcessor(spec.Params), true
	case spec.Metric == "halving":
		return derive.NewHalvingCountdownProcessor(spec.Params), true
	case spec.Metric == "power_law":
		return derive.NewPowerLawProcessor(spec.Params), true
	case spec.Metric == "power_law_osc":
		return derive.NewPowerLawOscillatorProcessor(spec.Params), true
	default:
		return nil, false
	}
}

// registryFor builds a one-entry registry holding the processor the spec
// names, so the pipeline's Lookup(spec.Metric) finds the parameterized
// processor instead of a default-parameter registration.
func registryFor(spec derive.MetricSpec) (*derive.Registry, error) {
	proc, ok := processorFor(spec)
	if !ok {
		return nil, &unknownSpecError{metric: spec.Metric}
	}
	r := derive.NewRegistry()
	r.Register(derive.MetricSpec{Metric: spec.Metric}, proc)
	return r, nil
}

// unknownSpecError is returned when a spec names a metric no constructor
// handles — a wiring bug surfaced loudly rather than a silent no-op.
type unknownSpecError struct{ metric string }

func (e *unknownSpecError) Error() string { return "derived: no processor for metric " + e.metric }
