package repo

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/jackc/pgx/v5"
)

// Fact writers (canon.Writer half 2). Every Write method validates each row
// (validate.go, contract §35), queues only the accepted rows, and returns
// (written, rejected): written = rows the database confirmed, rejected = rows
// validation refused. Per-row database errors are counted as not-written and
// the first one is returned with the partial count — a batch is not required
// to be atomic, and the engine journals the counts either way.
//
// Timestamps: rows carry their own RetrievedAt when the provider set one;
// the writers never invent one (never-fake) — a zero RetrievedAt is stored
// as NULL, not now().

// splitValid partitions rows into accepted/rejected using the validator.
func splitValid[T any](rows []T, validate func(T, time.Time) (reject, warn string), now time.Time) (good []T, rejected int) {
	for _, row := range rows {
		if reject, _ := validate(row, now); reject != "" {
			rejected++
			continue
		}
		good = append(good, row)
	}
	return good, rejected
}

// WriteOhlcv implements canon.Writer.
func (r *Repo) WriteOhlcv(ctx context.Context, rows []canon.Ohlcv) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateOhlcv, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.ohlcv
				(instrument_id, venue_id, timeframe, open_time, close_time, o, h, l, c,
				 volume_base, volume_quote, trade_count, vwap, source, retrieved_at, provider_record_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
				ON CONFLICT (instrument_id, venue_id, timeframe, open_time) DO UPDATE SET
					close_time = EXCLUDED.close_time, o = EXCLUDED.o, h = EXCLUDED.h,
					l = EXCLUDED.l, c = EXCLUDED.c, volume_base = EXCLUDED.volume_base,
					volume_quote = EXCLUDED.volume_quote, trade_count = EXCLUDED.trade_count,
					vwap = EXCLUDED.vwap, source = EXCLUDED.source,
					retrieved_at = EXCLUDED.retrieved_at,
					provider_record_id = EXCLUDED.provider_record_id`,
				row.InstrumentID, row.VenueID, row.Timeframe, row.OpenTime, nullTime(row.CloseTime),
				row.O, row.H, row.L, row.C, row.VolumeBase, row.VolumeQuote,
				row.TradeCount, row.VWAP, row.Source, nullTime(row.RetrievedAt), nil)
		}
	})
	return written, rejected, err
}

// WriteTrades implements canon.Writer.
func (r *Repo) WriteTrades(ctx context.Context, rows []canon.Trade) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateTrade, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.trade
				(instrument_id, venue_id, provider_trade_id, trade_time, price, quantity,
				 side, aggressor, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
				ON CONFLICT (venue_id, instrument_id, provider_trade_id) DO UPDATE SET
					trade_time = EXCLUDED.trade_time, price = EXCLUDED.price,
					quantity = EXCLUDED.quantity, side = EXCLUDED.side,
					aggressor = EXCLUDED.aggressor, source = EXCLUDED.source,
					retrieved_at = EXCLUDED.retrieved_at`,
				row.InstrumentID, row.VenueID, row.ProviderTradeID, row.TradeTime,
				row.Price, row.Quantity, row.Side, row.Aggressor, row.Source,
				nullTime(row.RetrievedAt))
		}
	})
	return written, rejected, err
}

// WriteQuotes implements canon.Writer.
func (r *Repo) WriteQuotes(ctx context.Context, rows []canon.Quote) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateQuote, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.quote
				(instrument_id, venue_id, at, bid, ask, bid_size, ask_size, last, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
				ON CONFLICT (instrument_id, venue_id, at) DO UPDATE SET
					bid = EXCLUDED.bid, ask = EXCLUDED.ask, bid_size = EXCLUDED.bid_size,
					ask_size = EXCLUDED.ask_size, last = EXCLUDED.last,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				row.InstrumentID, row.VenueID, row.At, row.Bid, row.Ask, row.BidSize,
				row.AskSize, row.Last, row.Source, nullTime(row.RetrievedAt))
		}
	})
	return written, rejected, err
}

// WriteOrderbook implements canon.Writer. Both sides are marshalled to the
// jsonb columns; validation guarantees non-nil sides, so the params are never
// a nil []byte (which pgx would store as SQL NULL).
func (r *Repo) WriteOrderbook(ctx context.Context, rows []canon.OrderbookSnap) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateOrderbookSnap, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			bids, err := json.Marshal(row.Bids)
			if err != nil {
				continue
			}
			asks, err := json.Marshal(row.Asks)
			if err != nil {
				continue
			}
			b.Queue(`INSERT INTO data.orderbook
				(instrument_id, venue_id, at, depth, bids, asks, source)
				VALUES ($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT (instrument_id, venue_id, at) DO UPDATE SET
					depth = EXCLUDED.depth, bids = EXCLUDED.bids, asks = EXCLUDED.asks,
					source = EXCLUDED.source`,
				row.InstrumentID, row.VenueID, row.At, row.Depth, bids, asks, row.Source)
		}
	})
	return written, rejected, err
}

