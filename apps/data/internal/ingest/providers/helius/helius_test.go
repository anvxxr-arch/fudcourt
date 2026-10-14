package helius

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file is the offline contract test plan §41/§52 requires. It also pins the
// credential discipline the adapter's doc claims: a missing key fails BEFORE any
// request, and no error or recorded URL ever carries the key.

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

type spyDexWriter struct {
	swaps    []canon.Swap
	activity []canon.WalletActivity
}

func (w *spyDexWriter) WriteDexSwaps(_ context.Context, rows []canon.Swap) (int, int, error) {
	w.swaps = append(w.swaps, rows...)
	return len(rows), 0, nil
}
func (w *spyDexWriter) WriteDexWalletActivity(_ context.Context, rows []canon.WalletActivity) (int, int, error) {
	w.activity = append(w.activity, rows...)
	return len(rows), 0, nil
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
func (w *spyDexWriter) WriteDexMarketSnapshots(context.Context, []canon.DexMarketSnapshot) (int, int, error) {
	return 0, 0, nil
}
func (w *spyDexWriter) WriteDexLiquidityPositions(context.Context, []canon.DexLiquidityPosition) (int, int, error) {
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

const swapFixture = `[
	{"signature":"sig1","slot":100,"timestamp":1700000000,"type":"SWAP","feePayer":"wallet1",
	 "events":{"swap":{
		"tokenInputs":[{"userAccount":"wallet1","mint":"So11111111111111111111111111111111111111112",
			"rawTokenAmount":{"tokenAmount":"1000000000","decimals":9}}],
		"tokenOutputs":[{"userAccount":"wallet1","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			"rawTokenAmount":{"tokenAmount":"110926307","decimals":6}}]}}},
	{"signature":"sig2","slot":101,"timestamp":1700000060,"type":"TRANSFER","feePayer":"wallet1",
	 "events":{}},
	{"signature":"","slot":102,"timestamp":1700000120,"type":"SWAP","feePayer":"wallet1",
	 "events":{"swap":{"tokenInputs":[],"tokenOutputs":[]}}}
]`

// nativeSwapFixture is the shape the LIVE Helius API actually returns for most
// Solana swaps: ONE token side and ONE native SOL side, never two token sides.
// Copied from a real response to
// /v0/addresses/{mint}/transactions?type=SWAP, including the native leg's
// fields verbatim ({"account":…,"amount":<lamports>}).
//
// The fixture above was written from the adapter's own assumption (both token
// sides present), which is why the adapter could pass its tests while rejecting
// every swap the live API returned. These two cases are the ones that
// distinguish a working adapter from a self-consistent one.
const nativeSwapFixture = `[
	{"signature":"nsig1","slot":200,"timestamp":1700000500,"type":"SWAP","feePayer":"walletN",
	 "events":{"swap":{
		"tokenInputs":[],
		"tokenOutputs":[{"userAccount":"walletN","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			"rawTokenAmount":{"tokenAmount":"91389917","decimals":6}}],
		"nativeInput":{"account":"GFLe382LpAv7ZTpbpsT3xsL9J6M4XkzjZuVgKwUyYVp2","amount":"500000"}}}},
	{"signature":"nsig2","slot":201,"timestamp":1700000560,"type":"SWAP","feePayer":"walletN",
	 "events":{"swap":{
		"tokenInputs":[{"userAccount":"walletN","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			"rawTokenAmount":{"tokenAmount":"50000000","decimals":6}}],
		"tokenOutputs":[],
		"nativeOutput":{"account":"2R8nPz6cxhGm6YW9YKijZKPNyLdP8m23sgDfqGAwJUcp","amount":"91389917"}}}},
	{"signature":"nsig3","slot":202,"timestamp":1700000620,"type":"SWAP","feePayer":"walletN",
	 "events":{"swap":{"tokenInputs":[],"tokenOutputs":[]}}}
]`

// TestNativeLegSwapsAreMapped is the regression for the live-coverage defect:
// a swap whose SOL side arrives as nativeInput/nativeOutput must map, using the
// wrapped-SOL mint (the same identity the jupiter adapter keys at 9 decimals)
// and lamports as the exact raw amount. A swap with NO leg on a side must still
// be rejected rather than fabricated.
func TestNativeLegSwapsAreMapped(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: nativeSwapFixture}, 0)
	c.apiKeys = []string{"test-key"}
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "swaps", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "helius", Dataset: "swaps", Subject: seedAddress,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 2 || res.RowsRejected != 1 {
		t.Fatalf("result %+v (want 2 written, 1 rejected — the leg-less swap)", res)
	}
	usdc := tokenID("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	wsol := tokenID(wsolMint)

	// nsig1: SOL in (native), USDC out.
	in := dw.swaps[0]
	if in.TxHash != "nsig1" {
		t.Fatalf("swap order: %+v", in.TxHash)
	}
	if in.TokenIn != wsol {
		t.Fatalf("token in %q (want the wrapped-SOL token id %q)", in.TokenIn, wsol)
	}
	if in.TokenOut != usdc {
		t.Fatalf("token out %q (want USDC %q)", in.TokenOut, usdc)
	}
	if in.AmountIn.Decimals != 9 || in.AmountIn.Normalized().String() != "0.0005" {
		t.Fatalf("native in: %d/%s (want 9/0.0005, from 500000 lamports)",
			in.AmountIn.Decimals, in.AmountIn.Normalized().String())
	}
	if in.AmountOut.Normalized().String() != "91.389917" {
		t.Fatalf("token out amount %s", in.AmountOut.Normalized().String())
	}
	// The trader falls back to the native side's account when the token side is
	// absent, so a native-leg swap still carries its wallet.
	if in.Trader != "walletN" {
		t.Fatalf("trader %q", in.Trader)
	}

	// nsig2: USDC in, SOL out (native).
	out := dw.swaps[1]
	if out.TokenIn != usdc || out.TokenOut != wsol {
		t.Fatalf("nsig2 legs: in=%q out=%q", out.TokenIn, out.TokenOut)
	}
	if out.AmountOut.Decimals != 9 || out.AmountOut.Normalized().String() != "0.091389917" {
		t.Fatalf("native out: %d/%s", out.AmountOut.Decimals, out.AmountOut.Normalized().String())
	}
}

// TestSwapsExactAmountsAndCursor proves the swap mapping is exact (raw + decimals
// preserved, never a float), that a non-swap and a signature-less tx are counted
// as rejections rather than fabricated rows, and that the cursor carries the last
// signature for the next page.
func TestSwapsExactAmountsAndCursor(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: swapFixture}, 0)
	c.apiKeys = []string{"test-key"}
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "swaps", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "helius", Dataset: "swaps", Subject: seedAddress,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 1 || res.RowsRejected != 2 {
		t.Fatalf("result %+v (want 1 written, 2 rejected)", res)
	}
	if len(dw.swaps) != 1 {
		t.Fatalf("swaps %+v", dw.swaps)
	}
	s := dw.swaps[0]
	if s.AmountIn.Decimals != 9 || s.AmountIn.Normalized().String() != "1" {
		t.Fatalf("amount in: %d/%s", s.AmountIn.Decimals, s.AmountIn.Normalized().String())
	}
	if s.AmountOut.Decimals != 6 || s.AmountOut.Normalized().String() != "110.926307" {
		t.Fatalf("amount out: %d/%s", s.AmountOut.Decimals, s.AmountOut.Normalized().String())
	}
	if s.TxHash != "sig1" || s.BlockNumber == nil || *s.BlockNumber != 100 {
		t.Fatalf("swap ids: %+v", s)
	}
	if s.Provenance.Tier != canon.TierIndexer || s.Provenance.SourceType != "indexer" {
		t.Fatalf("provenance %+v", s.Provenance)
	}
	if res.Next["before"] != "sig2" {
		t.Fatalf("cursor %+v (want last signature sig2)", res.Next)
	}
}

