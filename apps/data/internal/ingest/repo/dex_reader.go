package repo

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/jackc/pgx/v5"
)

// This file implements dexstore.Reader: the DEX-specific reads the
// /api/v1/dex/* surface serves (docs/dex/audit.md §4). The frozen market
// entity lists (chains, protocols, tokens, venues) are served by canon.Reader
// and are NOT repeated here.
//
// Pool snapshots live in the EXISTING data.pool table (dexscreener and
// geckoterminal write it), so ListDexPools/ListDexRankings/GetDexPool read that
// table and reuse scanPool — the pool payload therefore carries the market
// contract's float64 price/liquidity.
//
// The exact-numeric pool state lives in data.dex_market_snapshot, which IS
// populated (dexscreener writes it; `?pool=` reads serve exact decimal
// strings). The remaining gap is a READER, not the data: /pools has not been
// repointed at the snapshot table yet, so it still serves the float64
// projection. See docs/dex/report.md limitation 2 and follow-up 4.

// nullDec converts a nullable numeric string into a canon.Dec (absent when the
// column is NULL or unparseable with a loud error).
func nullDec(s *string) (canon.Dec, error) {
	if s == nil || *s == "" {
		return canon.NilDec, nil
	}
	d, err := canon.DecFromString(*s)
	if err != nil {
		return canon.NilDec, fmt.Errorf("repo: bad decimal %q: %w", *s, err)
	}
	return d, nil
}

// decPtr converts a nullable numeric string into an optional *canon.Dec.
func decPtr(s *string) (*canon.Dec, error) {
	if s == nil || *s == "" {
		return nil, nil
	}
	d, err := canon.DecFromString(*s)
	if err != nil {
		return nil, fmt.Errorf("repo: bad decimal %q: %w", *s, err)
	}
	return &d, nil
}

// finalizeProvenance resolves a row's provider name into the plan §3 tier and
// source-type, and moves an event-time column into ObservedAt. Every data.dex_*
// table stores only the provider name (the `source` column) plus retrieved_at,
// so the tier/type come from canon.ClassifyProvider — the fixed fact about our
// adapter, never guessed — instead of being projected as empty strings and a
// zero time, which is the never-fake violation this closes.
//
// eventTime is nil for a table with no natural event-time column.
func finalizeProvenance(p *canon.Provenance, eventTime *time.Time) {
	if c, ok := canon.ClassifyProvider(p.SourceProvider); ok {
		p.Tier = c.Tier
		p.SourceType = c.Type
	}
	if eventTime != nil && !eventTime.IsZero() {
		p.ObservedAt = *eventTime
	}
}

// amount converts a (rawString, decimals) column pair into a canon.TokenAmount.
// A NULL raw means "absent" and yields the zero TokenAmount with a nil Raw.
func amount(raw *string, decimals *int) (canon.TokenAmount, error) {
	if raw == nil || *raw == "" {
		return canon.TokenAmount{}, nil
	}
	bi, ok := new(big.Int).SetString(*raw, 10)
	if !ok {
		return canon.TokenAmount{}, fmt.Errorf("repo: bad raw amount %q", *raw)
	}
	d := 0
	if decimals != nil {
		d = *decimals
	}
	return canon.NewTokenAmount(bi, d)
}

