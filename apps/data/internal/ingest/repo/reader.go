package repo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/jackc/pgx/v5"
)

// Reader (canon.Reader, ADDENDUM A): windowed reads the /api/data handlers
// serve. Windows are half-open [start, end); zero start/end are unbounded on
// that side. Rows are read ORDER BY <time> DESC (the newest-first serving
// order) and reversed so the returned slice is time-ASC — the natural shape
// for charts — except the list endpoints, which have their own documented
// ordering. LIMIT is clamped by clampLimit (zero = provider default 100, cap
// 1000).

// listRows runs a window query with the given filter and limit and scans it
// via scan, returning rows in the SQL's own order (the list endpoints keep
// their documented ordering).
func listRows[T any](ctx context.Context, r *Repo, sql string, args []any, limit int, scan func(pgx.Rows) (T, error)) ([]T, error) {
	out, err := listRowsRaw(ctx, r, sql, args, limit, scan)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// listRowsASC is listRows plus a reversal: window queries read
// ORDER BY <time> DESC (newest-first, so LIMIT keeps the LATEST rows —
// LIMIT on an ASC read would silently keep the oldest), then the slice is
// reversed to the time-ASC shape charts want.
func listRowsASC[T any](ctx context.Context, r *Repo, sql string, args []any, limit int, scan func(pgx.Rows) (T, error)) ([]T, error) {
	out, err := listRowsRaw(ctx, r, sql, args, limit, scan)
	if err != nil {
		return nil, err
	}
	slices.Reverse(out)
	return out, nil
}

// listRowsRaw executes and scans without touching row order.
func listRowsRaw[T any](ctx context.Context, r *Repo, sql string, args []any, limit int, scan func(pgx.Rows) (T, error)) ([]T, error) {
	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("repo: query: %w", err)
	}
	defer rows.Close()
	out := make([]T, 0, clampLimit(limit))
	for rows.Next() {
		row, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo: scan: %w", err)
	}
	return out, nil
}

