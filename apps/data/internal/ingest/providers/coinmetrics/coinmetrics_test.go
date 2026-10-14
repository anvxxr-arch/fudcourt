package coinmetrics

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

type fakeDoer struct {
	status int
	body   string
	seen   []string
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, r.URL.String())
	return &http.Response{
		StatusCode: f.status,
		Body:       io.NopCloser(strings.NewReader(f.body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

type captureWriter struct {
	series       []canon.SeriesMeta
	observations []canon.Observation
	err          error
}

func (w *captureWriter) UpsertSeries(_ context.Context, rows []canon.SeriesMeta) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.series = append(w.series, rows...)
	return len(rows), nil
}

func (w *captureWriter) WriteObservations(_ context.Context, rows []canon.Observation) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.observations = append(w.observations, rows...)
	return len(rows), 0, nil
}

func (w *captureWriter) UpsertAssets(context.Context, []canon.Asset) (int, error) { return 0, nil }
func (w *captureWriter) UpsertChains(context.Context, []canon.Chain) (int, error) { return 0, nil }
func (w *captureWriter) UpsertVenues(context.Context, []canon.Venue) (int, error) { return 0, nil }
func (w *captureWriter) UpsertInstruments(context.Context, []canon.Instrument) (int, error) {
	return 0, nil
}
func (w *captureWriter) UpsertProtocols(context.Context, []canon.Protocol) (int, error) {
	return 0, nil
}
func (w *captureWriter) UpsertProviderSymbols(context.Context, []canon.ProviderSymbol) (int, error) {
	return 0, nil
}
func (w *captureWriter) WriteOhlcv(context.Context, []canon.Ohlcv) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteTrades(context.Context, []canon.Trade) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteQuotes(context.Context, []canon.Quote) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteOrderbook(context.Context, []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteLiquidations(context.Context, []canon.Liquidation) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteOptionQuotes(context.Context, []canon.OptionQuote) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteFunding(context.Context, []canon.FundingRate) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteOpenInterest(context.Context, []canon.OpenInterest) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WritePools(context.Context, []canon.Pool) (int, int, error) { return 0, 0, nil }
func (w *captureWriter) WriteArticles(context.Context, []canon.Article) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WritePredictionMarkets(context.Context, []canon.PredictionMarket) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteChainTVL(context.Context, []canon.ChainTVL) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteProtocolTVL(context.Context, []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteSupply(context.Context, []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, nil
}
func (w *captureWriter) WriteMetric(context.Context, string, []canon.MetricPoint) (int, error) {
	return 0, nil
}

// pageFixture is trimmed from the live community API: values are STRINGS.
const pageFixture = `{
 "data":[
  {"asset":"btc","time":"2026-10-09T00:00:00.000000000Z","CapMrktEstUSD":"1659129884611.5","PriceUSD":"82562.55"},
  {"asset":"btc","time":"2026-10-10T00:00:00.000000000Z","CapMrktEstUSD":"not-a-number","PriceUSD":"82948.86"}
 ]}`

func TestMetricsParsesStringValues(t *testing.T) {
	fd := &fakeDoer{status: 200, body: pageFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	res, err := (&fetcher{dataset: "asset-metrics", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "coinmetrics", Dataset: "asset-metrics", Subject: "btc", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("metrics: %v", err)
	}
	if len(w.series) != 2 {
		t.Fatalf("series rows: %d", len(w.series))
	}
	// 2 rows x 2 metrics = 4 candidates, one bad market-cap value rejected.
	if res.RowsWritten != 3 || res.RowsRejected != 1 {
		t.Fatalf("written=%d rejected=%d, want 3/1", res.RowsWritten, res.RowsRejected)
	}
	for _, o := range w.observations {
		if o.Value == nil {
			t.Fatalf("nil value written")
		}
	}
}

func TestMetricsRejectsBadValueNeverZeroes(t *testing.T) {
	fd := &fakeDoer{status: 200, body: pageFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	if _, err := (&fetcher{dataset: "asset-metrics", client: c}).Fetch(context.Background(),
		ingest.Job{Dataset: "asset-metrics"}, w); err != nil {
		t.Fatalf("metrics: %v", err)
	}
	// the bad CapMrktEstUSD value must NOT appear as a 0 point.
	for _, o := range w.observations {
		if o.Value != nil && *o.Value == 0 {
			t.Fatalf("zero value written for a rejected reading")
		}
	}
}

func TestCommunityMetricsExcludesValuation(t *testing.T) {
	for _, m := range communityMetrics {
		if m == "CapRealUSD" || m == "NUPL" || m == "SOPR" {
			t.Fatalf("valuation metric %s must not be fetched keylessly", m)
		}
	}
}

func TestStatusErrorLoud(t *testing.T) {
	fd := &fakeDoer{status: 403, body: "forbidden"}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "asset-metrics", client: c}).Fetch(context.Background(), ingest.Job{}, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 403 {
		t.Fatalf("want status HardError 403, got %v", err)
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "coinmetrics" {
		t.Fatalf("provider: %s", m.Provider())
	}
	if _, ok := m.Fetchers()["asset-metrics"]; !ok {
		t.Fatalf("missing fetcher")
	}
	for _, j := range m.Jobs() {
		if !j.Enabled || j.Provider != "coinmetrics" {
			t.Fatalf("job: %+v", j)
		}
	}
}
