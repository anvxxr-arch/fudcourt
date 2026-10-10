package derive

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// ErrEmptyInput is returned when a source series has no usable points.
var ErrEmptyInput = errors.New("derive: source series has no points")

// ErrUnknownProcessor is returned when the spec's metric has no registered
// processor.
var ErrUnknownProcessor = errors.New("derive: unknown processor")

// pointsToFloats extracts the values of a MetricPoint slice in order. A nil
// Value (absent reading) becomes NaN, the pure functions' absent marker.
func pointsToFloats(pts []canon.MetricPoint) []float64 {
	x := make([]float64, len(pts))
	for i := range pts {
		x[i] = math.NaN()
		if pts[i].Value != nil {
			x[i] = *pts[i].Value
		}
	}
	return x
}

// floatsToPoints zips values with the input's timestamps. NaN becomes a nil
// Value (a NULL in data.metric, never a fake 0). Meta records the producing
// processor, its parameters and the source series id.
func floatsToPoints(ts []time.Time, x []float64, proc string, params map[string]string, sourceSeriesID string) []canon.MetricPoint {
	out := make([]canon.MetricPoint, len(x))
	for i := range x {
		out[i] = canon.MetricPoint{
			At:     ts[i],
			Source: Source,
		}
		if !math.IsNaN(x[i]) {
			v := x[i]
			out[i].Value = &v
		}
		meta := map[string]any{
			"processor":  proc,
			"source_ref": sourceSeriesID,
		}
		for k, v := range params {
			meta["param_"+k] = v
		}
		out[i].Meta = meta
	}
	return out
}

// seriesTimestamps extracts the input points' timestamps in order. A source
// point with a zero timestamp is invalid; Run rejects it loudly.
func seriesTimestamps(pts []canon.MetricPoint) ([]time.Time, error) {
	ts := make([]time.Time, len(pts))
	for i := range pts {
		if pts[i].At.IsZero() {
			return nil, fmt.Errorf("derive: source point %d has zero timestamp", i)
		}
		ts[i] = pts[i].At
	}
	return ts, nil
}

// observationsToPoints converts the Reader's Observation rows to the
// MetricPoint shape the processors take. Market rows carry ObservedAt;
// economic rows may carry only a Period, anchored at the period's start
// (UTC) - a deterministic convention, never a fabricated value. A row with
// neither gets a zero At, which Run's timestamp check rejects loudly.
func observationsToPoints(obs []canon.Observation) []canon.MetricPoint {
	out := make([]canon.MetricPoint, len(obs))
	for i := range obs {
		at := obs[i].ObservedAt
		if at.IsZero() {
			at = parsePeriodStart(obs[i].Period)
		}
		out[i] = canon.MetricPoint{
			At:     at,
			Value:  obs[i].Value,
			Source: obs[i].Source,
		}
	}
	return out
}

// parsePeriodStart anchors an economic period label at its start, UTC.
// Accepted shapes: "2024", "2024-03", "2024-03-15" (time.Parse layouts
// "2006", "2006-01", "2006-01-02"). Anything else returns the zero time.
func parsePeriodStart(period string) time.Time {
	for _, layout := range []string{"2006-01-02", "2006-01", "2006"} {
		if t, err := time.Parse(layout, period); err == nil {
			return t
		}
	}
	return time.Time{}
}

// cadenceFrames are the uniform canon timeframes mapped to representative
// durations for cadence inference. 1M/quarterly/annual use their typical
// month/quarter/year lengths; the mixed-case vocabulary itself is preserved.
var cadenceFrames = []struct {
	tf string
	d  time.Duration
}{
	{"1s", time.Second},
	{"1m", time.Minute},
	{"5m", 5 * time.Minute},
	{"15m", 15 * time.Minute},
	{"1h", time.Hour},
	{"4h", 4 * time.Hour},
	{"1d", 24 * time.Hour},
	{"1w", 7 * 24 * time.Hour},
	{"1M", 30 * 24 * time.Hour},
	{"quarterly", 91 * 24 * time.Hour},
	{"annual", 365 * 24 * time.Hour},
}

// inferFrequency reads the input cadence off the timestamps: the median gap
// between consecutive points, mapped to the closest canon timeframe in the
// closed vocabulary. The median tolerates gaps (weekends, missing bars). One
// or zero points, or a non-positive median, is "event" (the irregular frame).
func inferFrequency(ts []time.Time) string {
	if len(ts) < 2 {
		return "event"
	}
	deltas := make([]time.Duration, 0, len(ts)-1)
	for i := 1; i < len(ts); i++ {
		deltas = append(deltas, ts[i].Sub(ts[i-1]))
	}
	sort.Slice(deltas, func(i, j int) bool { return deltas[i] < deltas[j] })
	median := deltas[len(deltas)/2]
	if median <= 0 {
		return "event"
	}
	best := cadenceFrames[0].tf
	bestDist := math.Abs(float64(median - cadenceFrames[0].d))
	for _, f := range cadenceFrames[1:] {
		if dist := math.Abs(float64(median - f.d)); dist < bestDist {
			best, bestDist = f.tf, dist
		}
	}
	return best
}

// Pipeline derives one registered metric from one source series and lands
// the result in the data.metric hypertable through the canon.Writer. The
// reader, writer and registry are injected; the pipeline itself has no
// scheduling, storage or engine code.
type Pipeline struct {
	reader canon.Reader
	writer canon.Writer
	reg    *Registry
	// DefaultWindow is the read-back length Run uses when neither the spec
	// nor the registry pins one.
	DefaultWindow int
}

