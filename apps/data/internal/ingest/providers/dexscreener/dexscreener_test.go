package dexscreener

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
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
	chains  int
	venues  int
	pools   int
	provSym int
	err     error
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
func (w *spyWriter) WriteLiquidations(ctx context.Context, rows []canon.Liquidation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOptionQuotes(ctx context.Context, rows []canon.OptionQuote) (int, int, error) {
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

// Fixtures trimmed from the real endpoints (shape-true, values real). The
// token-pairs shape is a bare array; pair/search wrap in {"pairs":[...]}.
const tokenPairsFixture = `[
 {"chainId":"ethereum","dexId":"uniswap","url":"https://dexscreener.com/ethereum/0x11b815efb8f581194ae79006d24e0d814b7697f6",
  "pairAddress":"0x11b815efb8f581194ae79006d24e0d814b7697f6",
  "baseToken":{"address":"0xdAC17F958D2ee523a2206206994597C13D831ec7","name":"Tether USD","symbol":"USDT"},
  "quoteToken":{"address":"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","name":"Wrapped Ether","symbol":"WETH"},
  "priceUsd":"0.9992","volume":{"h24":891.51},"liquidity":{"usd":1198.14},"fdv":88234217960,
  "pairCreatedAt":1774509491000},
 {"chainId":"ethereum","dexId":"curve","url":"https://dexscreener.com/ethereum/stbl",
  "pairAddress":"0xEf3a1CaE64848F9eB25022de4DCb77b40afFe419-0xdAC17F958D2ee523a2206206994597C13D831ec7-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "labels":["stbl"],
  "baseToken":{"address":"0xdAC17F958D2ee523a2206206994597C13D831ec7","name":"Tether USD","symbol":"USDT"},
  "quoteToken":{"address":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","name":"USD Coin","symbol":"USDC"},
  "priceUsd":0.9992,"volume":{"h24":891.51},"liquidity":{"usd":1198.14},"fdv":88234217960,
  "pairCreatedAt":1774509491000}
]`
const searchFixture = `{"schemaVersion":"1.0.0","pairs":[
 {"chainId":"solana","dexId":"raydium","pairAddress":"58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
  "baseToken":{"address":"So11111111111111111111111111111111111111112","name":"Wrapped SOL","symbol":"SOL"},
  "quoteToken":{"address":"Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB","name":"Tether USD","symbol":"USDT"},
  "priceUsd":"132.11","volume":{"h24":"5213551.66"},"liquidity":{"usd":6378086.14}}
]}`
const emptyPairsFixture = `[]`

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

func TestTokenPairsMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: tokenPairsFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	res, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "dexscreener", Dataset: "pools", Subject: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("pools: %v", err)
	}
	if res.RowsWritten != 2 || res.RowsRejected != 0 {
		t.Fatalf("rows: written %d rejected %d", res.RowsWritten, res.RowsRejected)
	}
	if len(w.pools) != 2 || len(w.chains) != 1 || len(w.venues) != 2 {
		t.Fatalf("pools %d chains %d venues %d", len(w.pools), len(w.chains), len(w.venues))
	}
	if fd.seen[0] != "https://api.dexscreener.com/token-pairs/v1/ethereum/0xdac17f958d2ee523a2206206994597c13d831ec7" {
		t.Fatalf("url: %s", fd.seen[0])
	}
	p := w.pools[0]
	wantPool := canon.MintID(canon.KindPool, canon.PoolKey("ethereum", "0x11b815efb8f581194ae79006d24e0d814b7697f6"))
	if p.PoolID != wantPool {
		t.Fatalf("pool id %q, want %q", p.PoolID, wantPool)
	}
	if p.ChainID != canon.MintID(canon.KindChain, canon.ChainKey("ethereum")) {
		t.Fatalf("chain id %q", p.ChainID)
	}
	if p.DEXVenueID != canon.MintID(canon.KindVenue, canon.VenueKey("uniswap")) {
		t.Fatalf("venue id %q", p.DEXVenueID)
	}
	if p.Address != "0x11b815efb8f581194ae79006d24e0d814b7697f6" {
		t.Fatalf("address %q", p.Address)
	}
	// The sides' display symbols ride on the pool row: every pool read projects
	// them so a consumer can name a pool's sides without a join. Unset here, the
	// whole API reports anonymous pools.
	if p.BaseSymbol == nil || *p.BaseSymbol != "USDT" {
		t.Fatalf("base symbol %v, want USDT", p.BaseSymbol)
	}
	if p.QuoteSymbol == nil || *p.QuoteSymbol != "WETH" {
		t.Fatalf("quote symbol %v, want WETH", p.QuoteSymbol)
	}
	// pairCreatedAt arrives as epoch MILLISECONDS and is the pair's age, not the
	// snapshot's time (At is the poll's now — confusing the two would date every
	// pool to the moment it was polled).
	wantCreated := time.UnixMilli(1774509491000).UTC()
	if p.PoolCreatedAt == nil || !p.PoolCreatedAt.Equal(wantCreated) {
		t.Fatalf("pair created_at %v, want %v", p.PoolCreatedAt, wantCreated)
	}
	if p.PoolCreatedAt.Equal(p.At) {
		t.Fatal("pair created_at must not be the snapshot time")
	}
	// priceUsd arrived as a string and still parses.
	if p.Price == nil || *p.Price != 0.9992 {
		t.Fatalf("price %v", p.Price)
	}
	if p.LiquidityUSD == nil || *p.LiquidityUSD != 1198.14 {
		t.Fatalf("liquidity %v", p.LiquidityUSD)
	}
	if p.Volume24hUSD == nil || *p.Volume24hUSD != 891.51 {
		t.Fatalf("volume %v", p.Volume24hUSD)
	}
	if p.FdvUsd == nil || *p.FdvUsd != 88234217960 {
		t.Fatalf("fdv %v", p.FdvUsd)
	}
	// At is the fetch time (a live snapshot, not provider-stamped).
	if p.At.IsZero() || p.Source != "dexscreener" || p.RetrievedAt.IsZero() {
		t.Fatalf("at %v source %q retrieved %v", p.At, p.Source, p.RetrievedAt)
	}
	// The composite pairAddress stays verbatim (identity, not display).
	if w.pools[1].Address != "0xEf3a1CaE64848F9eB25022de4DCb77b40afFe419-0xdAC17F958D2ee523a2206206994597C13D831ec7-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" {
		t.Fatalf("composite address %q", w.pools[1].Address)
	}
	// Venue rows are dex-kind, unknown (this build cannot trade there).
	for _, v := range w.venues {
		if v.Kind != "dex" || v.Known {
			t.Fatalf("venue %+v", v)
		}
	}
}

