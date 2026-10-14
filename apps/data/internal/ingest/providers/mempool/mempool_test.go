package mempool

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fakeDoer answers every request with one canned status+body and records URLs.
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

// captureWriter spies on series and observation writes.
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

// hashrateFixture is trimmed from the live /mining/hashrate/1y response.
const hashrateFixture = `{
 "hashrates":[{"timestamp":1760227200,"avgHashrate":1.1e21},{"timestamp":1760313600,"avgHashrate":1.2e21}],
 "difficulty":[{"time":1759190933,"height":916704,"difficulty":132716002350731.3,"adjustment":0.999691}]
}`

// rewardsFixture is trimmed from the live /mining/blocks/rewards/1m response:
// variable-size buckets (avgHeight steps ~5), AvgRewards in satoshi per block.
const rewardsFixture = `[
 {"avgHeight":970600,"timestamp":1760227200,"avgRewards":314837318,"USD":112222},
 {"avgHeight":970605,"timestamp":1760234400,"avgRewards":314257420,"USD":111998},
 {"avgHeight":970610,"timestamp":1760241600,"avgRewards":313696797,"USD":110815}
]`

func TestHashrateMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: hashrateFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	res, err := (&fetcher{dataset: "hashrate", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "mempool", Dataset: "hashrate", Subject: "bitcoin", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("hashrate: %v", err)
	}
	if !strings.Contains(fd.seen[0], "/api/v1/mining/hashrate/all") {
		t.Fatalf("url: %s", fd.seen[0])
	}
	if len(w.series) != 2 {
		t.Fatalf("series rows: %d", len(w.series))
	}
	if res.RowsWritten != 3 {
		t.Fatalf("rows written: %d, want 3 (2 hashrate + 1 difficulty)", res.RowsWritten)
	}
	// hashrate is converted H/s -> EH/s.
	var hashVal *float64
	for _, o := range w.observations {
		if o.SeriesID == w.series[0].SeriesID {
			hashVal = o.Value
		}
	}
	if hashVal == nil || *hashVal < 1000 || *hashVal > 2000 {
		t.Fatalf("hashrate EH/s: %v", hashVal)
	}
}

// TestBlocksBucketToDaily pins the span-weighted daily reconstruction: rows are
// variable-size buckets, so the daily total is sum(perBlock * span) / 1e8.
func TestBlocksBucketToDaily(t *testing.T) {
	fd := &fakeDoer{status: 200, body: rewardsFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	_, err := (&fetcher{dataset: "rewards", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "mempool", Dataset: "rewards", Subject: "bitcoin", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("rewards: %v", err)
	}
	if len(w.observations) == 0 {
		t.Fatalf("no observations")
	}
	// all three rows share one UTC day; spans are 5,5,5 blocks (last row
	// reuses the previous span). total = sum(rewards)*5/1e8 ≈ 47.14 BTC
	var total float64
	for _, o := range w.observations {
		total += *o.Value
	}
	if total < 47 || total > 48 {
		t.Fatalf("daily total: %v, want ~47.14", total)
	}
}

func TestBlocksBucketsSameDayMerge(t *testing.T) {
	// two rows on the same UTC day must merge into ONE observation.
	fd := &fakeDoer{status: 200, body: rewardsFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	if _, err := (&fetcher{dataset: "rewards", client: c}).Fetch(context.Background(),
		ingest.Job{Dataset: "rewards"}, w); err != nil {
		t.Fatalf("rewards: %v", err)
	}
	days := map[string]int{}
	for _, o := range w.observations {
		days[o.Period]++
	}
	for d, n := range days {
		if n != 1 {
			t.Fatalf("day %s has %d rows, want 1", d, n)
		}
	}
}

func TestUnknownDatasetLoud(t *testing.T) {
	fd := &fakeDoer{status: 200, body: "[]"}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "nope", client: c}).Fetch(context.Background(), ingest.Job{}, &captureWriter{})
	if _, ok := err.(*HardError); !ok {
		t.Fatalf("want HardError, got %T: %v", err, err)
	}
}

func TestStatusErrorLoud(t *testing.T) {
	fd := &fakeDoer{status: 503, body: "upstream down"}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "hashrate", client: c}).Fetch(context.Background(), ingest.Job{}, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 503 {
		t.Fatalf("want status HardError 503, got %v", err)
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "mempool" {
		t.Fatalf("provider: %s", m.Provider())
	}
	f := m.Fetchers()
	for _, ds := range []string{"hashrate", "rewards", "fees"} {
		if _, ok := f[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
	for _, j := range m.Jobs() {
		if !j.Enabled || j.Provider != "mempool" {
			t.Fatalf("job: %+v", j)
		}
	}
}

func TestUtcDay(t *testing.T) {
	// 1760227200 == 2025-10-12T00:00:00Z
	if got := utcDay(1760227200); got != 1760227200 {
		t.Fatalf("utcDay(midnight) = %d", got)
	}
	if got := utcDay(1760227200 + 3600); got != 1760227200 {
		t.Fatalf("utcDay(+1h) = %d", got)
	}
	_ = time.UTC
}
