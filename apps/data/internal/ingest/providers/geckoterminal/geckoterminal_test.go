package geckoterminal

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
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

// spyWriter counts the writes each dataset performs.
type spyWriter struct {
	chains int
	venues int
	pools  int
	err    error
}

func (w *spyWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.chains += len(rows)
	return len(rows), nil
}
func (w *spyWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.venues += len(rows)
	return len(rows), nil
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
	if w.err != nil {
		return 0, 0, w.err
	}
	w.pools += len(rows)
	return len(rows), 0, nil
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

// Fixtures trimmed from the real endpoint (shape-true, values real): a JSON-
// API document with string numerics, a nested relationships.dex, and two
// included tokens in base/quote order.
const poolFixture = `{
 "data": {
  "id": "eth_0x11b815efb8f581194ae79006d24e0d814b7697f6",
  "type": "pool",
  "attributes": {
   "base_token_price_usd": "2482.24",
   "address": "0x11b815efb8f581194ae79006d24e0d814b7697f6",
   "name": "WETH / USDT 0.05%",
   "pool_created_at": "2021-12-29T12:35:27Z",
   "fdv_usd": "5382604507.30344",
   "volume_usd": {"h24": "10486450.8916035"},
   "reserve_in_usd": "9435637.1372"
  },
  "relationships": {
   "base_token": {"data": {"id": "eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "type": "token"}},
   "quote_token": {"data": {"id": "eth_0xdac17f958d2ee523a2206206994597c13d831ec7", "type": "token"}},
   "dex": {"data": {"id": "uniswap_v3", "type": "dex"}}
  }
 },
 "included": [
  {"id": "eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "type": "token",
   "attributes": {"address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "name": "Wrapped Ether", "symbol": "WETH", "decimals": 18}},
  {"id": "eth_0xdac17f958d2ee523a2206206994597c13d831ec7", "type": "token",
   "attributes": {"address": "0xdac17f958d2ee523a2206206994597c13d831ec7", "name": "Tether USD", "symbol": "USDT", "decimals": 6}}
 ]
}`
const poolNoDexFixture = `{
 "data": {
  "id": "eth_0xabc", "type": "pool",
  "attributes": {"address": "0xabc", "base_token_price_usd": "1.5", "reserve_in_usd": "10"},
  "relationships": {}
 },
 "included": []
}`

// captureWriter spies and keeps the rows for identity assertions.
type captureWriter struct {
	spyWriter
	chains []canon.Chain
	venues []canon.Venue
	pools  []canon.Pool
}

func (w *captureWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	w.chains = append(w.chains, rows...)
	return w.spyWriter.UpsertChains(ctx, rows)
}
func (w *captureWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	w.venues = append(w.venues, rows...)
	return w.spyWriter.UpsertVenues(ctx, rows)
}
func (w *captureWriter) WritePools(ctx context.Context, rows []canon.Pool) (int, int, error) {
	w.pools = append(w.pools, rows...)
	return w.spyWriter.WritePools(ctx, rows)
}

func TestPoolMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: poolFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	res, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "geckoterminal", Dataset: "pools", Subject: "eth:0x11b815efb8f581194ae79006d24e0d814b7697f6", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	if res.RowsWritten != 1 || res.RowsRejected != 0 {
		t.Fatalf("rows: written %d rejected %d", res.RowsWritten, res.RowsRejected)
	}
	if len(w.pools) != 1 || len(w.chains) != 1 || len(w.venues) != 1 {
		t.Fatalf("pools %d chains %d venues %d", len(w.pools), len(w.chains), len(w.venues))
	}
	if fd.seen[0] != "https://api.geckoterminal.com/api/v2/networks/eth/pools/0x11b815efb8f581194ae79006d24e0d814b7697f6?include=base_token,quote_token" {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// The eth network slug maps to the canonical ethereum chain name.
	wantPool := canon.MintID(canon.KindPool, canon.PoolKey("ethereum", "0x11b815efb8f581194ae79006d24e0d814b7697f6"))
	p := w.pools[0]
	if p.PoolID != wantPool {
		t.Fatalf("pool id %q, want %q", p.PoolID, wantPool)
	}
	if p.ChainID != canon.MintID(canon.KindChain, canon.ChainKey("ethereum")) {
		t.Fatalf("chain id %q", p.ChainID)
	}
	if p.DEXVenueID != canon.MintID(canon.KindVenue, canon.VenueKey("uniswap_v3")) {
		t.Fatalf("venue id %q", p.DEXVenueID)
	}
	if p.Address != "0x11b815efb8f581194ae79006d24e0d814b7697f6" {
		t.Fatalf("address %q", p.Address)
	}
	// Numerics arrive as strings and must parse.
	if p.Price == nil || *p.Price != 2482.24 {
		t.Fatalf("price %v", p.Price)
	}
	if p.LiquidityUSD == nil || *p.LiquidityUSD != 9435637.1372 {
		t.Fatalf("liquidity %v", p.LiquidityUSD)
	}
	if p.Volume24hUSD == nil || *p.Volume24hUSD != 10486450.8916035 {
		t.Fatalf("volume %v", p.Volume24hUSD)
	}
	if p.FdvUsd == nil || *p.FdvUsd != 5382604507.30344 {
		t.Fatalf("fdv %v", p.FdvUsd)
	}
	// Included tokens anchor base=WETH, quote=USDT (stablecoin kind). WETH
	// is not in the reference vocabulary (ETH is): kind other is the honest
	// classification, same rule as the dexscreener adapter.
	wantBase := canon.MintID(canon.KindAsset, canon.AssetKey(canon.AssetOther, "WETH"))
	if p.BaseAssetID == nil || *p.BaseAssetID != wantBase {
		t.Fatalf("base asset %v", p.BaseAssetID)
	}
	wantQuote := canon.MintID(canon.KindAsset, canon.AssetKey(canon.AssetStablecoin, "USDT"))
	if p.QuoteAssetID == nil || *p.QuoteAssetID != wantQuote {
		t.Fatalf("quote asset %v", p.QuoteAssetID)
	}
	if p.At.IsZero() || p.Source != "geckoterminal" || p.RetrievedAt.IsZero() {
		t.Fatalf("at %v source %q retrieved %v", p.At, p.Source, p.RetrievedAt)
	}
	// Venue rows are dex-kind, unknown (this build cannot trade there).
	for _, v := range w.venues {
		if v.Kind != "dex" || v.Known {
			t.Fatalf("venue %+v", v)
		}
	}
}

func TestPoolWithoutDexFallsBackToProviderVenue(t *testing.T) {
	fd := &fakeDoer{status: 200, body: poolNoDexFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	if _, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "geckoterminal", Dataset: "pools", Subject: "eth:0xabc", Mode: "poll"}, w); err != nil {
		t.Fatalf("pool: %v", err)
	}
	if len(w.pools) != 1 || len(w.venues) != 1 {
		t.Fatalf("pools %d venues %d", len(w.pools), len(w.venues))
	}
	if w.pools[0].DEXVenueID != canon.MintID(canon.KindVenue, canon.VenueKey("geckoterminal")) {
		t.Fatalf("venue id %q", w.pools[0].DEXVenueID)
	}
	// No included tokens: the asset anchors stay nil, never guessed.
	if w.pools[0].BaseAssetID != nil || w.pools[0].QuoteAssetID != nil {
		t.Fatal("asset anchors must stay nil without included tokens")
	}
	// Fields the document omits stay nil (never-fake).
	if w.pools[0].Volume24hUSD != nil || w.pools[0].FdvUsd != nil {
		t.Fatal("absent numerics must stay nil")
	}
}

