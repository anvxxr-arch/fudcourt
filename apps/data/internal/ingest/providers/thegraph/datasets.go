package thegraph

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

// This file implements the two The Graph datasets. A subgraph exposes a typed
// schema, and the query is written against the canonical Uniswap-v3-style
// entities (swaps, poolDayDatas). Amounts arrive as decimal STRINGS
// (token0Price is a BigDecimal string) or, for raw token amounts, as strings
// too — so every value is parsed exactly and no float64 touches a row.
//
// The swaps query pages by BLOCK NUMBER ascending from an explicit cursor, which
// is the Graph's documented stable ordering (a timestamp cursor can skip or
// repeat rows when two swaps share a block). The `first`/`skip` pair is avoided
// for exactly that reason.

// swapsQuery is the swap-history page. The token decimals are read from the
// POOL, not the swap: on a Uniswap-v3-style subgraph a Swap carries only
// token0/token1 addresses (no `decimals`), so `swap.token0 { decimals }` would
// resolve to 0 and scale every amount by 1e18. The pool entity is where the
// token objects (with their decimals) hang, so the query descends pool -> token.
//
// orderBy: [blockNumber, transactionIndex, logIndex] is the subgraph's
// deterministic tiebreak, so paging cannot drop a row inside a multi-swap block.
//
// amount0/amount1 arrive as BigDecimal STRINGS in token units (e.g. "-1.234"),
// not raw integers; the adapter re-scales them to exact raw via the token
// decimals rather than trusting a float.
const swapsQuery = `query Swaps($pool: String!, $from: Int!, $first: Int!) {
  swaps(
    where: { pool: $pool, blockNumber_gte: $from }
    orderBy: blockNumber
    orderDirection: asc
    first: $first
  ) {
    id
    transaction { id blockNumber timestamp }
    logIndex
    timestamp
    amount0
    amount1
    amountUSD
    pool {
      token0 { id symbol decimals }
      token1 { id symbol decimals }
    }
  }
}`

// poolDayDataQuery is the daily pool-stats window (plan §4 "Market state").
const poolDayDataQuery = `query PoolDayData($pool: String!, $from: Int!) {
  poolDayDatas(
    where: { pool: $pool, date_gte: $from }
    orderBy: date
    orderDirection: asc
    first: 1000
  ) {
    date
    volumeUSD
    feesUSD
    tvlUSD
    token0Price
    token1Price
  }
}`

// swapRow is one subgraph swap (trimmed to the fields the adapter reads). The
// tokens hang off the POOL, not the swap — see swapsQuery.
type swapRow struct {
	ID          string `json:"id"`
	LogIndex    string `json:"logIndex"`
	Timestamp   string `json:"timestamp"`
	Amount0     string `json:"amount0"`
	Amount1     string `json:"amount1"`
	AmountUSD   string `json:"amountUSD"`
	Transaction struct {
		ID          string `json:"id"`
		BlockNumber string `json:"blockNumber"`
		Timestamp   string `json:"timestamp"`
	} `json:"transaction"`
	Pool struct {
		Token0 subgraphToken `json:"token0"`
		Token1 subgraphToken `json:"token1"`
	} `json:"pool"`
}

type subgraphToken struct {
	ID       string `json:"id"`
	Symbol   string `json:"symbol"`
	Decimals string `json:"decimals"`
}