// amountPtr converts a nullable (rawString, decimals) pair into *TokenAmount.
func amountPtr(raw *string, decimals *int) (*canon.TokenAmount, error) {
	if raw == nil || *raw == "" {
		return nil, nil
	}
	a, err := amount(raw, decimals)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// --- pool reads (data.pool) -------------------------------------------------

// ListDexPools implements dexstore.Reader. Cursor: (BeforeAt, BeforePoolID)
// keyset, ordered at DESC, pool_id DESC so paging is stable under writes.
func (r *Repo) ListDexPools(ctx context.Context, q dexstore.DexPoolQuery) ([]canon.Pool, error) {
	f := &filter{}
	if q.ChainID != "" {
		f.add("chain_id = "+f.nextArg(), q.ChainID)
	}
	if q.VenueID != "" {
		f.add("dex_venue_id = "+f.nextArg(), q.VenueID)
	}
	if q.MinLiquidityUSD != nil {
		f.add("liquidity_usd >= "+f.nextArg(), *q.MinLiquidityUSD)
	}
	if q.MinVolume24hUSD != nil {
		f.add("volume_24h_usd >= "+f.nextArg(), *q.MinVolume24hUSD)
	}
	if !q.BeforeAt.IsZero() || q.BeforePoolID != "" {
		c1 := f.nextArg()
		f.add("(at, pool_id) < ("+c1+", "+f.nextArg()+")", q.BeforeAt, q.BeforePoolID)
	}
	sql := `SELECT pool_id, at, chain_id, dex_venue_id, address, base_asset_id, quote_asset_id,
		base_symbol, quote_symbol, fee_tier_bps, price, liquidity_usd, volume_24h_usd,
		fdv_usd, source, retrieved_at, pool_created_at
		FROM data.pool` + f.where() +
		fmt.Sprintf(" ORDER BY at DESC, pool_id DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(q.Limit))
	return listRows(ctx, r, sql, args, q.Limit, scanPool)
}

// GetDexPool implements dexstore.Reader: the newest snapshot for one pool id.
func (r *Repo) GetDexPool(ctx context.Context, poolID string) (canon.Pool, bool, error) {
	sql := `SELECT pool_id, at, chain_id, dex_venue_id, address, base_asset_id, quote_asset_id,
		base_symbol, quote_symbol, fee_tier_bps, price, liquidity_usd, volume_24h_usd,
		fdv_usd, source, retrieved_at, pool_created_at
		FROM data.pool WHERE pool_id = $1 ORDER BY at DESC LIMIT 1`
	rows, err := listRows(ctx, r, sql, []any{poolID}, 1, scanPool)
	if err != nil {
		return canon.Pool{}, false, err
	}
	if len(rows) == 0 {
		return canon.Pool{}, false, nil
	}
	return rows[0], true, nil
}

// ListDexRankings implements dexstore.Reader: the plan §31 ranking query over
// data.pool. Sort is validated by the handler; an unknown value falls back to
// the volume ordering and is documented here rather than silently mis-sorting.
func (r *Repo) ListDexRankings(ctx context.Context, q dexstore.DexRankingQuery) ([]canon.Pool, error) {
	f := &filter{}
	if q.ChainID != "" {
		f.add("chain_id = "+f.nextArg(), q.ChainID)
	}
	order := "volume_24h_usd DESC NULLS LAST"
	switch q.Sort {
	case "liquidity":
		order = "liquidity_usd DESC NULLS LAST"
	case "price_change":
		// data.pool carries no change column; price DESC is the documented
		// proxy and the client must label it as "price", not "change".
		order = "price DESC NULLS LAST"
	case "newest", "transactions":
		order = "at DESC"
	case "trending", "score", "volume", "":
		order = "volume_24h_usd DESC NULLS LAST"
	}
	sql := `SELECT pool_id, at, chain_id, dex_venue_id, address, base_asset_id, quote_asset_id,
		base_symbol, quote_symbol, fee_tier_bps, price, liquidity_usd, volume_24h_usd,
		fdv_usd, source, retrieved_at, pool_created_at
		FROM data.pool` + f.where() +
		fmt.Sprintf(" ORDER BY %s LIMIT $%d", order, len(f.args)+1)
	args := append(f.args, clampLimit(q.Limit))
	return listRows(ctx, r, sql, args, q.Limit, scanPool)
}

// --- candles + swaps --------------------------------------------------------

// ReadDexCandles implements dexstore.Reader: pool candles in a window,
// time-ASC (the chart shape).
func (r *Repo) ReadDexCandles(ctx context.Context, poolID, interval string, start, end time.Time, limit int) ([]canon.DexCandle, error) {
	f := &filter{}
	f.add("pool_id = "+f.nextArg(), poolID)
	if interval != "" {
		f.add("interval = "+f.nextArg(), interval)
	}
	f.timeRange("open_time", start, end)
	sql := `SELECT candle_id, natural_key, pool_id, chain_id, interval, open_time, close_time,
		o, h, l, c, volume_base, volume_quote, volume_usd, trade_count, vwap, source, retrieved_at
		FROM data.dex_candle` + f.where() +
		fmt.Sprintf(" ORDER BY open_time DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanDexCandle)
}

// ReadDexSwaps implements dexstore.Reader: a pool's swaps in a window.
func (r *Repo) ReadDexSwaps(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.Swap, error) {
	f := &filter{}
	if poolID != "" {
		f.add("pool_id = "+f.nextArg(), poolID)
	}
	f.timeRange("event_time", start, end)
	sql := `SELECT swap_id, natural_key, pool_id, chain_id, tx_hash, log_index, block_number,
		tx_index, trader, sender, token_in, token_out, amount_in_raw, amount_in_decimals,
		amount_out_raw, amount_out_decimals, amount_usd, side, source, event_time, retrieved_at
		FROM data.dex_swap` + f.where() +
		fmt.Sprintf(" ORDER BY event_time DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanDexSwap)
}

// scanDexCandle scans one dex_candle row, converting the numeric columns to
// exact canon.Dec values.
func scanDexCandle(row pgx.Rows) (canon.DexCandle, error) {
	var (
		c                               canon.DexCandle
		o, h, l, cl                     string
		volBase, volQuote, volUSD, vwap *string
	)
	err := row.Scan(&c.CandleID, &c.NaturalKey, &c.PoolID, &c.ChainID, &c.Interval,
		&c.OpenTime, &c.CloseTime, &o, &h, &l, &cl, &volBase, &volQuote, &volUSD,
		&c.TradeCount, &vwap, &c.Provenance.SourceProvider, &c.Provenance.NormalizedAt)
	if err != nil {
		return c, fmt.Errorf("repo: scan dex_candle: %w", err)
	}
	if c.Open, err = canon.DecFromString(o); err != nil {
		return c, err
	}
	if c.High, err = canon.DecFromString(h); err != nil {
		return c, err
	}
	if c.Low, err = canon.DecFromString(l); err != nil {
		return c, err
	}
	if c.Close, err = canon.DecFromString(cl); err != nil {
		return c, err
	}
	if c.VolumeBase, err = decPtr(volBase); err != nil {
		return c, err
	}
	if c.VolumeQuote, err = decPtr(volQuote); err != nil {
		return c, err
	}
	if c.VolumeUSD, err = decPtr(volUSD); err != nil {
		return c, err
	}
	if c.VWAP, err = decPtr(vwap); err != nil {
		return c, err
	}
	// observed_at is knowable: the bar's open time.
	finalizeProvenance(&c.Provenance, &c.OpenTime)
	return c, nil
}

// scanDexSwap scans one dex_swap row.
func scanDexSwap(row pgx.Rows) (canon.Swap, error) {
	var (
		s              canon.Swap
		inRaw, outRaw  string
		inDec, outDec  int
		amountUSD      *string
		trader, sender *string
		side           *string
	)
	err := row.Scan(&s.SwapID, &s.NaturalKey, &s.PoolID, &s.ChainID, &s.TxHash, &s.LogIndex,
		&s.BlockNumber, &s.TxIndex, &trader, &sender, &s.TokenIn, &s.TokenOut,
		&inRaw, &inDec, &outRaw, &outDec, &amountUSD, &side,
		&s.Provenance.SourceProvider, &s.EventTime, &s.Provenance.NormalizedAt)
	if err != nil {
		return s, fmt.Errorf("repo: scan dex_swap: %w", err)
	}
	if s.AmountIn, err = amount(&inRaw, &inDec); err != nil {
		return s, err
	}
	if s.AmountOut, err = amount(&outRaw, &outDec); err != nil {
		return s, err
	}
	if s.AmountUSD, err = decPtr(amountUSD); err != nil {
		return s, err
	}
	if trader != nil {
		s.Trader = *trader
	}
	if sender != nil {
		s.Sender = *sender
	}
	if side != nil {
		s.Side = *side
	}
	finalizeProvenance(&s.Provenance, &s.EventTime)
	return s, nil
}
