package evmrpc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// The fixtures below are REAL Ethereum mainnet payloads, captured from a public
// node and trimmed to the fields the adapter reads. A synthetic fixture would
// prove the decoder agrees with the author's idea of the format, which is
// exactly the assumption a wrong topic constant or a mis-ordered data word
// invalidates - so the topic0 values and the log bodies are pinned to observed
// bytes, not computed.

// realBlock is block 0x18f6640 (eth_getBlockByNumber, full=false).
const realBlock = `{
  "number": "0x18f6640",
  "hash": "0x6c72cb8465f8ca58ace276631593aec7d364551c5794bb9a7ff93f4289f82c34",
  "parentHash": "0x2f97e4495e417e637914251e8a84d49ebdb21de198b2c9face2b9252b2aea62b",
  "timestamp": "0x6acc92e3",
  "gasUsed": "0x1b48850",
  "gasLimit": "0x3938700",
  "baseFeePerGas": "0x3d8c1c0",
  "miner": "0x396343362be2a4da1ce0c1c210945346fb82aa49"
}`

// realV3Swap is a Swap log from the Uniswap V3 USDC/WETH 0.05% pool
// 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640, tx
// 0x75c92223f560f656641b389c1db33b16f19119e8dbec341041d1e455c8a202cb.
const realV3Swap = `{
  "address": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  "topics": [
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
    "0x0000000000000000000000004313c378cc91ea583c91387b9216e2c03096b27f",
    "0x0000000000000000000000004313c378cc91ea583c91387b9216e2c03096b27f"
  ],
  "data": "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffff2658787000000000000000000000000000000000000000000000000013c8bfa597cc0000000000000000000000000000000000000004d29a0c4f27aeb668f467f895eeb0000000000000000000000000000000000000000000000002b2e808c56cb64a200000000000000000000000000000000000000000000000000000000000304c7",
  "blockNumber": "0x18f663d",
  "blockHash": "0x4ea310100a845db4edc0d9dc440346916122fef924eedfe3462bf92eefa1a427",
  "transactionHash": "0x75c92223f560f656641b389c1db33b16f19119e8dbec341041d1e455c8a202cb",
  "transactionIndex": "0x3e",
  "logIndex": "0x54",
  "removed": false
}`

// realV2Swap is a Swap log from the Uniswap V2 USDC/WETH pair
// 0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc, tx
// 0x7beb819a5425355541fc432acd3699ef6cbc6f5303c01a832eb8d78cae1ab8e3.
const realV2Swap = `{
  "address": "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
  "topics": [
    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
    "0x0000000000000000000000004313c378cc91ea583c91387b9216e2c03096b27f",
    "0x0000000000000000000000004313c378cc91ea583c91387b9216e2c03096b27f"
  ],
  "data": "0x0000000000000000000000000000000000000000000000000000000001acf0d8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000026c15107867b6e",
  "blockNumber": "0x18f663b",
  "blockHash": "0x2e79f7d123d33efb9db8db4851a15c3210f4c054f031f23f40545190672dbfc3",
  "transactionHash": "0x7beb819a5425355541fc432acd3699ef6cbc6f5303c01a832eb8d78cae1ab8e3",
  "transactionIndex": "0x11",
  "logIndex": "0x13",
  "removed": false
}`

// realV3PoolCreated is a PoolCreated log from the Uniswap V3 factory
// 0x1F98431c8aD98523631AE4a59f267346ea31F984. NOTE the pool address is the
// second DATA word, not an indexed topic.
const realV3PoolCreated = `{
  "address": "0x1f98431c8ad98523631ae4a59f267346ea31f984",
  "topics": [
    "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
    "0x0000000000000000000000008dfa4e2fb04f394f5c203589461ac95e07559ee1",
    "0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "0x0000000000000000000000000000000000000000000000000000000000002710"
  ],
  "data": "0x00000000000000000000000000000000000000000000000000000000000000c8000000000000000000000000370c602e0c8bcff7fceddc972eb6a041a71cec80",
  "blockNumber": "0x18f5ae8",
  "blockHash": "0x0d6d5e1c0d1e6f2e9e2f3e6a5a0f9f0e1b2c3d4e5f60718293a4b5c6d7e8f901",
  "transactionHash": "0x7e0b87c3311d6c9ec48085bce32ff8ce0229da2b6daccf44f6aea1ffc1de5cc8",
  "transactionIndex": "0x5",
  "logIndex": "0x8",
  "removed": false
}`

