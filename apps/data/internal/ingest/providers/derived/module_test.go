package derived

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fakeReader serves daily BTC bars and records the ohlcv window calls. It
// embeds canon.Reader for the methods the fetcher never calls (they panic if
// reached); ReadOhlcv and ListSeries are the two the pipeline actually uses.
type fakeReader struct {
	canon.Reader
	bars  []canon.Ohlcv
	obs   []canon.Observation
	calls int
	fail  error
	meta  []canon.SeriesMeta
}

func (f *fakeReader) ListSeries(_ context.Context, _ canon.SeriesQuery) ([]canon.SeriesMeta, error) {
	return f.meta, nil
}

// ReadTimeseries serves the onchain mining series (empty by default).
func (f *fakeReader) ReadTimeseries(_ context.Context, _ string, _, _ time.Time, limit int) ([]canon.Observation, error) {
	if f.fail != nil {
		return nil, f.fail
	}
	out := f.obs
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}

func (f *fakeReader) ReadOhlcv(_ context.Context, instrumentID, venueID, timeframe string, start, end time.Time, limit int) ([]canon.Ohlcv, error) {
	if f.fail != nil {
		return nil, f.fail
	}
	f.calls++
	out := make([]canon.Ohlcv, 0, len(f.bars))
	for _, b := range f.bars {
		if instrumentID != "" && b.InstrumentID != instrumentID {
			continue
		}
		if venueID != "" && b.VenueID != venueID {
			continue
		}
		if timeframe != "" && b.Timeframe != timeframe {
			continue
		}
		if !end.IsZero() && !b.OpenTime.Before(end) {
			continue
		}
		out = append(out, b)
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}

// fakeWriter records the metrics written per series id.
type fakeWriter struct {
	metrics map[string][]canon.MetricPoint
	series  map[string]canon.SeriesMeta
	err     error
}

func newFakeWriter() *fakeWriter {
	return &fakeWriter{metrics: map[string][]canon.MetricPoint{}, series: map[string]canon.SeriesMeta{}}
}

func (w *fakeWriter) UpsertSeries(_ context.Context, rows []canon.SeriesMeta) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	for _, s := range rows {
		w.series[s.SeriesID] = s
	}
	return len(rows), nil
}

func (w *fakeWriter) WriteMetric(_ context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.metrics[seriesID] = append(w.metrics[seriesID], points...)
	return len(points), nil
}

// The remaining Writer methods are unused; they fail loudly if called.
func (w *fakeWriter) unused(m string) error { return errors.New("unexpected " + m) }
func (w *fakeWriter) UpsertAssets(context.Context, []canon.Asset) (int, error) {
	return 0, w.unused("UpsertAssets")
}
func (w *fakeWriter) UpsertChains(context.Context, []canon.Chain) (int, error) {
	return 0, w.unused("UpsertChains")
}
func (w *fakeWriter) UpsertVenues(context.Context, []canon.Venue) (int, error) {
	return 0, w.unused("UpsertVenues")
}
func (w *fakeWriter) UpsertInstruments(context.Context, []canon.Instrument) (int, error) {
	return 0, w.unused("UpsertInstruments")
}
func (w *fakeWriter) UpsertProtocols(context.Context, []canon.Protocol) (int, error) {
	return 0, w.unused("UpsertProtocols")
}
func (w *fakeWriter) UpsertProviderSymbols(context.Context, []canon.ProviderSymbol) (int, error) {
	return 0, w.unused("UpsertProviderSymbols")
}
func (w *fakeWriter) WriteOhlcv(context.Context, []canon.Ohlcv) (int, int, error) {
	return 0, 0, w.unused("WriteOhlcv")
}
func (w *fakeWriter) WriteTrades(context.Context, []canon.Trade) (int, int, error) {
	return 0, 0, w.unused("WriteTrades")
}
func (w *fakeWriter) WriteQuotes(context.Context, []canon.Quote) (int, int, error) {
	return 0, 0, w.unused("WriteQuotes")
}
func (w *fakeWriter) WriteOrderbook(context.Context, []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, w.unused("WriteOrderbook")
}
func (w *fakeWriter) WriteLiquidations(context.Context, []canon.Liquidation) (int, int, error) {
	return 0, 0, w.unused("WriteLiquidations")
}
func (w *fakeWriter) WriteOptionQuotes(context.Context, []canon.OptionQuote) (int, int, error) {
	return 0, 0, w.unused("WriteOptionQuotes")
}
func (w *fakeWriter) WriteObservations(context.Context, []canon.Observation) (int, int, error) {
	return 0, 0, w.unused("WriteObservations")
}
func (w *fakeWriter) WriteFunding(context.Context, []canon.FundingRate) (int, int, error) {
	return 0, 0, w.unused("WriteFunding")
}
func (w *fakeWriter) WriteOpenInterest(context.Context, []canon.OpenInterest) (int, int, error) {
	return 0, 0, w.unused("WriteOpenInterest")
}
func (w *fakeWriter) WritePools(context.Context, []canon.Pool) (int, int, error) {
	return 0, 0, w.unused("WritePools")
}
func (w *fakeWriter) WriteArticles(context.Context, []canon.Article) (int, int, error) {
	return 0, 0, w.unused("WriteArticles")
}
func (w *fakeWriter) WritePredictionMarkets(context.Context, []canon.PredictionMarket) (int, int, error) {
	return 0, 0, w.unused("WritePredictionMarkets")
}
func (w *fakeWriter) WriteChainTVL(context.Context, []canon.ChainTVL) (int, int, error) {
	return 0, 0, w.unused("WriteChainTVL")
}
func (w *fakeWriter) WriteProtocolTVL(context.Context, []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, w.unused("WriteProtocolTVL")
}
func (w *fakeWriter) WriteSupply(context.Context, []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, w.unused("WriteSupply")
}