func TestSearchAndPairModesUseWrappedEndpoints(t *testing.T) {
	fd := &fakeDoer{status: 200, body: searchFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	if _, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "dexscreener", Dataset: "pools", Subject: "search/solana:SOL USDT", Mode: "poll"}, w); err != nil {
		t.Fatalf("search: %v", err)
	}
	if fd.seen[0] != "https://api.dexscreener.com/latest/dex/search?q=SOL+USDT" {
		t.Fatalf("search url: %s", fd.seen[0])
	}
	if w.pools != 1 {
		t.Fatalf("search pools: %d", w.pools)
	}
	fd2 := &fakeDoer{status: 200, body: searchFixture}
	c2 := newClient(fd2, 0)
	if _, err := (&fetcher{dataset: "pools", client: c2}).Fetch(context.Background(),
		ingest.Job{Provider: "dexscreener", Dataset: "pools", Subject: "pair/ethereum:0x11b815efb8f581194ae79006d24e0d814b7697f6", Mode: "poll"}, &spyWriter{}); err != nil {
		t.Fatalf("pair: %v", err)
	}
	if fd2.seen[0] != "https://api.dexscreener.com/latest/dex/pairs/ethereum/0x11b815efb8f581194ae79006d24e0d814b7697f6" {
		t.Fatalf("pair url: %s", fd2.seen[0])
	}
}