// TestAllEmptySignaturesKeepTheCursor is the regression for an
// infinite-pagination defect: a page where NO signature is usable must return
// the job's cursor UNCHANGED. Returning {"before": ""} reads back as absent,
// and returning nil wipes the stored column (MarkSuccess writes SQL NULL) —
// either way the next page restarts from the beginning.
//
// A first run with no cursor at all has nothing to preserve, so it persists an
// EMPTY cursor (the fetcher normalizes nil -> {}), which reads back as "" and
// pages from the top — correct, since there is no earlier boundary. The second
// case below pins that, and pins that no spurious "before" key is invented.
func TestAllEmptySignaturesKeepTheCursor(t *testing.T) {
	// Two transactions that mapSwap rejects, both signature-less.
	body := `[
		{"signature":"","slot":1,"timestamp":1700000000,"transaction":{"signatures":[]}},
		{"signature":"","slot":2,"timestamp":1700000001,"transaction":{"signatures":[]}}
	]`
	c := newClient(&fakeDoer{status: 200, body: body}, 0)
	c.apiKeys = []string{"k"}
	f := &fetcher{dataset: "swaps", client: c, dw: &spyDexWriter{}}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "helius", Dataset: "swaps", Subject: seedAddress,
		Cursor: ingest.Cursor{"before": "prior-sig"},
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.Next == nil {
		t.Fatal("nil Next wipes the stored cursor; it must be returned unchanged")
	}
	if res.Next["before"] != "prior-sig" {
		t.Fatalf("cursor %+v (want the incoming cursor preserved, never \"\")", res.Next)
	}
	if len(res.Next) != 1 {
		t.Fatalf("the cursor must carry exactly the incoming key, got %+v", res.Next)
	}

	// No incoming cursor: nothing to preserve, and no "before" key may be
	// invented (an empty "before" is what caused the restart).
	c2 := newClient(&fakeDoer{status: 200, body: body}, 0)
	c2.apiKeys = []string{"k"}
	f2 := &fetcher{dataset: "swaps", client: c2, dw: &spyDexWriter{}}
	res2, err := f2.Fetch(context.Background(), ingest.Job{
		Provider: "helius", Dataset: "swaps", Subject: seedAddress,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch (no cursor): %v", err)
	}
	if res2.Next == nil {
		t.Fatal("Next must not be nil (the engine writes a nil Cursor as SQL NULL: jobstore.go keeps cur nil)")
	}
	if _, ok := res2.Next["before"]; ok {
		t.Fatalf("no \"before\" key may be invented on an all-empty page, got %+v", res2.Next)
	}
}

// TestNoCredentialsFailsBeforeRequest is the security contract: with no key the
// fetch must fail terminally WITHOUT touching the network, so a disabled seed can
// never leak a malformed request.
func TestNoCredentialsFailsBeforeRequest(t *testing.T) {
	fd := &fakeDoer{status: 200, body: "[]"}
	c := newClient(fd, 0)
	c.apiKeys = nil
	f := &fetcher{dataset: "swaps", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "helius", Dataset: "swaps", Subject: seedAddress,
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "no-credentials" {
		t.Fatalf("want no-credentials HardError, got %v", err)
	}
	if len(fd.seen) != 0 {
		t.Fatalf("no request may be made without a key; got %v", fd.seen)
	}
}

// TestKeyNeverLeaksIntoError is the secret-hygiene contract: a failing request
// must redact the key from the stored URL, and the seed jobs must be seeded
// DISABLED with no credentials.
func TestKeyNeverLeaksIntoError(t *testing.T) {
	const secret = "SUPER-SECRET-KEY"
	fd := &fakeDoer{status: 500, body: `{"error":"boom"}`}
	c := newClient(fd, 0)
	c.apiKeys = []string{secret}
	f := &fetcher{dataset: "swaps", client: c, dw: &spyDexWriter{}}
	_, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "helius", Dataset: "swaps", Subject: seedAddress,
	}, spyWriter{})
	if err == nil {
		t.Fatal("500 must be a HardError")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaked the api key: %s", err.Error())
	}
	if he, ok := err.(*HardError); ok && he.URL != "" && strings.Contains(he.URL, secret) {
		t.Fatalf("stored URL leaked the api key: %s", he.URL)
	}
	// Jobs gating: no key means the seed jobs are disabled.
	m := NewModule(nil, &spyDexWriter{})
	m.client.apiKeys = nil
	for _, j := range m.Jobs() {
		if j.Enabled {
			t.Fatalf("job %+v must be disabled without credentials", j)
		}
	}
	m.client.apiKeys = []string{"k"}
	for _, j := range m.Jobs() {
		if !j.Enabled {
			t.Fatalf("job %+v must be enabled with credentials", j)
		}
	}
}

