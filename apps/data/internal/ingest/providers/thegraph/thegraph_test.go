package thegraph

import (
	"context"
	"io"
	"math/big"
	"net/http"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file is the offline contract test plan §41/§52 requires: a canned
// subgraph envelope through the adapter to canonical rows, no network. It pins
// the three mapping hazards Uniswap-v3-style subgraph schemas create:
//
//  1. the pool-perspective SIGN (positive = the taker's input),
//  2. the BigDecimal amounts that must be re-scaled by the POOL token decimals
//     (never read off the swap, which has no decimals field), and
//  3. the block cursor that must not skip a boundary block.
//
// It also pins the credential discipline (the subgraph URL is the secret).

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

type spyDexWriter struct {
	swaps   []canon.Swap
	markets []canon.DexMarketSnapshot
}

func (w *spyDexWriter) WriteDexSwaps(_ context.Context, r []canon.Swap) (int, int, error) {
	w.swaps = append(w.swaps, r...)
	return len(r), 0, nil
}
func (w *spyDexWriter) WriteDexMarketSnapshots(_ context.Context, r []canon.DexMarketSnapshot) (int, int, error) {
	w.markets = append(w.markets, r...)
	return len(r), 0, nil
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

// swapFixture is a REAL Uniswap-v3 subgraph shape: token0/token1 (with their
// decimals) hang off the POOL, and amount0/amount1 are pool-perspective
// BigDecimal strings in token units.
const swapFixture = `{"data":{"swaps":[
	{"id":"s1","logIndex":"7","timestamp":"1700000000",
	 "amount0":"1","amount1":"-2345.678901","amountUSD":"2345.678901",
	 "transaction":{"id":"0xtx1","blockNumber":"21000000","timestamp":"1700000000"},
	 "pool":{"token0":{"id":"0xWETH","symbol":"WETH","decimals":"18"},
	         "token1":{"id":"0xUSDC","symbol":"USDC","decimals":"6"}}},
	{"id":"s2","logIndex":"9","timestamp":"1700000060",
	 "amount0":"-0.5","amount1":"1000.5","amountUSD":"1000.5",
	 "transaction":{"id":"0xtx2","blockNumber":"21000050","timestamp":"1700000060"},
	 "pool":{"token0":{"id":"0xWETH","symbol":"WETH","decimals":"18"},
	         "token1":{"id":"0xUSDC","symbol":"USDC","decimals":"6"}}}
]}}`

// TestSwapsPositiveIsTakerInput pins the direction hazard: amount0 POSITIVE
// means the taker SENT token0 (input). Reading the sign backwards inverts every
// trade, and the second row proves the direction flips per swap.
func TestSwapsPositiveIsTakerInput(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: swapFixture}, 0)
	c.baseURL = "https://gateway.example/subgraphs/x"
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "swaps", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "thegraph", Dataset: "swaps", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 2 {
		t.Fatalf("result %+v", res)
	}
	// Row 1: amount0 positive -> WETH IN (1.0), USDC OUT (2345.678901).
	s := dw.swaps[0]
	if s.AmountIn.Decimals != 18 || s.AmountIn.Normalized().String() != "1" {
		t.Fatalf("swap1 in: %d/%s (want 18/1 WETH)", s.AmountIn.Decimals, s.AmountIn.Normalized().String())
	}
	if s.AmountOut.Decimals != 6 || s.AmountOut.Normalized().String() != "2345.678901" {
		t.Fatalf("swap1 out: %d/%s", s.AmountOut.Decimals, s.AmountOut.Normalized().String())
	}
	// Row 2: amount1 positive -> USDC IN (1000.5), WETH OUT (0.5) — the flip.
	s2 := dw.swaps[1]
	if s2.AmountIn.Decimals != 6 || s2.AmountIn.Normalized().String() != "1000.5" {
		t.Fatalf("swap2 in: %d/%s", s2.AmountIn.Decimals, s2.AmountIn.Normalized().String())
	}
	if s2.AmountOut.Decimals != 18 || s2.AmountOut.Normalized().String() != "0.5" {
		t.Fatalf("swap2 out: %d/%s", s2.AmountOut.Decimals, s2.AmountOut.Normalized().String())
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

// TestAmountsScaledBySameDecimalsProveLegIsIndexed is the regression for a real
// defect: when both tokens share a decimals exponent, a "first leg that scales"
// search silently pairs token0's magnitude with token1's decimals. This fixture
// uses 6/6 decimals where the two amounts are deliberately different magnitudes,
// so picking the wrong leg is visible.
func TestAmountsScaledBySameDecimalsProveLegIsIndexed(t *testing.T) {
	body := `{"data":{"swaps":[
		{"id":"s","logIndex":"1","timestamp":"1700000000",
		 "amount0":"111.111111","amount1":"-222.222222","amountUSD":"222.222222",
		 "transaction":{"id":"0xtx","blockNumber":"100","timestamp":"1700000000"},
		 "pool":{"token0":{"id":"0xA","decimals":"6"},"token1":{"id":"0xB","decimals":"6"}}}
	]}}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.baseURL = "https://gateway.example/x"
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "swaps", client: c, dw: dw}
	if _, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "thegraph", Dataset: "swaps", Subject: seedPool,
	}, spyWriter{}); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	s := dw.swaps[0]
	if s.AmountIn.RawString() != "111111111" {
		t.Fatalf("input raw = %s (want 111111111, i.e. the POSITIVE leg)", s.AmountIn.RawString())
	}
	if s.AmountOut.RawString() != "222222222" {
		t.Fatalf("output raw = %s (want 222222222, i.e. the NEGATIVE leg)", s.AmountOut.RawString())
	}
}

// TestSubUnitPrecisionRejected proves an amount with more fractional digits than
// the token can hold is rejected, never silently rounded.
func TestSubUnitPrecisionRejected(t *testing.T) {
	body := `{"data":{"swaps":[
		{"id":"s","logIndex":"1","timestamp":"1700000000",
		 "amount0":"1","amount1":"-2345.6789014","amountUSD":"2345.67",
		 "transaction":{"id":"0xtx","blockNumber":"100","timestamp":"1700000000"},
		 "pool":{"token0":{"id":"0xWETH","decimals":"18"},"token1":{"id":"0xUSDC","decimals":"6"}}}
	]}}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.baseURL = "https://gateway.example/x"
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "swaps", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "thegraph", Dataset: "swaps", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 || res.RowsRejected != 1 {
		t.Fatalf("sub-unit precision must be rejected, not rounded: %+v", res)
	}
}

// TestMissingPoolDecimalsRejected proves a swap whose pool tokens carry no
// decimals is refused rather than scaled at a default 0.
func TestMissingPoolDecimalsRejected(t *testing.T) {
	body := `{"data":{"swaps":[
		{"id":"s","logIndex":"1","timestamp":"1700000000",
		 "amount0":"1","amount1":"-2","amountUSD":"2",
		 "transaction":{"id":"0xtx","blockNumber":"100","timestamp":"1700000000"},
		 "pool":{"token0":{"id":"0xA"},"token1":{"id":"0xB"}}}
	]}}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.baseURL = "https://gateway.example/x"
	f := &fetcher{dataset: "swaps", client: c, dw: &spyDexWriter{}}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "thegraph", Dataset: "swaps", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 || res.RowsRejected != 1 {
		t.Fatalf("a missing decimals field must reject, not default to 0: %+v", res)
	}
}

// TestSwapsBothSidesSameSignRejected proves a direction-less swap is a
// rejection, never a guessed input side.
func TestSwapsBothSidesSameSignRejected(t *testing.T) {
	body := `{"data":{"swaps":[
		{"id":"s","logIndex":"1","timestamp":"1700000000","amount0":"1","amount1":"2",
		 "transaction":{"id":"0xtx","blockNumber":"100","timestamp":"1700000000"},
		 "pool":{"token0":{"id":"0xA","decimals":"18"},"token1":{"id":"0xB","decimals":"6"}}}
	]}}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.baseURL = "https://gateway.example/x"
	f := &fetcher{dataset: "swaps", client: c, dw: &spyDexWriter{}}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "thegraph", Dataset: "swaps", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 || res.RowsRejected != 1 {
		t.Fatalf("a direction-less swap must be rejected: %+v", res)
	}
}

// TestNoCredentialsFailsBeforeRequest is the security contract: no subgraph URL
// means a terminal failure BEFORE any network call, so a disabled seed can never
// emit a credential-less request.
func TestNoCredentialsFailsBeforeRequest(t *testing.T) {
	fd := &fakeDoer{status: 200, body: "{}"}
	c := newClient(fd, 0)
	c.baseURL = ""
	f := &fetcher{dataset: "swaps", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "thegraph", Dataset: "swaps", Subject: seedPool,
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "no-credentials" {
		t.Fatalf("want no-credentials HardError, got %v", err)
	}
	if len(fd.seen) != 0 {
		t.Fatalf("no request may be made without a credential: %v", fd.seen)
	}
}

// TestCredentialNeverLeaks proves the subgraph URL (the secret) never reaches an
// error string on a failure path.
func TestCredentialNeverLeaks(t *testing.T) {
	const secret = "https://gateway.thegraph.com/api/SUPERSECRETKEY/subgraphs/id/xyz"
	fd := &fakeDoer{status: 500, body: `{"error":"boom"}`}
	c := newClient(fd, 0)
	c.baseURL = secret
	f := &fetcher{dataset: "swaps", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "thegraph", Dataset: "swaps", Subject: seedPool,
	}, spyWriter{})
	if err == nil {
		t.Fatal("500 must be a HardError")
	}
	if strings.Contains(err.Error(), "SUPERSECRETKEY") {
		t.Fatalf("error leaked the subgraph credential: %s", err.Error())
	}
}

// TestGraphQLErrorsWith200IsFailure proves the subgraph's 200-with-errors
// envelope is a failure, not a silent empty success.
func TestGraphQLErrorsWith200IsFailure(t *testing.T) {
	body := `{"errors":[{"message":"bad query"}],"data":null}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.baseURL = "https://gateway.example/x"
	f := &fetcher{dataset: "swaps", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "thegraph", Dataset: "swaps", Subject: seedPool,
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "graphql" {
		t.Fatalf("want graphql HardError, got %v", err)
	}
}

// TestPoolDayDataMapsExactDecimals proves the daily window maps exactly and
// leaves TVL OUT rather than mislabelling it.
func TestPoolDayDataMapsExactDecimals(t *testing.T) {
	body := `{"data":{"poolDayDatas":[
		{"date":"1700000000","volumeUSD":"9876543.21","feesUSD":"2962.96","tvlUSD":"123456789.01","token0Price":"4001.123456789","token1Price":"0.00024"}
	]}}`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.baseURL = "https://gateway.example/x"
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "pool-day-data", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "thegraph", Dataset: "pool-day-data", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 1 {
		t.Fatalf("result %+v", res)
	}
	m := dw.markets[0]
	if m.Volume24hUSD == nil || m.Volume24hUSD.String() != "9876543.21" {
		t.Fatalf("volume %v", m.Volume24hUSD)
	}
	if m.PriceNative == nil || m.PriceNative.String() != "4001.123456789" {
		t.Fatalf("price %v", m.PriceNative)
	}
	// TVL has no column on the canonical snapshot; it must NOT be smuggled into
	// MarketCapUSD (a different number).
	if m.MarketCapUSD != nil {
		t.Fatalf("TVL must not be mislabelled as market cap: %v", m.MarketCapUSD)
	}
	if m.Provenance.Tier != canon.TierIndexer {
		t.Fatalf("provenance %+v", m.Provenance)
	}
}

// TestNilWriterFailsLoud proves neither dataset silently no-ops without a port.
func TestNilWriterFailsLoud(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "{}"}, 0)
	c.baseURL = "https://gateway.example/x"
	for _, ds := range []string{"swaps", "pool-day-data"} {
		f := &fetcher{dataset: ds, client: c}
		if _, err := f.Fetch(context.Background(), ingest.Job{
			Provider: "thegraph", Dataset: ds, Subject: seedPool,
		}, spyWriter{}); err == nil {
			t.Fatalf("%s: nil writer must fail loudly", ds)
		}
	}
}

// TestJobsGatedOnCredentials proves the paid-subgraph seeds are DISABLED without
// a URL (a missing credential is a disabled seed, not a failing tick).
func TestJobsGatedOnCredentials(t *testing.T) {
	m := NewModule(nil, &spyDexWriter{})
	m.client.baseURL = ""
	for _, j := range m.Jobs() {
		if j.Enabled {
			t.Fatalf("job %+v must be disabled without credentials", j)
		}
	}
	m.client.baseURL = "https://gateway.example/x"
	for _, j := range m.Jobs() {
		if !j.Enabled {
			t.Fatalf("job %+v must be enabled with credentials + writer", j)
		}
	}
	if len(m.Fetchers()) != 2 {
		t.Fatalf("fetchers %v", m.Fetchers())
	}
}

// TestWriterClassAgreesWithClassify pins the write-side class against canon's
// single vocabulary, so the two cannot drift.
func TestWriterClassAgreesWithClassify(t *testing.T) {
	got, ok := canon.ClassifyProvider(providerName)
	if !ok {
		t.Fatalf("%q is not classified in canon", providerName)
	}
	if string(got.Tier) != "S2" || got.Type != sourceType {
		t.Fatalf("canon says %s/%s, thegraph writes S2/%s", got.Tier, got.Type, sourceType)
	}
}

// TestScaledAmountExactness proves the BigDecimal -> raw conversion keeps every
// digit and refuses sub-unit precision.
func TestScaledAmountExactness(t *testing.T) {
	amt, err := scaledAmount("1.234567", 6)
	if err != nil || amt.RawString() != "1234567" {
		t.Fatalf("scaled = %v %v", amt.RawString(), err)
	}
	amt, err = scaledAmount("-0.5", 18)
	if err != nil || amt.RawString() != "500000000000000000" {
		t.Fatalf("scaled = %v %v", amt.RawString(), err)
	}
	if _, err := scaledAmount("0.0000001", 6); err == nil {
		t.Fatal("sub-unit precision must be an error")
	}
	if _, err := scaledAmount("", 6); err == nil {
		t.Fatal("an empty amount must be an error")
	}
	if n := new(big.Int); n.Cmp(big.NewInt(0)) != 0 {
		t.Fatal("sanity")
	}
}