func TestEmptyPageWritesNothing(t *testing.T) {
	fd := &fakeDoer{status: 200, body: emptyPairsFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	res, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "dexscreener", Dataset: "pools", Subject: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("pools: %v", err)
	}
	if res.RowsWritten != 0 || w.pools != 0 || w.chains != 0 {
		t.Fatalf("written %d pools %d chains %d", res.RowsWritten, w.pools, w.chains)
	}
}

func TestMissingAddressIsRejected(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `[{"chainId":"ethereum","dexId":"uniswap","pairAddress":""}]`}
	c := newClient(fd, 0)
	w := &spyWriter{}
	res, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "dexscreener", Dataset: "pools", Subject: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("pools: %v", err)
	}
	if res.RowsRejected != 1 || res.RowsWritten != 0 {
		t.Fatalf("written %d rejected %d", res.RowsWritten, res.RowsRejected)
	}
}

func TestBadSubjectIsHardError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "[]"}, 0)
	_, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "dexscreener", Dataset: "pools", Subject: "no-colon-here"}, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 429, body: `{"error":"rate limit"}`}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "pools", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "dexscreener", Dataset: "pools", Subject: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7"}, &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 429 {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestUnknownDatasetIsHardError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "[]"}, 0)
	_, err := (&fetcher{dataset: "nope", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "dexscreener", Dataset: "nope"}, &spyWriter{})
	if err == nil {
		t.Fatal("unknown dataset must be a HardError")
	}
}

func TestJobsRegistered(t *testing.T) {
	// Without a DEX writer the module still builds; only the market-snapshots
	// job is gated off (it has nowhere to write).
	m := NewModule(nil, nil)
	if m.Provider() != "dexscreener" {
		t.Fatalf("provider %q", m.Provider())
	}
	js := m.Jobs()
	if len(js) != 6 {
		t.Fatalf("jobs: %+v", js)
	}
	for _, j := range js {
		if j.Mode != "poll" || j.Schedule != 5*60*1e9 {
			t.Fatalf("job %+v", j)
		}
		if _, _, _, ok := splitSubject(j.Subject); !ok {
			t.Fatalf("subject %q does not parse", j.Subject)
		}
		switch j.Dataset {
		case "pools":
			if !j.Enabled {
				t.Fatalf("pools must be enabled: %+v", j)
			}
		case "market-snapshots":
			if j.Enabled {
				t.Fatalf("market-snapshots must be gated off without a writer: %+v", j)
			}
		default:
			t.Fatalf("unexpected dataset %+v", j)
		}
	}
	mw := NewModule(nil, &spyDexWriter{})
	for _, j := range mw.Jobs() {
		if j.Dataset == "market-snapshots" && !j.Enabled {
			t.Fatal("market-snapshots must be enabled with a writer")
		}
	}
	f := m.Fetchers()
	if len(f) != 2 {
		t.Fatalf("fetchers: %v", f)
	}
	for _, name := range []string{"pools", "market-snapshots"} {
		if _, ok := f[name]; !ok {
			t.Fatalf("no %s fetcher", name)
		}
	}
}

// spyDexWriter records market-snapshot batches; every other method is a no-op.
type spyDexWriter struct {
	markets [][]canon.DexMarketSnapshot
	err     error
}

func (w *spyDexWriter) WriteDexMarketSnapshots(_ context.Context, rows []canon.DexMarketSnapshot) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.markets = append(w.markets, rows)
	return len(rows), 0, nil
}

