package bitquery

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file is the offline contract test plan §41/§52 requires: a canned
// Bitquery v2 envelope through the adapter to canonical swaps, no network. It
// pins the explicit buy/sell direction (no sign to interpret, unlike a
// subgraph), the exact whole-token -> raw re-scaling, and the credential
// discipline (the key is a header secret, never a URL or an error string).

type fakeDoer struct {
	status int
	body   string
	seen   []*http.Request
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, r)
	return &http.Response{
		StatusCode: f.status,
		Body:       io.NopCloser(strings.NewReader(f.body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

// spyWriter must satisfy canon.Writer for the engine's entity writes.
type spyWriter struct{}

func (spyWriter) UpsertAssets(context.Context, []canon.Asset) (int, error) { return 0, nil }
func (spyWriter) UpsertChains(context.Context, []canon.Chain) (int, error) { return 0, nil }
func (spyWriter) UpsertVenues(context.Context, []canon.Venue) (int, error) { return 0, nil }
func (spyWriter) UpsertInstruments(context.Context, []canon.Instrument) (int, error) {
	return 0, nil
}
func (spyWriter) UpsertProtocols(context.Context, []canon.Protocol) (int, error) { return 0, nil }
func (spyWriter) UpsertSeries(context.Context, []canon.SeriesMeta) (int, error)  { return 0, nil }
func (spyWriter) UpsertProviderSymbols(context.Context, []canon.ProviderSymbol) (int, error) {
	return 0, nil
}
func (spyWriter) WriteOhlcv(context.Context, []canon.Ohlcv) (int, int, error)  { return 0, 0, nil }
func (spyWriter) WriteTrades(context.Context, []canon.Trade) (int, int, error) { return 0, 0, nil }
func (spyWriter) WriteQuotes(context.Context, []canon.Quote) (int, int, error) { return 0, 0, nil }
func (spyWriter) WriteOrderbook(context.Context, []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WriteLiquidations(context.Context, []canon.Liquidation) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WriteOptionQuotes(context.Context, []canon.OptionQuote) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WriteObservations(context.Context, []canon.Observation) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WriteFunding(context.Context, []canon.FundingRate) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WriteOpenInterest(context.Context, []canon.OpenInterest) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WritePools(context.Context, []canon.Pool) (int, int, error) { return 0, 0, nil }
func (spyWriter) WriteArticles(context.Context, []canon.Article) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WritePredictionMarkets(context.Context, []canon.PredictionMarket) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WriteChainTVL(context.Context, []canon.ChainTVL) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WriteProtocolTVL(context.Context, []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WriteSupply(context.Context, []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, nil
}
func (spyWriter) WriteMetric(context.Context, string, []canon.MetricPoint) (int, error) {
	return 0, nil
}

type spyDexWriter struct{ swaps []canon.Swap }

func (w *spyDexWriter) WriteDexSwaps(_ context.Context, r []canon.Swap) (int, int, error) {
	w.swaps = append(w.swaps, r...)
	return len(r), 0, nil
}
func (w *spyDexWriter) WriteDexMarketSnapshots(context.Context, []canon.DexMarketSnapshot) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) UpsertDexDeployments(context.Context, []canon.DexDeployment) (int, error) {
	return 0, nil
}
func (w *spyDexWriter) UpsertPoolTokens(context.Context, []canon.PoolToken) (int, error) {
	return 0, nil
}
func (w *spyDexWriter) WriteDexCandles(context.Context, []canon.DexCandle) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexLiquiditySnapshots(context.Context, []canon.DexLiquiditySnapshot) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexLiquidityPositions(context.Context, []canon.DexLiquidityPosition) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexWalletActivity(context.Context, []canon.WalletActivity) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexRouteQuotes(context.Context, []canon.RouteQuote) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexRiskMetrics(context.Context, []canon.RiskMetric) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexMEVEvents(context.Context, []canon.MEVEvent) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexPerpMarkets(context.Context, []canon.PerpMarket) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexPerpLiquidations(context.Context, []canon.PerpLiquidation) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexOrderbookSnapshots(context.Context, []canon.DexOrderbookSnapshot) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteProviderObservations(context.Context, []canon.ProviderObservation) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteProviderHealth(context.Context, []dexstore.ProviderHealth) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteQualityStatus(context.Context, []dexstore.QualityStatus) (int, int, error) {
	return 0, 0, nil
}

var (
	_ canon.Writer    = spyWriter{}
	_ dexstore.Writer = (*spyDexWriter)(nil)
)

// tradeFixture is a Bitquery v2 DEXTrades shape: buy/sell legs, each with its
// Currency.Decimals, and a block/transaction identity.
const tradeFixture = `{"data":{"EVM":{"DEXTrades":[
	{"Block":{"Number":"21000000","Time":"2026-10-12T06:00:00Z"},
	 "Transaction":{"Hash":"0xtx1"},
	 "Trade":{"Index":"3",
	   "Buy":{"Amount":"2345.678901","Buyer":"0xbuyer",
	          "Currency":{"SmartContract":"0xUSDC","Symbol":"USDC","Decimals":"6"}},
	   "Sell":{"Amount":"1","Seller":"0xseller",
	           "Currency":{"SmartContract":"0xWETH","Symbol":"WETH","Decimals":"18"}},
	   "AmountInUSD":"2345.678901"}},
	{"Block":{"Number":"21000050","Time":"2026-10-12T06:00:12Z"},
	 "Transaction":{"Hash":"0xtx2"},
	 "Trade":{"Index":"5",
	   "Buy":{"Amount":"0.5","Buyer":"0xbuyer2",
	          "Currency":{"SmartContract":"0xWETH","Symbol":"WETH","Decimals":"18"}},
	   "Sell":{"Amount":"2001.25","Seller":"0xseller2",
	           "Currency":{"SmartContract":"0xUSDC","Symbol":"USDC","Decimals":"6"}},
	   "AmountInUSD":"2001.25"}}
]}}}`

// TestDexTradesDirectionIsExplicit pins the mapping: the SELL leg is the taker's
// input and the BUY leg is the output. There is no sign to interpret (unlike a
// subgraph), so a leg swap is the only way to get it wrong — and it is visible.
func TestDexTradesDirectionIsExplicit(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: tradeFixture}, 0)
	c.apiKey = "test-key"
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "dex-trades", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 2 {
		t.Fatalf("result %+v", res)
	}
	// Trade 1: sell WETH 1.0 -> buy USDC 2345.678901.
	s := dw.swaps[0]
	if s.AmountIn.Decimals != 18 || s.AmountIn.Normalized().String() != "1" {
		t.Fatalf("trade1 in: %d/%s (want 18/1 WETH)", s.AmountIn.Decimals, s.AmountIn.Normalized().String())
	}
	if s.AmountOut.Decimals != 6 || s.AmountOut.Normalized().String() != "2345.678901" {
		t.Fatalf("trade1 out: %d/%s", s.AmountOut.Decimals, s.AmountOut.Normalized().String())
	}
	if s.TokenIn != canon.MintID(canon.KindToken, canon.TokenKey("ethereum", "0xWETH")) {
		t.Fatalf("trade1 token_in = %s", s.TokenIn)
	}
	if s.Trader != "0xseller" {
		t.Fatalf("trade1 trader = %q (want the sell-side seller)", s.Trader)
	}
	// Trade 2 flips: sell USDC -> buy WETH.
	s2 := dw.swaps[1]
	if s2.AmountIn.Decimals != 6 || s2.AmountIn.Normalized().String() != "2001.25" {
		t.Fatalf("trade2 in: %d/%s", s2.AmountIn.Decimals, s2.AmountIn.Normalized().String())
	}
	if s2.AmountOut.Decimals != 18 || s2.AmountOut.Normalized().String() != "0.5" {
		t.Fatalf("trade2 out: %d/%s", s2.AmountOut.Decimals, s2.AmountOut.Normalized().String())
	}
	if s.Provenance.Tier != canon.TierIndexer || s.Provenance.SourceType != "indexer" {
		t.Fatalf("provenance %+v", s.Provenance)
	}
	if s.Provenance.BlockNumber == nil || *s.Provenance.BlockNumber != 21000000 {
		t.Fatalf("block %+v", s.Provenance.BlockNumber)
	}
	if s.AmountUSD == nil || s.AmountUSD.String() != "2345.678901" {
		t.Fatalf("amountUSD %v", s.AmountUSD)
	}
	if got, ok := res.Next["block"].(float64); !ok || got != 21000050 {
		t.Fatalf("cursor %+v (want newest block 21000050)", res.Next)
	}
}

// TestLegWithoutDecimalsRejected proves a leg with no decimals is refused
// rather than scaled at a default.
func TestLegWithoutDecimalsRejected(t *testing.T) {
	body := `{"data":{"EVM":{"DEXTrades":[
		{"Block":{"Number":"100","Time":"2026-10-12T06:00:00Z"},
		 "Transaction":{"Hash":"0xtx"},
		 "Trade":{"Index":"1",
		   "Buy":{"Amount":"1","Currency":{"SmartContract":"0xUSDC"}},
		   "Sell":{"Amount":"1","Currency":{"SmartContract":"0xWETH","Decimals":"18"}}}}
	]}}}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.apiKey = "test-key"
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "dex-trades", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 || res.RowsRejected != 1 {
		t.Fatalf("a leg without decimals must be rejected: %+v", res)
	}
}

// TestSubUnitPrecisionRejected proves sub-unit precision is refused, never
// silently rounded.
func TestSubUnitPrecisionRejected(t *testing.T) {
	body := `{"data":{"EVM":{"DEXTrades":[
		{"Block":{"Number":"100","Time":"2026-10-12T06:00:00Z"},
		 "Transaction":{"Hash":"0xtx"},
		 "Trade":{"Index":"1",
		   "Buy":{"Amount":"1.0000001","Currency":{"SmartContract":"0xUSDC","Decimals":"6"}},
		   "Sell":{"Amount":"1","Currency":{"SmartContract":"0xWETH","Decimals":"18"}}}}
	]}}}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.apiKey = "test-key"
	f := &fetcher{dataset: "dex-trades", client: c, dw: &spyDexWriter{}}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 || res.RowsRejected != 1 {
		t.Fatalf("sub-unit precision must be rejected: %+v", res)
	}
}

// TestNoCredentialsFailsBeforeRequest is the security contract: no key means a
// terminal failure BEFORE any network call.
func TestNoCredentialsFailsBeforeRequest(t *testing.T) {
	fd := &fakeDoer{status: 200, body: "{}"}
	c := newClient(fd, 0)
	c.apiKey = ""
	f := &fetcher{dataset: "dex-trades", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "no-credentials" {
		t.Fatalf("want no-credentials HardError, got %v", err)
	}
	if len(fd.seen) != 0 {
		t.Fatalf("no request may be made without a key: %d sent", len(fd.seen))
	}
}

// TestKeyIsAHeaderNeverAURL proves the credential rides the Authorization
// header and never the URL (so it cannot land in a log line).
func TestKeyIsAHeaderNeverAURL(t *testing.T) {
	const key = "SUPERSECRETKEY"
	fd := &fakeDoer{status: 200, body: tradeFixture}
	c := newClient(fd, 0)
	c.apiKey = key
	f := &fetcher{dataset: "dex-trades", client: c, dw: &spyDexWriter{}}
	if _, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{}); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(fd.seen) != 1 {
		t.Fatalf("expected one request, got %d", len(fd.seen))
	}
	req := fd.seen[0]
	if strings.Contains(req.URL.String(), key) {
		t.Fatalf("the key must not be in the URL: %s", req.URL.String())
	}
	if req.Header.Get("Authorization") != "Bearer "+key {
		t.Fatalf("the key must ride the Authorization header in the documented Bearer form, got %q", req.Header.Get("Authorization"))
	}
}

// TestKeyNeverLeaksIntoError proves a failure path does not echo the key.
func TestKeyNeverLeaksIntoError(t *testing.T) {
	const key = "SUPERSECRETKEY"
	c := newClient(&fakeDoer{status: 500, body: `{"error":"boom"}`}, 0)
	c.apiKey = key
	f := &fetcher{dataset: "dex-trades", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{})
	if err == nil {
		t.Fatal("500 must be a HardError")
	}
	if strings.Contains(err.Error(), key) {
		t.Fatalf("error leaked the key: %s", err.Error())
	}
}

// TestGraphQLErrorsWith200IsFailure proves the 200-with-errors envelope fails.
func TestGraphQLErrorsWith200IsFailure(t *testing.T) {
	body := `{"errors":[{"message":"bad query"}],"data":null}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.apiKey = "k"
	f := &fetcher{dataset: "dex-trades", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "graphql" {
		t.Fatalf("want graphql HardError, got %v", err)
	}
}

// TestNilWriterFailsLoud proves the dataset does not no-op without a port.
func TestNilWriterFailsLoud(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "{}"}, 0)
	c.apiKey = "k"
	f := &fetcher{dataset: "dex-trades", client: c}
	if _, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "bitquery", Dataset: "dex-trades", Subject: seedPool,
	}, spyWriter{}); err == nil {
		t.Fatal("nil writer must fail loudly")
	}
}

// TestJobsGatedOnCredentials proves the paid-indexer seed is DISABLED without a
// key.
func TestJobsGatedOnCredentials(t *testing.T) {
	m := NewModule(nil, &spyDexWriter{})
	m.client.apiKey = ""
	for _, j := range m.Jobs() {
		if j.Enabled {
			t.Fatalf("job %+v must be disabled without a key", j)
		}
	}
	m.client.apiKey = "k"
	for _, j := range m.Jobs() {
		if !j.Enabled {
			t.Fatalf("job %+v must be enabled with a key + writer", j)
		}
	}
	if len(m.Fetchers()) != 1 {
		t.Fatalf("fetchers %v", m.Fetchers())
	}
}

// TestWriterClassAgreesWithClassify pins the write-side class against canon.
func TestWriterClassAgreesWithClassify(t *testing.T) {
	got, ok := canon.ClassifyProvider(providerName)
	if !ok {
		t.Fatalf("%q is not classified in canon", providerName)
	}
	if string(got.Tier) != "S2" || got.Type != sourceType {
		t.Fatalf("canon says %s/%s, bitquery writes S2/%s", got.Tier, got.Type, sourceType)
	}
}

// TestParseTimeForms proves the block-time parser accepts the shapes Bitquery
// emits and refuses garbage.
func TestParseTimeForms(t *testing.T) {
	if _, err := parseTime("2026-10-12T06:00:00Z"); err != nil {
		t.Fatalf("RFC3339: %v", err)
	}
	if _, err := parseTime("1760000000"); err != nil {
		t.Fatalf("unix seconds: %v", err)
	}
	if _, err := parseTime("not a time"); err == nil {
		t.Fatal("garbage must not parse")
	}
}