// TestWalletActivityMapsSwap proves the wallet dataset carries the moved token
// TestKeysRoundRobin proves the multi-key rotation: consecutive requests use
// successive keys, so a burst spreads over several rate limits instead of
// draining one key. It also proves rotation is REAL (a "first key always wins"
// implementation would still pass a single-key test) and that duplicates
// collapse, so a repeated key cannot be selected twice in a row.
func TestKeysRoundRobin(t *testing.T) {
	fd := &fakeDoer{status: 200, body: "[]"}
	c := newClient(fd, 0)
	c.apiKeys = []string{"key-A", "key-B", "key-C"}
	for i := 0; i < 6; i++ {
		f := &fetcher{dataset: "swaps", client: c, dw: &spyDexWriter{}}
		if _, err := f.Fetch(context.Background(), ingest.Job{
			Provider: "helius", Dataset: "swaps", Subject: seedAddress,
		}, spyWriter{}); err != nil {
			t.Fatalf("fetch %d: %v", i, err)
		}
	}
	if len(fd.seen) != 6 {
		t.Fatalf("requests %d (want 6)", len(fd.seen))
	}
	want := []string{"key-A", "key-B", "key-C"}
	for i, u := range fd.seen {
		if !strings.Contains(u, "api-key="+want[i%3]) {
			t.Fatalf("request %d used %s (want %s)", i, u, want[i%3])
		}
	}

	// A duplicated or blank entry must not consume a rotation slot.
	t.Setenv(APIKeysEnv, " dup , ,dup, second ")
	t.Setenv(APIKeyEnv, "second")
	if got := keysFromEnv(); len(got) != 2 || got[0] != "dup" || got[1] != "second" {
		t.Fatalf("keysFromEnv %q (want [dup second])", got)
	}
}