// WriteObservations implements canon.Writer.
func (r *Repo) WriteObservations(ctx context.Context, rows []canon.Observation) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateObservation, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			revision := row.Revision
			if revision == "" {
				revision = "latest"
			}
			provider := row.Source // documented: the provider column spells the family name (§ "source" note in schema.sql)
			b.Queue(`INSERT INTO data.observation
				(series_id, period, observed_at, value, revision, vintage, source, provider,
				 provider_record_id, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
				ON CONFLICT (series_id, period, observed_at, revision) DO UPDATE SET
					value = EXCLUDED.value, vintage = EXCLUDED.vintage, source = EXCLUDED.source,
					provider = EXCLUDED.provider, provider_record_id = EXCLUDED.provider_record_id,
					retrieved_at = EXCLUDED.retrieved_at`,
				row.SeriesID, row.Period, row.ObservedAt, row.Value, revision, row.Vintage,
				row.Source, provider, nil, nullTime(row.RetrievedAt))
		}
	})
	return written, rejected, err
}

// WriteFunding implements canon.Writer.
func (r *Repo) WriteFunding(ctx context.Context, rows []canon.FundingRate) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateFunding, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.funding
				(instrument_id, venue_id, funding_time, rate, cap, predicted, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
				ON CONFLICT (instrument_id, venue_id, funding_time) DO UPDATE SET
					rate = EXCLUDED.rate, cap = EXCLUDED.cap, predicted = EXCLUDED.predicted,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				row.InstrumentID, row.VenueID, row.FundingTime, row.Rate, row.Cap,
				false, row.Source, nullTime(row.RetrievedAt))
		}
	})
	return written, rejected, err
}

// WriteOpenInterest implements canon.Writer.
func (r *Repo) WriteOpenInterest(ctx context.Context, rows []canon.OpenInterest) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateOpenInterest, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.open_interest
				(instrument_id, venue_id, at, oi_usd, oi_base, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7)
				ON CONFLICT (instrument_id, venue_id, at) DO UPDATE SET
					oi_usd = EXCLUDED.oi_usd, oi_base = EXCLUDED.oi_base,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				row.InstrumentID, row.VenueID, row.OIAt, row.OpenInterestUSD,
				row.OpenInterestBase, row.Source, nullTime(row.RetrievedAt))
		}
	})
	return written, rejected, err
}

// WritePools implements canon.Writer.
func (r *Repo) WritePools(ctx context.Context, rows []canon.Pool) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validatePool, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.pool
				(pool_id, at, chain_id, dex_venue_id, address, base_asset_id, quote_asset_id,
				 base_symbol, quote_symbol, fee_tier_bps, price, liquidity_usd, volume_24h_usd,
				 fdv_usd, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
				ON CONFLICT (pool_id, at) DO UPDATE SET
					dex_venue_id = EXCLUDED.dex_venue_id, base_asset_id = EXCLUDED.base_asset_id,
					quote_asset_id = EXCLUDED.quote_asset_id, base_symbol = EXCLUDED.base_symbol,
					quote_symbol = EXCLUDED.quote_symbol, fee_tier_bps = EXCLUDED.fee_tier_bps,
					price = EXCLUDED.price, liquidity_usd = EXCLUDED.liquidity_usd,
					volume_24h_usd = EXCLUDED.volume_24h_usd, fdv_usd = EXCLUDED.fdv_usd,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				row.PoolID, row.At, row.ChainID, nilIfEmpty(row.DEXVenueID), row.Address,
				row.BaseAssetID, row.QuoteAssetID, nil, nil, row.FeeTierBps, row.Price,
				row.LiquidityUSD, row.Volume24hUSD, row.FdvUsd, row.Source,
				nullTime(row.RetrievedAt))
		}
	})
	return written, rejected, err
}

// WriteArticles implements canon.Writer. The canonical id (ArticleID) doubles
// as the provider_article_id natural key: it is opaque (DR-036) and unique
// per provider, never parsed — and the provider name rides on Source (the
// family name, e.g. "coinglass"), matching the Article struct's only
// provider-carrying field.
func (r *Repo) WriteArticles(ctx context.Context, rows []canon.Article) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateArticle, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.news_article
				(article_id, provider, provider_article_id, headline, summary, url, publisher,
				 published_at, language, topics, assets, countries, sentiment, importance,
				 source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
				ON CONFLICT (article_id) DO UPDATE SET
					provider = EXCLUDED.provider, provider_article_id = EXCLUDED.provider_article_id,
					headline = EXCLUDED.headline, summary = EXCLUDED.summary, url = EXCLUDED.url,
					publisher = EXCLUDED.publisher, published_at = EXCLUDED.published_at,
					language = EXCLUDED.language, topics = EXCLUDED.topics,
					assets = EXCLUDED.assets, countries = EXCLUDED.countries,
					sentiment = EXCLUDED.sentiment, importance = EXCLUDED.importance,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				row.ArticleID, row.Source, row.ArticleID, row.Headline, row.Summary, row.URL,
				row.Publisher, row.PublishedAt, row.Language, row.Topics, row.Assets,
				[]string{}, row.Sentiment, nil, row.Source, nullTime(row.RetrievedAt))
		}
	})
	return written, rejected, err
}