// swaps implements the `swaps` dataset. The cursor is the last block WRITTEN
// (blockNumber_gte, not _gt) so a boundary block is re-read rather than skipped:
// a re-read is idempotent under the deterministic SwapKey, while a skip loses a
// swap permanently. The page size bounds one run; a full page hints the engine
// to continue promptly.
func (c *client) swaps(ctx context.Context, w canon.Writer, dw dexstore.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	if dw == nil {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "no dex writer wired"}
	}
	chain, poolAddr, ok := splitSubject(job.Subject)
	if !ok {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "swaps job needs subject chain:poolAddress, got " + job.Subject}
	}
	fromBlock := int64(0)
	if v, ok := job.Cursor["block"].(float64); ok && v > 0 {
		fromBlock = int64(v)
	}
	var res struct {
		Swaps []swapRow `json:"swaps"`
	}
	if err := c.post(ctx, swapsQuery, map[string]any{
		"pool": strings.ToLower(poolAddr), "from": fromBlock, "first": swapPageSize,
	}, &res); err != nil {
		return 0, 0, nil, err
	}
	if _, err := w.UpsertChains(ctx, []canon.Chain{{ChainID: chainID(chain), Name: chain, Kind: chainKind(chain)}}); err != nil {
		return 0, 0, nil, err
	}
	now := time.Now().UTC()
	rows := make([]canon.Swap, 0, len(res.Swaps))
	rejected := 0
	lastBlock := fromBlock
	for _, s := range res.Swaps {
		row, block, ok := c.mapSwap(chain, poolAddr, s, now)
		if !ok {
			rejected++
			continue
		}
		rows = append(rows, row)
		if block > lastBlock {
			lastBlock = block
		}
	}
	written, rej, err := dw.WriteDexSwaps(ctx, rows)
	if err != nil {
		return written, rej + rejected, nil, err
	}
	// The cursor advances to the newest block ACTUALLY seen, so a short page
	// resumes from where the data ended rather than the requested bound.
	return written, rej + rejected, ingest.Cursor{"block": float64(lastBlock)}, nil
}

// mapSwap maps one subgraph swap to canon.Swap. ok is false when the identity
// or an amount is unusable — the caller counts a rejection rather than
// fabricating a row.
//
// DIRECTION: amount0/amount1 are the POOL's delta in token units, so a POSITIVE
// value means the taker SENT that token into the pool (the taker's INPUT) and a
// NEGATIVE value means the pool SENT it out (the taker's OUTPUT). Reading the
// sign backwards — or collapsing to a "negative is input" shorthand — silently
// inverts every trade.
func (c *client) mapSwap(chain, poolAddr string, s swapRow, now time.Time) (canon.Swap, int64, bool) {
	if s.Transaction.ID == "" || s.ID == "" {
		return canon.Swap{}, 0, false
	}
	block, err := parseInt64(s.Transaction.BlockNumber)
	if err != nil {
		return canon.Swap{}, 0, false
	}
	logIdx, err := parseInt64(orDefault(s.LogIndex, "0"))
	if err != nil {
		return canon.Swap{}, 0, false
	}
	t0, t1 := s.Pool.Token0, s.Pool.Token1
	d0, err0 := parseInt64(orDefault(t0.Decimals, ""))
	d1, err1 := parseInt64(orDefault(t1.Decimals, ""))
	if err0 != nil || err1 != nil || t0.ID == "" || t1.ID == "" {
		// A swap whose pool tokens (and therefore decimals) are unknown cannot
		// be scaled exactly; refuse rather than guess. A missing decimals field
		// is NOT a 0-decimal token.
		return canon.Swap{}, 0, false
	}
	// The BigDecimal amounts are re-scaled to exact raw integers via the token
	// decimals: raw = |amount| * 10^decimals, taken exactly (never via float64).
	inTok, amtIn, outTok, amtOut, ok := swapLegs(s.Amount0, s.Amount1, int(d0), t0.ID, int(d1), t1.ID)
	if !ok {
		return canon.Swap{}, 0, false
	}
	eventTime, err := parseUnixSeconds(orDefault(s.Timestamp, s.Transaction.Timestamp))
	if err != nil {
		// The swap's own timestamp is authoritative; fall back to the
		// transaction's, and only refuse when BOTH are unparseable.
		return canon.Swap{}, 0, false
	}
	li := int(logIdx)
	prov := canon.ProvenanceForProvider(providerName)
	prov.ChainID = chainID(chain)
	prov.BlockNumber = &block
	prov.TxHash = s.Transaction.ID
	prov.SourceType = sourceType
	prov.ObservedAt = eventTime
	prov.NormalizedAt = now
	sw := canon.Swap{
		SwapID:      canon.MintID(canon.KindSwap, canon.SwapKey(chain, s.Transaction.ID, li)),
		NaturalKey:  canon.SwapKey(chain, s.Transaction.ID, li),
		PoolID:      canon.MintID(canon.KindPool, canon.PoolKey(chain, poolAddr)),
		ChainID:     chainID(chain),
		TxHash:      s.Transaction.ID,
		LogIndex:    li,
		BlockNumber: &block,
		TokenIn:     canon.MintID(canon.KindToken, canon.TokenKey(chain, inTok)),
		TokenOut:    canon.MintID(canon.KindToken, canon.TokenKey(chain, outTok)),
		AmountIn:    amtIn,
		AmountOut:   amtOut,
		EventTime:   eventTime,
		Provenance:  prov,
	}
	if d, err := canon.DecFromString(s.AmountUSD); err == nil && d.Present() {
		sw.AmountUSD = &d
	}
	return sw, block, true
}