func TestBadSubjectIsHardError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "{}"}, 0)
	_, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "geckoterminal", Dataset: "pools", Subject: "no-colon"}, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 404, body: `{"errors":[{"status":"404","title":"Not Found"}]}`}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "geckoterminal", Dataset: "pools", Subject: "eth:0xdead"}, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 404 {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestUnknownDatasetIsHardError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "{}"}, 0)
	_, err := (&fetcher{dataset: "nope", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "geckoterminal", Dataset: "nope"}, &spyWriter{})
	if err == nil {
		t.Fatal("unknown dataset must be a HardError")
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "geckoterminal" {
		t.Fatalf("provider %q", m.Provider())
	}
	js := m.Jobs()
	if len(js) != 2 {
		t.Fatalf("jobs: %+v", js)
	}
	for _, j := range js {
		if j.Dataset != "pools" || j.Mode != "poll" || !j.Enabled {
			t.Fatalf("job %+v", j)
		}
		if j.Schedule != 5*60*1e9 {
			t.Fatalf("schedule %v", j.Schedule)
		}
		if !strings.Contains(j.Subject, ":") {
			t.Fatalf("subject %q does not parse", j.Subject)
		}
	}
	f := m.Fetchers()
	if len(f) != 1 {
		t.Fatalf("fetchers: %v", f)
	}
	if _, ok := f["pools"]; !ok {
		t.Fatal("no pools fetcher")
	}
}