// WritePredictionMarkets implements canon.Writer. Same provider-id rule as
// articles: MarketID is the opaque canonical id and the provider-unique
// natural key; Source carries the provider name.
func (r *Repo) WritePredictionMarkets(ctx context.Context, rows []canon.PredictionMarket) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validatePredictionMarket, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.prediction_market
				(market_id, provider, provider_market_id, question, outcomes, prices,
				 liquidity_usd, volume_24h_usd, end_date, resolution_status, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
				ON CONFLICT (market_id) DO UPDATE SET
					provider = EXCLUDED.provider, provider_market_id = EXCLUDED.provider_market_id,
					question = EXCLUDED.question, outcomes = EXCLUDED.outcomes,
					prices = EXCLUDED.prices, liquidity_usd = EXCLUDED.liquidity_usd,
					volume_24h_usd = EXCLUDED.volume_24h_usd, end_date = EXCLUDED.end_date,
					resolution_status = EXCLUDED.resolution_status, source = EXCLUDED.source,
					retrieved_at = EXCLUDED.retrieved_at`,
				row.MarketID, row.Source, row.MarketID, nilIfEmpty(row.Question),
				row.Outcomes, row.Prices, row.LiquidityUSD, row.Volume24hUSD, row.EndDate,
				nilIfEmpty(row.ResolutionStatus), row.Source, nullTime(row.RetrievedAt))
		}
	})
	return written, rejected, err
}

// WriteChainTVL implements canon.Writer.
func (r *Repo) WriteChainTVL(ctx context.Context, rows []canon.ChainTVL) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateChainTVL, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.tvl_chain (chain_id, at, tvl_usd, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5)
				ON CONFLICT (chain_id, at) DO UPDATE SET
					tvl_usd = EXCLUDED.tvl_usd, source = EXCLUDED.source,
					retrieved_at = EXCLUDED.retrieved_at`,
				row.ChainID, row.At, row.TVLUSD, row.Source, nil)
		}
	})
	return written, rejected, err
}

// WriteProtocolTVL implements canon.Writer. Empty ChainID is the protocol-
// aggregated observation (the column's DEFAULT empty-string spelling).
func (r *Repo) WriteProtocolTVL(ctx context.Context, rows []canon.ProtocolTVL) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateProtocolTVL, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			chainID := row.ChainID
			if chainID == "" {
				chainID = ""
			}
			b.Queue(`INSERT INTO data.tvl_protocol (protocol_id, chain_id, at, tvl_usd, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6)
				ON CONFLICT (protocol_id, chain_id, at) DO UPDATE SET
					tvl_usd = EXCLUDED.tvl_usd, source = EXCLUDED.source,
					retrieved_at = EXCLUDED.retrieved_at`,
				row.ProtocolID, chainID, row.At, row.TVLUSD, row.Source, nil)
		}
	})
	return written, rejected, err
}

// WriteSupply implements canon.Writer.
func (r *Repo) WriteSupply(ctx context.Context, rows []canon.SupplySnapshot) (written, rejected int, err error) {
	now := time.Now()
	good, rejected := splitValid(rows, validateSupply, now)
	written, err = r.execBatchTolerant(ctx, len(good), func(b *pgx.Batch) {
		for _, row := range good {
			b.Queue(`INSERT INTO data.supply
				(chain_id, address, at, asset_id, total_supply, circulating_supply,
				 source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
				ON CONFLICT (chain_id, address, at) DO UPDATE SET
					asset_id = EXCLUDED.asset_id, total_supply = EXCLUDED.total_supply,
					circulating_supply = EXCLUDED.circulating_supply,
					source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at`,
				row.ChainID, row.Address, row.At, row.AssetID, row.TotalSupply,
				row.CirculatingSupply, row.Source, nil)
		}
	})
	return written, rejected, err
}

// WriteMetric implements canon.Writer. All-or-nothing per call: every point
// is validated first (any bad point fails the call with the row index), then
// the batch runs strict — the count is either all points or the error.
func (r *Repo) WriteMetric(ctx context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	if seriesID == "" {
		return 0, fmt.Errorf("repo: write metric: empty series id")
	}
	now := time.Now()
	for i := range points {
		if reject, _ := validateMetricPoint(points[i], now); reject != "" {
			return 0, fmt.Errorf("repo: write metric %s: point %d: %s", seriesID, i, reject)
		}
	}
	if err := r.execBatchStrict(ctx, len(points), func(b *pgx.Batch) {
		for _, p := range points {
			source := p.Source
			if source == "" {
				source = "derived"
			}
			meta := any(nil)
			if p.Meta != nil {
				if b, err := json.Marshal(p.Meta); err == nil {
					meta = b
				}
			}
			b.Queue(`INSERT INTO data.metric (series_id, at, value, meta, source)
				VALUES ($1,$2,$3,$4,$5)
				ON CONFLICT (series_id, at) DO UPDATE SET
					value = EXCLUDED.value, meta = EXCLUDED.meta, source = EXCLUDED.source`,
				seriesID, p.At, p.Value, meta, source)
		}
	}); err != nil {
		return 0, err
	}
	return len(points), nil
}

// nullTime maps a zero time to SQL NULL (never-fake: absence is NULL).
func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}
