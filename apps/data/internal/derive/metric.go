package derive

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// SchemaVersion is the schema version stamped on every derived series this
// package mints.
const SchemaVersion = "v1"

// Source is the data.metric source column value for derived points.
const Source = "derived"

// MetricSpec names one derived metric: which domain it lands in, the metric
// name (the Processor's registered name) and the subject key of the source
// series it derives from. Params carries the processor's free-form parameters
// ("period", "fast", "slow", "signal", "mult", "window", ...); the processor
// documents and defaults what it reads.
type MetricSpec struct {
	Domain     string
	Metric     string
	SubjectKey string
	Params     map[string]string
}

// Param returns the parameter named key, or def when absent.
func (s MetricSpec) Param(key, def string) string {
	if s.Params == nil {
		return def
	}
	if v, ok := s.Params[key]; ok && v != "" {
		return v
	}
	return def
}

// Processor computes one derived metric from normalized input points. Compute
// is a pure function: no IO, no clock, no global state; same input, same
// output. The input slice is read-only and points carry nil Values for absent
// readings; processors treat those as NaN. Output points are one-to-one with
// the input (index i answers input i); a not-yet-computable point is NaN.
type Processor interface {
	Name() string
	Compute(ctx context.Context, in []canon.MetricPoint) ([]canon.MetricPoint, error)
}

// Registry maps a metric name to its Processor. Names are unique; Register
// panics on a duplicate, the same way a package-level wiring table mis-wiring
// is a programmer error and not a runtime condition.
type Registry struct {
	mu    sync.RWMutex
	procs map[string]Processor
	specs map[string]MetricSpec
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{procs: map[string]Processor{}, specs: map[string]MetricSpec{}}
}

// windower is implemented by processors that know their warmup length: how
// many input points a run should read back so the lookback windows can fill.
// The pipeline uses it to size ReadTimeseries when the caller passes 0.
type windower interface {
	Window() int
}

// Register installs proc under spec.Metric. The spec is kept for reference
// (the pipeline merges its params with the run spec's); the processor carries
// its own baked parameters. A duplicate metric name panics.
func (r *Registry) Register(spec MetricSpec, fn Processor) {
	if fn == nil {
		panic("derive: Register called with nil processor")
	}
	if spec.Metric == "" {
		panic("derive: Register called with empty metric name")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.procs[spec.Metric]; dup {
		panic(fmt.Sprintf("derive: processor %q already registered", spec.Metric))
	}
	r.procs[spec.Metric] = fn
	r.specs[spec.Metric] = spec
}

// Lookup returns the processor registered under name.
func (r *Registry) Lookup(name string) (Processor, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.procs[name]
	return p, ok
}

// Spec returns the registration spec for name.
func (r *Registry) Spec(name string) (MetricSpec, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.specs[name]
	return s, ok
}

// Window returns the warmup length the processor registered under name
// declares, or 0 when it is unknown or declares none.
func (r *Registry) Window(name string) int {
	r.mu.RLock()
	fn, ok := r.procs[name]
	r.mu.RUnlock()
	if !ok {
		return 0
	}
	if w, ok := fn.(windower); ok {
		return w.Window()
	}
	return 0
}

// Names lists the registered metric names in sorted order.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.procs))
	for n := range r.procs {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// compile-time checks: the registry stores Processors that declare their
// warmup windows.
var (
	_ Processor = (*paramsAdapter)(nil)
	_ Processor = (*multiValueAdapter)(nil)
	_ windower  = (*paramsAdapter)(nil)
	_ windower  = (*multiValueAdapter)(nil)
)

// DerivedSeriesKey mints the canonical id of the derived series a run of
// metric on subject produces: SeriesKey(domain, metric+'_'+suffix, subject).
// The suffix distinguishes parameter variants of one metric (macd_12_26_9,
// bb_20_2, rsi_14, ...) so two parameterizations never share a series.
func DerivedSeriesKey(domain, metric, subjectKey string, params map[string]string) string {
	return canon.SeriesKey(domain, metric+"_"+MetricSuffix(params), subjectKey)
}

// MetricSuffix builds the parameter suffix from the params map: the sorted
// params' sanitized values joined by '_' (so {"fast":"12","slow":"26"} is
// "12_26"; "period":"14" is "14"), with '.', '-' and ' ' replaced so the
// suffix stays a clean path segment. No params → "d" so the suffix (and the
// path segment) is never empty.
func MetricSuffix(params map[string]string) string {
	if len(params) == 0 {
		return "d"
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		v := sanitizeParam(params[k])
		if v == "" {
			v = "d"
		}
		parts = append(parts, v)
	}
	return joinParamSuffix(parts)
}

// sanitizeParam strips characters that are illegal in the series natural key
// (it is joined with '/'): '.', '-' and ' ' become 'd'. Only values are
// sanitized; keys come from processor code, not user input.
func sanitizeParam(v string) string {
	out := make([]byte, 0, len(v))
	for _, c := range []byte(v) {
		switch c {
		case '.', '-', ' ':
			out = append(out, 'd')
		default:
			out = append(out, c)
		}
	}
	return string(out)
}

// joinParamSuffix joins the parts with '_'.
func joinParamSuffix(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += "_"
		}
		out += p
	}
	return out
}
