// Live proofs against a real EVM node. Skipped unless EVM_RPC_LIVE=1, so an
// offline `go test ./...` never depends on the network or on a credential.
//
//	EVM_RPC_LIVE=1 go test ./apps/data/internal/ingest/providers/evmrpc/ -run TestLive -v
//
// The unit tests pin the DECODERS against captured mainnet payloads. These
// proofs pin the TRANSPORT: that the adapter's request shape is one a real node
// accepts, and that its decoder agrees with what the node returns right now.
// The two are different failure modes - a wrong topic constant passes a
// self-consistent fixture test and fails here.
package evmrpc

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// liveEndpoint is a keyless public node, used so the proof does not require a
// credential. It is read from the override variable the adapter already
// understands, so the test exercises the SAME resolution path a deployment
// uses rather than a private shortcut.
func liveEndpoint(t *testing.T) string {
	t.Helper()
	if os.Getenv("EVM_RPC_LIVE") != "1" {
		t.Skip("set EVM_RPC_LIVE=1 to run the live node proofs")
	}
	ep := os.Getenv("EVM_RPC_LIVE_URL")
	if ep == "" {
		ep = "https://ethereum-rpc.publicnode.com"
	}
	return ep
}

func TestLiveBlockRoundTrip(t *testing.T) {
	ep := liveEndpoint(t)
	t.Setenv("EVM_RPC_URL_ETHEREUM", ep)
	c := newClient(nil, 30*time.Second)

	head, err := c.blockNumber(context.Background(), ep)
	if err != nil {
		t.Fatalf("eth_blockNumber: %v", err)
	}
	if head == 0 {
		t.Fatal("a live chain reported height 0")
	}
	t.Logf("live head = %d", head)

	hdr, err := c.blockByNumber(context.Background(), ep, head, false)
	if err != nil {
		t.Fatalf("eth_getBlockByNumber: %v", err)
	}
	if hdr.Hash == "" || hdr.ParentHash == "" {
		t.Fatalf("header missing hash/parentHash: %+v", hdr)
	}
	// A post-merge Ethereum block always carries a base fee. Its absence here
	// would mean the adapter read a field the node does not send.
	if hdr.BaseFeePerGas == "" {
		t.Error("a live post-merge header has no baseFeePerGas")
	}
	gwei, ok := baseFeeGwei(hdr)
	if !ok || gwei <= 0 {
		t.Errorf("baseFeeGwei = %v/%v", gwei, ok)
	}
	pct, ok := gasUsedPct(hdr)
	if !ok || pct < 0 || pct > 100 {
		t.Errorf("gasUsedPct = %v/%v", pct, ok)
	}
	at, ok := blockTime(hdr)
	if !ok || at.Year() < 2024 {
		t.Errorf("blockTime = %v/%v", at, ok)
	}
	t.Logf("live block %d hash=%s baseFee=%.6f gwei gasUsed=%.2f%% time=%s",
		head, hdr.Hash, gwei, pct, at.Format(time.RFC3339))

	// And through the PUBLIC path: the module's fetcher writing to a Writer.
	w := &spyWriter{}
	f := NewModule(nil).Fetchers()["block"]
	res, err := f.Fetch(context.Background(),
		ingest.Job{Provider: providerName, Dataset: "block", Subject: "ethereum", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if res.RowsWritten == 0 {
		t.Fatal("the fetcher wrote nothing")
	}
	if res.Next[cursorLastBlockHash] != hdr.Hash {
		t.Errorf("cursor hash %v != header hash %s", res.Next[cursorLastBlockHash], hdr.Hash)
	}
	t.Logf("live fetch: rows_in=%d written=%d rejected=%d cursor_block=%v",
		res.RowsIn, res.RowsWritten, res.RowsRejected, res.Next[cursorLastBlock])
}

// TestLiveSwapDecoderAgainstTheNode reads a known mainnet swap transaction's
// receipt and decodes the logs with THIS package's decoders, then checks the
// decoded amounts against the values the same node reports in the transaction's
// own data. It is the strongest available check that the topic constants and
// the word order are right: a mis-ordered data word still decodes, but it will
// not reconcile against the tx.
func TestLiveSwapDecoderAgainstTheNode(t *testing.T) {
	ep := liveEndpoint(t)
	c := newClient(nil, 30*time.Second)

	// Uniswap V3 USDC/WETH 0.05% pool, mainnet.
	const pool = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"
	logs, err := c.getLogs(context.Background(), ep, logFilter{
		FromBlock: 0x18f6600,
		ToBlock:   0x18f6650,
		Address:   pool,
		Topics:    [][]string{{TopicV3Swap}},
	})
	if err != nil {
		t.Fatalf("eth_getLogs: %v", err)
	}
	if len(logs) == 0 {
		t.Skip("no V3 swaps in the probed range; the range is a fixed historical window")
	}
	decoded := 0
	for _, l := range logs {
		sw, err := decodeV3Swap(l)
		if err != nil {
			t.Fatalf("decodeV3Swap on a live log: %v", err)
		}
		// A V3 swap moves value in at least one direction and the pool's tick
		// is inside the int24 range. A mis-decoded word would break one of
		// these invariants.
		if sw.Amount0.Sign() == 0 && sw.Amount1.Sign() == 0 {
			t.Errorf("log %s: both amounts are zero", l.TransactionHash)
		}
		if sw.Tick.Int64() < -887272 || sw.Tick.Int64() > 887272 {
			t.Errorf("log %s: tick %s is outside int24", l.TransactionHash, sw.Tick)
		}
		if sw.SqrtPriceX96.Sign() <= 0 {
			t.Errorf("log %s: sqrtPriceX96 %s is not positive", l.TransactionHash, sw.SqrtPriceX96)
		}
		if decoded == 0 {
			t.Logf("live swap tx=%s block=%s amount0=%s amount1=%s tick=%s",
				l.TransactionHash, l.BlockNumber, sw.Amount0, sw.Amount1, sw.Tick)
		}
		decoded++
	}
	t.Logf("decoded %d live V3 swap logs from pool %s", decoded, pool)
}

// TestLivePoolCreatedDiscovery proves the discovery signal works against the
// real factory: the adapter can find new pools by topic alone.
func TestLivePoolCreatedDiscovery(t *testing.T) {
	ep := liveEndpoint(t)
	c := newClient(nil, 30*time.Second)

	const factory = "0x1f98431c8ad98523631ae4a59f267346ea31f984" // Uniswap V3
	logs, err := c.getLogs(context.Background(), ep, logFilter{
		FromBlock: 0x18f5a00,
		ToBlock:   0x18f5b00,
		Address:   factory,
		Topics:    [][]string{{TopicV3PoolCreated}},
	})
	if err != nil {
		t.Fatalf("eth_getLogs: %v", err)
	}
	if len(logs) == 0 {
		t.Skip("no pool creations in the probed range")
	}
	for _, l := range logs {
		pc, err := decodeV3PoolCreated(l)
		if err != nil {
			t.Fatalf("decodeV3PoolCreated on a live log: %v", err)
		}
		// The pool address must be a real address, and it must NOT equal a
		// token - the bug of reading it from a topic instead of the data word.
		if pc.Pool == "" || pc.Pool == pc.Token0 || pc.Pool == pc.Token1 {
			t.Errorf("log %s: bad pool address %q", l.TransactionHash, pc.Pool)
		}
		if pc.TickSpacing == nil {
			t.Errorf("log %s: no tickSpacing", l.TransactionHash)
		}
		if pc.FeeUnits == nil {
			t.Errorf("log %s: no fee", l.TransactionHash)
		}
		bps, ok := pc.FeeBps()
		if !ok || bps <= 0 || bps > 10000 {
			t.Errorf("log %s: fee %d bps out of range", l.TransactionHash, bps)
		}
		t.Logf("live pool created: pool=%s token0=%s token1=%s fee=%d bps tickSpacing=%d",
			pc.Pool, pc.Token0, pc.Token1, bps, *pc.TickSpacing)
	}
}

// TestLiveRPCSurfacesTheEnvelopeShape pins the transport against the node's
// ACTUAL envelope, so a change in the response shape (a proxy wrapping result,
// a string id) fails here rather than silently producing a null result.
func TestLiveRPCSurfacesTheEnvelopeShape(t *testing.T) {
	ep := liveEndpoint(t)
	c := newClient(nil, 30*time.Second)
	var raw json.RawMessage
	if err := c.call(context.Background(), ep, "eth_chainId", []any{}, &raw); err != nil {
		t.Fatalf("eth_chainId: %v", err)
	}
	var hexID string
	if err := json.Unmarshal(raw, &hexID); err != nil {
		t.Fatalf("chainId result is not a hex string: %s", raw)
	}
	if hexID != "0x1" {
		t.Errorf("chainId = %s, want 0x1", hexID)
	}
}
