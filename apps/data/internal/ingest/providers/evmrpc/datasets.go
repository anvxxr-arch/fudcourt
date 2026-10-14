package evmrpc

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// This file maps decoded AMM events to canonical swaps and writes them. A swap
// is the only event that becomes a canon.Swap; mint/burn/sync are decoded but do
// NOT fabricate a swap row (a liquidity change is not a trade), which keeps the
// swap table honest.
//
// The pool's token ORDER matters: V2's Swap reports (amount0In, amount1In,
// amount0Out, amount1Out) which the parser already collapses into a signed
// (amount0, amount1) pair in pool order, and V3's Swap already reports signed
// (amount0, amount1) in pool order. Either way, the POSITIVE leg is what the
// pool received (the taker's input) — the same convention the subgraph adapter
// uses, so a pool's trades read the same across every provider.

// poolLogs is the `pool-logs` dataset: one eth_getLogs page over a pool's
// block range, decoded and written as canonical swaps.
func (c *client) poolLogs(ctx context.Context, w canon.Writer, dw dexstore.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	if dw == nil {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "no dex writer wired"}
	}
	chain, poolAddr, ok := splitSubject(job.Subject)
	if !ok {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "pool-logs job needs subject chain:poolAddress, got " + job.Subject}
	}
	fromBlock := int64(0)
	if v, ok := job.Cursor["block"].(float64); ok && v > 0 {
		fromBlock = int64(v)
	}
	// A real node rejects an unbounded eth_getLogs range (typical caps are
	// 1k–10k blocks), so the request covers ONE bounded window and the cursor
	// carries the next start. Without this the adapter cannot complete even its
	// first live run.
	toBlock := fromBlock + logWindowBlocks - 1
	// eth_blockNumber returns a bare 0x quantity string, not a block object.
	var head string
	if err := c.call(ctx, "eth_blockNumber", []any{}, &head); err != nil {
		return 0, 0, nil, err
	}
	if latest, err := parseUint64(head); err == nil && int64(latest) < toBlock {
		toBlock = int64(latest)
	}
	var logs []rawLog
	params := []any{
		map[string]any{
			"address":   strings.ToLower(poolAddr),
			"fromBlock": hexUint64(uint64(fromBlock)),
			"toBlock":   hexUint64(uint64(toBlock)),
		},
	}
	if err := c.call(ctx, "eth_getLogs", params, &logs); err != nil {
		return 0, 0, nil, err
	}
	if _, err := w.UpsertChains(ctx, []canon.Chain{{ChainID: chainID(chain), Name: chain, Kind: chainKind(chain)}}); err != nil {
		return 0, 0, nil, err
	}
	// The swap event carries no token identity or decimals, so resolve the pool's
	// metadata BEFORE mapping: an unresolved pool is a loud failure, never a
	// guessed exponent.
	pm, err := c.resolvePoolMeta(ctx, poolAddr)
	if err != nil {
		return 0, 0, nil, err
	}
	// The metadata read IS the pool's composition (plan §4), so it is written
	// rather than discarded — data.dex_pool_token had a writer but no producer.
	// The reserves are not known from this read, so they are left absent rather
	// than fabricated.
	if err := c.writePoolComposition(ctx, dw, chain, poolAddr, pm); err != nil {
		return 0, 0, nil, err
	}
	now := time.Now().UTC()
	rows := make([]canon.Swap, 0, len(logs))
	rejected := 0
	// The cursor advances to the WINDOW's end, not the last log seen: a window
	// with no swaps in it must still advance, or the job would re-read the same
	// empty range forever.
	lastBlock := toBlock
	for _, l := range logs {
		e, err := parseLog(l)
		if err != nil {
			// A log this adapter claims to model but cannot decode is a
			// rejection, not a silent skip.
			rejected++
			continue
		}
		if e == nil || e.Kind != "swap" || e.Amount0 == nil || e.Amount1 == nil {
			continue
		}
		row, ok := c.mapSwap(ctx, chain, poolAddr, pm, e, now)
		if !ok {
			rejected++
			continue
		}
		rows = append(rows, row)
		if e.Block > lastBlock {
			lastBlock = e.Block
		}
	}
	written, rej, err := dw.WriteDexSwaps(ctx, rows)
	if err != nil {
		return written, rej + rejected, nil, err
	}
	return written, rej + rejected, ingest.Cursor{"block": float64(lastBlock)}, nil
}

