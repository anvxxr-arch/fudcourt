package evmrpc

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"

	"math/big"
)

// This file resolves the pool metadata a swap event does NOT carry: the token
// ADDRESSES and their DECIMALS. Both live on the contract, not in the log, so
// they are read with `eth_call` (token0/token1 on the pool, decimals on each
// token) and cached per pool for the process lifetime.
//
// Resolving them before writing an amount is REQUIRED, not an optimisation:
// canon.TokenAmount is (raw integer, decimals), and writing raw wei at a guessed
// exponent fabricates a number (the ~1e18 error this whole tier exists to avoid).
// If the metadata cannot be resolved, the fetch fails loudly — it never writes a
// defaulted exponent.

// poolMeta is one pool's resolved token identity and exponents.
type poolMeta struct {
	Token0 string
	Token1 string
	Dec0   int
	Dec1   int
}

// selectors, computed from their signatures so a copied literal cannot drift.
var (
	selToken0   = selector("token0()")
	selToken1   = selector("token1()")
	selDecimals = selector("decimals()")
)

// selector returns the 0x-prefixed 4-byte function selector for a signature.
func selector(sig string) string { return topic(sig)[:10] }

// metaCache is a per-client, mutex-guarded pool metadata cache. It is safe for
// the engine's worker pool to share one client across concurrent jobs.
type metaCache struct {
	mu sync.Mutex
	m  map[string]*poolMeta
}

// resolvePoolMeta returns the pool's cached metadata, reading it on first use.
// A partial read (a zero address, an out-of-range exponent) is an error, so a
// caller never scales an amount with a guessed exponent.
func (c *client) resolvePoolMeta(ctx context.Context, pool string) (*poolMeta, error) {
	pool = strings.ToLower(strings.TrimSpace(pool))
	if pool == "" {
		return nil, &HardError{Kind: "shape", Detail: "empty pool address"}
	}
	c.meta.mu.Lock()
	if m, ok := c.meta.m[pool]; ok {
		c.meta.mu.Unlock()
		return m, nil
	}
	c.meta.mu.Unlock()
	m, err := c.readPoolMeta(ctx, pool)
	if err != nil {
		return nil, err
	}
	c.meta.mu.Lock()
	if c.meta.m == nil {
		c.meta.m = map[string]*poolMeta{}
	}
	c.meta.m[pool] = m
	c.meta.mu.Unlock()
	return m, nil
}

// readPoolMeta performs the three eth_calls (token0, token1, decimals x2).
func (c *client) readPoolMeta(ctx context.Context, pool string) (*poolMeta, error) {
	t0w, err := c.callWord(ctx, pool, selToken0)
	if err != nil {
		return nil, err
	}
	t1w, err := c.callWord(ctx, pool, selToken1)
	if err != nil {
		return nil, err
	}
	t0 := wordAddress("0x" + hexWord(t0w))
	t1 := wordAddress("0x" + hexWord(t1w))
	if t0 == "" || t1 == "" {
		return nil, &HardError{Kind: "shape", Detail: "pool " + pool + " returned an empty token address"}
	}
	d0w, err := c.callWord(ctx, t0, selDecimals)
	if err != nil {
		return nil, err
	}
	d1w, err := c.callWord(ctx, t1, selDecimals)
	if err != nil {
		return nil, err
	}
	d0, d1 := int(d0w.Int64()), int(d1w.Int64())
	if !validDecimals(d0) || !validDecimals(d1) {
		return nil, &HardError{Kind: "shape", Detail: fmt.Sprintf("pool %s decimals out of range: %d/%d", pool, d0, d1)}
	}
	return &poolMeta{Token0: t0, Token1: t1, Dec0: d0, Dec1: d1}, nil
}

// callWord performs one eth_call and returns the first 32-byte word of the
// result. A revert or an empty result is a failure, never a zero.
func (c *client) callWord(ctx context.Context, to, sel string) (*big.Int, error) {
	var out string
	params := []any{map[string]any{"to": to, "data": sel}, "latest"}
	if err := c.call(ctx, "eth_call", params, &out); err != nil {
		return nil, err
	}
	words, err := hexWords(out)
	if err != nil {
		return nil, &HardError{Kind: "shape", Detail: fmt.Sprintf("eth_call %s: %v", sel, err)}
	}
	if len(words) == 0 {
		return nil, &HardError{Kind: "shape", Detail: "eth_call " + sel + " returned an empty word"}
	}
	return words[0], nil
}

// validDecimals reports whether an ERC-20 exponent is in canon's accepted range
// (0..255). A read outside it means the target is not a token we can scale.
func validDecimals(d int) bool { return d >= 0 && d <= 255 }

// blockTimeCache is a per-client, mutex-guarded block -> timestamp cache.
type blockTimeCache struct {
	mu sync.Mutex
	m  map[int64]time.Time
}

// blockTime returns a block's timestamp, reading it once per block. A raw log
// carries a block NUMBER, not a time, so the time must come from the header — an
// epoch-0 EventTime would be a fabricated timestamp, and the S0 tier must not
// fabricate.
func (c *client) blockTime(ctx context.Context, block int64) (time.Time, error) {
	c.blocks.mu.Lock()
	if t, ok := c.blocks.m[block]; ok {
		c.blocks.mu.Unlock()
		return t, nil
	}
	c.blocks.mu.Unlock()
	var hdr struct {
		Timestamp string `json:"timestamp"`
	}
	params := []any{hexUint64(uint64(block)), false}
	if err := c.call(ctx, "eth_getBlockByNumber", params, &hdr); err != nil {
		return time.Time{}, err
	}
	secs, err := parseUint64(hdr.Timestamp)
	if err != nil {
		return time.Time{}, &HardError{Kind: "shape", Detail: fmt.Sprintf("block %d timestamp %q: %v", block, hdr.Timestamp, err)}
	}
	t := time.Unix(int64(secs), 0).UTC()
	c.blocks.mu.Lock()
	if c.blocks.m == nil {
		c.blocks.m = map[int64]time.Time{}
	}
	c.blocks.m[block] = t
	c.blocks.mu.Unlock()
	return t, nil
}

// hexWord renders a big integer as a 32-byte big-endian hex word (no 0x).
func hexWord(v *big.Int) string {
	b := v.Bytes()
	if len(b) > 32 {
		b = b[len(b)-32:]
	}
	padded := make([]byte, 32)
	copy(padded[32-len(b):], b)
	return hex.EncodeToString(padded)
}
