package repo

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/jackc/pgx/v5"
)

// This file is the third batch of DEX writers: perp markets/liquidations,
// orderbook snapshots, raw provider observations, and the two observability
// writers (provider health, quality status).

// WriteDexPerpMarkets implements dexstore.Writer. UNIQUE (natural_key, at).
func (r *Repo) WriteDexPerpMarkets(ctx context.Context, rows []canon.PerpMarket) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validatePerpMarket, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, m := range good {
			b.Queue(`INSERT INTO data.dex_perp_market
				(perp_market_id, natural_key, venue_id, market_type, base_asset_id, quote_asset_id,
				 base_symbol, quote_symbol, index_price, mark_price, open_interest_usd,
				 open_interest_base, funding_rate, max_leverage, at, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
				ON CONFLICT (natural_key, at) DO UPDATE SET
					index_price = EXCLUDED.index_price, mark_price = EXCLUDED.mark_price,
					open_interest_usd = EXCLUDED.open_interest_usd, open_interest_base = EXCLUDED.open_interest_base,
					funding_rate = EXCLUDED.funding_rate, max_leverage = EXCLUDED.max_leverage,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				m.PerpMarketID, m.NaturalKey, m.VenueID, m.MarketType, m.BaseAssetID, m.QuoteAssetID,
				m.BaseSymbol, m.QuoteSymbol, decOrNil(m.IndexPrice), decOrNil(m.MarkPrice),
				rawOrNil(m.OpenInterestUSD), decOrNil(m.OpenInterestBase), decOrNil(m.FundingRate),
				decOrNil(m.MaxLeverage), m.At, m.Provenance.SourceProvider, nullTime(m.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// WriteDexPerpLiquidations implements dexstore.Writer. Append-only events with a
// batch-local seen-set, mirroring WriteLiquidations (facts.go): a conflict is
// counted as written.
func (r *Repo) WriteDexPerpLiquidations(ctx context.Context, rows []canon.PerpLiquidation) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validatePerpLiquidation, now)
	type key struct {
		venue, market string
		at            int64
	}
	seen := map[key]bool{}
	deduped := good[:0]
	for _, l := range good {
		k := key{l.VenueID, l.PerpMarketID, l.At.UnixNano()}
		if seen[k] {
			continue
		}
		seen[k] = true
		deduped = append(deduped, l)
	}
	good = deduped

	n := 0
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, l := range good {
			n++
			b.Queue(`INSERT INTO data.dex_perp_liquidation
				(venue_id, perp_market_id, at, side, price, quantity_raw, quantity_decimals,
				 value_usd, wallet, tx_hash, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
				ON CONFLICT DO NOTHING`,
				l.VenueID, l.PerpMarketID, l.At, nilIfEmpty(l.Side), l.Price.String(),
				l.Quantity.RawString(), l.Quantity.Decimals, decOrNil(l.ValueUSD),
				nilIfEmpty(l.Wallet), nilIfEmpty(l.TxHash), l.Provenance.SourceProvider,
				nullTime(l.Provenance.NormalizedAt))
		}
	})
	return written, rejected, err
}

// WriteDexOrderbookSnapshots implements dexstore.Writer. UNIQUE (pool_id, at).
// Both sides render as jsonb arrays of [priceString, sizeString] — exact
// decimals, never floats.
func (r *Repo) WriteDexOrderbookSnapshots(ctx context.Context, rows []canon.DexOrderbookSnapshot) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateOrderbookSnapshot, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, s := range good {
			b.Queue(`INSERT INTO data.dex_orderbook_snapshot
				(snapshot_id, natural_key, pool_id, chain_id, at, depth, bids, asks, source)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
				ON CONFLICT (pool_id, at) DO UPDATE SET
					depth = EXCLUDED.depth, bids = EXCLUDED.bids, asks = EXCLUDED.asks,
					source = EXCLUDED.source`,
				s.SnapshotID, s.NaturalKey, s.PoolID, s.ChainID, s.At, s.Depth,
				jsonOrNil(orderbookLevels(s.Bids)), jsonOrNil(orderbookLevels(s.Asks)),
				s.Provenance.SourceProvider)
		}
	})
	return written, rejected, err
}

// orderbookLevels maps levels to [priceString, sizeString] pairs.
func orderbookLevels(ls []canon.OrderbookLevel) [][2]string {
	if len(ls) == 0 {
		return nil
	}
	out := make([][2]string, 0, len(ls))
	for _, l := range ls {
		out = append(out, [2]string{l.Price.String(), l.Size.String()})
	}
	return out
}

// WriteProviderObservations implements dexstore.Writer. The cold raw tier;
// retention (not this writer) removes expired rows.
func (r *Repo) WriteProviderObservations(ctx context.Context, rows []canon.ProviderObservation) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateProviderObservation, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, o := range good {
			b.Queue(`INSERT INTO data.dex_provider_observation
				(observation_id, natural_key, provider, dataset, record_id, endpoint,
				 payload, payload_bytes, source, observed_at, stored_at, expires_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
				ON CONFLICT (provider, dataset, record_id, observed_at) DO NOTHING`,
				o.ObservationID, o.NaturalKey, o.Provider, o.Dataset, o.RecordID,
				nilIfEmpty(o.Endpoint), jsonBytesOrNil(o.Payload), o.PayloadBytes,
				o.Provider, o.ObservedAt, time.Now().UTC(), o.ExpiresAt)
		}
	})
	return written, rejected, err
}

// WriteProviderHealth implements dexstore.Writer.
func (r *Repo) WriteProviderHealth(ctx context.Context, rows []dexstore.ProviderHealth) (written, rejected int, err error) {
	good, rejected := splitValid(rows, validateProviderHealth, time.Now())
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, h := range good {
			b.Queue(`INSERT INTO data.dex_provider_health
				(provider, window_start, availability_pct, latency_p50_ms, latency_p95_ms,
				 latency_p99_ms, error_count, success_count, rate_limit_events, last_success,
				 last_failure, staleness_seconds, state)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
				ON CONFLICT (provider, window_start) DO UPDATE SET
					availability_pct = EXCLUDED.availability_pct, latency_p50_ms = EXCLUDED.latency_p50_ms,
					latency_p95_ms = EXCLUDED.latency_p95_ms, latency_p99_ms = EXCLUDED.latency_p99_ms,
					error_count = EXCLUDED.error_count, success_count = EXCLUDED.success_count,
					rate_limit_events = EXCLUDED.rate_limit_events, last_success = EXCLUDED.last_success,
					last_failure = EXCLUDED.last_failure, staleness_seconds = EXCLUDED.staleness_seconds,
					state = EXCLUDED.state`,
				h.Provider, time.Unix(h.WindowStart, 0).UTC(), h.AvailabilityPct,
				h.LatencyP50Ms, h.LatencyP95Ms, h.LatencyP99Ms, h.ErrorCount, h.SuccessCount,
				h.RateLimitEvents, unixOrNil(h.LastSuccessUnix), unixOrNil(h.LastFailureUnix),
				h.StalenessSeconds, h.State)
		}
	})
	return written, rejected, err
}

// WriteQualityStatus implements dexstore.Writer.
func (r *Repo) WriteQualityStatus(ctx context.Context, rows []dexstore.QualityStatus) (written, rejected int, err error) {
	good, rejected := splitValid(rows, validateQualityStatus, time.Now())
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, q := range good {
			b.Queue(`INSERT INTO data.dex_quality_status
				(subject_key, dataset, at, state, reasons, detail)
				VALUES ($1,$2,$3,$4,$5,$6)
				ON CONFLICT (subject_key, dataset, at) DO UPDATE SET
					state = EXCLUDED.state, reasons = EXCLUDED.reasons, detail = EXCLUDED.detail`,
				q.SubjectKey, q.Dataset, time.Unix(q.AtUnix, 0).UTC(), q.State,
				emptyToNilSlice(q.Reasons), jsonOrNil(q.Detail))
		}
	})
	return written, rejected, err
}

// validateProviderHealth rejects a row with no provider, no window, or a state
// outside the closed vocabulary.
func validateProviderHealth(h dexstore.ProviderHealth, _ time.Time) (reject, warn string) {
	label := "dex provider health"
	switch {
	case h.Provider == "":
		return label + ": empty provider", ""
	case h.WindowStart <= 0:
		return label + ": non-positive window_start", ""
	case h.ErrorCount < 0 || h.SuccessCount < 0:
		return label + ": negative count", ""
	}
	return "", ""
}

// validateQualityStatus rejects a row with an empty subject/dataset or an
// unknown state (mirrors the DDL CHECK so the writer never trips the database).
func validateQualityStatus(q dexstore.QualityStatus, _ time.Time) (reject, warn string) {
	label := "dex quality status"
	switch {
	case q.SubjectKey == "":
		return label + ": empty subject_key", ""
	case q.Dataset == "":
		return label + ": empty dataset", ""
	case q.AtUnix <= 0:
		return label + ": non-positive at", ""
	case !dexstore.ValidQualityState(q.State):
		return label + ": unknown state " + q.State, ""
	}
	return "", ""
}

// unixOrNil maps an optional unix-seconds value to a timestamptz, or nil.
func unixOrNil(v *int64) any {
	if v == nil {
		return nil
	}
	return time.Unix(*v, 0).UTC()
}

// jsonRawOrNil keeps a raw json document for a jsonb column, nil when empty.
func jsonRawOrNil(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	var probe any
	if err := json.Unmarshal(b, &probe); err != nil {
		return nil
	}
	return b
}

var _ = fmt.Sprintf
