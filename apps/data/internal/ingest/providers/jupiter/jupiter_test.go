package jupiter

import (
	"context"
	"io"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file is the offline contract test plan §41/§52 requires of every
// provider: a canned upstream body through the adapter to a canonical result,
// no network. The two defects it guards are the ones the live run exposed — the
// fabricated decimals default and the legs that carried the FULL input on every
// hop.

type fakeDoer struct {
	status int
	body   string
	seen   []string
}

// bigFromString is a test helper: a base-10 *big.Int from a string.
func bigFromString(s string) *big.Int {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("bad big int literal " + s)
	}
	return n
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

// spyWriter satisfies canon.Writer (no-ops) so the fetcher is exercised without
// a database.
type spyWriter struct{}

func (spyWriter) UpsertAssets(context.Context, []canon.Asset) (int, error)           { return 0, nil }
func (spyWriter) UpsertChains(context.Context, []canon.Chain) (int, error)           { return 0, nil }
func (spyWriter) UpsertVenues(context.Context, []canon.Venue) (int, error)           { return 0, nil }
func (spyWriter) UpsertInstruments(context.Context, []canon.Instrument) (int, error) { return 0, nil }
func (spyWriter) UpsertProtocols(context.Context, []canon.Protocol) (int, error)     { return 0, nil }
func (spyWriter) UpsertSeries(context.Context, []canon.SeriesMeta) (int, error)      { return 0, nil }
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

// spyDexWriter records the quote it was handed.
type spyDexWriter struct{ quotes []canon.RouteQuote }

func (w *spyDexWriter) WriteDexRouteQuotes(_ context.Context, rows []canon.RouteQuote) (int, int, error) {
	w.quotes = append(w.quotes, rows...)
	return len(rows), 0, nil
}

func (w *spyDexWriter) UpsertDexDeployments(context.Context, []canon.DexDeployment) (int, error) {
	return 0, nil
}
func (w *spyDexWriter) UpsertPoolTokens(context.Context, []canon.PoolToken) (int, error) {
	return 0, nil
}
func (w *spyDexWriter) WriteDexSwaps(context.Context, []canon.Swap) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexCandles(context.Context, []canon.DexCandle) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexLiquiditySnapshots(context.Context, []canon.DexLiquiditySnapshot) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexMarketSnapshots(context.Context, []canon.DexMarketSnapshot) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexLiquidityPositions(context.Context, []canon.DexLiquidityPosition) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexWalletActivity(context.Context, []canon.WalletActivity) (int, int, error) {
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

const quoteFixture = `{
	"inputMint":"So11111111111111111111111111111111111111112",
	"inAmount":"1000000000",
	"outputMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
	"outAmount":"110926307",
	"otherAmountThreshold":"110371675",
	"priceImpactPct":"0",
	"routePlan":[
		{"percent":60,"swapInfo":{"ammKey":"POOL_A","label":"Raydium","feeAmount":"1500000","feeMint":"So11111111111111111111111111111111111111112"}},
		{"percent":40,"swapInfo":{"ammKey":"POOL_B","label":"Orca","feeAmount":"1000000","feeMint":"So11111111111111111111111111111111111111112"}}
	]
}`

// TestQuoteExactDecimalsAndLegs is the contract test for the two live defects:
// the amounts normalize with the mint's REAL decimals (9/6, never 0), and each
// route leg carries its percent share rather than the whole input.
func TestQuoteExactDecimalsAndLegs(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: quoteFixture}, 0)
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "quote", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "jupiter", Dataset: "quote", Subject: defaultQuoteSubject,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 1 {
		t.Fatalf("result %+v", res)
	}
	if len(dw.quotes) != 1 {
		t.Fatalf("quotes %+v", dw.quotes)
	}
	q := dw.quotes[0]
	// The decimals fix: 1000000000 lamports @ 9 decimals = 1 SOL, not 1e9.
	if q.AmountIn.Decimals != 9 || q.AmountIn.Normalized().String() != "1" {
		t.Fatalf("in amount: decimals=%d normalized=%s (want 9 / 1)",
			q.AmountIn.Decimals, q.AmountIn.Normalized().String())
	}
	if q.AmountOut.Decimals != 6 || q.AmountOut.Normalized().String() != "110.926307" {
		t.Fatalf("out amount: decimals=%d normalized=%s (want 6 / 110.926307)",
			q.AmountOut.Decimals, q.AmountOut.Normalized().String())
	}
	// The legs fix: percent shares, both sides populated, never the full input.
	if len(q.Legs) != 2 {
		t.Fatalf("legs: %+v", q.Legs)
	}
	if q.Legs[0].AmountIn.Normalized().String() != "0.6" {
		t.Fatalf("leg0 in = %s (want 0.6 of 1 SOL)", q.Legs[0].AmountIn.Normalized().String())
	}
	if q.Legs[0].AmountOut.Normalized().String() != "66.555784" {
		t.Fatalf("leg0 out = %s", q.Legs[0].AmountOut.Normalized().String())
	}
	if q.Legs[1].AmountIn.Normalized().String() != "0.4" {
		t.Fatalf("leg1 in = %s", q.Legs[1].AmountIn.Normalized().String())
	}
	if q.Legs[0].Sources[0].PoolID == "" || q.Legs[0].Sources[0].ChainID == "" {
		t.Fatalf("leg source: %+v", q.Legs[0].Sources)
	}
	if q.Provenance.Tier != canon.TierAggregator || q.Provenance.SourceType != "aggregator" {
		t.Fatalf("provenance %+v", q.Provenance)
	}
}