// swapLegs resolves the taker's input and output amounts from the two
// pool-perspective BigDecimal legs. The POSITIVE leg is what the taker SENT
// (input); the NEGATIVE leg is what the taker RECEIVED (output). A swap that is
// not exactly one-each (both positive, both negative, or a zero on either side)
// has no unambiguous direction and is refused rather than guessed.
//
// The leg is selected by INDEX, not by "which one scales": token0 and token1
// frequently share a decimals exponent, so a first-that-scales search would
// silently pair token0's magnitude with token1's decimals.
func swapLegs(amt0, amt1 string, dec0 int, tok0 string, dec1 int, tok1 string) (inTok string, inAmt canon.TokenAmount, outTok string, outAmt canon.TokenAmount, ok bool) {
	r0, err0 := canon.DecFromString(amt0)
	r1, err1 := canon.DecFromString(amt1)
	if err0 != nil || err1 != nil || !r0.Present() || !r1.Present() {
		return "", canon.TokenAmount{}, "", canon.TokenAmount{}, false
	}
	var inStr, outStr string
	var inDec, outDec int
	switch s0, s1 := r0.Rat().Sign(), r1.Rat().Sign(); {
	case s0 > 0 && s1 < 0:
		inStr, inTok, inDec = amt0, tok0, dec0
		outStr, outTok, outDec = amt1, tok1, dec1
	case s1 > 0 && s0 < 0:
		inStr, inTok, inDec = amt1, tok1, dec1
		outStr, outTok, outDec = amt0, tok0, dec0
	default:
		return "", canon.TokenAmount{}, "", canon.TokenAmount{}, false
	}
	inA, err := scaledAmount(inStr, inDec)
	if err != nil {
		return "", canon.TokenAmount{}, "", canon.TokenAmount{}, false
	}
	outA, err := scaledAmount(outStr, outDec)
	if err != nil {
		return "", canon.TokenAmount{}, "", canon.TokenAmount{}, false
	}
	return inTok, inA, outTok, outA, true
}

// scaledAmount converts a token-unit BigDecimal string to the exact raw integer
// amount at the given decimals: raw = |value| * 10^decimals. The rational
// multiplication keeps every digit; a value that does not land on an integer
// (more fractional digits than the token has) is an error, never a rounding.
func scaledAmount(s string, decimals int) (canon.TokenAmount, error) {
	d, err := canon.DecFromString(s)
	if err != nil || !d.Present() {
		return canon.TokenAmount{}, fmt.Errorf("thegraph: bad amount %q", s)
	}
	r := new(big.Rat).Set(d.Rat())
	r.Abs(r)
	r.Mul(r, new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)))
	if !r.IsInt() {
		return canon.TokenAmount{}, fmt.Errorf("thegraph: %q has sub-unit precision at %d decimals", s, decimals)
	}
	return canon.NewTokenAmount(r.Num(), decimals)
}

// poolDayRow is one subgraph daily pool datum.
type poolDayRow struct {
	Date        string `json:"date"`
	VolumeUSD   string `json:"volumeUSD"`
	FeesUSD     string `json:"feesUSD"`
	TVLUSD      string `json:"tvlUSD"`
	Token0Price string `json:"token0Price"`
	Token1Price string `json:"token1Price"`
}

