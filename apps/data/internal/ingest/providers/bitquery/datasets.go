package bitquery

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

// This file implements the `dex-trades` dataset against Bitquery's v2 EVM
// `DEXTrades` cube. One row is one trade with an explicit buy and sell leg, so
// unlike a subgraph's signed amount0/amount1 there is no sign to interpret:
// Sell = the taker's input, Buy = the taker's output. Amounts are decimal
// strings in whole-token units and the decimals ride on Currency.Decimals, so
// the adapter re-scales to exact raw via the token's own exponent.

// dexTradesQuery pages one pool's trades by BLOCK NUMBER ascending from an
// explicit cursor. The network is a VARIABLE, not a literal: the subject's chain
// slug decides which cube is queried, so a `base:` subject can never silently
// query the Ethereum cube and mint rows under the wrong chain_id.
const dexTradesQuery = `query DexTrades($network: EVMNetwork!, $pool: String!, $from: Int!, $limit: Int!) {
  EVM(network: $network) {
    DEXTrades(
      where: {Trade: {Dex: {SmartContract: {is: $pool}}}, Block: {Number: {ge: $from}}}
      orderBy: {ascending: Block_Number}
      limit: {count: $limit}
    ) {
      Block { Number Time }
      Transaction { Hash }
      Trade {
        Index
        Buy { Amount Buyer Currency { SmartContract Symbol Decimals } }
        Sell { Amount Seller Currency { SmartContract Symbol Decimals } }
        AmountInUSD
      }
    }
  }
}`

// bitqueryNetwork maps a canonical chain slug to Bitquery's EVM network enum.
// ok is false for a chain this adapter does not cover, and the caller REJECTS
// rather than defaulting to ethereum — a wrong network is a wrong chain_id on
// every row. Solana has its own non-EVM cube and is not served here.
func bitqueryNetwork(chain string) (string, bool) {
	switch chain {
	case "ethereum", "eth":
		return "eth", true
	case "base":
		return "base", true
	case "arbitrum":
		return "arbitrum", true
	case "optimism":
		return "optimism", true
	case "matic", "polygon":
		return "matic", true
	case "bsc", "bnb":
		return "bsc", true
	case "avalanche", "avax":
		return "avalanche", true
	default:
		return "", false
	}
}

// tradeRow is one Bitquery DEXTrade (trimmed to the fields the adapter reads).
type tradeRow struct {
	Block struct {
		Number string `json:"Number"`
		Time   string `json:"Time"`
	} `json:"Block"`
	Transaction struct {
		Hash string `json:"Hash"`
	} `json:"Transaction"`
	Trade struct {
		Index string   `json:"Index"`
		Buy   tradeLeg `json:"Buy"`
		Sell  tradeLeg `json:"Sell"`
		USD   string   `json:"AmountInUSD"`
	} `json:"Trade"`
}

type tradeLeg struct {
	Amount   string `json:"Amount"`
	Buyer    string `json:"Buyer"`
	Seller   string `json:"Seller"`
	Currency struct {
		SmartContract string `json:"SmartContract"`
		Symbol        string `json:"Symbol"`
		Decimals      string `json:"Decimals"`
	} `json:"Currency"`
}

// dexTrades implements the `dex-trades` dataset: one page of pool trades mapped
// to canonical swaps and written through the DEX writer. The cursor is the last
// block SEEN so a boundary block is re-read (idempotent under the deterministic
// SwapKey) rather than skipped (which would lose a swap permanently).
func (c *client) dexTrades(ctx context.Context, w canon.Writer, dw dexstore.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	if dw == nil {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "no dex writer wired"}
	}
	chain, poolAddr, ok := splitSubject(job.Subject)
	if !ok {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "dex-trades job needs subject chain:poolAddress, got " + job.Subject}
	}
	network, ok := bitqueryNetwork(chain)
	if !ok {
		// An uncovered chain is refused rather than silently queried on the
		// Ethereum cube, which would mint rows under the wrong chain_id.
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "bitquery does not cover chain " + chain}
	}
	fromBlock := int64(0)
	if v, ok := job.Cursor["block"].(float64); ok && v > 0 {
		fromBlock = int64(v)
	}
	var res struct {
		EVM struct {
			DEXTrades []tradeRow `json:"DEXTrades"`
		} `json:"EVM"`
	}
	if err := c.post(ctx, dexTradesQuery, map[string]any{
		// The pool address is lowercased so a checksummed subject cannot mint a
		// second identity for a pool the other adapters already keyed lowercase.
		"network": network, "pool": strings.ToLower(poolAddr), "from": fromBlock, "limit": tradePageSize,
	}, &res); err != nil {
		return 0, 0, nil, err
	}
	if _, err := w.UpsertChains(ctx, []canon.Chain{{ChainID: chainID(chain), Name: chain, Kind: chainKind(chain)}}); err != nil {
		return 0, 0, nil, err
	}
	now := time.Now().UTC()
	rows := make([]canon.Swap, 0, len(res.EVM.DEXTrades))
	rejected := 0
	lastBlock := fromBlock
	for _, t := range res.EVM.DEXTrades {
		row, block, ok := c.mapTrade(chain, poolAddr, t, now)
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
	return written, rej + rejected, ingest.Cursor{"block": float64(lastBlock)}, nil
}