// ListAssets implements canon.Reader.
func (r *Repo) ListAssets(ctx context.Context, q canon.ListQuery) ([]canon.Asset, error) {
	f := &filter{}
	if q.Search != "" {
		f.add("(symbol ILIKE "+f.nextArg()+" OR name ILIKE "+f.nextArg()+")", "%"+q.Search+"%", "%"+q.Search+"%")
	}
	lo := len(f.args) + 1
	sql := `SELECT asset_id, symbol, name, kind, chain_id, decimals, created_at, updated_at
		FROM data.asset` + f.where() + fmt.Sprintf(" ORDER BY kind, symbol LIMIT $%d OFFSET $%d", lo, lo+1)
	args := append(f.args, clampLimit(q.Limit), q.Offset)
	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("repo: list assets: %w", err)
	}
	defer rows.Close()
	out := []canon.Asset{}
	for rows.Next() {
		var a canon.Asset
		if err := rows.Scan(&a.AssetID, &a.Symbol, &a.Name, &a.Kind, &a.ChainID, &a.Decimals, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, fmt.Errorf("repo: list assets scan: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListChains implements canon.Reader.
func (r *Repo) ListChains(ctx context.Context, q canon.ListQuery) ([]canon.Chain, error) {
	f := &filter{}
	if q.Search != "" {
		f.add("(name ILIKE "+f.nextArg()+" OR display_name ILIKE "+f.nextArg()+")", "%"+q.Search+"%", "%"+q.Search+"%")
	}
	lo := len(f.args) + 1
	sql := `SELECT chain_id, name, display_name, kind, native_asset_id, chain_numeric_id, created_at, updated_at
		FROM data.chain` + f.where() + fmt.Sprintf(" ORDER BY name LIMIT $%d OFFSET $%d", lo, lo+1)
	args := append(f.args, clampLimit(q.Limit), q.Offset)
	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("repo: list chains: %w", err)
	}
	defer rows.Close()
	out := []canon.Chain{}
	for rows.Next() {
		var c canon.Chain
		if err := rows.Scan(&c.ChainID, &c.Name, &c.DisplayName, &c.Kind, &c.NativeAssetID, &c.ChainNumericID, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, fmt.Errorf("repo: list chains scan: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ListVenues implements canon.Reader.
func (r *Repo) ListVenues(ctx context.Context, q canon.ListQuery) ([]canon.Venue, error) {
	f := &filter{}
	if q.Search != "" {
		f.add("name ILIKE "+f.nextArg(), "%"+q.Search+"%")
	}
	lo := len(f.args) + 1
	sql := `SELECT venue_id, name, kind, known, market_types, url, created_at, updated_at
		FROM data.venue` + f.where() + fmt.Sprintf(" ORDER BY venue_id LIMIT $%d OFFSET $%d", lo, lo+1)
	args := append(f.args, clampLimit(q.Limit), q.Offset)
	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("repo: list venues: %w", err)
	}
	defer rows.Close()
	out := []canon.Venue{}
	for rows.Next() {
		var v canon.Venue
		if err := rows.Scan(&v.VenueID, &v.Name, &v.Kind, &v.Known, &v.MarketTypes, &v.URL, &v.CreatedAt, &v.UpdatedAt); err != nil {
			return nil, fmt.Errorf("repo: list venues scan: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// ListProtocols implements canon.Reader.
func (r *Repo) ListProtocols(ctx context.Context, q canon.ListQuery) ([]canon.Protocol, error) {
	f := &filter{}
	if q.Search != "" {
		f.add("(slug ILIKE "+f.nextArg()+" OR name ILIKE "+f.nextArg()+")", "%"+q.Search+"%", "%"+q.Search+"%")
	}
	lo := len(f.args) + 1
	sql := `SELECT protocol_id, slug, name, category, created_at, updated_at
		FROM data.protocol` + f.where() + fmt.Sprintf(" ORDER BY slug LIMIT $%d OFFSET $%d", lo, lo+1)
	args := append(f.args, clampLimit(q.Limit), q.Offset)
	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("repo: list protocols: %w", err)
	}
	defer rows.Close()
	out := []canon.Protocol{}
	for rows.Next() {
		var p canon.Protocol
		if err := rows.Scan(&p.ProtocolID, &p.Slug, &p.Name, &p.Category, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("repo: list protocols scan: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListInstruments implements canon.Reader.
func (r *Repo) ListInstruments(ctx context.Context, q canon.InstrumentQuery) ([]canon.Instrument, error) {
	f := &filter{}
	if q.VenueID != "" {
		f.add("venue_id = "+f.nextArg(), q.VenueID)
	}
	if q.MarketType != "" {
		f.add("market_type = "+f.nextArg(), q.MarketType)
	}
	if q.Base != "" {
		f.add("base_symbol = "+f.nextArg(), q.Base)
	}
	if q.Quote != "" {
		f.add("quote_symbol = "+f.nextArg(), q.Quote)
	}
	lo := len(f.args) + 1
	sql := `SELECT instrument_id, venue_id, market_type, base_asset_id, quote_asset_id,
		base_symbol, quote_symbol, expiry, strike,
		coalesce(option_type, ''), tick_size, lot_size,
		contract_size, isin, cusip, figi, ticker, status, created_at, updated_at
		FROM data.instrument` + f.where() +
		fmt.Sprintf(" ORDER BY venue_id, base_symbol, quote_symbol LIMIT $%d OFFSET $%d", lo, lo+1)
	args := append(f.args, clampLimit(q.Limit), q.Offset)
	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("repo: list instruments: %w", err)
	}
	defer rows.Close()
	out := []canon.Instrument{}
	for rows.Next() {
		var i canon.Instrument
		if err := rows.Scan(&i.InstrumentID, &i.VenueID, &i.MarketType, &i.BaseAssetID, &i.QuoteAssetID,
			&i.BaseSymbol, &i.QuoteSymbol, &i.Expiry, &i.Strike, &i.OptionType, &i.TickSize,
			&i.LotSize, &i.ContractSize, &i.ISIN, &i.CUSIP, &i.FIGI, &i.Ticker, &i.Status,
			&i.CreatedAt, &i.UpdatedAt); err != nil {
			return nil, fmt.Errorf("repo: list instruments scan: %w", err)
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// ListSeries implements canon.Reader.
func (r *Repo) ListSeries(ctx context.Context, q canon.SeriesQuery) ([]canon.SeriesMeta, error) {
	f := &filter{}
	if q.Domain != "" {
		f.add("domain = "+f.nextArg(), q.Domain)
	}
	if q.Metric != "" {
		f.add("metric = "+f.nextArg(), q.Metric)
	}
	if q.SubjectKey != "" {
		f.add("subject_key = "+f.nextArg(), q.SubjectKey)
	}
	if q.CountryID != "" {
		f.add("country_id = "+f.nextArg(), q.CountryID)
	}
	if q.AssetID != "" {
		f.add("asset_id = "+f.nextArg(), q.AssetID)
	}
	if q.InstrumentID != "" {
		f.add("instrument_id = "+f.nextArg(), q.InstrumentID)
	}
	if q.ChainID != "" {
		f.add("chain_id = "+f.nextArg(), q.ChainID)
	}
	if q.ProtocolID != "" {
		f.add("protocol_id = "+f.nextArg(), q.ProtocolID)
	}
	if q.VenueID != "" {
		f.add("venue_id = "+f.nextArg(), q.VenueID)
	}
	lo := len(f.args) + 1
	sql := `SELECT series_id, domain, metric, subject_key, title, unit, frequency, country_id,
		asset_id, instrument_id, chain_id, protocol_id, venue_id, source, provider,
		provider_series_id, revision, is_derived, schema_version, normalization_version,
		created_at, updated_at
		FROM data.series` + f.where() + fmt.Sprintf(" ORDER BY provider, provider_series_id LIMIT $%d", lo)
	args := append(f.args, clampLimit(q.Limit))
	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("repo: list series: %w", err)
	}
	defer rows.Close()
	out := []canon.SeriesMeta{}
	for rows.Next() {
		var s canon.SeriesMeta
		if err := rows.Scan(&s.SeriesID, &s.Domain, &s.Metric, &s.SubjectKey, &s.Title, &s.Unit,
			&s.Frequency, &s.CountryID, &s.AssetID, &s.InstrumentID, &s.ChainID, &s.ProtocolID,
			&s.VenueID, &s.Source, &s.Provider, &s.ProviderSeriesID, &s.Revision, &s.IsDerived,
			&s.SchemaVersion, &s.NormalizationVersion, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("repo: list series scan: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ReadTimeseries implements canon.Reader.
func (r *Repo) ReadTimeseries(ctx context.Context, seriesID string, start, end time.Time, limit int) ([]canon.Observation, error) {
	f := &filter{}
	if seriesID != "" {
		f.add("series_id = "+f.nextArg(), seriesID)
	}
	f.timeRange("observed_at", start, end)
	sql := `SELECT series_id, period, observed_at, value, revision, vintage, source,
		provider, provider_record_id, retrieved_at
		FROM data.observation` + f.where() +
		fmt.Sprintf(" ORDER BY observed_at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanObservation)
}

// scanObservation scans one observation row (reader projection order).
func scanObservation(row pgx.Rows) (canon.Observation, error) {
	var o canon.Observation
	var provider, recordID *string
	var retrieved *time.Time
	err := row.Scan(&o.SeriesID, &o.Period, &o.ObservedAt, &o.Value, &o.Revision, &o.Vintage,
		&o.Source, &provider, &recordID, &retrieved)
	if err != nil {
		return o, fmt.Errorf("repo: scan observation: %w", err)
	}
	if retrieved != nil {
		o.RetrievedAt = *retrieved
	}
	return o, nil
}

// ReadOhlcv implements canon.Reader.
func (r *Repo) ReadOhlcv(ctx context.Context, instrumentID, venueID, timeframe string, start, end time.Time, limit int) ([]canon.Ohlcv, error) {
	f := &filter{}
	if instrumentID != "" {
		f.add("instrument_id = "+f.nextArg(), instrumentID)
	}
	if venueID != "" {
		f.add("venue_id = "+f.nextArg(), venueID)
	}
	if timeframe != "" {
		f.add("timeframe = "+f.nextArg(), timeframe)
	}
	f.timeRange("open_time", start, end)
	sql := `SELECT instrument_id, venue_id, timeframe, open_time, close_time, o, h, l, c,
		volume_base, volume_quote, trade_count, vwap, source, retrieved_at, provider_record_id
		FROM data.ohlcv` + f.where() +
		fmt.Sprintf(" ORDER BY open_time DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanOhlcv)
}

// scanOhlcv scans one ohlcv row (reader projection order).
func scanOhlcv(row pgx.Rows) (canon.Ohlcv, error) {
	var o canon.Ohlcv
	var recordID *string
	err := row.Scan(&o.InstrumentID, &o.VenueID, &o.Timeframe, &o.OpenTime, &o.CloseTime,
		&o.O, &o.H, &o.L, &o.C, &o.VolumeBase, &o.VolumeQuote, &o.TradeCount, &o.VWAP,
		&o.Source, &o.RetrievedAt, &recordID)
	if err != nil {
		return o, fmt.Errorf("repo: scan ohlcv: %w", err)
	}
	return o, nil
}

// ReadFunding implements canon.Reader. Non-empty asset joins instrument and
// filters on its base symbol so callers can ask by asset instead of id.
func (r *Repo) ReadFunding(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]canon.FundingRate, error) {
	f := &filter{}
	join := ""
	if asset != "" {
		join = " JOIN data.instrument i ON i.instrument_id = f.instrument_id"
		f.add("i.base_symbol = "+f.nextArg(), asset)
	}
	if instrumentID != "" {
		f.add("f.instrument_id = "+f.nextArg(), instrumentID)
	}
	if venueID != "" {
		f.add("f.venue_id = "+f.nextArg(), venueID)
	}
	f.timeRange("f.funding_time", start, end)
	sql := `SELECT f.instrument_id, f.venue_id, f.funding_time, f.rate, f.cap, f.source, f.retrieved_at
		FROM data.funding f` + join + f.where() +
		fmt.Sprintf(" ORDER BY f.funding_time DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, func(row pgx.Rows) (canon.FundingRate, error) {
		var fr canon.FundingRate
		if err := row.Scan(&fr.InstrumentID, &fr.VenueID, &fr.FundingTime, &fr.Rate, &fr.Cap,
			&fr.Source, &fr.RetrievedAt); err != nil {
			return fr, fmt.Errorf("repo: scan funding: %w", err)
		}
		return fr, nil
	})
}

// ReadOpenInterest implements canon.Reader with the same asset join.
func (r *Repo) ReadOpenInterest(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]canon.OpenInterest, error) {
	f := &filter{}
	join := ""
	if asset != "" {
		join = " JOIN data.instrument i ON i.instrument_id = o.instrument_id"
		f.add("i.base_symbol = "+f.nextArg(), asset)
	}
	if instrumentID != "" {
		f.add("o.instrument_id = "+f.nextArg(), instrumentID)
	}
	if venueID != "" {
		f.add("o.venue_id = "+f.nextArg(), venueID)
	}
	f.timeRange("o.at", start, end)
	sql := `SELECT o.instrument_id, o.venue_id, o.at, o.oi_usd, o.oi_base, o.source, o.retrieved_at
		FROM data.open_interest o` + join + f.where() +
		fmt.Sprintf(" ORDER BY o.at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, func(row pgx.Rows) (canon.OpenInterest, error) {
		var oi canon.OpenInterest
		if err := row.Scan(&oi.InstrumentID, &oi.VenueID, &oi.OIAt, &oi.OpenInterestUSD,
			&oi.OpenInterestBase, &oi.Source, &oi.RetrievedAt); err != nil {
			return oi, fmt.Errorf("repo: scan open_interest: %w", err)
		}
		return oi, nil
	})
}

// ReadLiquidations implements canon.Reader with the same asset join as the
// other derivatives reads: non-empty asset filters on the instrument's base
// symbol so callers can ask by asset instead of id.
func (r *Repo) ReadLiquidations(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]canon.Liquidation, error) {
	f := &filter{}
	join := ""
	if asset != "" {
		join = " JOIN data.instrument i ON i.instrument_id = l.instrument_id"
		f.add("i.base_symbol = "+f.nextArg(), asset)
	}
	if instrumentID != "" {
		f.add("l.instrument_id = "+f.nextArg(), instrumentID)
	}
	if venueID != "" {
		f.add("l.venue_id = "+f.nextArg(), venueID)
	}
	f.timeRange("l.at", start, end)
	sql := `SELECT l.instrument_id, l.venue_id, l.at, l.side, l.price, l.quantity,
		l.value_usd, l.source, l.retrieved_at
		FROM data.liquidation l` + join + f.where() +
		fmt.Sprintf(" ORDER BY l.at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, func(row pgx.Rows) (canon.Liquidation, error) {
		var li canon.Liquidation
		var retrieved *time.Time
		if err := row.Scan(&li.InstrumentID, &li.VenueID, &li.At, &li.Side, &li.Price,
			&li.Quantity, &li.ValueUSD, &li.Source, &retrieved); err != nil {
			return li, fmt.Errorf("repo: scan liquidation: %w", err)
		}
		if retrieved != nil {
			li.RetrievedAt = *retrieved
		}
		return li, nil
	})
}

// ReadOptionQuotes implements canon.Reader with the same asset join.
func (r *Repo) ReadOptionQuotes(ctx context.Context, instrumentID, venueID, asset string, start, end time.Time, limit int) ([]canon.OptionQuote, error) {
	f := &filter{}
	join := ""
	if asset != "" {
		join = " JOIN data.instrument i ON i.instrument_id = oq.instrument_id"
		f.add("i.base_symbol = "+f.nextArg(), asset)
	}
	if instrumentID != "" {
		f.add("oq.instrument_id = "+f.nextArg(), instrumentID)
	}
	if venueID != "" {
		f.add("oq.venue_id = "+f.nextArg(), venueID)
	}
	f.timeRange("oq.at", start, end)
	sql := `SELECT oq.instrument_id, oq.venue_id, oq.at, oq.mark_price, oq.index_price,
		oq.bid, oq.ask, oq.volume_24h, oq.open_interest, oq.iv, oq.delta, oq.gamma,
		oq.theta, oq.vega, oq.source, oq.retrieved_at
		FROM data.option_quote oq` + join + f.where() +
		fmt.Sprintf(" ORDER BY oq.at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, func(row pgx.Rows) (canon.OptionQuote, error) {
		var q canon.OptionQuote
		var retrieved *time.Time
		if err := row.Scan(&q.InstrumentID, &q.VenueID, &q.At, &q.MarkPrice, &q.IndexPrice,
			&q.Bid, &q.Ask, &q.Volume24h, &q.OpenInterest, &q.IV, &q.Delta, &q.Gamma,
			&q.Theta, &q.Vega, &q.Source, &retrieved); err != nil {
			return q, fmt.Errorf("repo: scan option_quote: %w", err)
		}
		if retrieved != nil {
			q.RetrievedAt = *retrieved
		}
		return q, nil
	})
}

// ReadTrades implements canon.Reader.
func (r *Repo) ReadTrades(ctx context.Context, instrumentID, venueID string, start, end time.Time, limit int) ([]canon.Trade, error) {
	f := &filter{}
	if instrumentID != "" {
		f.add("instrument_id = "+f.nextArg(), instrumentID)
	}
	if venueID != "" {
		f.add("venue_id = "+f.nextArg(), venueID)
	}
	f.timeRange("trade_time", start, end)
	sql := `SELECT instrument_id, venue_id, provider_trade_id, trade_time, price, quantity,
		side, aggressor, source, retrieved_at
		FROM data.trade` + f.where() +
		fmt.Sprintf(" ORDER BY trade_time DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanTrades)
}

// scanTrades scans one trade row (reader projection order).
func scanTrades(row pgx.Rows) (canon.Trade, error) {
	var t canon.Trade
	var retrieved *time.Time
	err := row.Scan(&t.InstrumentID, &t.VenueID, &t.ProviderTradeID, &t.TradeTime, &t.Price,
		&t.Quantity, &t.Side, &t.Aggressor, &t.Source, &retrieved)
	if err != nil {
		return t, fmt.Errorf("repo: scan trade: %w", err)
	}
	if retrieved != nil {
		t.RetrievedAt = *retrieved
	}
	return t, nil
}

// ReadOrderbook implements canon.Reader.
func (r *Repo) ReadOrderbook(ctx context.Context, instrumentID, venueID string, start, end time.Time, limit int) ([]canon.OrderbookSnap, error) {
	f := &filter{}
	if instrumentID != "" {
		f.add("instrument_id = "+f.nextArg(), instrumentID)
	}
	if venueID != "" {
		f.add("venue_id = "+f.nextArg(), venueID)
	}
	f.timeRange("at", start, end)
	sql := `SELECT instrument_id, venue_id, at, depth, bids, asks, source
		FROM data.orderbook` + f.where() +
		fmt.Sprintf(" ORDER BY at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanOrderbook)
}

// scanOrderbook scans one orderbook row (reader projection order). A NULL
// jsonb side decodes to a nil slice, never an error; a NULL depth is zero.
func scanOrderbook(row pgx.Rows) (canon.OrderbookSnap, error) {
	var o canon.OrderbookSnap
	var depth *int
	var bids, asks []byte
	err := row.Scan(&o.InstrumentID, &o.VenueID, &o.At, &depth, &bids, &asks, &o.Source)
	if err != nil {
		return o, fmt.Errorf("repo: scan orderbook: %w", err)
	}
	if depth != nil {
		o.Depth = *depth
	}
	if len(bids) > 0 {
		if err := json.Unmarshal(bids, &o.Bids); err != nil {
			return o, fmt.Errorf("repo: scan orderbook bids: %w", err)
		}
	}
	if len(asks) > 0 {
		if err := json.Unmarshal(asks, &o.Asks); err != nil {
			return o, fmt.Errorf("repo: scan orderbook asks: %w", err)
		}
	}
	return o, nil
}

// ListPools implements canon.Reader. Filters: chain, DEX venue and minimum
// liquidity (the pool table carries no base/quote symbol columns — pool
// identity is (chain, address), and asset anchoring rides on the asset ids;
// symbol-shaped pool queries resolve through provider_symbol upstream).
func (r *Repo) ListPools(ctx context.Context, q canon.PoolQuery) ([]canon.Pool, error) {
	f := &filter{}
	if q.ChainID != "" {
		f.add("chain_id = "+f.nextArg(), q.ChainID)
	}
	if q.DEXID != "" {
		f.add("dex_venue_id = "+f.nextArg(), q.DEXID)
	}
	if q.MinLiquidityUSD > 0 {
		f.add("liquidity_usd >= "+f.nextArg(), q.MinLiquidityUSD)
	}
	sql := `SELECT pool_id, at, chain_id, dex_venue_id, address, base_asset_id, quote_asset_id,
		fee_tier_bps, price, liquidity_usd, volume_24h_usd,
		fdv_usd, source, retrieved_at
		FROM data.pool` + f.where() +
		fmt.Sprintf(" ORDER BY at DESC, liquidity_usd DESC NULLS LAST LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(q.Limit))
	return listRows(ctx, r, sql, args, q.Limit, scanPool)
}

// scanPool scans one pool row (reader projection order).
func scanPool(row pgx.Rows) (canon.Pool, error) {
	var p canon.Pool
	err := row.Scan(&p.PoolID, &p.At, &p.ChainID, &p.DEXVenueID, &p.Address, &p.BaseAssetID,
		&p.QuoteAssetID, &p.FeeTierBps, &p.Price,
		&p.LiquidityUSD, &p.Volume24hUSD, &p.FdvUsd, &p.Source, &p.RetrievedAt)
	if err != nil {
		return p, fmt.Errorf("repo: scan pool: %w", err)
	}
	return p, nil
}

// ListArticles implements canon.Reader (newest first).
func (r *Repo) ListArticles(ctx context.Context, limit int) ([]canon.Article, error) {
	sql := `SELECT article_id, headline, summary, url, publisher, published_at, language,
		topics, assets, sentiment, source, retrieved_at
		FROM data.news_article ORDER BY published_at DESC NULLS LAST LIMIT $1`
	return listRows(ctx, r, sql, []any{clampLimit(limit)}, limit, func(row pgx.Rows) (canon.Article, error) {
		var a canon.Article
		if err := row.Scan(&a.ArticleID, &a.Headline, &a.Summary, &a.URL, &a.Publisher,
			&a.PublishedAt, &a.Language, &a.Topics, &a.Assets, &a.Sentiment, &a.Source,
			&a.RetrievedAt); err != nil {
			return a, fmt.Errorf("repo: scan article: %w", err)
		}
		return a, nil
	})
}

// ListPredictionMarkets implements canon.Reader.
func (r *Repo) ListPredictionMarkets(ctx context.Context, limit int) ([]canon.PredictionMarket, error) {
	sql := `SELECT market_id, question, outcomes, prices, liquidity_usd, volume_24h_usd,
		end_date, resolution_status, source, retrieved_at
		FROM data.prediction_market ORDER BY market_id LIMIT $1`
	return listRows(ctx, r, sql, []any{clampLimit(limit)}, limit, func(row pgx.Rows) (canon.PredictionMarket, error) {
		var m canon.PredictionMarket
		if err := row.Scan(&m.MarketID, &m.Question, &m.Outcomes, &m.Prices, &m.LiquidityUSD,
			&m.Volume24hUSD, &m.EndDate, &m.ResolutionStatus, &m.Source, &m.RetrievedAt); err != nil {
			return m, fmt.Errorf("repo: scan prediction_market: %w", err)
		}
		return m, nil
	})
}

// ListChainTVL implements canon.Reader: the latest observation per chain.
func (r *Repo) ListChainTVL(ctx context.Context, limit int) ([]canon.ChainTVL, error) {
	sql := `SELECT chain_id, at, tvl_usd, source FROM (
			SELECT DISTINCT ON (chain_id) chain_id, at, tvl_usd, source
			FROM data.tvl_chain ORDER BY chain_id, at DESC
		) latest ORDER BY at DESC LIMIT $1`
	return listRows(ctx, r, sql, []any{clampLimit(limit)}, limit, func(row pgx.Rows) (canon.ChainTVL, error) {
		var t canon.ChainTVL
		if err := row.Scan(&t.ChainID, &t.At, &t.TVLUSD, &t.Source); err != nil {
			return t, fmt.Errorf("repo: scan tvl_chain: %w", err)
		}
		return t, nil
	})
}

// ListProtocolTVL implements canon.Reader: the latest observation per
// (protocol, chain).
func (r *Repo) ListProtocolTVL(ctx context.Context, limit int) ([]canon.ProtocolTVL, error) {
	sql := `SELECT protocol_id, chain_id, at, tvl_usd, source FROM (
			SELECT DISTINCT ON (protocol_id, chain_id) protocol_id, chain_id, at, tvl_usd, source
			FROM data.tvl_protocol ORDER BY protocol_id, chain_id, at DESC
		) latest ORDER BY at DESC LIMIT $1`
	return listRows(ctx, r, sql, []any{clampLimit(limit)}, limit, func(row pgx.Rows) (canon.ProtocolTVL, error) {
		var t canon.ProtocolTVL
		if err := row.Scan(&t.ProtocolID, &t.ChainID, &t.At, &t.TVLUSD, &t.Source); err != nil {
			return t, fmt.Errorf("repo: scan tvl_protocol: %w", err)
		}
		return t, nil
	})
}

// ResolveProviderSymbol implements canon.Reader. Unknown pairs return
// canon.ErrUnknownSymbol (errors.Is-compatible), never a guess.
func (r *Repo) ResolveProviderSymbol(ctx context.Context, provider, symbol string) (kind, canonicalID string, err error) {
	var k, id string
	err = r.pool.QueryRow(ctx,
		`SELECT kind, canonical_id FROM data.provider_symbol
		 WHERE provider = $1 AND provider_symbol = $2
		 ORDER BY verified DESC, last_seen_at DESC NULLS LAST LIMIT 1`,
		provider, symbol).Scan(&k, &id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", canon.ErrUnknownSymbol
	}
	if err != nil {
		return "", "", fmt.Errorf("repo: resolve provider symbol %s/%s: %w", provider, symbol, err)
	}
	return k, id, nil
}

// ListRuns implements canon.Reader: the newest ingestion runs (run journal
// observability).
func (r *Repo) ListRuns(ctx context.Context, limit int) ([]canon.RunRecord, error) {
	sql := `SELECT id, provider, dataset, subject, mode, started_at, finished_at, status,
		coalesce(rows_in, 0), coalesce(rows_written, 0), coalesce(rows_rejected, 0),
		coalesce(error, ''), coalesce(attempt, 0)
		FROM data.ingestion_run ORDER BY started_at DESC LIMIT $1`
	return listRows(ctx, r, sql, []any{clampLimit(limit)}, limit, func(row pgx.Rows) (canon.RunRecord, error) {
		var rec canon.RunRecord
		if err := row.Scan(&rec.ID, &rec.Provider, &rec.Dataset, &rec.Subject, &rec.Mode,
			&rec.StartedAt, &rec.FinishedAt, &rec.Status, &rec.RowsIn, &rec.RowsWritten,
			&rec.RowsRejected, &rec.Error, &rec.Attempt); err != nil {
			return rec, fmt.Errorf("repo: scan ingestion_run: %w", err)
		}
		return rec, nil
	})
}
