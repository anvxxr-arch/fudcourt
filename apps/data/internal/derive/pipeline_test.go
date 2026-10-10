package derive

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// fakeReader is the in-memory canon.Reader the pipeline tests inject: it
// serves one source series' observations and records the ListSeries calls.
type fakeReader struct {
	obs    []canon.Observation
	series []canon.SeriesMeta
	listed int
}

func (f *fakeReader) ReadTimeseries(_ context.Context, seriesID string, _, _ time.Time, limit int) ([]canon.Observation, error) {
	out := f.obs
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}

func (f *fakeReader) ListSeries(_ context.Context, _ canon.SeriesQuery) ([]canon.SeriesMeta, error) {
	f.listed++
	return f.series, nil
}

// The remaining Reader methods are unused by the pipeline; they exist to
// satisfy the interface and fail loudly if ever called.
func (f *fakeReader) unused(method string) error {
	return fmt.Errorf("fakeReader: unexpected call to %s", method)
}

func (f *fakeReader) ListAssets(context.Context, canon.ListQuery) ([]canon.Asset, error) {
	return nil, f.unused("ListAssets")
}

func (f *fakeReader) ListChains(context.Context, canon.ListQuery) ([]canon.Chain, error) {
	return nil, f.unused("ListChains")
}

func (f *fakeReader) ListVenues(context.Context, canon.ListQuery) ([]canon.Venue, error) {
	return nil, f.unused("ListVenues")
}

func (f *fakeReader) ListProtocols(context.Context, canon.ListQuery) ([]canon.Protocol, error) {
	return nil, f.unused("ListProtocols")
}

func (f *fakeReader) ListInstruments(context.Context, canon.InstrumentQuery) ([]canon.Instrument, error) {
	return nil, f.unused("ListInstruments")
}

func (f *fakeReader) ReadOhlcv(context.Context, string, string, string, time.Time, time.Time, int) ([]canon.Ohlcv, error) {
	return nil, f.unused("ReadOhlcv")
}

func (f *fakeReader) ReadFunding(context.Context, string, string, string, time.Time, time.Time, int) ([]canon.FundingRate, error) {
	return nil, f.unused("ReadFunding")
}

func (f *fakeReader) ReadOpenInterest(context.Context, string, string, string, time.Time, time.Time, int) ([]canon.OpenInterest, error) {
	return nil, f.unused("ReadOpenInterest")
}

func (f *fakeReader) ReadTrades(context.Context, string, string, time.Time, time.Time, int) ([]canon.Trade, error) {
	return nil, f.unused("ReadTrades")
}

func (f *fakeReader) ReadOrderbook(context.Context, string, string, time.Time, time.Time, int) ([]canon.OrderbookSnap, error) {
	return nil, f.unused("ReadOrderbook")
}

func (f *fakeReader) ListPools(context.Context, canon.PoolQuery) ([]canon.Pool, error) {
	return nil, f.unused("ListPools")
}

func (f *fakeReader) ListArticles(context.Context, int) ([]canon.Article, error) {
	return nil, f.unused("ListArticles")
}

func (f *fakeReader) ListPredictionMarkets(context.Context, int) ([]canon.PredictionMarket, error) {
	return nil, f.unused("ListPredictionMarkets")
}

func (f *fakeReader) ListChainTVL(context.Context, int) ([]canon.ChainTVL, error) {
	return nil, f.unused("ListChainTVL")
}

func (f *fakeReader) ListProtocolTVL(context.Context, int) ([]canon.ProtocolTVL, error) {
	return nil, f.unused("ListProtocolTVL")
}

func (f *fakeReader) ResolveProviderSymbol(context.Context, string, string) (string, string, error) {
	return "", "", f.unused("ResolveProviderSymbol")
}

func (f *fakeReader) ListRuns(context.Context, int) ([]canon.RunRecord, error) {
	return nil, f.unused("ListRuns")
}

func (f *fakeReader) HealthCheck(context.Context) error { return f.unused("HealthCheck") }

// fakeWriter records the UpsertSeries rows and WriteMetric calls the
// pipeline makes, and satisfies canon.Writer by failing loudly on everything
// else.
type fakeWriter struct {
	series   []canon.SeriesMeta
	metrics  map[string][]canon.MetricPoint
	writeErr error
}

func newFakeWriter() *fakeWriter {
	return &fakeWriter{metrics: map[string][]canon.MetricPoint{}}
}

