package coingecko

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// seqDoer answers consecutive requests from a canned list (the markets
// fetcher walks pages, so one response per request) and records every URL.
type seqDoer struct {
	bodies []string
	status int
	seen   []string
}

func (f *seqDoer) Do(r *http.Request) (*http.Response, error) {
	i := len(f.seen)
	f.seen = append(f.seen, r.URL.String())
	body := ""
	if i < len(f.bodies) {
		body = f.bodies[i]
	}
	return &http.Response{
		StatusCode: f.status,
		Body:       newReadCloser(body),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

// fakeDoer answers every request with the same canned status+body.
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

// spyWriter counts the writes each dataset performs.
type spyWriter struct {
	assets int
	obs    int
	provS  int
	err    error
}

func (w *spyWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.assets += len(rows)
	return len(rows), nil
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
	return 0, w.err
}

func (w *spyWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.provS += len(rows)
	return len(rows), nil
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
func (w *spyWriter) WriteLiquidations(ctx context.Context, rows []canon.Liquidation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOptionQuotes(ctx context.Context, rows []canon.OptionQuote) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.obs += len(rows)
	return len(rows), 0, nil
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
	return 0, w.err
}

// newReadCloser is a tiny io.ReadCloser over a string.
func newReadCloser(s string) ioReadCloser { return ioReadCloser{strings.NewReader(s)} }

type ioReadCloser struct{ *strings.Reader }

func (ioReadCloser) Close() error { return nil }

// Fixtures trimmed from the real endpoints (shape-true, values real).
const marketsPageFixture = `[
 {"id":"bitcoin","symbol":"btc","name":"Bitcoin","current_price":42661.0,
  "market_cap":838421331432.0,"total_volume":34567890012.0,
  "last_updated":"2026-02-05T18:45:02.482Z"},
 {"id":"tether","symbol":"usdt","name":"Tether USDt","current_price":1.0,
  "market_cap":140123456789.0,"total_volume":98765432101.0,
  "last_updated":"2026-02-05T18:45:02.482Z"}
]`

const globalFixture = `{"data":{"total_market_cap":{"usd":1723456789012.0},
 "total_volume":{"usd":112345678901.0},"market_cap_percentage":{"btc":52.1,"eth":15.3},
 "active_cryptocurrencies":17245,"updated_at":1769966700}}`

const marketChartFixture = `{"prices":[[1707163200000,42661.0],[1707166800000,42710.5]],
 "market_caps":[[1707163200000,838421331432.0],[1707166800000,839112000000.0]],
 "total_volumes":[[1707163200000,34567890012.0],[1707166800000,34123456789.0]]}`

func TestMarketsPaging(t *testing.T) {
	// Full page -> walks to page 2; short page (2 < 250 rows) stops there.
	full := "[" + strings.TrimSuffix(strings.Repeat(bitcoinRow+",", 249)+bitcoinRow, ",") + "]"
	fd := &seqDoer{status: 200, bodies: []string{full, marketsPageFixture}}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "coingecko", Dataset: "markets", Subject: "", Mode: "poll"}
	res, err := (&fetcher{dataset: "markets", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("markets: %v", err)
	}
	if len(fd.seen) != 2 {
		t.Fatalf("pages fetched: %d (%v)", len(fd.seen), fd.seen)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1") {
		t.Fatalf("page1 url: %s", fd.seen[0])
	}
	if !strings.HasSuffix(fd.seen[1], "page=2") {
		t.Fatalf("page2 url: %s", fd.seen[1])
	}
	// 250 rows on page 1 + page 2's two rows (bitcoin, tether): each row
	// upserts once, so the spy counts 252 rows (bitcoin appears twice).
	if w.assets != 252 {
		t.Fatalf("assets: %d", w.assets)
	}
	// 3 metrics per row: 252*3 = 756.
	if w.obs != 252*3 {
		t.Fatalf("observations: %d", w.obs)
	}
	if w.provS != 252 || res.RowsWritten != w.obs {
		t.Fatalf("provider symbols: %d, rows written: %d", w.provS, res.RowsWritten)
	}
}

const bitcoinRow = `{"id":"bitcoin","symbol":"btc","name":"Bitcoin","current_price":42661.0,
 "market_cap":838421331432.0,"total_volume":34567890012.0,
 "last_updated":"2026-02-05T18:45:02.482Z"}`

func TestMarketsShortPageStops(t *testing.T) {
	fd := &fakeDoer{status: 200, body: marketsPageFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "coingecko", Dataset: "markets", Subject: "", Mode: "poll"}
	if _, err := (&fetcher{dataset: "markets", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("markets: %v", err)
	}
	// 2 rows < per_page 250: one request only.
	if len(fd.seen) != 1 {
		t.Fatalf("pages fetched: %d", len(fd.seen))
	}
	if w.assets != 2 || w.provS != 2 || w.obs != 6 {
		t.Fatalf("assets/provS/obs: %d/%d/%d", w.assets, w.provS, w.obs)
	}
}

func TestMarketsMaxPagesCapsWalk(t *testing.T) {
	full := "[" + strings.TrimSuffix(strings.Repeat(bitcoinRow+",", 249)+bitcoinRow, ",") + "]"
	// MaxPages 1: one request even though the page was full.
	fd := &seqDoer{status: 200, bodies: []string{full, full}}
	_ = newClient(fd, 0)
	m := NewModuleWithConfig(fd, Config{MaxPages: 1})
	job := ingest.Job{Provider: "coingecko", Dataset: "markets", Subject: "", Mode: "poll"}
	if _, err := m.Fetchers()["markets"].Fetch(context.Background(), job, &spyWriter{}); err != nil {
		t.Fatalf("markets: %v", err)
	}
	if len(fd.seen) != 1 {
		t.Fatalf("pages fetched: %d", len(fd.seen))
	}
}

func TestMarketsRegistersCanonicalAssetIDs(t *testing.T) {
	fd := &fakeDoer{status: 200, body: marketsPageFixture}
	c := newClient(fd, 0)
	w := &captureWriter{spyWriter: &spyWriter{}}
	job := ingest.Job{Provider: "coingecko", Dataset: "markets", Subject: "", Mode: "poll"}
	if _, err := (&fetcher{dataset: "markets", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("markets: %v", err)
	}
	// BTC is a known native symbol: its asset id must be the MintID of the
	// reference natural key, and the provider symbol row must carry it.
	wantBTC := canon.MintID(canon.KindAsset, canon.AssetKey(canon.AssetNative, "BTC"))
	if len(w.symbols) != 2 {
		t.Fatalf("symbols: %d", len(w.symbols))
	}
	byGecko := map[string]canon.ProviderSymbol{}
	for _, s := range w.symbols {
		byGecko[s.ProviderSymb] = s
	}
	if got := byGecko["bitcoin"]; got.CanonicalID != wantBTC || got.Kind != "asset" || got.Provider != "coingecko" {
		t.Fatalf("bitcoin provider symbol: %+v (want id %s)", got, wantBTC)
	}
	// Series ids derive from the same asset id.
	wantSeries := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", "price", "asset:"+wantBTC))
	for _, o := range w.observations {
		if o.SeriesID == wantSeries {
			return
		}
	}
	t.Fatalf("no price observation for series %s", wantSeries)
}

// captureWriter spies and keeps the rows for identity assertions.
type captureWriter struct {
	*spyWriter
	symbols      []canon.ProviderSymbol
	observations []canon.Observation
}

func (w *captureWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	w.symbols = append(w.symbols, rows...)
	n, err := w.spyWriter.UpsertProviderSymbols(ctx, rows)
	if err != nil {
		return 0, err
	}
	return n, nil
}

func (w *captureWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	w.observations = append(w.observations, rows...)
	return w.spyWriter.WriteObservations(ctx, rows)
}

func TestGlobalMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: globalFixture}
	c := newClient(fd, 0)
	w := &captureWriter{spyWriter: &spyWriter{}}
	job := ingest.Job{Provider: "coingecko", Dataset: "global", Subject: "", Mode: "poll"}
	res, err := (&fetcher{dataset: "global", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("global: %v", err)
	}
	if w.obs != 3 || res.RowsWritten != 3 {
		t.Fatalf("observations: %d/%d", w.obs, res.RowsWritten)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.coingecko.com/api/v3/global") {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// total_market_cap series: subject global, domain crypto.
	want := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", "total_market_cap", "global"))
	found := false
	for _, o := range w.observations {
		if o.SeriesID == want && o.Value != nil && *o.Value == 1723456789012.0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing total_market_cap observation for %s", want)
	}
}

func TestGlobalMissingUsdCapIsShapeError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `{"data":{"total_volume":{"usd":1.0},"updated_at":1769966700}}`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "coingecko", Dataset: "global", Subject: "", Mode: "poll"}
	_, err := (&fetcher{dataset: "global", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestMarketChartMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: marketChartFixture}
	c := newClient(fd, 0)
	w := &captureWriter{spyWriter: &spyWriter{}}
	// Fresh seed job: subject carries the gecko id, no cursor yet.
	job := ingest.Job{Provider: "coingecko", Dataset: "market-chart", Subject: "bitcoin", Mode: "backfill"}
	res, err := (&fetcher{dataset: "market-chart", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("market chart: %v", err)
	}
	// 2 points x 3 arrays.
	if w.obs != 6 || res.RowsWritten != 6 {
		t.Fatalf("observations: %d/%d", w.obs, res.RowsWritten)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90") {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// The result must carry the self-contained next cursor.
	if res.Next["id"] != "bitcoin" || res.Next["symbol"] != "BTC" {
		t.Fatalf("next cursor: %v", res.Next)
	}
	// Series ids key on the canonical BTC asset id.
	wantBTC := canon.MintID(canon.KindAsset, canon.AssetKey(canon.AssetNative, "BTC"))
	wantPrice := canon.MintID(canon.KindSeries, canon.SeriesKey("crypto", "price", "asset:"+wantBTC))
	if w.observations[0].SeriesID != wantPrice {
		t.Fatalf("price series: %s, want %s", w.observations[0].SeriesID, wantPrice)
	}
}

func TestStatusErrorIsHardError(t *testing.T) {
	// Rate limit: 429 with an HTML body (no envelope in coingecko).
	fd := &fakeDoer{status: 429, body: `<html>rate limited</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "coingecko", Dataset: "global", Subject: "", Mode: "poll"}
	_, err := (&fetcher{dataset: "global", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 429 {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestNonJSONIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `<html>blocked</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "coingecko", Dataset: "global", Subject: "", Mode: "poll"}
	_, err := (&fetcher{dataset: "global", client: c}).Fetch(context.Background(), job, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "coingecko" {
		t.Fatalf("provider: %s", m.Provider())
	}
	fetchers := m.Fetchers()
	for _, ds := range []string{"markets", "global", "market-chart"} {
		if _, ok := fetchers[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
	jobs := m.Jobs()
	if len(jobs) == 0 {
		t.Fatalf("no jobs registered")
	}
	var markets5, global5, chart1h bool
	for _, j := range jobs {
		if j.Provider != "coingecko" || !j.Enabled {
			t.Fatalf("job spec: %+v", j)
		}
		switch {
		case j.Dataset == "markets" && j.Schedule == 5*time.Minute:
			markets5 = true
		case j.Dataset == "global" && j.Schedule == 5*time.Minute:
			global5 = true
		case j.Dataset == "market-chart" && j.Schedule == time.Hour:
			chart1h = true
		}
	}
	if !markets5 || !global5 || !chart1h {
		t.Fatalf("seed jobs wrong: %+v", jobs)
	}
}
