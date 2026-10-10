package blockscout

import (
	"context"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"net/http"
	"strings"
	"testing"
	"time"
)

// fakeDoer answers every request with a canned status+body and records the
// last URL (tests assert the endpoint+query shape).
type fakeDoer struct {
	status int
	body   string
	seen   []string
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, r.URL.String())
	return &http.Response{
		StatusCode: f.status,
		Body:       newReadCloser(f.body),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

// newReadCloser is a tiny io.ReadCloser over a string.
func newReadCloser(s string) ioReadCloser { return ioReadCloser{strings.NewReader(s)} }

type ioReadCloser struct{ *strings.Reader }

func (ioReadCloser) Close() error { return nil }

// spyWriter counts the writes each dataset performs.
type spyWriter struct {
	series   []canon.SeriesMeta
	seriesID []string
	pts      map[string][]canon.MetricPoint
	order    []string
	err      error
}

func (w *spyWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertInstruments(ctx context.Context, rows []canon.Instrument) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.series = append(w.series, rows...)
	for _, r := range rows {
		w.seriesID = append(w.seriesID, r.SeriesID)
	}
	return len(rows), nil
}
func (w *spyWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	return 0, w.err
}
func (w *spyWriter) WriteOhlcv(ctx context.Context, rows []canon.Ohlcv) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteTrades(ctx context.Context, rows []canon.Trade) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteQuotes(ctx context.Context, rows []canon.Quote) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteOrderbook(ctx context.Context, rows []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteFunding(ctx context.Context, rows []canon.FundingRate) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOpenInterest(ctx context.Context, rows []canon.OpenInterest) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WritePools(ctx context.Context, rows []canon.Pool) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteArticles(ctx context.Context, rows []canon.Article) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WritePredictionMarkets(ctx context.Context, rows []canon.PredictionMarket) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteChainTVL(ctx context.Context, rows []canon.ChainTVL) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteProtocolTVL(ctx context.Context, rows []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteSupply(ctx context.Context, rows []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteMetric(ctx context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	if w.pts == nil {
		w.pts = map[string][]canon.MetricPoint{}
	}
	w.pts[seriesID] = append(w.pts[seriesID], points...)
	w.order = append(w.order, seriesID)
	return len(points), nil
}

// Fixtures trimmed from the real endpoints (shape-true, values live from
// eth.blockscout.com and polygon.blockscout.com). Counters are decimal
// STRINGS, average_block_time is a NUMBER in milliseconds, gas_prices are
// numbers in gwei.
const ethStatsFixture = `{"average_block_time":12000,"coin_price":"2486.47",
 "gas_price_updated_at":"2026-10-09T18:08:35.314101Z",
 "gas_prices":{"slow":0.57,"average":0.9,"fast":2.4},
 "gas_prices_update_in":18461,"gas_used_today":"216713915844",
 "market_cap":"303645012006.29","network_utilization_percentage":56.6,
 "total_addresses":"738505157","total_blocks":"26156417",
 "total_transactions":"3793417199","transactions_today":"1836071","tvl":null}`
const polyStatsFixture = `{"average_block_time":1495,"coin_price":"0.100652",
 "gas_prices":{"slow":360.51,"average":369.9,"fast":470.96},
 "gas_used_today":"1833471202430","total_addresses":"985671216",
 "total_blocks":"48796431","total_transactions":"4844694019"}`

func TestStatsMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: ethStatsFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "blockscout", Dataset: "stats", Subject: "ethereum", Mode: "poll"}
	res, err := (&fetcher{dataset: "stats", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	// Four metrics: total_addresses, total_transactions, avg_block_time_sec,
	// gas_price_gwei.
	if res.RowsWritten != 4 || len(w.pts) != 4 {
		t.Fatalf("rows: %d, series: %d", res.RowsWritten, len(w.pts))
	}
	if fd.seen[0] != "https://eth.blockscout.com/api/v2/stats" {
		t.Fatalf("url: %s", fd.seen[0])
	}
	chain := canon.MintID(canon.KindChain, canon.ChainKey("ethereum"))
	for metric, want := range map[string]float64{
		"total_addresses":    738505157,
		"total_transactions": 3793417199,
		"avg_block_time_sec": 12, // 12000 ms -> 12 s
		"gas_price_gwei":     0.9,
	} {
		seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey("blockchain", metric, "chain:"+chain))
		pts, ok := w.pts[seriesID]
		if !ok || len(pts) != 1 {
			t.Fatalf("missing series %s (metric %s)", seriesID, metric)
		}
		if *pts[0].Value != want {
			t.Fatalf("%s value: %v want %v", metric, *pts[0].Value, want)
		}
		if pts[0].Source != "blockscout" {
			t.Fatalf("%s source: %s", metric, pts[0].Source)
		}
	}
	// Every metric's series row was upserted with the chain anchor.
	if len(w.series) != 4 {
		t.Fatalf("series upserts: %d", len(w.series))
	}
	for _, s := range w.series {
		if s.ChainID == nil || *s.ChainID != chain {
			t.Fatalf("series chain anchor: %+v", s)
		}
		if s.Domain != "blockchain" || s.Provider != "blockscout" {
			t.Fatalf("series meta: %+v", s)
		}
	}
}
func TestStatsPolygonInstance(t *testing.T) {
	fd := &fakeDoer{status: 200, body: polyStatsFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "blockscout", Dataset: "stats", Subject: "polygon", Mode: "poll"}
	res, err := (&fetcher{dataset: "stats", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("polygon stats: %v", err)
	}
	if fd.seen[0] != "https://polygon.blockscout.com/api/v2/stats" {
		t.Fatalf("url: %s", fd.seen[0])
	}
	if res.RowsWritten != 4 {
		t.Fatalf("rows: %d", res.RowsWritten)
	}
	chain := canon.MintID(canon.KindChain, canon.ChainKey("polygon"))
	seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey("blockchain", "avg_block_time_sec", "chain:"+chain))
	pts := w.pts[seriesID]
	// 1495 ms -> 1.495 s (the polygon instance's real block time).
	if len(pts) != 1 || *pts[0].Value != 1.495 {
		t.Fatalf("polygon block time: %+v", pts)
	}
}
func TestStatsUnknownChain(t *testing.T) {
	fd := &fakeDoer{status: 200, body: ethStatsFixture}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "blockscout", Dataset: "stats", Subject: "arbitrum", Mode: "poll"}
	_, err := (&fetcher{dataset: "stats", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
	if len(fd.seen) != 0 {
		t.Fatalf("requests made for unconfigured chain: %v", fd.seen)
	}
}
func TestStatsStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 503, body: `{"message":"instance down"}`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "blockscout", Dataset: "stats", Subject: "ethereum", Mode: "poll"}
	_, err := (&fetcher{dataset: "stats", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 503 {
		t.Fatalf("want status HardError, got %v", err)
	}
}
func TestStatsEmptyStatsIsShapeError(t *testing.T) {
	// A stats object with every metric absent yields no points: shape error,
	// never a silent zero-write.
	fd := &fakeDoer{status: 200, body: `{}`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "blockscout", Dataset: "stats", Subject: "ethereum", Mode: "poll"}
	_, err := (&fetcher{dataset: "stats", client: c}).Fetch(context.Background(), job, &spyWriter{})
	if _, ok := err.(*HardError); !ok {
		t.Fatalf("want HardError, got %v", err)
	}
}
func TestStatsPartialMetricsStillWrite(t *testing.T) {
	// No gas_prices in the response: the counters still write (never-fake
	// works both ways - absent is skipped, present is kept).
	fd := &fakeDoer{status: 200, body: `{"total_addresses":"1000","total_transactions":"2000",
	 "average_block_time":2000}`}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "blockscout", Dataset: "stats", Subject: "ethereum", Mode: "poll"}
	res, err := (&fetcher{dataset: "stats", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("partial stats: %v", err)
	}
	if res.RowsWritten != 3 {
		t.Fatalf("rows: %d", res.RowsWritten)
	}
	chain := canon.MintID(canon.KindChain, canon.ChainKey("ethereum"))
	gas := canon.MintID(canon.KindSeries, canon.SeriesKey("blockchain", "gas_price_gwei", "chain:"+chain))
	if len(w.pts[gas]) != 0 {
		t.Fatalf("gas series written without gas_prices: %+v", w.pts[gas])
	}
}
func TestNonJSONIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `<html>blocked</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "blockscout", Dataset: "stats", Subject: "ethereum", Mode: "poll"}
	_, err := (&fetcher{dataset: "stats", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}
func TestUnknownDataset(t *testing.T) {
	m := NewModule(nil)
	f := m.Fetchers()["stats"]
	_, err := f.Fetch(context.Background(), ingest.Job{Dataset: "stats"}, &spyWriter{})
	// sanity: stats fetcher exists and runs (fails on the fake transport is fine).
	_ = err
	if _, ok := m.Fetchers()["nope"]; ok {
		t.Fatalf("unexpected fetcher")
	}
	fx := &fetcher{dataset: "nope", client: newClient(nil, 0)}
	_, err = fx.Fetch(context.Background(), ingest.Job{}, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("unknown dataset: want shape HardError, got %v", err)
	}
}
func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "blockscout" {
		t.Fatalf("provider: %s", m.Provider())
	}
	fetchers := m.Fetchers()
	if _, ok := fetchers["stats"]; !ok {
		t.Fatalf("missing fetcher stats")
	}
	jobs := m.Jobs()
	if len(jobs) != 2 {
		t.Fatalf("jobs: %+v", jobs)
	}
	sawEth, sawPoly := false, false
	for _, j := range jobs {
		if j.Provider != "blockscout" || !j.Enabled || j.Dataset != "stats" ||
			j.Schedule != 5*time.Minute {
			t.Fatalf("job spec: %+v", j)
		}
		switch j.Subject {
		case "ethereum":
			sawEth = true
		case "polygon":
			sawPoly = true
		}
	}
	if !sawEth || !sawPoly {
		t.Fatalf("missing chain jobs: %+v", jobs)
	}
}
func TestSeriesIDDeterministic(t *testing.T) {
	chain := canon.MintID(canon.KindChain, canon.ChainKey("ethereum"))
	a := canon.MintID(canon.KindSeries, canon.SeriesKey("blockchain", "gas_price_gwei", "chain:"+chain))
	b := canon.MintID(canon.KindSeries, canon.SeriesKey("blockchain", "gas_price_gwei", "chain:"+chain))
	if a != b || !strings.HasPrefix(a, "series:") {
		t.Fatalf("series id drift: %q vs %q", a, b)
	}
}