func bars(n int) []canon.Ohlcv {
	base := time.Date(2018, 1, 1, 0, 0, 0, 0, time.UTC)
	out := make([]canon.Ohlcv, n)
	for i := range n {
		out[i] = canon.Ohlcv{
			InstrumentID: btcInstrumentID,
			VenueID:      btcVenueID,
			Timeframe:    "1d",
			OpenTime:     base.AddDate(0, 0, i),
			C:            100 + float64(i),
		}
	}
	return out
}

func TestModuleRegistration(t *testing.T) {
	m := NewModule(&fakeReader{})
	if m.Provider() != "derived" {
		t.Fatalf("provider: %s", m.Provider())
	}
	if _, ok := m.Fetchers()["metrics"]; !ok {
		t.Fatalf("missing metrics fetcher")
	}
	jobs := m.Jobs()
	if len(jobs) != 1 || jobs[0].Dataset != "metrics" || !jobs[0].Enabled {
		t.Fatalf("jobs: %+v", jobs)
	}
}

func TestFetchRunsEverySpec(t *testing.T) {
	r := &fakeReader{bars: bars(30)}
	w := newFakeWriter()
	res, err := (&fetcher{r: r}).Fetch(context.Background(), ingest.Job{}, w)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if res.RowsWritten != len(specs()) {
		t.Fatalf("specs written: %d, want %d", res.RowsWritten, len(specs()))
	}
	// A parameterized sma must land under its own series id (sma_1400), proving
	// the per-spec registry was used, not the default-parameter registration.
	if _, ok := w.series["series/market/sma_1400/asset:btcusd"]; !ok {
		t.Fatalf("sma_1400 series not written; got %v", keys(w.series))
	}
	if _, ok := w.metrics["series/market/sma_1400/asset:btcusd"]; !ok {
		t.Fatalf("sma_1400 metric not written")
	}
}

func TestFetchWriterErrorPropagates(t *testing.T) {
	r := &fakeReader{bars: bars(30)}
	w := newFakeWriter()
	w.err = errors.New("store down")
	if _, err := (&fetcher{r: r}).Fetch(context.Background(), ingest.Job{}, w); err == nil {
		t.Fatalf("want error, got nil")
	}
}

func TestFetchReadErrorPropagates(t *testing.T) {
	r := &fakeReader{fail: errors.New("db down")}
	w := newFakeWriter()
	if _, err := (&fetcher{r: r}).Fetch(context.Background(), ingest.Job{}, w); err == nil {
		t.Fatalf("want error, got nil")
	}
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
