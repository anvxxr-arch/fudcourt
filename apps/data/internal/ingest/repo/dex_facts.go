package repo

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/jackc/pgx/v5"
)

// This file implements the trading-fact half of dexstore.Writer (swaps,
// candles, liquidity and market snapshots). Every method follows facts.go's
// shape: splitValid -> execBatchTolerant -> (written, rejected, err).
//
// Numeric mapping (plan §54): a canon.Dec renders to its exact decimal STRING
// and a canon.TokenAmount to (raw integer string, decimals int). No float64 is
// ever passed into a numeric column.

// WriteDexSwaps implements dexstore.Writer. The UNIQUE (chain_id, tx_hash,
// log_index, event_time) makes an at-least-once re-delivery idempotent.
func (r *Repo) WriteDexSwaps(ctx context.Context, rows []canon.Swap) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateSwap, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, s := range good {
			b.Queue(`INSERT INTO data.dex_swap
				(swap_id, natural_key, pool_id, chain_id, tx_hash, log_index, block_number,
				 tx_index, trader, sender, token_in, token_out, amount_in_raw, amount_in_decimals,
				 amount_out_raw, amount_out_decimals, amount_usd, side, source, event_time, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
				ON CONFLICT (chain_id, tx_hash, log_index, event_time) DO UPDATE SET
					pool_id = EXCLUDED.pool_id, block_number = EXCLUDED.block_number,
					tx_index = EXCLUDED.tx_index, trader = EXCLUDED.trader, sender = EXCLUDED.sender,
					token_in = EXCLUDED.token_in, token_out = EXCLUDED.token_out,
					amount_in_raw = EXCLUDED.amount_in_raw, amount_in_decimals = EXCLUDED.amount_in_decimals,
					amount_out_raw = EXCLUDED.amount_out_raw, amount_out_decimals = EXCLUDED.amount_out_decimals,
					amount_usd = EXCLUDED.amount_usd, side = EXCLUDED.side,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				s.SwapID, s.NaturalKey, s.PoolID, s.ChainID, s.TxHash, s.LogIndex, s.BlockNumber,
				s.TxIndex, nilIfEmpty(s.Trader), nilIfEmpty(s.Sender), s.TokenIn, s.TokenOut,
				s.AmountIn.RawString(), s.AmountIn.Decimals, s.AmountOut.RawString(), s.AmountOut.Decimals,
				decOrNil(s.AmountUSD), nilIfEmpty(s.Side), s.Provenance.SourceProvider, s.EventTime,
				nullTime(s.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// WriteDexCandles implements dexstore.Writer. UNIQUE (pool_id, interval,
// open_time) is the plan §15 candle key.
func (r *Repo) WriteDexCandles(ctx context.Context, rows []canon.DexCandle) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateDexCandle, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, c := range good {
			b.Queue(`INSERT INTO data.dex_candle
				(candle_id, natural_key, pool_id, chain_id, interval, open_time, close_time,
				 o, h, l, c, volume_base, volume_quote, volume_usd, trade_count, vwap, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
				ON CONFLICT (pool_id, interval, open_time) DO UPDATE SET
					close_time = EXCLUDED.close_time, o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l,
					c = EXCLUDED.c, volume_base = EXCLUDED.volume_base, volume_quote = EXCLUDED.volume_quote,
					volume_usd = EXCLUDED.volume_usd, trade_count = EXCLUDED.trade_count,
					vwap = EXCLUDED.vwap, source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				c.CandleID, c.NaturalKey, c.PoolID, c.ChainID, c.Interval, c.OpenTime, nullTime(c.CloseTime),
				c.Open.String(), c.High.String(), c.Low.String(), c.Close.String(),
				decOrNil(c.VolumeBase), decOrNil(c.VolumeQuote), decOrNil(c.VolumeUSD),
				c.TradeCount, decOrNil(c.VWAP), c.Provenance.SourceProvider, nullTime(c.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// WriteDexLiquiditySnapshots implements dexstore.Writer. UNIQUE (pool_id, at).
func (r *Repo) WriteDexLiquiditySnapshots(ctx context.Context, rows []canon.DexLiquiditySnapshot) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateDexLiquiditySnapshot, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, s := range good {
			b.Queue(`INSERT INTO data.dex_liquidity_snapshot
				(snapshot_id, natural_key, pool_id, chain_id, at, reserves, liquidity_usd,
				 tick, tick_lower, tick_upper, active_liquidity, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
				ON CONFLICT (pool_id, at) DO UPDATE SET
					reserves = EXCLUDED.reserves, liquidity_usd = EXCLUDED.liquidity_usd,
					tick = EXCLUDED.tick, tick_lower = EXCLUDED.tick_lower,
					tick_upper = EXCLUDED.tick_upper, active_liquidity = EXCLUDED.active_liquidity,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				s.SnapshotID, s.NaturalKey, s.PoolID, s.ChainID, s.At, jsonOrNil(reserveJSON(s.Reserves)),
				decOrNil(s.LiquidityUSD), s.Tick, s.TickLower, s.TickUpper,
				decOrNil(s.ActiveLiquidity), s.Provenance.SourceProvider, nullTime(s.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// WriteDexMarketSnapshots implements dexstore.Writer. UNIQUE (pool_id, at).
func (r *Repo) WriteDexMarketSnapshots(ctx context.Context, rows []canon.DexMarketSnapshot) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateDexMarketSnapshot, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, s := range good {
			b.Queue(`INSERT INTO data.dex_market_snapshot
				(snapshot_id, natural_key, pool_id, chain_id, at, price_usd, price_native,
				 volume_24h_usd, txns_24h, buys_24h, sells_24h, price_change_pct_24h, fdv_usd,
				 market_cap_usd, fee_tier_bps, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
				ON CONFLICT (pool_id, at) DO UPDATE SET
					price_usd = EXCLUDED.price_usd, price_native = EXCLUDED.price_native,
					volume_24h_usd = EXCLUDED.volume_24h_usd, txns_24h = EXCLUDED.txns_24h,
					buys_24h = EXCLUDED.buys_24h, sells_24h = EXCLUDED.sells_24h,
					price_change_pct_24h = EXCLUDED.price_change_pct_24h, fdv_usd = EXCLUDED.fdv_usd,
					market_cap_usd = EXCLUDED.market_cap_usd, fee_tier_bps = EXCLUDED.fee_tier_bps,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				s.SnapshotID, s.NaturalKey, s.PoolID, s.ChainID, s.At,
				decOrNil(s.PriceUSD), decOrNil(s.PriceNative), decOrNil(s.Volume24hUSD),
				s.Txns24h, s.Buys24h, s.Sells24h, decOrNil(s.PriceChangePct24h),
				decOrNil(s.FDVUSD), decOrNil(s.MarketCapUSD), s.FeeTierBps,
				s.Provenance.SourceProvider, nullTime(s.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// reserveJSON maps pool reserves to the jsonb element shape the reserves column
// holds: {token_id, index, raw, decimals, weight, is_base}. Nil/absent parts
// are omitted rather than zeroed.
func reserveJSON(rs []canon.PoolToken) []map[string]any {
	if len(rs) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(rs))
	for _, t := range rs {
		m := map[string]any{"token_id": t.TokenID, "index": t.Index}
		if t.Reserve != nil && t.Reserve.Raw != nil {
			m["raw"] = t.Reserve.RawString()
			m["decimals"] = t.Reserve.Decimals
		}
		if t.Weight != nil && t.Weight.Present() {
			m["weight"] = t.Weight.String()
		}
		if t.IsBase != nil {
			m["is_base"] = *t.IsBase
		}
		out = append(out, m)
	}
	return out
}

// fmtSafe labels a write error with the table it targeted.
func fmtSafe(table string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("repo: write %s: %w", table, err)
}