// mapTrade maps one Bitquery trade to canon.Swap. ok is false when the identity
// or a leg is unusable — the caller counts a rejection rather than fabricating.
// The direction is EXPLICIT: the sell leg is the input, the buy leg the output.
func (c *client) mapTrade(chain, poolAddr string, t tradeRow, now time.Time) (canon.Swap, int64, bool) {
	if t.Transaction.Hash == "" {
		return canon.Swap{}, 0, false
	}
	block, err := parseInt64(t.Block.Number)
	if err != nil {
		return canon.Swap{}, 0, false
	}
	// An absent Trade.Index must be a REJECTION, not a default of 0: every row
	// would then share LogIndex 0 and a multi-swap transaction would collapse
	// its swaps onto one SwapKey, silently dropping all but the first.
	idx, err := parseInt64(t.Trade.Index)
	if err != nil {
		return canon.Swap{}, 0, false
	}
	inTok, inAmt, ok := legAmount(t.Trade.Sell)
	if !ok {
		return canon.Swap{}, 0, false
	}
	outTok, outAmt, ok := legAmount(t.Trade.Buy)
	if !ok {
		return canon.Swap{}, 0, false
	}
	eventTime, err := parseTime(t.Block.Time)
	if err != nil {
		return canon.Swap{}, 0, false
	}
	li := int(idx)
	prov := canon.ProvenanceForProvider(providerName)
	prov.ChainID = chainID(chain)
	prov.BlockNumber = &block
	prov.TxHash = t.Transaction.Hash
	prov.SourceType = sourceType
	prov.ObservedAt = eventTime
	prov.NormalizedAt = now
	sw := canon.Swap{
		SwapID:      canon.MintID(canon.KindSwap, canon.SwapKey(chain, t.Transaction.Hash, li)),
		NaturalKey:  canon.SwapKey(chain, t.Transaction.Hash, li),
		PoolID:      canon.MintID(canon.KindPool, canon.PoolKey(chain, poolAddr)),
		ChainID:     chainID(chain),
		TxHash:      t.Transaction.Hash,
		LogIndex:    li,
		BlockNumber: &block,
		TokenIn:     canon.MintID(canon.KindToken, canon.TokenKey(chain, inTok)),
		TokenOut:    canon.MintID(canon.KindToken, canon.TokenKey(chain, outTok)),
		AmountIn:    inAmt,
		AmountOut:   outAmt,
		EventTime:   eventTime,
		Provenance:  prov,
	}
	// The trader is the sell leg's seller when present, else the buy leg's
	// buyer; empty (never a placeholder) when Bitquery reports neither.
	if s := strings.TrimSpace(t.Trade.Sell.Seller); s != "" {
		sw.Trader = s
	} else if b := strings.TrimSpace(t.Trade.Buy.Buyer); b != "" {
		sw.Trader = b
	}
	if d, err := canon.DecFromString(t.Trade.USD); err == nil && d.Present() {
		sw.AmountUSD = &d
	}
	return sw, block, true
}

// legAmount maps one trade leg to a token address and an exact amount. The
// amount is a whole-token decimal string; raw = |amount| * 10^decimals, exact.
func legAmount(l tradeLeg) (string, canon.TokenAmount, bool) {
	tok := strings.TrimSpace(l.Currency.SmartContract)
	if tok == "" {
		return "", canon.TokenAmount{}, false
	}
	dec, err := parseInt64(l.Currency.Decimals)
	if err != nil {
		// A leg with no decimals cannot be scaled exactly; refuse rather than
		// assume 18 (or 0).
		return "", canon.TokenAmount{}, false
	}
	amt, err := scaledAmount(l.Amount, int(dec))
	if err != nil {
		return "", canon.TokenAmount{}, false
	}
	return tok, amt, true
}

// scaledAmount converts a whole-token decimal string to the exact raw integer
// amount at the given decimals: raw = |value| * 10^decimals. The rational
// multiplication keeps every digit; a value that does not land on an integer is
// an error, never a rounding.
func scaledAmount(s string, decimals int) (canon.TokenAmount, error) {
	d, err := canon.DecFromString(s)
	if err != nil || !d.Present() {
		return canon.TokenAmount{}, fmt.Errorf("bitquery: bad amount %q", s)
	}
	r := new(big.Rat).Set(d.Rat())
	r.Abs(r)
	r.Mul(r, new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)))
	if !r.IsInt() {
		return canon.TokenAmount{}, fmt.Errorf("bitquery: %q has sub-unit precision at %d decimals", s, decimals)
	}
	return canon.NewTokenAmount(r.Num(), decimals)
}

// --- helpers -----------------------------------------------------------------

// tradePageSize bounds one Bitquery page.
const tradePageSize = 1000

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

// parseInt64 parses a base-10 int64.
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

// parseTime parses Bitquery's block time: an RFC3339 timestamp, a date, or a
// unix-seconds spelling (the v2 cube emits ISO-8601 by default).
func parseTime(s string) (time.Time, error) {
	t := strings.TrimSpace(s)
	if t == "" {
		return time.Time{}, fmt.Errorf("empty time")
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"} {
		if v, err := time.Parse(layout, t); err == nil {
			return v.UTC(), nil
		}
	}
	// A bare unix-seconds integer is tolerated.
	if n, err := parseInt64(t); err == nil {
		return time.Unix(n, 0).UTC(), nil
	}
	return time.Time{}, fmt.Errorf("bad time %q", s)
}

// orDefault returns s unless it is empty, in which case def.
func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}