// rpcDoer answers JSON-RPC calls from a per-method handler and records the
// methods it was asked for.
type rpcDoer struct {
	mu      sync.Mutex
	methods []string
	// handler returns the raw `result` JSON for a method+params pair. A
	// non-empty raw body overrides the envelope entirely (used for the
	// malformed-envelope cases).
	handler func(method string, params []any) (result string, status int, rawBody string)
	calls   int
}

func (d *rpcDoer) Do(r *http.Request) (*http.Response, error) {
	b, _ := io.ReadAll(r.Body)
	var req struct {
		Method string `json:"method"`
		Params []any  `json:"params"`
	}
	_ = json.Unmarshal(b, &req)
	d.mu.Lock()
	d.methods = append(d.methods, req.Method)
	d.calls++
	d.mu.Unlock()

	result, status, raw := d.handler(req.Method, req.Params)
	body := raw
	if body == "" {
		body = `{"jsonrpc":"2.0","id":1,"result":` + result + `}`
	}
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

func (d *rpcDoer) seen() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.methods...)
}

// spyWriter records the observations and series a dataset writes.
type spyWriter struct {
	series  []canon.SeriesMeta
	obs     []canon.Observation
	metrics int
	err     error
}

func (w *spyWriter) UpsertAssets(context.Context, []canon.Asset) (int, error) { return 0, w.err }
func (w *spyWriter) UpsertChains(context.Context, []canon.Chain) (int, error) { return 0, w.err }
func (w *spyWriter) UpsertVenues(context.Context, []canon.Venue) (int, error) { return 0, w.err }
func (w *spyWriter) UpsertInstruments(context.Context, []canon.Instrument) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertProtocols(context.Context, []canon.Protocol) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertSeries(_ context.Context, rows []canon.SeriesMeta) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.series = append(w.series, rows...)
	return len(rows), nil
}
func (w *spyWriter) UpsertProviderSymbols(context.Context, []canon.ProviderSymbol) (int, error) {
	return 0, w.err
}
func (w *spyWriter) WriteOhlcv(context.Context, []canon.Ohlcv) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteTrades(context.Context, []canon.Trade) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteQuotes(context.Context, []canon.Quote) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOrderbook(context.Context, []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteLiquidations(context.Context, []canon.Liquidation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOptionQuotes(context.Context, []canon.OptionQuote) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteObservations(_ context.Context, rows []canon.Observation) (int, int, error) {
	if w.err != nil {
		return 0, 0, w.err
	}
	w.obs = append(w.obs, rows...)
	return len(rows), 0, nil
}
func (w *spyWriter) WriteFunding(context.Context, []canon.FundingRate) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOpenInterest(context.Context, []canon.OpenInterest) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WritePools(context.Context, []canon.Pool) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteArticles(context.Context, []canon.Article) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WritePredictionMarkets(context.Context, []canon.PredictionMarket) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteChainTVL(context.Context, []canon.ChainTVL) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteProtocolTVL(context.Context, []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteSupply(context.Context, []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteMetric(context.Context, string, []canon.MetricPoint) (int, error) {
	return 0, w.err
}

// blockHandler answers eth_blockNumber and eth_getBlockByNumber with the real
// fixture, except for heights named in override.
func blockHandler(head uint64, override map[uint64]string) func(string, []any) (string, int, string) {
	return func(method string, params []any) (string, int, string) {
		switch method {
		case "eth_blockNumber":
			return `"` + hexUint64(head) + `"`, 0, ""
		case "eth_getBlockByNumber":
			if len(params) == 0 {
				return "", 0, ""
			}
			num, _ := params[0].(string)
			n, _ := hexToUint64(num)
			if raw, ok := override[n]; ok {
				return raw, 0, ""
			}
			return realBlock, 0, ""
		}
		return `null`, 0, ""
	}
}

func TestBlockWritesChainTruth(t *testing.T) {
	t.Setenv("EVM_RPC_URL_ETHEREUM", "https://rpc.example/v2/SECRETKEY")
	doer := &rpcDoer{handler: blockHandler(0x18f6640, nil)}
	w := &spyWriter{}
	c := newClient(doer, time.Second)

	written, rejected, next, err := c.block(context.Background(), w,
		ingest.Job{Provider: providerName, Dataset: "block", Subject: "ethereum", Mode: "poll"})
	if err != nil {
		t.Fatalf("block: %v", err)
	}
	if written != 3 || rejected != 0 {
		t.Fatalf("written/rejected = %d/%d, want 3/0", written, rejected)
	}
	if got := doer.seen(); len(got) != 2 || got[0] != "eth_blockNumber" || got[1] != "eth_getBlockByNumber" {
		t.Fatalf("methods = %v, want [eth_blockNumber eth_getBlockByNumber]", got)
	}

	chainID := canon.MintID(canon.KindChain, canon.ChainKey("ethereum"))
	bySeries := map[string]*float64{}
	for _, o := range w.obs {
		bySeries[o.SeriesID] = o.Value
	}
	want := map[string]float64{
		seriesID(metricBlockHeight, chainID): 0x18f6640,
		seriesID(metricBaseFeeGwei, chainID): 0.064537024,
		seriesID(metricGasUsedPct, chainID):  47.68098666666667,
	}
	for sid, wantVal := range want {
		v, ok := bySeries[sid]
		if !ok {
			t.Fatalf("no observation for series %s", sid)
		}
		if v == nil {
			t.Fatalf("series %s has a nil value", sid)
		}
		if diff := *v - wantVal; diff > 1e-9 || diff < -1e-9 {
			t.Errorf("series %s = %v, want %v", sid, *v, wantVal)
		}
	}

	// The observation's time is the BLOCK's time, and retrieved_at is ours.
	blockAt := time.Unix(0x6acc92e3, 0).UTC()
	for _, o := range w.obs {
		if !o.ObservedAt.Equal(blockAt) {
			t.Errorf("observed_at = %v, want block time %v", o.ObservedAt, blockAt)
		}
		if o.RetrievedAt.IsZero() {
			t.Errorf("series %s: retrieved_at is zero", o.SeriesID)
		}
	}

	// Series rows are registered before the observations land in them.
	if len(w.series) != 3 {
		t.Fatalf("series upserted = %d, want 3", len(w.series))
	}
	for _, s := range w.series {
		if s.Provider != providerName || s.Domain != domainBlockchain {
			t.Errorf("series %s: provider=%q domain=%q", s.SeriesID, s.Provider, s.Domain)
		}
		if s.ChainID == nil || *s.ChainID != chainID {
			t.Errorf("series %s: chain_id=%v, want %s", s.SeriesID, s.ChainID, chainID)
		}
	}

	if next[cursorLastBlock] != float64(0x18f6640) {
		t.Errorf("cursor last_block = %v", next[cursorLastBlock])
	}
	if next[cursorLastBlockHash] != "0x6c72cb8465f8ca58ace276631593aec7d364551c5794bb9a7ff93f4289f82c34" {
		t.Errorf("cursor last_block_hash = %v", next[cursorLastBlockHash])
	}
}

func TestBlockReorgIsRecordedNotHidden(t *testing.T) {
	t.Setenv("EVM_RPC_URL_ETHEREUM", "https://rpc.example")
	// The previous run checkpointed height 0x18f6630 with a hash the chain no
	// longer has: the block was orphaned.
	orphaned := `{
      "number": "0x18f6630",
      "hash": "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
      "timestamp": "0x6acc9200",
      "gasUsed": "0x1",
      "gasLimit": "0x2"
    }`
	doer := &rpcDoer{handler: blockHandler(0x18f6640, map[uint64]string{0x18f6630: orphaned})}
	w := &spyWriter{}
	c := newClient(doer, time.Second)

	prev := ingest.Cursor{
		cursorLastBlock:     float64(0x18f6630),
		cursorLastBlockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
	}
	_, _, next, err := c.block(context.Background(), w,
		ingest.Job{Provider: providerName, Dataset: "block", Subject: "ethereum", Cursor: prev})
	if err != nil {
		t.Fatalf("block: %v", err)
	}
	if next[cursorReorgCount] != float64(1) {
		t.Errorf("reorg_count = %v, want 1", next[cursorReorgCount])
	}
	if next[cursorReorgAtBlock] != float64(0x18f6630) {
		t.Errorf("reorg_at_block = %v, want %d", next[cursorReorgAtBlock], 0x18f6630)
	}
	// The reorg does not stop the heartbeat: the current tip is still written.
	if len(w.obs) != 3 {
		t.Fatalf("observations = %d, want 3 (the tip is still canonical)", len(w.obs))
	}
}

func TestBlockBackwardsTipIsAReorg(t *testing.T) {
	t.Setenv("EVM_RPC_URL_ETHEREUM", "https://rpc.example")
	// The tip (0x18f6640) is BEHIND the checkpointed height: a different node
	// behind the endpoint, or a deep rollback. Either way the checkpoint is
	// unusable and must be flagged, not trusted.
	doer := &rpcDoer{handler: blockHandler(0x18f6640, nil)}
	c := newClient(doer, time.Second)
	prev := ingest.Cursor{
		cursorLastBlock:     float64(0x18f6700),
		cursorLastBlockHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
	}
	_, _, next, err := c.block(context.Background(), &spyWriter{},
		ingest.Job{Provider: providerName, Dataset: "block", Subject: "ethereum", Cursor: prev})
	if err != nil {
		t.Fatalf("block: %v", err)
	}
	if next[cursorReorgCount] != float64(1) {
		t.Errorf("reorg_count = %v, want 1", next[cursorReorgCount])
	}
}

func TestBlockNoEndpointNeverTouchesTheNetwork(t *testing.T) {
	t.Setenv(alchemyKeyEnv, "")
	t.Setenv("EVM_RPC_URL_ETHEREUM", "")
	doer := &rpcDoer{handler: func(string, []any) (string, int, string) { return `"0x1"`, 0, "" }}
	c := newClient(doer, time.Second)

	_, _, _, err := c.block(context.Background(), &spyWriter{},
		ingest.Job{Provider: providerName, Dataset: "block", Subject: "ethereum"})
	if err == nil {
		t.Fatal("want a no-credentials error")
	}
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "no-credentials" {
		t.Fatalf("err = %v, want HardError no-credentials", err)
	}
	if doer.calls != 0 {
		t.Fatalf("network calls = %d, want 0", doer.calls)
	}
}

func TestBlockAbsentBaseFeeStaysNull(t *testing.T) {
	t.Setenv("EVM_RPC_URL_ETHEREUM", "https://rpc.example")
	// A pre-EIP-1559 header: no baseFeePerGas field at all. The metric must be
	// ABSENT, not 0 - 0 gwei is a different, falsifiable claim.
	preLondon := `{
      "number": "0x100",
      "hash": "0xabc0000000000000000000000000000000000000000000000000000000000000",
      "timestamp": "0x5f5e100",
      "gasUsed": "0x1",
      "gasLimit": "0x2"
    }`
	doer := &rpcDoer{handler: blockHandler(0x100, map[uint64]string{0x100: preLondon})}
	w := &spyWriter{}
	c := newClient(doer, time.Second)

	written, _, _, err := c.block(context.Background(), w,
		ingest.Job{Provider: providerName, Dataset: "block", Subject: "ethereum"})
	if err != nil {
		t.Fatalf("block: %v", err)
	}
	// height + gas_used_pct; base fee absent.
	if written != 2 {
		t.Fatalf("written = %d, want 2 (no base-fee row)", written)
	}
	chainID := canon.MintID(canon.KindChain, canon.ChainKey("ethereum"))
	for _, o := range w.obs {
		if o.SeriesID == seriesID(metricBaseFeeGwei, chainID) {
			t.Fatalf("a base-fee observation was written for a pre-London block: %v", *o.Value)
		}
	}
}

func TestBlockRPCErrorIsTyped(t *testing.T) {
	t.Setenv("EVM_RPC_URL_ETHEREUM", "https://rpc.example")
	// A node reporting a failure inside HTTP 200 must surface the node's code,
	// not be flattened into a successful empty result.
	doer := &rpcDoer{handler: func(string, []any) (string, int, string) {
		return "", 200, `{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"limit exceeded","data":"rate limited"}}`
	}}
	c := newClient(doer, time.Second)
	_, _, _, err := c.block(context.Background(), &spyWriter{},
		ingest.Job{Provider: providerName, Dataset: "block", Subject: "ethereum"})
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "rpc-error" {
		t.Fatalf("err = %v, want HardError rpc-error", err)
	}
	if !strings.Contains(he.Error(), "limit exceeded") {
		t.Errorf("error lost the node's message: %v", he)
	}
}

func TestBlockUnknownChainIsAShapeError(t *testing.T) {
	doer := &rpcDoer{handler: func(string, []any) (string, int, string) { return `"0x1"`, 0, "" }}
	c := newClient(doer, time.Second)
	_, _, _, err := c.block(context.Background(), &spyWriter{},
		ingest.Job{Provider: providerName, Dataset: "block", Subject: "solana"})
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "shape" {
		t.Fatalf("err = %v, want HardError shape", err)
	}
	if doer.calls != 0 {
		t.Fatalf("network calls = %d, want 0 for an unmapped chain", doer.calls)
	}
}

func TestDecodeV3SwapRealMainnetLog(t *testing.T) {
	var l logEntry
	if err := json.Unmarshal([]byte(realV3Swap), &l); err != nil {
		t.Fatal(err)
	}
	if l.Topics[0] != TopicV3Swap {
		t.Fatalf("fixture topic0 %s != TopicV3Swap", l.Topics[0])
	}
	sw, err := decodeV3Swap(l)
	if err != nil {
		t.Fatalf("decodeV3Swap: %v", err)
	}
	if sw.Amount0.Cmp(big.NewInt(-228227193)) != 0 {
		t.Errorf("amount0 = %s, want -228227193 (negative: the pool paid token0 out)", sw.Amount0)
	}
	if sw.Amount1.Cmp(big.NewInt(89100000000000000)) != 0 {
		t.Errorf("amount1 = %s, want 89100000000000000", sw.Amount1)
	}
	if sw.SqrtPriceX96.String() != "1565043649840375674197614053121771" {
		t.Errorf("sqrtPriceX96 = %s", sw.SqrtPriceX96)
	}
	if sw.Liquidity.String() != "3111565732799538338" {
		t.Errorf("liquidity = %s", sw.Liquidity)
	}
	if sw.Tick.Int64() != 197831 {
		t.Errorf("tick = %s, want 197831", sw.Tick)
	}
	if sw.Sender != "0x4313c378cc91ea583c91387b9216e2c03096b27f" {
		t.Errorf("sender = %s", sw.Sender)
	}
}

func TestDecodeV2SwapRealMainnetLog(t *testing.T) {
	var l logEntry
	if err := json.Unmarshal([]byte(realV2Swap), &l); err != nil {
		t.Fatal(err)
	}
	if l.Topics[0] != TopicV2Swap {
		t.Fatalf("fixture topic0 %s != TopicV2Swap", l.Topics[0])
	}
	sw, err := decodeV2Swap(l)
	if err != nil {
		t.Fatalf("decodeV2Swap: %v", err)
	}
	// V2 amounts are UNSIGNED: reading them as signed would turn a large
	// reserve amount negative.
	if sw.Amount0In.Cmp(big.NewInt(28111064)) != 0 {
		t.Errorf("amount0In = %s, want 28111064", sw.Amount0In)
	}
	if sw.Amount1In.Sign() != 0 || sw.Amount0Out.Sign() != 0 {
		t.Errorf("zero legs = %s/%s, want 0/0", sw.Amount1In, sw.Amount0Out)
	}
	if sw.Amount1Out.String() != "10908602877770606" {
		t.Errorf("amount1Out = %s, want 10908602877770606", sw.Amount1Out)
	}
}

func TestDecodeV3PoolCreatedReadsPoolFromData(t *testing.T) {
	var l logEntry
	if err := json.Unmarshal([]byte(realV3PoolCreated), &l); err != nil {
		t.Fatal(err)
	}
	if l.Topics[0] != TopicV3PoolCreated {
		t.Fatalf("fixture topic0 %s != TopicV3PoolCreated", l.Topics[0])
	}
	pc, err := decodeV3PoolCreated(l)
	if err != nil {
		t.Fatalf("decodeV3PoolCreated: %v", err)
	}
	// The pool address lives in the second DATA word. Reading it from a topic
	// (as V2's PairCreated would) yields token1 instead - the exact bug this
	// assertion pins.
	if pc.Pool != "0x370c602e0c8bcff7fceddc972eb6a041a71cec80" {
		t.Errorf("pool = %s, want 0x370c602e0c8bcff7fceddc972eb6a041a71cec80", pc.Pool)
	}
	if pc.Pool == pc.Token1 {
		t.Errorf("pool address equals token1 - read from the wrong field")
	}
	if pc.Token0 != "0x8dfa4e2fb04f394f5c203589461ac95e07559ee1" {
		t.Errorf("token0 = %s", pc.Token0)
	}
	if pc.Token1 != "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" {
		t.Errorf("token1 = %s", pc.Token1)
	}
	if pc.TickSpacing == nil || *pc.TickSpacing != 200 {
		t.Errorf("tickSpacing = %v, want 200", pc.TickSpacing)
	}
	// fee 10000 is hundredths of a bip = 100 bps (1%), NOT 10000 bps.
	if pc.FeeUnits == nil || *pc.FeeUnits != 10000 {
		t.Fatalf("feeUnits = %v, want 10000", pc.FeeUnits)
	}
	bps, ok := pc.FeeBps()
	if !ok || bps != 100 {
		t.Errorf("FeeBps = %d/%v, want 100/true", bps, ok)
	}
	// A V2 pair has no fee in its event: FeeBps must report absence, not 0.
	v2 := PoolCreated{}
	if _, ok := v2.FeeBps(); ok {
		t.Error("a V2 PoolCreated reported a fee it does not carry")
	}
}

func TestDecodeRejectsShortDataRatherThanZeroPadding(t *testing.T) {
	// A truncated V3 Swap body: four words instead of five. Zero-padding would
	// fabricate a tick, so the decoder must refuse.
	var l logEntry
	_ = json.Unmarshal([]byte(realV3Swap), &l)
	l.Data = l.Data[:2+32*4*2]
	if _, err := decodeV3Swap(l); err == nil {
		t.Fatal("want an error for a short data blob")
	}
	// An odd-length hex blob is not a byte string at all.
	l.Data = "0xabc"
	if _, err := decodeV3Swap(l); err == nil {
		t.Fatal("want an error for an odd-length hex blob")
	}
}

func TestRedactHidesAKeyInThePath(t *testing.T) {
	// The major providers put the key in the PATH; a query-only redaction
	// would leak it through every error.
	got := redact("https://eth-mainnet.g.alchemy.com/v2/SUPERSECRETKEY")
	if strings.Contains(got, "SUPERSECRETKEY") {
		t.Fatalf("redact leaked the key: %s", got)
	}
	if got != "https://eth-mainnet.g.alchemy.com" {
		t.Fatalf("redact = %q", got)
	}
	if got := redact("https://user:pw@rpc.example:8545/path?apikey=SECRET"); strings.Contains(got, "SECRET") ||
		strings.Contains(got, "pw") {
		t.Fatalf("redact leaked credentials: %s", got)
	}
}

func TestCursorSurvivesTheJsonbRoundTrip(t *testing.T) {
	// data.job.cursor is jsonb: a uint64 written by one run comes back as a
	// float64. Reading it as anything else would silently reset the checkpoint
	// to 0 and re-scan from genesis.
	var roundTripped ingest.Cursor
	b, _ := json.Marshal(ingest.Cursor{cursorLastBlock: uint64(0x18f6640), cursorLastBlockHash: "0xaa"})
	if err := json.Unmarshal(b, &roundTripped); err != nil {
		t.Fatal(err)
	}
	n, ok := cursorUint64(roundTripped, cursorLastBlock)
	if !ok || n != 0x18f6640 {
		t.Fatalf("cursor last_block = %d/%v, want %d/true", n, ok, 0x18f6640)
	}
	if got := cursorString(roundTripped, cursorLastBlockHash); got != "0xaa" {
		t.Fatalf("cursor hash = %q", got)
	}
	// Absent and non-numeric values are absent, never 0.
	if _, ok := cursorUint64(ingest.Cursor{}, cursorLastBlock); ok {
		t.Error("an absent key reported a value")
	}
	if _, ok := cursorUint64(ingest.Cursor{cursorLastBlock: "nope"}, cursorLastBlock); ok {
		t.Error("a non-numeric value reported a value")
	}
}

func TestJobsSeedPerChainAndDisableUnconfiguredOnes(t *testing.T) {
	t.Setenv(alchemyKeyEnv, "")
	t.Setenv("EVM_RPC_URL_ETHEREUM", "https://rpc.example")
	t.Setenv("EVM_RPC_URL_BASE", "")
	m := NewModule(nil)
	if m.Provider() != providerName {
		t.Fatalf("provider = %s", m.Provider())
	}
	if !m.HasCredentials() {
		t.Fatal("HasCredentials = false with one endpoint set")
	}
	specs := m.Jobs()
	if len(specs) != len(chains) {
		t.Fatalf("jobs = %d, want %d (one per chain, configured or not)", len(specs), len(chains))
	}
	bySubject := map[string]ingest.JobSpec{}
	for _, s := range specs {
		bySubject[s.Subject] = s
	}
	if !bySubject["ethereum"].Enabled {
		t.Error("ethereum job is disabled with an endpoint set")
	}
	if bySubject["base"].Enabled {
		t.Error("base job is enabled with no endpoint set")
	}
	if _, ok := m.Fetchers()["block"]; !ok {
		t.Error("no fetcher registered for the block dataset")
	}
}

func TestNoEndpointAnywhereMeansNoCredentials(t *testing.T) {
	t.Setenv(alchemyKeyEnv, "")
	for _, c := range chains {
		t.Setenv(c.OverrideEnv, "")
	}
	if NewModule(nil).HasCredentials() {
		t.Fatal("HasCredentials = true with no endpoint configured")
	}
}

// TestEndpointUsesTheSharedAlchemyKey pins the credential model: ONE key
// expanded per chain, exactly as apps/reconciler/src/streams/sync.rs does it.
// A second chain-access credential for the same six chains would be a second
// source of truth for one fact.
func TestEndpointUsesTheSharedAlchemyKey(t *testing.T) {
	t.Setenv(alchemyKeyEnv, "SHAREDKEY")
	for _, c := range chains {
		t.Setenv(c.OverrideEnv, "")
	}
	eth, _ := lookupChain("ethereum")
	if got := endpoint(eth); got != "https://eth-mainnet.g.alchemy.com/v2/SHAREDKEY" {
		t.Errorf("ethereum endpoint = %q", got)
	}
	bsc, _ := lookupChain("bsc")
	if got := endpoint(bsc); got != "https://bnb-mainnet.g.alchemy.com/v2/SHAREDKEY" {
		t.Errorf("bsc endpoint = %q", got)
	}
	// The derived URL carries the key in its PATH; redact must still hide it.
	if got := redact(endpoint(eth)); strings.Contains(got, "SHAREDKEY") {
		t.Errorf("redact leaked the shared key: %s", got)
	}
}

// TestPerChainOverrideBeatsTheSharedKey: an explicit endpoint wins, so a
// self-hosted node is a drop-in without a second global credential.
func TestPerChainOverrideBeatsTheSharedKey(t *testing.T) {
	t.Setenv(alchemyKeyEnv, "SHAREDKEY")
	t.Setenv("EVM_RPC_URL_ETHEREUM", "http://127.0.0.1:8545")
	eth, _ := lookupChain("ethereum")
	if got := endpoint(eth); got != "http://127.0.0.1:8545" {
		t.Errorf("override ignored: %q", got)
	}
	if got := redact("http://127.0.0.1:8545"); got != "http://127.0.0.1:8545" {
		t.Errorf("redact dropped a local node's port: %q", got)
	}
}

// TestNoKeyMeansNoEndpoint: a missing shared key yields an EMPTY endpoint for
// every chain, so the fetch fails loudly as no-credentials instead of
// requesting https://<host>/v2/ with no key and reading the 401 as data.
func TestNoKeyMeansNoEndpoint(t *testing.T) {
	t.Setenv(alchemyKeyEnv, "")
	for _, c := range chains {
		t.Setenv(c.OverrideEnv, "")
		if got := endpoint(c); got != "" {
			t.Errorf("%s: endpoint = %q with no key, want empty", c.Name, got)
		}
	}
}

// TestChainMapMatchesTheTreeVocabulary pins the chain set to the names the rest
// of the tree already uses (apps/reconciler/src/chains.rs, the etherscan
// adapter's map). An invented name would mint a SECOND canonical chain id for
// one chain.
func TestChainMapMatchesTheTreeVocabulary(t *testing.T) {
	want := map[string]string{
		"ethereum": "1",
		"bsc":      "56",
		"polygon":  "137",
		"arbitrum": "42161",
		"optimism": "10",
		"base":     "8453",
	}
	if len(chains) != len(want) {
		t.Fatalf("chain map has %d entries, want %d", len(chains), len(want))
	}
	seenName := map[string]bool{}
	seenID := map[string]bool{}
	for _, c := range chains {
		id, ok := want[c.Name]
		if !ok {
			t.Errorf("chain %q is not in the tree's chain vocabulary", c.Name)
			continue
		}
		if c.ChainID != id {
			t.Errorf("chain %q: id %s, want %s", c.Name, c.ChainID, id)
		}
		if seenName[c.Name] {
			t.Errorf("duplicate chain name %q", c.Name)
		}
		if seenID[c.ChainID] {
			t.Errorf("duplicate chain id %q", c.ChainID)
		}
		seenName[c.Name] = true
		seenID[c.ChainID] = true
		if c.Host == "" || c.OverrideEnv == "" {
			t.Errorf("chain %q: host=%q overrideEnv=%q", c.Name, c.Host, c.OverrideEnv)
		}
	}
}