func (w *spyDexWriter) UpsertDexDeployments(context.Context, []canon.DexDeployment) (int, error) {
	return 0, w.err
}
func (w *spyDexWriter) UpsertPoolTokens(context.Context, []canon.PoolToken) (int, error) {
	return 0, w.err
}
func (w *spyDexWriter) WriteDexSwaps(context.Context, []canon.Swap) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexCandles(context.Context, []canon.DexCandle) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexLiquiditySnapshots(context.Context, []canon.DexLiquiditySnapshot) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexLiquidityPositions(context.Context, []canon.DexLiquidityPosition) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexWalletActivity(context.Context, []canon.WalletActivity) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexRouteQuotes(context.Context, []canon.RouteQuote) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexRiskMetrics(context.Context, []canon.RiskMetric) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexMEVEvents(context.Context, []canon.MEVEvent) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexPerpMarkets(context.Context, []canon.PerpMarket) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexPerpLiquidations(context.Context, []canon.PerpLiquidation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteDexOrderbookSnapshots(context.Context, []canon.DexOrderbookSnapshot) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteProviderObservations(context.Context, []canon.ProviderObservation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteProviderHealth(context.Context, []dexstore.ProviderHealth) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyDexWriter) WriteQualityStatus(context.Context, []dexstore.QualityStatus) (int, int, error) {
	return 0, 0, w.err
}

var _ dexstore.Writer = (*spyDexWriter)(nil)

// TestMarketSnapshotsExactDecimals drives the market-snapshots dataset with a
// fixture shaped like the REAL upstream body (probed live): priceUsd/priceNative
// are JSON strings, while volume.h24, priceChange.h24, fdv and marketCap are
// bare JSON numbers — so this test fails if `UseNumber` is removed, because a
// float64 decode would round them. A second pair with no priceChange asserts the
// column stays nil rather than fabricating a 0 (upstream omits it on ~4/30 pairs).
func TestMarketSnapshotsExactDecimals(t *testing.T) {
	body := `[
		{"chainId":"ethereum","dexId":"uniswap","pairAddress":"0xPOOL",
		"baseToken":{"address":"0xA","symbol":"WETH"},"quoteToken":{"address":"0xB","symbol":"USDT"},
		"priceUsd":"4001.123456789012345678","priceNative":"1.0001",
		"liquidity":{"usd":"12345678"},"volume":{"h24":9876543.21},
		"txns":{"h24":{"buys":1234,"sells":567}},
		"priceChange":{"h24":-3.25},"fdv":4001123456,"marketCap":3999999999},
		{"chainId":"ethereum","dexId":"uniswap","pairAddress":"0xNOCHANGE",
		"baseToken":{"address":"0xC","symbol":"DAI"},"quoteToken":{"address":"0xD","symbol":"USDC"},
		"priceUsd":"1.0","priceNative":"1.0","volume":{"h24":10},"txns":{"h24":{"buys":1,"sells":1}}}
	]`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "market-snapshots", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "dexscreener", Dataset: "market-snapshots", Subject: "ethereum:0xA",
	}, &spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 2 || res.RowsRejected != 0 {
		t.Fatalf("result %+v", res)
	}
	if len(dw.markets) != 1 || len(dw.markets[0]) != 2 {
		t.Fatalf("market batches %+v", dw.markets)
	}
	row := dw.markets[0][0]
	// A quoted string survives verbatim (the provider's published digits).
	if row.PriceUSD == nil || row.PriceUSD.String() != "4001.123456789012345678" {
		t.Fatalf("price exactness lost: %v", row.PriceUSD)
	}
	// A BARE NUMBER must survive exactly too — this is the UseNumber guard.
	if row.Volume24hUSD == nil || row.Volume24hUSD.String() != "9876543.21" {
		t.Fatalf("volume (JSON number) not exact: %v", row.Volume24hUSD)
	}
	if row.FDVUSD == nil || row.FDVUSD.String() != "4001123456" {
		t.Fatalf("fdv (JSON number) not exact: %v", row.FDVUSD)
	}
	if row.MarketCapUSD == nil || row.MarketCapUSD.String() != "3999999999" {
		t.Fatalf("market cap (JSON number) not exact: %v", row.MarketCapUSD)
	}
	if row.Txns24h == nil || *row.Txns24h != 1801 {
		t.Fatalf("txns %v", row.Txns24h)
	}
	if row.Buys24h == nil || *row.Buys24h != 1234 || row.Sells24h == nil || *row.Sells24h != 567 {
		t.Fatalf("buys/sells %v/%v", row.Buys24h, row.Sells24h)
	}
	if row.PriceChangePct24h == nil || row.PriceChangePct24h.String() != "-3.25" {
		t.Fatalf("price change (JSON number) not exact: %v", row.PriceChangePct24h)
	}
	if row.Provenance.Tier != canon.TierAggregator || row.Provenance.SourceType != "aggregator" {
		t.Fatalf("provenance %+v", row.Provenance)
	}
	if row.NaturalKey == "" || row.SnapshotID == "" {
		t.Fatalf("empty key/id: %+v", row)
	}
	// The pair with no priceChange must leave the column nil, never 0.
	if alt := dw.markets[0][1]; alt.PriceChangePct24h != nil {
		t.Fatalf("absent priceChange must stay nil, got %v", alt.PriceChangePct24h)
	} else if alt.Volume24hUSD == nil || alt.Volume24hUSD.String() != "10" {
		t.Fatalf("second pair volume %v", alt.Volume24hUSD)
	}
}