// writePoolComposition writes the pool's two sides to data.dex_pool_token
// (plan §4 "Pool composition"). Index 0 is token0 and 1 is token1 — the pool
// contract's own ordering, so a re-read cannot reshuffle sides. The reserve is
// NOT filled: this read (token0/token1/decimals) does not return reserves, and a
// guessed reserve would be a fabricated number.
func (c *client) writePoolComposition(ctx context.Context, dw dexstore.Writer, chain, poolAddr string, pm *poolMeta) error {
	poolID := canon.MintID(canon.KindPool, canon.PoolKey(chain, poolAddr))
	rows := []canon.PoolToken{
		{PoolID: poolID, TokenID: canon.MintID(canon.KindToken, canon.TokenKey(chain, pm.Token0)), Index: 0},
		{PoolID: poolID, TokenID: canon.MintID(canon.KindToken, canon.TokenKey(chain, pm.Token1)), Index: 1},
	}
	if _, err := dw.UpsertPoolTokens(ctx, rows); err != nil {
		return err
	}
	return nil
}

// mapSwap maps one decoded swap to canon.Swap with the pool's REAL token
// addresses and decimals. The positive leg is the taker's input; a swap that is
// not exactly one-each is refused rather than guessed. The block timestamp comes
// from the header (a log carries only the number), so the EventTime is real, not
// an epoch-0 placeholder.
func (c *client) mapSwap(ctx context.Context, chain, poolAddr string, pm *poolMeta, e *event, now time.Time) (canon.Swap, bool) {
	if e.TxHash == "" {
		return canon.Swap{}, false
	}
	s0, s1 := e.Amount0.Sign(), e.Amount1.Sign()
	var inRaw, outRaw *big.Int
	var inTok, outTok string
	var inDec, outDec int
	switch {
	case s0 > 0 && s1 < 0:
		inRaw, inTok, inDec = e.Amount0, pm.Token0, pm.Dec0
		outRaw, outTok, outDec = new(big.Int).Neg(e.Amount1), pm.Token1, pm.Dec1
	case s1 > 0 && s0 < 0:
		inRaw, inTok, inDec = e.Amount1, pm.Token1, pm.Dec1
		outRaw, outTok, outDec = new(big.Int).Neg(e.Amount0), pm.Token0, pm.Dec0
	default:
		return canon.Swap{}, false
	}
	amtIn, err := canon.NewTokenAmount(inRaw, inDec)
	if err != nil {
		return canon.Swap{}, false
	}
	amtOut, err := canon.NewTokenAmount(outRaw, outDec)
	if err != nil {
		return canon.Swap{}, false
	}
	at, err := c.blockTime(ctx, e.Block)
	if err != nil {
		// A swap without a resolvable time would carry a fabricated timestamp;
		// reject rather than write epoch 0.
		return canon.Swap{}, false
	}
	prov := canon.ProvenanceForProvider(providerName)
	prov.ChainID = chainID(chain)
	prov.BlockNumber = &e.Block
	prov.TxHash = e.TxHash
	prov.ObservedAt = at
	prov.NormalizedAt = now
	sw := canon.Swap{
		SwapID:      canon.MintID(canon.KindSwap, canon.SwapKey(chain, e.TxHash, e.LogIndex)),
		NaturalKey:  canon.SwapKey(chain, e.TxHash, e.LogIndex),
		PoolID:      canon.MintID(canon.KindPool, canon.PoolKey(chain, poolAddr)),
		ChainID:     chainID(chain),
		TxHash:      e.TxHash,
		LogIndex:    e.LogIndex,
		BlockNumber: &e.Block,
		TokenIn:     canon.MintID(canon.KindToken, canon.TokenKey(chain, inTok)),
		TokenOut:    canon.MintID(canon.KindToken, canon.TokenKey(chain, outTok)),
		AmountIn:    amtIn,
		AmountOut:   amtOut,
		EventTime:   at,
		Provenance:  prov,
	}
	// The trader is the V3 sender / V2 `to` the event indexed; a swap event does
	// not carry the EOA (it carries the router or the pool), so this is the
	// on-chain actor, left empty when the topic is absent.
	if e.Sender != "" {
		sw.Trader = e.Sender
	}
	return sw, true
}

// --- helpers -----------------------------------------------------------------

// logWindowBlocks bounds ONE eth_getLogs range. Public nodes cap a range at
// roughly 1k–10k blocks, so the adapter walks history in windows rather than
// asking one call for everything; the cursor advances by exactly one window.
const logWindowBlocks = 2000

// splitSubject parses "chain:poolAddress" at the FIRST colon.
func splitSubject(subject string) (chain, addr string, ok bool) {
	i := strings.IndexByte(subject, ':')
	if i <= 0 || i == len(subject)-1 {
		return "", "", false
	}
	return strings.ToLower(strings.TrimSpace(subject[:i])), strings.TrimSpace(subject[i+1:]), true
}

// chainID mints the canonical chain id.
func chainID(chain string) string { return canon.MintID(canon.KindChain, canon.ChainKey(chain)) }

// chainKind is the address family for a chain slug.
func chainKind(chain string) string {
	if chain == "solana" {
		return "solana"
	}
	return "evm"
}

// hexUint64 renders a block number as a 0x-hex quantity (the JSON-RPC form).
func hexUint64(n uint64) string { return fmt.Sprintf("0x%x", n) }