// and amount plus the swap's pool/token ids.
func TestWalletActivityMapsSwap(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: swapFixture}, 0)
	c.apiKeys = []string{"test-key"}
	dw := &spyDexWriter{}
	f := &fetcher{dataset: "wallet", client: c, dw: dw}
	res, err := f.Fetch(context.Background(), ingest.Job{
		Provider: "helius", Dataset: "wallet", Subject: seedAddress,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	// sig1 and sig2 have signatures; sig3 is empty -> 2 written, 1 rejected.
	if res.RowsWritten != 2 || res.RowsRejected != 1 {
		t.Fatalf("result %+v", res)
	}
	swapAct := dw.activity[0]
	if swapAct.PoolID == "" || swapAct.TokenID == "" || swapAct.Amount == nil {
		t.Fatalf("swap activity missing token/pool/amount: %+v", swapAct)
	}
	if swapAct.Amount.Normalized().String() != "1" {
		t.Fatalf("activity amount %s", swapAct.Amount.Normalized().String())
	}
	if swapAct.Provenance.Tier != canon.TierIndexer {
		t.Fatalf("provenance %+v", swapAct.Provenance)
	}
}

// TestNilWriterFailsLoud proves neither dataset silently no-ops without a port.
func TestNilWriterFailsLoud(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: swapFixture}, 0)
	c.apiKeys = []string{"test-key"}
	for _, ds := range []string{"swaps", "wallet"} {
		f := &fetcher{dataset: ds, client: c}
		if _, err := f.Fetch(context.Background(), ingest.Job{
			Provider: "helius", Dataset: ds, Subject: seedAddress,
		}, spyWriter{}); err == nil {
			t.Fatalf("%s: nil writer must fail loudly", ds)
		}
	}
}

// TestJobsSeeded proves the seeded subjects parse and carry the backward cursor
// shape.
func TestJobsSeeded(t *testing.T) {
	m := NewModule(nil, &spyDexWriter{})
	m.client.apiKeys = []string{"k"}
	if m.Provider() != "helius" || !m.HasCredentials() {
		t.Fatalf("provider=%q creds=%v", m.Provider(), m.HasCredentials())
	}
	if len(m.Jobs()) != 2 {
		t.Fatalf("jobs %+v", m.Jobs())
	}
	for _, j := range m.Jobs() {
		if j.Subject != seedAddress || j.Schedule != time.Hour {
			t.Fatalf("job %+v", j)
		}
	}
	if len(m.Fetchers()) != 2 {
		t.Fatalf("fetchers %v", m.Fetchers())
	}
}