func (f *fakeWriter) UpsertSeries(_ context.Context, rows []canon.SeriesMeta) (int, error) {
	f.series = append(f.series, rows...)
	return len(rows), nil
}

func (f *fakeWriter) WriteMetric(_ context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	f.metrics[seriesID] = append(f.metrics[seriesID], points...)
	return len(points), nil
}

func (f *fakeWriter) unused(method string) (int, int, error) {
	return 0, 0, fmt.Errorf("fakeWriter: unexpected call to %s", method)
}

func (f *fakeWriter) UpsertAssets(context.Context, []canon.Asset) (int, error) {
	return f.unusedSingle("UpsertAssets")
}

func (f *fakeWriter) UpsertChains(context.Context, []canon.Chain) (int, error) {
	return f.unusedSingle("UpsertChains")
}

func (f *fakeWriter) UpsertVenues(context.Context, []canon.Venue) (int, error) {
	return f.unusedSingle("UpsertVenues")
}

func (f *fakeWriter) UpsertInstruments(context.Context, []canon.Instrument) (int, error) {
	return f.unusedSingle("UpsertInstruments")
}

func (f *fakeWriter) UpsertProtocols(context.Context, []canon.Protocol) (int, error) {
	return f.unusedSingle("UpsertProtocols")
}

func (f *fakeWriter) UpsertProviderSymbols(context.Context, []canon.ProviderSymbol) (int, error) {
	return f.unusedSingle("UpsertProviderSymbols")
}

func (f *fakeWriter) WriteOhlcv(context.Context, []canon.Ohlcv) (int, int, error) {
	return f.unused("WriteOhlcv")
}

func (f *fakeWriter) WriteTrades(context.Context, []canon.Trade) (int, int, error) {
	return f.unused("WriteTrades")
}

func (f *fakeWriter) WriteQuotes(context.Context, []canon.Quote) (int, int, error) {
	return f.unused("WriteQuotes")
}

func (f *fakeWriter) WriteOrderbook(context.Context, []canon.OrderbookSnap) (int, int, error) {
	return f.unused("WriteOrderbook")
}

func (f *fakeWriter) WriteObservations(context.Context, []canon.Observation) (int, int, error) {
	return f.unused("WriteObservations")
}

func (f *fakeWriter) WriteFunding(context.Context, []canon.FundingRate) (int, int, error) {
	return f.unused("WriteFunding")
}

func (f *fakeWriter) WriteOpenInterest(context.Context, []canon.OpenInterest) (int, int, error) {
	return f.unused("WriteOpenInterest")
}

func (f *fakeWriter) WritePools(context.Context, []canon.Pool) (int, int, error) {
	return f.unused("WritePools")
}

func (f *fakeWriter) WriteArticles(context.Context, []canon.Article) (int, int, error) {
	return f.unused("WriteArticles")
}

func (f *fakeWriter) WritePredictionMarkets(context.Context, []canon.PredictionMarket) (int, int, error) {
	return f.unused("WritePredictionMarkets")
}

func (f *fakeWriter) WriteChainTVL(context.Context, []canon.ChainTVL) (int, int, error) {
	return f.unused("WriteChainTVL")
}

func (f *fakeWriter) WriteProtocolTVL(context.Context, []canon.ProtocolTVL) (int, int, error) {
	return f.unused("WriteProtocolTVL")
}

func (f *fakeWriter) WriteSupply(context.Context, []canon.SupplySnapshot) (int, int, error) {
	return f.unused("WriteSupply")
}

func (f *fakeWriter) unusedSingle(method string) (int, error) {
	return 0, fmt.Errorf("fakeWriter: unexpected call to %s", method)
}

// ptr is the float64 pointer helper for observation fixtures.
func ptr(v float64) *float64 { return &v }

// compile-time checks: the fakes satisfy the frozen canon interfaces.
var (
	_ canon.Reader = (*fakeReader)(nil)
	_ canon.Writer = (*fakeWriter)(nil)
)

// testSourceID is the source series the pipeline tests read from.
var testSourceID = canon.SeriesKey("market", "px", "asset:btcusd")

// testObs builds one Observation per price, one hour apart from a fixed
// base, values pointing at the input floats.
func testObs(t *testing.T, prices []float64) []canon.Observation {
	t.Helper()
	base := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	obs := make([]canon.Observation, len(prices))
	for i, p := range prices {
		v := p
		obs[i] = canon.Observation{
			SeriesID:   testSourceID,
			ObservedAt: base.Add(time.Duration(i) * time.Hour),
			Value:      &v,
			Source:     "binance",
		}
	}
	return obs
}