// TestMarketCursorKeepsSubjectOverride is the regression for a cursor-clobber
// defect: the fetch reads job.Cursor["subject"] as an override, so returning a
// cursor built from nil would permanently erase it on the first successful run
// (the engine replaces the whole cursor column with Next). The tier keys must
// be ADDED to the existing cursor, never replace it.
func TestMarketCursorKeepsSubjectOverride(t *testing.T) {
	// search mode wraps its rows in {"pairs": [...]}.
	body := `{"pairs":[{"chainId":"ethereum","dexId":"uniswap","pairAddress":"0xPOOL",
		"baseToken":{"address":"0xA","symbol":"WETH"},"quoteToken":{"address":"0xB","symbol":"USDT"},
		"priceUsd":"4001.12","volume":{"h24":9876543.21},"txns":{"h24":{"buys":1234,"sells":567}}}]}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "market-snapshots", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "dexscreener", Dataset: "market-snapshots", Subject: "ethereum:0xSEED",
		Cursor: ingest.Cursor{"subject": "search/ethereum:weth", "keep": "me"},
	}, &spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if got, _ := res.Next["subject"].(string); got != "search/ethereum:weth" {
		t.Fatalf("the subject override must survive the tier write, got %q (full cursor %+v)", got, res.Next)
	}
	if got, _ := res.Next["keep"].(string); got != "me" {
		t.Fatalf("an unrelated cursor key must survive too, got %+v", res.Next)
	}
	if _, ok := res.Next["activity_tier"]; !ok {
		t.Fatalf("the tier must still be recorded, got %+v", res.Next)
	}
}

// TestMarketSnapshotsNilWriterFailsLoud proves the dataset refuses to run
// without a write port.
func TestMarketSnapshotsNilWriterFailsLoud(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "[]"}, 0)
	f := &fetcher{dataset: "market-snapshots", client: c}
	if _, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "dexscreener", Dataset: "market-snapshots", Subject: "ethereum:0xA",
	}, &spyWriter{}); err == nil {
		t.Fatal("nil writer must fail loudly")
	}
}

// TestZeroPairCursorKeepsSubjectOverride is the regression for the OTHER
// cursor-clobber path: a successful fetch that yields no pairs must still return
// the job's cursor, because the engine replaces the whole column with Next. An
// empty cursor here would erase the subject override on the first quiet run.
func TestZeroPairCursorKeepsSubjectOverride(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: `{"pairs":[]}`}, 0)
	f := &fetcher{dataset: "market-snapshots", client: c, dw: &spyDexWriter{}}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "dexscreener", Dataset: "market-snapshots", Subject: "search/ethereum:x",
		Cursor: ingest.Cursor{"subject": "search/ethereum:weth", "keep": "me"},
	}, &spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 {
		t.Fatalf("no pairs means no rows: %+v", res)
	}
	if got, _ := res.Next["subject"].(string); got != "search/ethereum:weth" {
		t.Fatalf("a zero-pair success must preserve the cursor, got %+v", res.Next)
	}
	if got, _ := res.Next["keep"].(string); got != "me" {
		t.Fatalf("other keys must survive too, got %+v", res.Next)
	}
}
