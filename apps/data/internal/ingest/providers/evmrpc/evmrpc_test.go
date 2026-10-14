package evmrpc

import (
	"context"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file is the offline contract test plan §41/§52 requires: canned JSON-RPC
// responses through the adapter to canonical swaps, no node. It pins the three
// hazards the raw-log path creates:
//
//  1. V2's Swap carries FOUR amount words (in0,in1,out0,out1) that fold to a
//     signed IN-OUT pair — reading only the first two makes a swap look like a
//     mint.
//  2. The event carries no token decimals, so the pool metadata is resolved via
//     eth_call and each leg is scaled at its OWN exponent (18/6) — never 0.
//  3. The block timestamp comes from the header, so EventTime is real, not
//     epoch 0.

type fakeRPC struct {
	// handlers keyed by JSON-RPC method; params-testing is done by the handlers.
	handlers map[string]func(params []any) (any, string) // (result, errorMessage)
	seen     []string
}

func (f *fakeRPC) Do(r *http.Request) (*http.Response, error) {
	b, _ := io.ReadAll(r.Body)
	var req rpcRequest
	_ = json.Unmarshal(b, &req)
	f.seen = append(f.seen, req.Method)
	h, ok := f.handlers[req.Method]
	var body string
	if !ok {
		body = `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}`
	} else if res, em := h(req.Params); em != "" {
		body = `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"` + em + `"}}`
	} else {
		rb, _ := json.Marshal(res)
		body = `{"jsonrpc":"2.0","id":1,"result":` + string(rb) + `}`
	}
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(body)),
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
	swaps []canon.Swap
	pools []canon.PoolToken
}

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
func (w *spyDexWriter) UpsertPoolTokens(_ context.Context, r []canon.PoolToken) (int, error) {
	w.pools = append(w.pools, r...)
	return len(r), nil
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

// Real 20-byte hex addresses for the fixtures (a non-hex "0xWETH" would fail
// the ABI decoder, which is the point).
const (
	addrWETH = "0x1111111111111111111111111111111111111111"
	addrUSDC = "0x2222222222222222222222222222222222222222"
	// addrPool is the SEEDED subject pool: the adapter keys pool identity by the
	// subject address it queried, not by the log's own Address field.
	addrPool = "0x11b815efb8f581194ae79006d24e0d814b7697f6"
)

// word renders a big integer as a 32-byte ABI word (hex, no 0x).
func word(v *big.Int) string { return hexWord(v) }

// addrWord left-pads a 20-byte address to a 32-byte word.
func addrWord(a string) string {
	a = strings.TrimPrefix(a, "0x")
	return strings.Repeat("0", 24) + a
}

// newFakeRPC builds a node stub that answers the pool metadata calls and returns
// the given logs, with a fixed block timestamp.
func newFakeRPC(logs []rawLog, token0, token1 string, dec0, dec1 int64, blockTS string) *fakeRPC {
	return &fakeRPC{handlers: map[string]func([]any) (any, string){
		"eth_getLogs": func([]any) (any, string) { return logs, "" },
		"eth_call": func(params []any) (any, string) {
			call := params[0].(map[string]any)
			to := strings.ToLower(call["to"].(string))
			data := call["data"].(string)
			switch {
			case data == selToken0:
				return "0x" + addrWord(token0), ""
			case data == selToken1:
				return "0x" + addrWord(token1), ""
			case data == selDecimals && to == strings.ToLower(token0):
				return "0x" + word(big.NewInt(dec0)), ""
			case data == selDecimals && to == strings.ToLower(token1):
				return "0x" + word(big.NewInt(dec1)), ""
			}
			return nil, "unexpected eth_call " + data + " to " + to
		},
		"eth_getBlockByNumber": func([]any) (any, string) {
			return map[string]any{"timestamp": blockTS}, ""
		},
		"eth_blockNumber": func([]any) (any, string) {
			return "0x1400080", ""
		},
	}}
}

func (f *fakeRPC) client() *client {
	c := newClient(f, 0)
	c.endpoint = "https://node.example/rpc"
	return c
}

// TestV2SwapFoldsFourWords pins the V2 hazard: the pair Swap folds IN-OUT from
// FOUR words, so reading only the first two is caught. In this fixture token0 is
// WETH (18) and token1 is USDC (6); a taker sells 1 WETH for 2345.5 USDC.
func TestV2SwapFoldsFourWords(t *testing.T) {
	oneWETH := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	usdcOut := big.NewInt(2345500000) // 2345.5 USDC at 6 decimals
	data := "0x" + word(oneWETH) + word(big.NewInt(0)) + word(big.NewInt(0)) + word(usdcOut)
	logs := []rawLog{{
		Address: "0xpool", Topics: []string{topicV2Swap, "0x" + addrWord("0xrouter"), "0x" + addrWord("0xtaker")},
		Data: data, BlockNumber: "0x1400000", TransactionHash: "0xtx", LogIndex: "0x2",
	}}
	f := newFakeRPC(logs, addrWETH, addrUSDC, 18, 6, "0x66000000")
	c := f.client()
	dw := &spyDexWriter{}
	fet := &fetcher{dataset: "pool-logs", client: c, dw: dw}
	res, err := fet.Fetch(context.Background(), ingest.Job{
		Provider: "evmrpc", Dataset: "pool-logs", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 1 {
		t.Fatalf("result %+v", res)
	}
	s := dw.swaps[0]
	// WETH positive (in), USDC negative (out) after the fold.
	if s.AmountIn.Decimals != 18 || s.AmountIn.Normalized().String() != "1" {
		t.Fatalf("in: %d/%s (want 18/1 WETH)", s.AmountIn.Decimals, s.AmountIn.Normalized().String())
	}
	if s.AmountOut.Decimals != 6 || s.AmountOut.Normalized().String() != "2345.5" {
		t.Fatalf("out: %d/%s (want 6/2345.5 USDC)", s.AmountOut.Decimals, s.AmountOut.Normalized().String())
	}
	if s.TokenIn != canon.MintID(canon.KindToken, canon.TokenKey("ethereum", addrWETH)) {
		t.Fatalf("token_in = %s", s.TokenIn)
	}
	// The resolved metadata must also be PERSISTED as pool composition: index 0
	// is token0, 1 is token1, and the reserve is left absent (this read does not
	// return it — a guessed reserve would be fabricated).
	if len(dw.pools) != 2 {
		t.Fatalf("pool composition rows = %d (want 2)", len(dw.pools))
	}
	poolID := canon.MintID(canon.KindPool, canon.PoolKey("ethereum", addrPool))
	byIdx := map[int]canon.PoolToken{}
	for _, pt := range dw.pools {
		if pt.PoolID != poolID {
			t.Fatalf("composition pool_id = %s (want %s)", pt.PoolID, poolID)
		}
		if pt.Reserve != nil {
			t.Fatalf("reserve must be absent, got %v", pt.Reserve)
		}
		byIdx[pt.Index] = pt
	}
	if byIdx[0].TokenID != canon.MintID(canon.KindToken, canon.TokenKey("ethereum", addrWETH)) {
		t.Fatalf("index 0 = %s (want token0 WETH)", byIdx[0].TokenID)
	}
	if byIdx[1].TokenID != canon.MintID(canon.KindToken, canon.TokenKey("ethereum", addrUSDC)) {
		t.Fatalf("index 1 = %s (want token1 USDC)", byIdx[1].TokenID)
	}
	if s.Provenance.Tier != canon.TierBlockchain || s.Provenance.SourceType != "rpc" {
		t.Fatalf("provenance %+v (want S0/rpc)", s.Provenance)
	}
	if s.Provenance.BlockNumber == nil || *s.Provenance.BlockNumber != 0x1400000 {
		t.Fatalf("block %+v", s.Provenance.BlockNumber)
	}
	// EventTime must come from the header, not epoch 0.
	if s.EventTime.Unix() != 0x66000000 {
		t.Fatalf("event_time = %s (want the header timestamp)", s.EventTime)
	}
}

// TestV3SwapSignedAmounts pins the V3 path: amount0/amount1 are int256, the
// positive leg is the input, and the two legs scale at their own exponents.
func TestV3SwapSignedAmounts(t *testing.T) {
	// amount0 = +0.5 WETH (18), amount1 = -1000.25 USDC (6).
	amount0 := new(big.Int).Div(new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil), big.NewInt(2))
	amount1 := new(big.Int).Neg(big.NewInt(1000250000))
	// int256 encoding: a negative word is 2^256 + value.
	amount1Word := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 256), amount1)
	data := "0x" + word(amount0) + word(amount1Word) + word(big.NewInt(1)) + word(big.NewInt(2)) + word(big.NewInt(0))
	logs := []rawLog{{
		Address: "0xpool", Topics: []string{topicV3Swap, "0x" + addrWord("0xrouter"), "0x" + addrWord("0xtaker")},
		Data: data, BlockNumber: "0x1400001", TransactionHash: "0xtxv3", LogIndex: "0x0",
	}}
	f := newFakeRPC(logs, addrWETH, addrUSDC, 18, 6, "0x6600000c")
	c := f.client()
	dw := &spyDexWriter{}
	fet := &fetcher{dataset: "pool-logs", client: c, dw: dw}
	res, err := fet.Fetch(context.Background(), ingest.Job{
		Provider: "evmrpc", Dataset: "pool-logs", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 1 {
		t.Fatalf("result %+v", res)
	}
	s := dw.swaps[0]
	if s.AmountIn.Decimals != 18 || s.AmountIn.Normalized().String() != "0.5" {
		t.Fatalf("in: %d/%s (want 18/0.5 WETH)", s.AmountIn.Decimals, s.AmountIn.Normalized().String())
	}
	if s.AmountOut.Decimals != 6 || s.AmountOut.Normalized().String() != "1000.25" {
		t.Fatalf("out: %d/%s (want 6/1000.25 USDC)", s.AmountOut.Decimals, s.AmountOut.Normalized().String())
	}
}

// TestNoCredentialNoRequest proves no endpoint means a terminal failure before
// any network call.
func TestNoCredentialNoRequest(t *testing.T) {
	f := &fakeRPC{handlers: map[string]func([]any) (any, string){}}
	c := newClient(f, 0)
	c.endpoint = ""
	fet := &fetcher{dataset: "pool-logs", client: c, dw: &spyDexWriter{}}
	_, err := fet.Fetch(context.Background(), ingest.Job{
		Provider: "evmrpc", Dataset: "pool-logs", Subject: seedPool,
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "no-credentials" {
		t.Fatalf("want no-credentials HardError, got %v", err)
	}
	if len(f.seen) != 0 {
		t.Fatalf("no request may be made without an endpoint: %v", f.seen)
	}
}

// TestRPCErrorIsHardError proves a JSON-RPC error object with a 200 status is a
// failure, not an empty success.
func TestRPCErrorIsHardError(t *testing.T) {
	f := &fakeRPC{handlers: map[string]func([]any) (any, string){
		"eth_getLogs": func([]any) (any, string) { return nil, "rate limited" },
	}}
	c := f.client()
	fet := &fetcher{dataset: "pool-logs", client: c, dw: &spyDexWriter{}}
	_, err := fet.Fetch(context.Background(), ingest.Job{
		Provider: "evmrpc", Dataset: "pool-logs", Subject: seedPool,
	}, spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "rpc" {
		t.Fatalf("want rpc HardError, got %v", err)
	}
}

// TestUnknownTopicIsSkipped proves a log the adapter does not model (a transfer)
// is skipped, not rejected.
func TestUnknownTopicIsSkipped(t *testing.T) {
	logs := []rawLog{{
		Address: "0xpool", Topics: []string{topic("Transfer(address,address,uint256)")},
		Data: "0x", BlockNumber: "0x10", TransactionHash: "0xt", LogIndex: "0x0",
	}}
	f := newFakeRPC(logs, addrWETH, addrUSDC, 18, 6, "0x66000000")
	c := f.client()
	dw := &spyDexWriter{}
	fet := &fetcher{dataset: "pool-logs", client: c, dw: dw}
	res, err := fet.Fetch(context.Background(), ingest.Job{
		Provider: "evmrpc", Dataset: "pool-logs", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 || res.RowsRejected != 0 {
		t.Fatalf("an unmodelled log must be skipped: %+v", res)
	}
}

// TestJunkBlockTimeRejected proves a swap whose block time cannot be read is
// rejected rather than written with epoch 0.
func TestJunkBlockTimeRejected(t *testing.T) {
	oneWETH := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	data := "0x" + word(oneWETH) + word(big.NewInt(0)) + word(big.NewInt(0)) + word(big.NewInt(1))
	logs := []rawLog{{
		Address: "0xpool", Topics: []string{topicV2Swap}, Data: data,
		BlockNumber: "0x1400000", TransactionHash: "0xtx", LogIndex: "0x0",
	}}
	f := newFakeRPC(logs, addrWETH, addrUSDC, 18, 6, "not-a-number")
	c := f.client()
	dw := &spyDexWriter{}
	fet := &fetcher{dataset: "pool-logs", client: c, dw: dw}
	res, err := fet.Fetch(context.Background(), ingest.Job{
		Provider: "evmrpc", Dataset: "pool-logs", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 {
		t.Fatalf("a swap without a resolvable time must not be written: %+v", res)
	}
}

// TestNilWriterFailsLoud proves the dataset does not no-op without a port.
func TestNilWriterFailsLoud(t *testing.T) {
	c := newClient(&fakeRPC{handlers: map[string]func([]any) (any, string){}}, 0)
	c.endpoint = "https://node.example/rpc"
	fet := &fetcher{dataset: "pool-logs", client: c}
	if _, err := fet.Fetch(context.Background(), ingest.Job{
		Provider: "evmrpc", Dataset: "pool-logs", Subject: seedPool,
	}, spyWriter{}); err == nil {
		t.Fatal("nil writer must fail loudly")
	}
}

// TestJobsGatedOnCredentials proves the node seed is disabled without an
// endpoint.
func TestJobsGatedOnCredentials(t *testing.T) {
	m := NewModule(nil, &spyDexWriter{})
	m.client.endpoint = ""
	for _, j := range m.Jobs() {
		if j.Enabled {
			t.Fatalf("job %+v must be disabled without an endpoint", j)
		}
	}
	m.client.endpoint = "https://node.example/rpc"
	for _, j := range m.Jobs() {
		if !j.Enabled {
			t.Fatalf("job %+v must be enabled with an endpoint + writer", j)
		}
	}
}

// TestWriterClassAgreesWithClassify pins the write-side class to canon's single
// vocabulary (S0/rpc), so the row and the read-side projection cannot drift.
func TestWriterClassAgreesWithClassify(t *testing.T) {
	got, ok := canon.ClassifyProvider(providerName)
	if !ok {
		t.Fatalf("%q is not classified in canon", providerName)
	}
	if got.Tier != canon.TierBlockchain || got.Type != sourceType {
		t.Fatalf("canon says %s/%s, evmrpc writes S0/%s", got.Tier, got.Type, sourceType)
	}
}

// TestSelectorMatchesSignature proves the hand-computed selectors really are the
// keccak prefixes they claim (a copied literal could drift).
func TestSelectorMatchesSignature(t *testing.T) {
	if selDecimals != "0x313ce567" {
		t.Fatalf("decimals() selector = %s", selDecimals)
	}
	if selToken0 != "0x0dfe1681" {
		t.Fatalf("token0() selector = %s", selToken0)
	}
	if selToken1 != "0xd21220a7" {
		t.Fatalf("token1() selector = %s", selToken1)
	}
}

// TestHexWordsRejectsMalformed proves the ABI decoder refuses junk rather than
// returning a partial read.
func TestHexWordsRejectsMalformed(t *testing.T) {
	if _, err := hexWords("0x123"); err == nil {
		t.Fatal("odd-length hex must fail")
	}
	if _, err := hexWords("0xzz"); err == nil {
		t.Fatal("non-hex must fail")
	}
	w, err := hexWords("0x" + word(big.NewInt(7)))
	if err != nil || len(w) != 1 || w[0].Int64() != 7 {
		t.Fatalf("a single word must decode: %v %v", w, err)
	}
	if ws, err := hexWords("0x"); err != nil || len(ws) != 0 {
		t.Fatalf("empty data is zero words: %v %v", ws, err)
	}
}

// TestInt256Sign proves two's-complement decoding.
func TestInt256Sign(t *testing.T) {
	neg := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(-5))
	if got := signedFromInt256(neg); got.Int64() != -5 {
		t.Fatalf("neg = %s (want -5)", got)
	}
	if got := signedFromInt256(big.NewInt(5)); got.Int64() != 5 {
		t.Fatalf("pos = %s (want 5)", got)
	}
}

// TestAttrHelperNotConfused proves the address extractor takes the low 20 bytes.
func TestAddressExtraction(t *testing.T) {
	topicWord := "0x" + addrWord("0xabcdef0123456789abcdef0123456789abcdef01")
	if got := wordAddress(topicWord); got != "0xabcdef0123456789abcdef0123456789abcdef01" {
		t.Fatalf("address = %s", got)
	}
}

// TestGetLogsWindowIsBounded is the regression for the range-rejection defect:
// a real node rejects an unbounded eth_getLogs range, so the request must ask
// for exactly one bounded window and the cursor must land on that window's end.
func TestGetLogsWindowIsBounded(t *testing.T) {
	oneWETH := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	data := "0x" + word(oneWETH) + word(big.NewInt(0)) + word(big.NewInt(0)) + word(big.NewInt(1))
	// One log inside the window, so RowsWritten proves the window is walked.
	logs := []rawLog{{
		Address: addrPool, Topics: []string{topicV2Swap, "0x" + addrWord("0xrouter"), "0x" + addrWord("0xtaker")},
		Data: data, BlockNumber: "0x64", TransactionHash: "0xtxw", LogIndex: "0x0",
	}}
	f := newFakeRPC(logs, addrWETH, addrUSDC, 18, 6, "0x66000000")
	var gotFrom, gotTo string
	inner := f.handlers["eth_getLogs"]
	f.handlers["eth_getLogs"] = func(params []any) (any, string) {
		call := params[0].(map[string]any)
		gotFrom, _ = call["fromBlock"].(string)
		gotTo, _ = call["toBlock"].(string)
		return inner(params)
	}
	c := f.client()
	dw := &spyDexWriter{}
	fet := &fetcher{dataset: "pool-logs", client: c, dw: dw}
	res, err := fet.Fetch(context.Background(), ingest.Job{
		Provider: "evmrpc", Dataset: "pool-logs", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotTo == "latest" {
		t.Fatalf("toBlock must be a bounded number, got %q", gotTo)
	}
	from, _ := parseUint64(gotFrom)
	to, _ := parseUint64(gotTo)
	if to-from+1 != logWindowBlocks {
		t.Fatalf("window = %d blocks (want %d)", to-from+1, logWindowBlocks)
	}
	// The cursor advances to the WINDOW end, so an empty next window advances
	// instead of re-reading this one forever.
	if cur, ok := res.Next["block"].(float64); !ok || int64(cur) != int64(to) {
		t.Fatalf("cursor = %+v (want the window end %d)", res.Next, to)
	}
}

// TestEmptyWindowStillAdvances proves a window with no swaps moves the cursor
// forward — without it a quiet pool would pin the job on one empty range.
func TestEmptyWindowStillAdvances(t *testing.T) {
	f := newFakeRPC(nil, addrWETH, addrUSDC, 18, 6, "0x66000000")
	c := f.client()
	fet := &fetcher{dataset: "pool-logs", client: c, dw: &spyDexWriter{}}
	res, err := fet.Fetch(context.Background(), ingest.Job{
		Provider: "evmrpc", Dataset: "pool-logs", Subject: seedPool,
	}, spyWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsWritten != 0 {
		t.Fatalf("no logs means no rows: %+v", res)
	}
	if cur, ok := res.Next["block"].(float64); !ok || int64(cur) != logWindowBlocks-1 {
		t.Fatalf("an empty window must still advance the cursor: %+v", res.Next)
	}
}