// TestPipelineRunEndToEnd is the example wiring: a default registry, a fake
// reader holding 5 prices, a fake writer; Run computes sma(2) into the
// derived series and every landing field is pinned.
func TestPipelineRunEndToEnd(t *testing.T) {
	reader := &fakeReader{obs: testObs(t, []float64{2, 4, 6, 8, 10})}
	writer := newFakeWriter()
	reg := NewRegistry()
	reg.Register(MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "asset:btcusd", Params: map[string]string{"period": "2"}}, NewSMAProcessor(map[string]string{"period": "2"}))

	p := NewPipeline(reader, writer, reg, 0)
	spec := MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "asset:btcusd", Params: map[string]string{"period": "2"}}
	// The read-back is the caller's policy: 5 covers the whole fixture (a
	// recurring job would read its warmup from reg.Window("sma") instead).
	if err := p.Run(context.Background(), spec, testSourceID, 5); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// The derived series row: canonical id with the param suffix, derived
	// identity, inherited cadence.
	wantID := "series/market/sma_2/asset:btcusd"
	if len(writer.series) != 1 {
		t.Fatalf("UpsertSeries called %d times, want 1", len(writer.series))
	}
	row := writer.series[0]
	if row.SeriesID != wantID {
		t.Fatalf("series id = %q, want %q", row.SeriesID, wantID)
	}
	if row.Domain != "market" || row.Metric != "sma" || row.SubjectKey != "asset:btcusd" {
		t.Fatalf("series identity = %s/%s/%s", row.Domain, row.Metric, row.SubjectKey)
	}
	if !row.IsDerived {
		t.Fatal("derived series row is not marked is_derived")
	}
	if row.Source != "derived" || row.Provider != "derived" {
		t.Fatalf("series source/provider = %q/%q, want derived/derived", row.Source, row.Provider)
	}
	if row.SchemaVersion != "v1" {
		t.Fatalf("series schema version = %q, want v1", row.SchemaVersion)
	}
	if row.Frequency != "1h" {
		t.Fatalf("series frequency = %q, want inherited 1h", row.Frequency)
	}

	// The metric points: NaN head (nil Value), then window means, timestamps
	// aligned with the input.
	pts := writer.metrics[wantID]
	if len(pts) != 5 {
		t.Fatalf("wrote %d points, want 5", len(pts))
	}
	wantVals := []float64{math.NaN(), 3, 5, 7, 9}
	for i, want := range wantVals {
		if pts[i].At != reader.obs[i].ObservedAt {
			t.Fatalf("point %d at = %v, want %v", i, pts[i].At, reader.obs[i].ObservedAt)
		}
		if math.IsNaN(want) {
			if pts[i].Value != nil {
				t.Fatalf("point %d value = %v, want NULL", i, *pts[i].Value)
			}
			continue
		}
		if pts[i].Value == nil {
			t.Fatalf("point %d value = NULL, want %v", i, want)
		}
		if math.Abs(*pts[i].Value-want) > 1e-9 {
			t.Fatalf("point %d value = %v, want %v", i, *pts[i].Value, want)
		}
		if pts[i].Source != "derived" {
			t.Fatalf("point %d source = %q, want derived", i, pts[i].Source)
		}
		if pts[i].Meta["processor"] != "sma" {
			t.Fatalf("point %d meta processor = %v", i, pts[i].Meta["processor"])
		}
		if pts[i].Meta["source_ref"] != testSourceID {
			t.Fatalf("point %d meta source_ref = %v", i, pts[i].Meta["source_ref"])
		}
	}
}