// TestQuoteUnknownMintFailsLoud proves the never-fake rule: a mint with no known
// decimals is a HardError, never a silent 0.
func TestQuoteUnknownMintFailsLoud(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: quoteFixture}, 0)
	f := &fetcher{dataset: "quote", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "jupiter", Dataset: "quote",
		Subject: "UNKNOWNMINT111111111111111111111111111111:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1000",
	}, spyWriter{})
	if err == nil {
		t.Fatal("unknown mint must fail loudly, not assume 0 decimals")
	}
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

// TestQuoteNilWriterFailsLoud proves the dataset refuses to run with no port.
func TestQuoteNilWriterFailsLoud(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: quoteFixture}, 0)
	f := &fetcher{dataset: "quote", client: c}
	if _, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "jupiter", Dataset: "quote", Subject: defaultQuoteSubject,
	}, spyWriter{}); err == nil {
		t.Fatal("nil writer must fail loudly")
	}
}

// TestQuoteStatusErrorIsTyped proves a non-2xx is a status HardError.
func TestQuoteStatusErrorIsTyped(t *testing.T) {
	c := newClient(&fakeDoer{status: 429, body: `{"error":"rate limited"}`}, 0)
	f := &fetcher{dataset: "quote", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "jupiter", Dataset: "quote", Subject: defaultQuoteSubject,
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 429 {
		t.Fatalf("want status 429 HardError, got %v", err)
	}
}

// TestTokensUpsertsAssets proves the tokens dataset maps the list to canonical
// assets plus the provider-symbol map, skipping rows missing address/symbol.
func TestTokensUpsertsAssets(t *testing.T) {
	body := `[
		{"address":"mintA","symbol":"AAA","name":"Alpha","decimals":9},
		{"address":"","symbol":"BBB","decimals":6},
		{"address":"mintC","symbol":"","decimals":6},
		{"address":"mintD","symbol":"DDD","name":"Delta","decimals":6}
	]`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	f := &fetcher{dataset: "tokens", client: c}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "jupiter", Dataset: "tokens", Subject: chainSolana,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsRejected != 2 {
		t.Fatalf("want 2 rejected (empty address/symbol), got %+v", res)
	}
}

// TestJobsSeeded proves the quote job is enabled and its subject parses with the
// env-independent default (no API key needed on the keyless tier).
func TestJobsSeeded(t *testing.T) {
	m := NewModule(nil, &spyDexWriter{})
	if m.Provider() != "jupiter" {
		t.Fatalf("provider %q", m.Provider())
	}
	var quote, tokens bool
	for _, j := range m.Jobs() {
		switch j.Dataset {
		case "quote":
			quote = j.Enabled && j.Schedule == 30*time.Second
			if _, _, _, ok := splitQuoteSubject(j.Subject); !ok {
				t.Fatalf("quote subject %q does not parse", j.Subject)
			}
		case "tokens":
			tokens = j.Enabled
		}
	}
	if !quote || !tokens {
		t.Fatalf("jobs: quote=%v tokens=%v", quote, tokens)
	}
	if len(m.Fetchers()) != 2 {
		t.Fatalf("fetchers: %v", m.Fetchers())
	}
}

// TestLegShareExactness pins the helper directly: exact scaling, and an absent
// share for a zero/out-of-range percent rather than a fabricated 0.
func TestLegShareExactness(t *testing.T) {
	total, err := canon.NewTokenAmount(bigFromString("1000000000"), 9)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := legShare(total, 60)
	if !ok || got.Normalized().String() != "0.6" {
		t.Fatalf("60%%: %v %v", got, ok)
	}
	if _, ok := legShare(total, 0); ok {
		t.Fatal("0 percent must yield no share")
	}
	if _, ok := legShare(total, 101); ok {
		t.Fatal(">100 percent must yield no share")
	}
	if _, ok := legShare(canon.TokenAmount{}, 50); ok {
		t.Fatal("absent raw must yield no share")
	}
}
