package repo

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/jackc/pgx/v5"
)

// This file is the second half of the DEX fact writers: LP positions, wallet
// activity, route quotes, risk metrics and MEV events. Same shape and numeric
// mapping as dex_facts.go.

// WriteDexLiquidityPositions implements dexstore.Writer. UNIQUE (pool_id,
// owner, at).
func (r *Repo) WriteDexLiquidityPositions(ctx context.Context, rows []canon.DexLiquidityPosition) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateDexLiquidityPosition, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, p := range good {
			b.Queue(`INSERT INTO data.dex_liquidity_position
				(position_id, natural_key, pool_id, chain_id, owner, token_id, nft_token_id,
				 amounts, tick_lower, tick_upper, liquidity, value_usd, at, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
				ON CONFLICT (pool_id, owner, at) DO UPDATE SET
					token_id = EXCLUDED.token_id, nft_token_id = EXCLUDED.nft_token_id,
					amounts = EXCLUDED.amounts, tick_lower = EXCLUDED.tick_lower,
					tick_upper = EXCLUDED.tick_upper, liquidity = EXCLUDED.liquidity,
					value_usd = EXCLUDED.value_usd, source = EXCLUDED.source,
					retrieved_at = EXCLUDED.retrieved_at`,
				p.PositionID, p.NaturalKey, p.PoolID, p.ChainID, p.Owner,
				nilIfEmpty(p.TokenID), p.NFTTokenID, jsonOrNil(reserveJSON(p.Amounts)),
				p.TickLower, p.TickUpper, decOrNil(p.Liquidity), decOrNil(p.ValueUSD),
				p.At, p.Provenance.SourceProvider, nullTime(p.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// WriteDexWalletActivity implements dexstore.Writer. UNIQUE (provider,
// natural_key, event_time).
func (r *Repo) WriteDexWalletActivity(ctx context.Context, rows []canon.WalletActivity) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateWalletActivity, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, a := range good {
			b.Queue(`INSERT INTO data.dex_wallet_activity
				(activity_id, natural_key, provider, chain_id, wallet, kind, pool_id, token_id,
				 amount_raw, amount_decimals, value_usd, tx_hash, counterparty, source, event_time, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
				ON CONFLICT (provider, natural_key, event_time) DO UPDATE SET
					wallet = EXCLUDED.wallet, kind = EXCLUDED.kind, pool_id = EXCLUDED.pool_id,
					token_id = EXCLUDED.token_id, amount_raw = EXCLUDED.amount_raw,
					amount_decimals = EXCLUDED.amount_decimals, value_usd = EXCLUDED.value_usd,
					tx_hash = EXCLUDED.tx_hash, counterparty = EXCLUDED.counterparty,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				a.ActivityID, a.NaturalKey, a.Provider, a.ChainID, a.Wallet, a.Kind,
				nilIfEmpty(a.PoolID), nilIfEmpty(a.TokenID), rawOrNil(a.Amount), decimalsOrNil(a.Amount),
				decOrNil(a.ValueUSD), nilIfEmpty(a.TxHash), nilIfEmpty(a.Counterparty),
				a.Provenance.SourceProvider, a.EventTime, nullTime(a.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// WriteDexRouteQuotes implements dexstore.Writer. UNIQUE (natural_key): a
// re-quote at the same (provider, pair, size) updates the row rather than
// stacking duplicates.
func (r *Repo) WriteDexRouteQuotes(ctx context.Context, rows []canon.RouteQuote) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateRouteQuote, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, q := range good {
			b.Queue(`INSERT INTO data.dex_route_quote
				(quote_id, natural_key, provider, chain_id, token_in, token_out,
				 amount_in_raw, amount_in_decimals, amount_out_raw, amount_out_decimals,
				 expected_output_usd, gas_estimate_usd, gas_estimate_raw, gas_estimate_decimals,
				 price_impact_pct, slippage_pct, legs, quoted_at, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
				ON CONFLICT (natural_key) DO UPDATE SET
					amount_out_raw = EXCLUDED.amount_out_raw, amount_out_decimals = EXCLUDED.amount_out_decimals,
					expected_output_usd = EXCLUDED.expected_output_usd, gas_estimate_usd = EXCLUDED.gas_estimate_usd,
					gas_estimate_raw = EXCLUDED.gas_estimate_raw, gas_estimate_decimals = EXCLUDED.gas_estimate_decimals,
					price_impact_pct = EXCLUDED.price_impact_pct, slippage_pct = EXCLUDED.slippage_pct,
					legs = EXCLUDED.legs, quoted_at = EXCLUDED.quoted_at, retrieved_at = EXCLUDED.retrieved_at`,
				q.QuoteID, q.NaturalKey, q.Provider, q.ChainID, q.TokenIn, q.TokenOut,
				q.AmountIn.RawString(), q.AmountIn.Decimals, q.AmountOut.RawString(), q.AmountOut.Decimals,
				decOrNil(q.ExpectedOutputUSD), decOrNil(q.GasUSD),
				rawOrNil(q.GasEstimate), decimalsOrNil(q.GasEstimate),
				decOrNil(q.PriceImpactPct), decOrNil(q.SlippagePct), jsonOrNil(q.Legs),
				q.QuotedAt, nullTime(q.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// WriteDexRiskMetrics implements dexstore.Writer. UNIQUE (natural_key, at).
func (r *Repo) WriteDexRiskMetrics(ctx context.Context, rows []canon.RiskMetric) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateRiskMetric, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, m := range good {
			b.Queue(`INSERT INTO data.dex_risk_metric
				(risk_id, natural_key, subject_key, metric, score, band, algorithm_version,
				 input_sources, at, source)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
				ON CONFLICT (natural_key, at) DO UPDATE SET
					score = EXCLUDED.score, band = EXCLUDED.band,
					input_sources = EXCLUDED.input_sources, source = EXCLUDED.source`,
				m.RiskID, m.NaturalKey, m.SubjectKey, m.Metric, m.Score.String(),
				nilIfEmpty(m.Band), m.AlgorithmVersion, emptyToNilSlice(m.InputSources),
				m.At, m.Provenance.SourceProvider)
		}
	})
	return written, rejected, err
}

// WriteDexMEVEvents implements dexstore.Writer. UNIQUE (chain_id, tx_hash,
// event_time): a transaction is classified once.
func (r *Repo) WriteDexMEVEvents(ctx context.Context, rows []canon.MEVEvent) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateMEVEvent, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, e := range good {
			b.Queue(`INSERT INTO data.dex_mev_event
				(mev_id, natural_key, chain_id, tx_hash, block_number, kind, pool_id, victim,
				 attacker, profit_usd, profit_raw, profit_decimals, source, event_time, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
				ON CONFLICT (chain_id, tx_hash, event_time) DO UPDATE SET
					block_number = EXCLUDED.block_number, kind = EXCLUDED.kind, pool_id = EXCLUDED.pool_id,
					victim = EXCLUDED.victim, attacker = EXCLUDED.attacker, profit_usd = EXCLUDED.profit_usd,
					profit_raw = EXCLUDED.profit_raw, profit_decimals = EXCLUDED.profit_decimals,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				e.MEVID, e.NaturalKey, e.ChainID, e.TxHash, e.BlockNumber, e.Kind,
				nilIfEmpty(e.PoolID), nilIfEmpty(e.Victim), nilIfEmpty(e.Attacker),
				decOrNil(e.ProfitUSD), rawOrNil(e.ProfitToken), decimalsOrNil(e.ProfitToken),
				e.Provenance.SourceProvider, e.EventTime, nullTime(e.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// emptyToNilSlice collapses an empty string slice to SQL NULL (never-fake
// prefers NULL over an empty array).
func emptyToNilSlice(s []string) any {
	if len(s) == 0 {
		return nil
	}
	return s
}