// TestPipelineWindowPrecedence pins the read-back resolution: explicit
// argument wins, then spec param, then processor-declared window.
func TestPipelineWindowPrecedence(t *testing.T) {
	var gotLimit int
	reader := &limitRecorder{
		fakeReader: &fakeReader{obs: testObs(t, []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10})},
		fn:         func(limit int) { gotLimit = limit },
	}
	writer := newFakeWriter()
	reg := NewRegistry()
	reg.Register(MetricSpec{Metric: "sma", Params: map[string]string{"period": "3"}}, NewSMAProcessor(map[string]string{"period": "3"}))
	p := NewPipeline(reader, writer, reg, 0)

	spec := MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "global", Params: map[string]string{"period": "3", "window": "7"}}
	if err := p.Run(context.Background(), spec, testSourceID, 0); err != nil {
		t.Fatalf("Run(spec window): %v", err)
	}
	if gotLimit != 7 {
		t.Fatalf("spec param window: read limit = %d, want 7", gotLimit)
	}

	if err := p.Run(context.Background(), spec, testSourceID, 9); err != nil {
		t.Fatalf("Run(explicit window): %v", err)
	}
	if gotLimit != 9 {
		t.Fatalf("explicit window: read limit = %d, want 9", gotLimit)
	}

	specNoWindow := MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "global", Params: map[string]string{"period": "3"}}
	if err := p.Run(context.Background(), specNoWindow, testSourceID, 0); err != nil {
		t.Fatalf("Run(processor window): %v", err)
	}
	if gotLimit != 3 {
		t.Fatalf("processor window: read limit = %d, want 3", gotLimit)
	}
}

// limitRecorder is a fakeReader that records the limit it was called with.
type limitRecorder struct {
	*fakeReader
	fn func(int)
}

func (f *limitRecorder) ReadTimeseries(_ context.Context, _ string, _, _ time.Time, limit int) ([]canon.Observation, error) {
	f.fn(limit)
	if limit > 0 && len(f.obs) > limit {
		return f.obs[len(f.obs)-limit:], nil
	}
	return f.obs, nil
}

// TestPipelineUnknownProcessor pins the loud failure on an unregistered
// metric.
func TestPipelineUnknownProcessor(t *testing.T) {
	reader := &fakeReader{obs: testObs(t, []float64{1, 2, 3})}
	writer := newFakeWriter()
	p := NewPipeline(reader, writer, NewRegistry(), 0)
	err := p.Run(context.Background(), MetricSpec{Domain: "market", Metric: "ghost", SubjectKey: "global"}, testSourceID, 0)
	if !errors.Is(err, ErrUnknownProcessor) {
		t.Fatalf("Run(ghost) = %v, want ErrUnknownProcessor", err)
	}
}

// TestPipelineEmptyInput pins the loud failure on a source series with no
// points.
func TestPipelineEmptyInput(t *testing.T) {
	reader := &fakeReader{}
	writer := newFakeWriter()
	reg := NewRegistry()
	reg.Register(MetricSpec{Metric: "sma"}, NewSMAProcessor(nil))
	p := NewPipeline(reader, writer, reg, 0)
	err := p.Run(context.Background(), MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "global"}, testSourceID, 0)
	if !errors.Is(err, ErrEmptyInput) {
		t.Fatalf("Run(empty) = %v, want ErrEmptyInput", err)
	}
}

// TestPipelineWriteErrorPropagates pins that a WriteMetric failure surfaces,
// never a silent drop.
func TestPipelineWriteErrorPropagates(t *testing.T) {
	reader := &fakeReader{obs: testObs(t, []float64{1, 2, 3, 4})}
	writer := newFakeWriter()
	writer.writeErr = errors.New("metric table down")
	reg := NewRegistry()
	reg.Register(MetricSpec{Metric: "sma"}, NewSMAProcessor(map[string]string{"period": "2"}))
	p := NewPipeline(reader, writer, reg, 0)
	err := p.Run(context.Background(), MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "global"}, testSourceID, 0)
	if err == nil || !strings.Contains(err.Error(), "metric table down") {
		t.Fatalf("Run(write error) = %v, want the writer error surfaced", err)
	}
}

// TestPipelineSeriesUpsertSkippedWhenExisting pins the idempotent behavior:
// the series row is only upserted when the reader does not already return it.
func TestPipelineSeriesUpsertSkippedWhenExisting(t *testing.T) {
	wantID := canon.SeriesKey("market", "sma_2", "asset:btcusd")
	existing := canon.SeriesMeta{SeriesID: wantID, Domain: "market", Metric: "sma", IsDerived: true}
	reader := &fakeReader{obs: testObs(t, []float64{2, 4, 6}), series: []canon.SeriesMeta{existing}}
	writer := newFakeWriter()
	reg := NewRegistry()
	reg.Register(MetricSpec{Metric: "sma", Params: map[string]string{"period": "2"}}, NewSMAProcessor(map[string]string{"period": "2"}))
	p := NewPipeline(reader, writer, reg, 0)
	if err := p.Run(context.Background(), MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "asset:btcusd", Params: map[string]string{"period": "2"}}, testSourceID, 0); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(writer.series) != 0 {
		t.Fatalf("UpsertSeries called with an existing row: %+v", writer.series)
	}
}