// poolDayData implements the `pool-day-data` dataset: daily pool state as exact
// market snapshots, keyed on (pool, day) so a re-read upserts rather than
// duplicates. It carries the day's volume, fees, TVL and the token0 price.
func (c *client) poolDayData(ctx context.Context, w canon.Writer, dw dexstore.Writer, job ingest.Job) (int, int, error) {
	if dw == nil {
		return 0, 0, &HardError{Kind: "shape", Detail: "no dex writer wired"}
	}
	chain, poolAddr, ok := splitSubject(job.Subject)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "pool-day-data job needs subject chain:poolAddress, got " + job.Subject}
	}
	from := time.Now().UTC().AddDate(0, 0, -90).Unix()
	var res struct {
		PoolDayDatas []poolDayRow `json:"poolDayDatas"`
	}
	if err := c.post(ctx, poolDayDataQuery, map[string]any{
		"pool": strings.ToLower(poolAddr), "from": from,
	}, &res); err != nil {
		return 0, 0, err
	}
	if _, err := w.UpsertChains(ctx, []canon.Chain{{ChainID: chainID(chain), Name: chain, Kind: chainKind(chain)}}); err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	poolID := canon.MintID(canon.KindPool, canon.PoolKey(chain, poolAddr))
	rows := make([]canon.DexMarketSnapshot, 0, len(res.PoolDayDatas))
	rejected := 0
	for _, d := range res.PoolDayDatas {
		secs, err := parseInt64(d.Date)
		if err != nil {
			rejected++
			continue
		}
		at := time.Unix(secs, 0).UTC()
		prov := canon.ProvenanceForProvider(providerName)
		prov.ChainID = chainID(chain)
		prov.SourceType = sourceType
		prov.ObservedAt = at
		prov.NormalizedAt = now
		row := canon.DexMarketSnapshot{
			SnapshotID: canon.MintID(canon.KindMarketSnapshot, canon.MarketSnapshotKey(poolID, at.Unix())),
			NaturalKey: canon.MarketSnapshotKey(poolID, at.Unix()),
			PoolID:     poolID,
			ChainID:    chainID(chain),
			At:         at,
			Provenance: prov,
		}
		if v, err := canon.DecFromString(d.VolumeUSD); err == nil && v.Present() {
			row.Volume24hUSD = &v
		}
		// TVL is deliberately NOT stored as MarketCapUSD (they are different
		// numbers); DexMarketSnapshot has no TVL column, so it is left out of the
		// row rather than mislabelled into a field that means something else.
		if v, err := canon.DecFromString(d.Token0Price); err == nil && v.Present() {
			row.PriceNative = &v
		}
		rows = append(rows, row)
	}
	written, rej, err := dw.WriteDexMarketSnapshots(ctx, rows)
	if err != nil {
		return written, rej + rejected, err
	}
	return written, rej + rejected, nil
}

// --- helpers -----------------------------------------------------------------

// swapPageSize bounds one subgraph page. A full page means more history exists.
const swapPageSize = 1000

// splitSubject parses "chain:poolAddress" at the FIRST colon (an address never
// contains one).
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

// parseInt64 parses a base-10 int64, tolerating a decimal spelling.
func parseInt64(s string) (int64, error) {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0, fmt.Errorf("empty integer")
	}
	n, ok := new(big.Int).SetString(t, 10)
	if !ok || !n.IsInt64() {
		return 0, fmt.Errorf("bad integer %q", s)
	}
	return n.Int64(), nil
}

// parseUnixSeconds parses a unix-seconds spelling into a UTC time, tolerating a
// fractional part (some subgraphs emit "1700000000.0").
func parseUnixSeconds(s string) (time.Time, error) {
	t := strings.TrimSpace(s)
	if i := strings.IndexByte(t, '.'); i > 0 {
		t = t[:i]
	}
	n, err := parseInt64(t)
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(n, 0).UTC(), nil
}

// orDefault returns s unless it is empty, in which case def.
func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}