// NewPipeline builds a pipeline over a canon store and a registry.
func NewPipeline(r canon.Reader, w canon.Writer, reg *Registry, defaultWindow int) *Pipeline {
	return &Pipeline{reader: r, writer: w, reg: reg, DefaultWindow: defaultWindow}
}

// Run derives spec.Metric from sourceSeriesID and writes the result to the
// derived series DerivedSeriesKey(spec). It is one synchronous pass: read,
// compute, write. Nothing schedules itself; callers (the orchestrator's
// engine wiring) decide when to call it.
//
// window is the read-back length from the source series: how many trailing
// points the processor gets so its lookback windows can fill. 0 means
// spec.Params["window"], then the registry's processor-declared warmup
// window, then the pipeline default; still 0, the read is unbounded (the
// canon Reader's zero-limit convention) - a backfill computes the whole
// history, an incremental pass reads its warmup.
func (p *Pipeline) Run(ctx context.Context, spec MetricSpec, sourceSeriesID string, window int) error {
	if spec.Domain == "" {
		return errors.New("derive: spec needs a domain")
	}
	if spec.SubjectKey == "" {
		return errors.New("derive: spec needs a subject key")
	}
	proc, ok := p.reg.Lookup(spec.Metric)
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownProcessor, spec.Metric)
	}
	if window <= 0 {
		window = p.readWindow(spec)
	}
	obs, err := p.reader.ReadTimeseries(ctx, sourceSeriesID, time.Time{}, time.Time{}, window)
	if err != nil {
		return fmt.Errorf("derive: reading source series %s: %w", sourceSeriesID, err)
	}
	if len(obs) == 0 {
		return ErrEmptyInput
	}
	in := observationsToPoints(obs)
	ts, err := seriesTimestamps(in)
	if err != nil {
		return err
	}
	out, err := proc.Compute(ctx, in)
	if err != nil {
		return fmt.Errorf("derive: processor %q failed: %w", spec.Metric, err)
	}
	if len(out) != len(in) {
		return fmt.Errorf("derive: processor %q returned %d points for %d inputs", spec.Metric, len(out), len(in))
	}
	// Index alignment: the processor is a pure function over the input
	// order, so output i belongs to timestamp i.
	x := make([]float64, len(out))
	for i := range out {
		x[i] = math.NaN()
		if out[i].Value != nil {
			x[i] = *out[i].Value
		}
	}
	derivedID := DerivedSeriesKey(spec.Domain, spec.Metric, spec.SubjectKey, spec.Params)
	if err := p.ensureSeries(ctx, derivedID, spec, sourceSeriesID, inferFrequency(ts)); err != nil {
		return err
	}
	points := floatsToPoints(ts, x, spec.Metric, spec.Params, sourceSeriesID)
	if _, err := p.writer.WriteMetric(ctx, derivedID, points); err != nil {
		return fmt.Errorf("derive: writing metric %s: %w", derivedID, err)
	}
	return nil
}

// readWindow resolves the read-back length: explicit spec param, registry
// registration, pipeline default, in that order.
func (p *Pipeline) readWindow(spec MetricSpec) int {
	if w := spec.Param("window", ""); w != "" {
		if n, err := strconv.Atoi(w); err == nil && n > 0 {
			return n
		}
	}
	if w := p.reg.Window(spec.Metric); w > 0 {
		return w
	}
	return p.DefaultWindow
}

// ensureSeries upserts the derived series row (is_derived = true, source
// "derived", schema v1, frequency inherited from the input cadence) if it
// does not exist yet. The series id is minted with the same SeriesKey rule
// the resolver uses, so the row the pipeline creates is the row the API
// serves.
func (p *Pipeline) ensureSeries(ctx context.Context, seriesID string, spec MetricSpec, sourceSeriesID, frequency string) error {
	existing, err := p.reader.ListSeries(ctx, canon.SeriesQuery{
		Domain:     spec.Domain,
		Metric:     spec.Metric,
		SubjectKey: spec.SubjectKey,
	})
	if err != nil {
		return fmt.Errorf("derive: checking series %s: %w", seriesID, err)
	}
	for _, s := range existing {
		if s.SeriesID == seriesID {
			return nil
		}
	}
	title := spec.Domain + "/" + spec.Metric
	meta := canon.SeriesMeta{
		SeriesID:             seriesID,
		Domain:               spec.Domain,
		Metric:               spec.Metric,
		SubjectKey:           spec.SubjectKey,
		Title:                &title,
		Frequency:            frequency,
		Source:               Source,
		Provider:             Source,
		ProviderSeriesID:     sourceProviderID(spec, sourceSeriesID),
		Revision:             "latest",
		IsDerived:            true,
		SchemaVersion:        SchemaVersion,
		NormalizationVersion: "none",
	}
	if _, err := p.writer.UpsertSeries(ctx, []canon.SeriesMeta{meta}); err != nil {
		return fmt.Errorf("derive: upserting derived series %s: %w", seriesID, err)
	}
	return nil
}

// sourceProviderID builds the data.series provider_series_id value for a
// derived row: the metric suffix already disambiguates parameterizations, so
// the value is deterministic for one (metric, params, source) triple.
func sourceProviderID(spec MetricSpec, sourceSeriesID string) string {
	return spec.Metric + "_" + MetricSuffix(spec.Params) + ":" + sourceSeriesID
}