// TestObservationsToPointsPeriods pins the period anchoring: "2024-03" is
// March 1 UTC, an ObservedAt row passes through untouched.
func TestObservationsToPointsPeriods(t *testing.T) {
	obs := []canon.Observation{
		{Period: "2024", Value: ptr(1.0)},
		{Period: "2024-03", Value: ptr(2.0)},
		{Period: "2024-03-15", Value: ptr(3.0)},
		{ObservedAt: time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC), Value: ptr(4.0)},
	}
	pts := observationsToPoints(obs)
	if got := pts[0].At; got != time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC) {
		t.Fatalf("period 2024 anchored at %v", got)
	}
	if got := pts[1].At; got != time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC) {
		t.Fatalf("period 2024-03 anchored at %v", got)
	}
	if got := pts[2].At; got != time.Date(2024, 3, 15, 0, 0, 0, 0, time.UTC) {
		t.Fatalf("period 2024-03-15 anchored at %v", got)
	}
	if got := pts[3].At; !got.Equal(obs[3].ObservedAt) {
		t.Fatalf("ObservedAt row changed: %v", got)
	}
}

// TestInferFrequency pins the median-gap cadence mapping.
func TestInferFrequency(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	hourly := []time.Time{base, base.Add(time.Hour), base.Add(2 * time.Hour)}
	if got := inferFrequency(hourly); got != "1h" {
		t.Fatalf("inferFrequency(hourly) = %q, want 1h", got)
	}
	daily := []time.Time{base, base.Add(24 * time.Hour), base.Add(48 * time.Hour)}
	if got := inferFrequency(daily); got != "1d" {
		t.Fatalf("inferFrequency(daily) = %q, want 1d", got)
	}
	// A gap does not move the median: 1h, 1h, 25h → median 1h.
	gapped := []time.Time{base, base.Add(time.Hour), base.Add(2 * time.Hour), base.Add(27 * time.Hour)}
	if got := inferFrequency(gapped); got != "1h" {
		t.Fatalf("inferFrequency(gapped) = %q, want 1h", got)
	}
	if got := inferFrequency([]time.Time{base}); got != "event" {
		t.Fatalf("inferFrequency(single) = %q, want event", got)
	}
}

// TestPipelineNaNStoredAsNull pins the never-fake rule end to end: the NaN
// head of a longer processor lands as nil Values in the metric table.
func TestPipelineNaNStoredAsNull(t *testing.T) {
	reader := &fakeReader{obs: testObs(t, []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10})}
	writer := newFakeWriter()
	reg := NewRegistry()
	reg.Register(MetricSpec{Metric: "sma", Params: map[string]string{"period": "4"}}, NewSMAProcessor(map[string]string{"period": "4"}))
	p := NewPipeline(reader, writer, reg, 0)
	if err := p.Run(context.Background(), MetricSpec{Domain: "market", Metric: "sma", SubjectKey: "global", Params: map[string]string{"period": "4"}}, testSourceID, 10); err != nil {
		t.Fatalf("Run: %v", err)
	}
	pts := writer.metrics["series/market/sma_4/global"]
	if len(pts) != 10 {
		t.Fatalf("wrote %d points, want 10", len(pts))
	}
	for i := 0; i < 3; i++ {
		if pts[i].Value != nil {
			t.Fatalf("NaN head point %d stored as %v, want NULL", i, *pts[i].Value)
		}
	}
	for i := 3; i < 10; i++ {
		if pts[i].Value == nil {
			t.Fatalf("point %d NULL, want a value", i)
		}
	}
}

// TestRunDoesNotSchedule pins the self-scheduling ban: nothing in the
// package starts goroutines or timers at construction. This test only
// asserts the constructor returns a plain struct.
func TestRunDoesNotSchedule(t *testing.T) {
	reg := NewDefaultRegistry()
	p := NewPipeline(&fakeReader{}, newFakeWriter(), reg, 100)
	if p.DefaultWindow != 100 {
		t.Fatalf("DefaultWindow = %d, want 100", p.DefaultWindow)
	}
}
