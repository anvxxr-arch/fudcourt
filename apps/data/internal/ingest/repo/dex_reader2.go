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

// This file is the second half of the DEX reader: snapshots, positions,
// orderbook, wallet activity, risk, MEV, perps, routing, deployments and the
// observability reads.

// ReadDexLiquiditySnapshots implements dexstore.Reader.
func (r *Repo) ReadDexLiquiditySnapshots(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.DexLiquiditySnapshot, error) {
	f := &filter{}
	f.add("pool_id = "+f.nextArg(), poolID)
	f.timeRange("at", start, end)
	sql := `SELECT snapshot_id, natural_key, pool_id, chain_id, at, reserves, liquidity_usd,
		tick, tick_lower, tick_upper, active_liquidity, source, retrieved_at
		FROM data.dex_liquidity_snapshot` + f.where() +
		fmt.Sprintf(" ORDER BY at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanDexLiquiditySnapshot)
}

// ReadDexMarketSnapshots implements dexstore.Reader.
func (r *Repo) ReadDexMarketSnapshots(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.DexMarketSnapshot, error) {
	f := &filter{}
	f.add("pool_id = "+f.nextArg(), poolID)
	f.timeRange("at", start, end)
	sql := `SELECT snapshot_id, natural_key, pool_id, chain_id, at, price_usd, price_native,
		volume_24h_usd, txns_24h, buys_24h, sells_24h, price_change_pct_24h, fdv_usd,
		market_cap_usd, fee_tier_bps, source, retrieved_at
		FROM data.dex_market_snapshot` + f.where() +
		fmt.Sprintf(" ORDER BY at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanDexMarketSnapshot)
}

// ListLatestDexMarketSnapshots implements dexstore.Reader: the market board —
// the NEWEST snapshot per pool, not every snapshot of every pool. A plain
// "ORDER BY at DESC LIMIT n" would list one pool n times (the caller's board
// would be a single pair repeated), so the per-pool pick happens in a
// DISTINCT ON subquery and only then is the requested order applied.
func (r *Repo) ListLatestDexMarketSnapshots(ctx context.Context, q dexstore.DexMarketQuery) ([]canon.DexMarketSnapshot, error) {
	f := &filter{}
	if q.ChainID != "" {
		f.add("chain_id = "+f.nextArg(), q.ChainID)
	}
	const cols = `snapshot_id, natural_key, pool_id, chain_id, at, price_usd, price_native,
		volume_24h_usd, txns_24h, buys_24h, sells_24h, price_change_pct_24h, fdv_usd,
		market_cap_usd, fee_tier_bps, source, retrieved_at`
	sql := `SELECT ` + cols + ` FROM (
			SELECT DISTINCT ON (pool_id) ` + cols + `
			FROM data.dex_market_snapshot` + f.where() + `
			ORDER BY pool_id, at DESC
		) latest ORDER BY ` + dexMarketOrder(q.Sort) + fmt.Sprintf(" LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(q.Limit))
	// listRows, not listRowsASC: the row order here is the REQUESTED ranking,
	// and reversing it would hand back a board sorted the wrong way.
	return listRows(ctx, r, sql, args, q.Limit, scanDexMarketSnapshot)
}

// dexMarketOrder maps a validated sort onto its ORDER BY. NULLS LAST keeps a
// row the provider left blank out of the top of a board it cannot compete in;
// an empty sort is the volume board the handler defaults to.
func dexMarketOrder(sort string) string {
	switch sort {
	case "price_change":
		return "price_change_pct_24h DESC NULLS LAST, pool_id"
	case "transactions":
		return "txns_24h DESC NULLS LAST, pool_id"
	case "newest":
		return "at DESC, pool_id"
	default:
		return "volume_24h_usd DESC NULLS LAST, pool_id"
	}
}


func (r *Repo) ReadDexLiquidityPositions(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.DexLiquidityPosition, error) {
	f := &filter{}
	if poolID != "" {
		f.add("pool_id = "+f.nextArg(), poolID)
	}
	f.timeRange("at", start, end)
	sql := `SELECT position_id, natural_key, pool_id, chain_id, owner, token_id, nft_token_id,
		amounts, tick_lower, tick_upper, liquidity, value_usd, at, source, retrieved_at
		FROM data.dex_liquidity_position` + f.where() +
		fmt.Sprintf(" ORDER BY at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanDexLiquidityPosition)
}

// ReadDexOrderbookSnapshots implements dexstore.Reader.
func (r *Repo) ReadDexOrderbookSnapshots(ctx context.Context, poolID string, start, end time.Time, limit int) ([]canon.DexOrderbookSnapshot, error) {
	f := &filter{}
	f.add("pool_id = "+f.nextArg(), poolID)
	f.timeRange("at", start, end)
	sql := `SELECT snapshot_id, natural_key, pool_id, chain_id, at, depth, bids, asks, source
		FROM data.dex_orderbook_snapshot` + f.where() +
		fmt.Sprintf(" ORDER BY at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanDexOrderbookSnapshot)
}

// ReadDexWalletActivity implements dexstore.Reader.
func (r *Repo) ReadDexWalletActivity(ctx context.Context, wallet string, start, end time.Time, limit int) ([]canon.WalletActivity, error) {
	f := &filter{}
	if wallet != "" {
		f.add("wallet = "+f.nextArg(), wallet)
	}
	f.timeRange("event_time", start, end)
	sql := `SELECT activity_id, natural_key, provider, chain_id, wallet, kind, pool_id, token_id,
		amount_raw, amount_decimals, value_usd, tx_hash, counterparty, source, event_time, retrieved_at
		FROM data.dex_wallet_activity` + f.where() +
		fmt.Sprintf(" ORDER BY event_time DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanWalletActivity)
}

// ReadDexRiskMetrics implements dexstore.Reader: subject+metric windowed.
func (r *Repo) ReadDexRiskMetrics(ctx context.Context, subjectKey, metric string, start, end time.Time, limit int) ([]canon.RiskMetric, error) {
	f := &filter{}
	if subjectKey != "" {
		f.add("subject_key = "+f.nextArg(), subjectKey)
	}
	if metric != "" {
		f.add("metric = "+f.nextArg(), metric)
	}
	f.timeRange("at", start, end)
	sql := `SELECT risk_id, natural_key, subject_key, metric, score, band, algorithm_version,
		input_sources, at, source
		FROM data.dex_risk_metric` + f.where() +
		fmt.Sprintf(" ORDER BY at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanRiskMetric)
}

// ReadDexMEVEvents implements dexstore.Reader.
func (r *Repo) ReadDexMEVEvents(ctx context.Context, chainID string, start, end time.Time, limit int) ([]canon.MEVEvent, error) {
	f := &filter{}
	if chainID != "" {
		f.add("chain_id = "+f.nextArg(), chainID)
	}
	f.timeRange("event_time", start, end)
	sql := `SELECT mev_id, natural_key, chain_id, tx_hash, block_number, kind, pool_id, victim,
		attacker, profit_usd, profit_raw, profit_decimals, source, event_time, retrieved_at
		FROM data.dex_mev_event` + f.where() +
		fmt.Sprintf(" ORDER BY event_time DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanMEVEvent)
}

// ReadDexPerpMarkets implements dexstore.Reader: the newest snapshot per market.
func (r *Repo) ReadDexPerpMarkets(ctx context.Context, venueID string, limit int) ([]canon.PerpMarket, error) {
	f := &filter{}
	if venueID != "" {
		f.add("venue_id = "+f.nextArg(), venueID)
	}
	sql := `SELECT DISTINCT ON (perp_market_id)
		perp_market_id, natural_key, venue_id, market_type, base_asset_id, quote_asset_id,
		base_symbol, quote_symbol, index_price, mark_price, open_interest_usd,
		open_interest_base, funding_rate, max_leverage, at, source, retrieved_at
		FROM data.dex_perp_market` + f.where() +
		fmt.Sprintf(" ORDER BY perp_market_id, at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRows(ctx, r, sql, args, limit, scanPerpMarket)
}

// ReadDexPerpLiquidations implements dexstore.Reader.
func (r *Repo) ReadDexPerpLiquidations(ctx context.Context, perpMarketID string, start, end time.Time, limit int) ([]canon.PerpLiquidation, error) {
	f := &filter{}
	if perpMarketID != "" {
		f.add("perp_market_id = "+f.nextArg(), perpMarketID)
	}
	f.timeRange("at", start, end)
	sql := `SELECT venue_id, perp_market_id, at, side, price, quantity_raw, quantity_decimals,
		value_usd, wallet, tx_hash, source, retrieved_at
		FROM data.dex_perp_liquidation` + f.where() +
		fmt.Sprintf(" ORDER BY at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRowsASC(ctx, r, sql, args, limit, scanPerpLiquidation)
}

// ReadDexRouteQuotes implements dexstore.Reader: the freshest quote per
// provider for a pair.
func (r *Repo) ReadDexRouteQuotes(ctx context.Context, chainID, tokenIn, tokenOut string, limit int) ([]canon.RouteQuote, error) {
	f := &filter{}
	if chainID != "" {
		f.add("chain_id = "+f.nextArg(), chainID)
	}
	if tokenIn != "" {
		f.add("token_in = "+f.nextArg(), tokenIn)
	}
	if tokenOut != "" {
		f.add("token_out = "+f.nextArg(), tokenOut)
	}
	sql := `SELECT DISTINCT ON (provider)
		quote_id, natural_key, provider, chain_id, token_in, token_out,
		amount_in_raw, amount_in_decimals, amount_out_raw, amount_out_decimals,
		expected_output_usd, gas_estimate_usd, gas_estimate_raw, gas_estimate_decimals,
		price_impact_pct, slippage_pct, legs, quoted_at, retrieved_at
		FROM data.dex_route_quote` + f.where() +
		fmt.Sprintf(" ORDER BY provider, quoted_at DESC LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRows(ctx, r, sql, args, limit, scanRouteQuote)
}

// ListDexDeployments implements dexstore.Reader.
func (r *Repo) ListDexDeployments(ctx context.Context, protocolID string, limit int) ([]canon.DexDeployment, error) {
	f := &filter{}
	if protocolID != "" {
		f.add("protocol_id = "+f.nextArg(), protocolID)
	}
	sql := `SELECT deployment_id, natural_key, protocol_id, chain_id, factory, router,
		other_contracts, address_kind, source, retrieved_at
		FROM data.dex_deployment` + f.where() +
		fmt.Sprintf(" ORDER BY chain_id LIMIT $%d", len(f.args)+1)
	args := append(f.args, clampLimit(limit))
	return listRows(ctx, r, sql, args, limit, scanDexDeployment)
}

// ListProviderHealth implements dexstore.Reader: the newest window per provider.
func (r *Repo) ListProviderHealth(ctx context.Context, limit int) ([]dexstore.ProviderHealth, error) {
	sql := `SELECT DISTINCT ON (provider)
		provider, window_start, availability_pct, latency_p50_ms, latency_p95_ms,
		latency_p99_ms, error_count, success_count, rate_limit_events, last_success,
		last_failure, staleness_seconds, state
		FROM data.dex_provider_health ORDER BY provider, window_start DESC LIMIT $1`
	return listRows(ctx, r, sql, []any{clampLimit(limit)}, limit, scanProviderHealth)
}

// ListQualityStatus implements dexstore.Reader: the newest verdict per subject.
func (r *Repo) ListQualityStatus(ctx context.Context, limit int) ([]dexstore.QualityStatus, error) {
	sql := `SELECT DISTINCT ON (subject_key, dataset)
		subject_key, dataset, at, state, reasons, detail
		FROM data.dex_quality_status ORDER BY subject_key, dataset, at DESC LIMIT $1`
	return listRows(ctx, r, sql, []any{clampLimit(limit)}, limit, scanQualityStatus)
}

// --- scanners ---------------------------------------------------------------

func scanDexLiquiditySnapshot(row pgx.Rows) (canon.DexLiquiditySnapshot, error) {
	var (
		s        canon.DexLiquiditySnapshot
		reserves []byte
		liq      *string
	)
	err := row.Scan(&s.SnapshotID, &s.NaturalKey, &s.PoolID, &s.ChainID, &s.At, &reserves,
		&liq, &s.Tick, &s.TickLower, &s.TickUpper, &s.ActiveLiquidity,
		&s.Provenance.SourceProvider, &s.Provenance.NormalizedAt)
	if err != nil {
		return s, fmt.Errorf("repo: scan dex_liquidity_snapshot: %w", err)
	}
	if s.LiquidityUSD, err = decPtr(liq); err != nil {
		return s, err
	}
	finalizeProvenance(&s.Provenance, &s.At)
	return s, nil
}

func scanDexMarketSnapshot(row pgx.Rows) (canon.DexMarketSnapshot, error) {
	var (
		s                              canon.DexMarketSnapshot
		priceUSD, priceNat, vol24, chg *string
		fdv, mcap                      *string
	)
	err := row.Scan(&s.SnapshotID, &s.NaturalKey, &s.PoolID, &s.ChainID, &s.At,
		&priceUSD, &priceNat, &vol24, &s.Txns24h, &s.Buys24h, &s.Sells24h,
		&chg, &fdv, &mcap, &s.FeeTierBps, &s.Provenance.SourceProvider, &s.Provenance.NormalizedAt)
	if err != nil {
		return s, fmt.Errorf("repo: scan dex_market_snapshot: %w", err)
	}
	if s.PriceUSD, err = decPtr(priceUSD); err != nil {
		return s, err
	}
	if s.PriceNative, err = decPtr(priceNat); err != nil {
		return s, err
	}
	if s.Volume24hUSD, err = decPtr(vol24); err != nil {
		return s, err
	}
	if s.PriceChangePct24h, err = decPtr(chg); err != nil {
		return s, err
	}
	if s.FDVUSD, err = decPtr(fdv); err != nil {
		return s, err
	}
	if s.MarketCapUSD, err = decPtr(mcap); err != nil {
		return s, err
	}
	finalizeProvenance(&s.Provenance, &s.At)
	return s, nil
}

func scanDexLiquidityPosition(row pgx.Rows) (canon.DexLiquidityPosition, error) {
	var (
		p        canon.DexLiquidityPosition
		tokenID  *string
		amounts  []byte
		liq, val *string
	)
	err := row.Scan(&p.PositionID, &p.NaturalKey, &p.PoolID, &p.ChainID, &p.Owner, &tokenID,
		&p.NFTTokenID, &amounts, &p.TickLower, &p.TickUpper, &liq, &val, &p.At,
		&p.Provenance.SourceProvider, &p.Provenance.NormalizedAt)
	if err != nil {
		return p, fmt.Errorf("repo: scan dex_liquidity_position: %w", err)
	}
	if tokenID != nil {
		p.TokenID = *tokenID
	}
	if p.Liquidity, err = decPtr(liq); err != nil {
		return p, err
	}
	if p.ValueUSD, err = decPtr(val); err != nil {
		return p, err
	}
	if len(amounts) > 0 {
		var elems []struct {
			TokenID  string `json:"token_id"`
			Index    int    `json:"index"`
			Raw      string `json:"raw"`
			Decimals int    `json:"decimals"`
			Weight   string `json:"weight"`
			IsBase   *bool  `json:"is_base"`
		}
		if err := json.Unmarshal(amounts, &elems); err != nil {
			return p, fmt.Errorf("repo: decode position amounts: %w", err)
		}
		for _, e := range elems {
			pt := canon.PoolToken{TokenID: e.TokenID, Index: e.Index, IsBase: e.IsBase}
			if e.Raw != "" {
				if a, err := amount(&e.Raw, &e.Decimals); err == nil {
					pt.Reserve = &a
				}
			}
			if e.Weight != "" {
				if d, err := canon.DecFromString(e.Weight); err == nil {
					pt.Weight = &d
				}
			}
			p.Amounts = append(p.Amounts, pt)
		}
	}
	finalizeProvenance(&p.Provenance, &p.At)
	return p, nil
}

func scanDexOrderbookSnapshot(row pgx.Rows) (canon.DexOrderbookSnapshot, error) {
	var (
		s          canon.DexOrderbookSnapshot
		bids, asks []byte
	)
	err := row.Scan(&s.SnapshotID, &s.NaturalKey, &s.PoolID, &s.ChainID, &s.At, &s.Depth,
		&bids, &asks, &s.Provenance.SourceProvider)
	if err != nil {
		return s, fmt.Errorf("repo: scan dex_orderbook_snapshot: %w", err)
	}
	if s.Bids, err = decodeLevels(bids); err != nil {
		return s, err
	}
	if s.Asks, err = decodeLevels(asks); err != nil {
		return s, err
	}
	finalizeProvenance(&s.Provenance, &s.At)
	return s, nil
}

// decodeLevels turns a jsonb [[price,size],...] body back into exact levels.
func decodeLevels(b []byte) ([]canon.OrderbookLevel, error) {
	if len(b) == 0 {
		return nil, nil
	}
	var raw [][2]string
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("repo: decode orderbook levels: %w", err)
	}
	out := make([]canon.OrderbookLevel, 0, len(raw))
	for _, pair := range raw {
		price, err := canon.DecFromString(pair[0])
		if err != nil {
			return nil, err
		}
		size, err := canon.DecFromString(pair[1])
		if err != nil {
			return nil, err
		}
		out = append(out, canon.OrderbookLevel{Price: price, Size: size})
	}
	return out, nil
}

func scanWalletActivity(row pgx.Rows) (canon.WalletActivity, error) {
	var (
		a                    canon.WalletActivity
		poolID, tokenID      *string
		raw                  *string
		dec                  *int
		val                  *string
		txHash, counterparty *string
	)
	err := row.Scan(&a.ActivityID, &a.NaturalKey, &a.Provider, &a.ChainID, &a.Wallet, &a.Kind,
		&poolID, &tokenID, &raw, &dec, &val, &txHash, &counterparty,
		&a.Provenance.SourceProvider, &a.EventTime, &a.Provenance.NormalizedAt)
	if err != nil {
		return a, fmt.Errorf("repo: scan dex_wallet_activity: %w", err)
	}
	if poolID != nil {
		a.PoolID = *poolID
	}
	if tokenID != nil {
		a.TokenID = *tokenID
	}
	if txHash != nil {
		a.TxHash = *txHash
	}
	if counterparty != nil {
		a.Counterparty = *counterparty
	}
	if a.Amount, err = amountPtr(raw, dec); err != nil {
		return a, err
	}
	if a.ValueUSD, err = decPtr(val); err != nil {
		return a, err
	}
	finalizeProvenance(&a.Provenance, &a.EventTime)
	return a, nil
}

func scanRiskMetric(row pgx.Rows) (canon.RiskMetric, error) {
	var (
		m     canon.RiskMetric
		score string
		band  *string
	)
	err := row.Scan(&m.RiskID, &m.NaturalKey, &m.SubjectKey, &m.Metric, &score, &band,
		&m.AlgorithmVersion, &m.InputSources, &m.At, &m.Provenance.SourceProvider)
	if err != nil {
		return m, fmt.Errorf("repo: scan dex_risk_metric: %w", err)
	}
	if m.Score, err = canon.DecFromString(score); err != nil {
		return m, err
	}
	if band != nil {
		m.Band = *band
	}
	finalizeProvenance(&m.Provenance, &m.At)
	return m, nil
}

func scanMEVEvent(row pgx.Rows) (canon.MEVEvent, error) {
	var (
		e                   canon.MEVEvent
		poolID, victim, atk *string
		profitUSD           *string
		profitRaw           *string
		profitDec           *int
	)
	err := row.Scan(&e.MEVID, &e.NaturalKey, &e.ChainID, &e.TxHash, &e.BlockNumber, &e.Kind,
		&poolID, &victim, &atk, &profitUSD, &profitRaw, &profitDec,
		&e.Provenance.SourceProvider, &e.EventTime, &e.Provenance.NormalizedAt)
	if err != nil {
		return e, fmt.Errorf("repo: scan dex_mev_event: %w", err)
	}
	if poolID != nil {
		e.PoolID = *poolID
	}
	if victim != nil {
		e.Victim = *victim
	}
	if atk != nil {
		e.Attacker = *atk
	}
	if e.ProfitUSD, err = decPtr(profitUSD); err != nil {
		return e, err
	}
	if e.ProfitToken, err = amountPtr(profitRaw, profitDec); err != nil {
		return e, err
	}
	finalizeProvenance(&e.Provenance, &e.EventTime)
	return e, nil
}

func scanPerpMarket(row pgx.Rows) (canon.PerpMarket, error) {
	var (
		m                         canon.PerpMarket
		idx, mark, oiBase, fr, ml *string
		oiUSD                     *string
		oiUSDDec                  *int
	)
	err := row.Scan(&m.PerpMarketID, &m.NaturalKey, &m.VenueID, &m.MarketType,
		&m.BaseAssetID, &m.QuoteAssetID, &m.BaseSymbol, &m.QuoteSymbol,
		&idx, &mark, &oiUSD, &oiUSDDec, &oiBase, &fr, &ml, &m.At,
		&m.Provenance.SourceProvider, &m.Provenance.NormalizedAt)
	if err != nil {
		return m, fmt.Errorf("repo: scan dex_perp_market: %w", err)
	}
	if m.IndexPrice, err = decPtr(idx); err != nil {
		return m, err
	}
	if m.MarkPrice, err = decPtr(mark); err != nil {
		return m, err
	}
	if m.OpenInterestUSD, err = amountPtr(oiUSD, oiUSDDec); err != nil {
		return m, err
	}
	if m.OpenInterestBase, err = decPtr(oiBase); err != nil {
		return m, err
	}
	if m.FundingRate, err = decPtr(fr); err != nil {
		return m, err
	}
	if m.MaxLeverage, err = decPtr(ml); err != nil {
		return m, err
	}
	finalizeProvenance(&m.Provenance, &m.At)
	return m, nil
}

func scanPerpLiquidation(row pgx.Rows) (canon.PerpLiquidation, error) {
	var (
		l           canon.PerpLiquidation
		side        *string
		price       string
		qRaw        string
		qDec        int
		val         *string
		wallet, txh *string
	)
	err := row.Scan(&l.VenueID, &l.PerpMarketID, &l.At, &side, &price, &qRaw, &qDec,
		&val, &wallet, &txh, &l.Provenance.SourceProvider, &l.Provenance.NormalizedAt)
	if err != nil {
		return l, fmt.Errorf("repo: scan dex_perp_liquidation: %w", err)
	}
	if side != nil {
		l.Side = *side
	}
	if l.Price, err = canon.DecFromString(price); err != nil {
		return l, err
	}
	if l.Quantity, err = amount(&qRaw, &qDec); err != nil {
		return l, err
	}
	if l.ValueUSD, err = decPtr(val); err != nil {
		return l, err
	}
	if wallet != nil {
		l.Wallet = *wallet
	}
	if txh != nil {
		l.TxHash = *txh
	}
	finalizeProvenance(&l.Provenance, &l.At)
	return l, nil
}

func scanRouteQuote(row pgx.Rows) (canon.RouteQuote, error) {
	var (
		q                canon.RouteQuote
		inRaw, outRaw    string
		inDec, outDec    int
		expOut, gasUSD   *string
		gasRaw           *string
		gasDec           *int
		impact, slippage *string
		legs             []byte
	)
	err := row.Scan(&q.QuoteID, &q.NaturalKey, &q.Provider, &q.ChainID, &q.TokenIn, &q.TokenOut,
		&inRaw, &inDec, &outRaw, &outDec, &expOut, &gasUSD, &gasRaw, &gasDec,
		&impact, &slippage, &legs, &q.QuotedAt, &q.Provenance.NormalizedAt)
	if err != nil {
		return q, fmt.Errorf("repo: scan dex_route_quote: %w", err)
	}
	if q.AmountIn, err = amount(&inRaw, &inDec); err != nil {
		return q, err
	}
	if q.AmountOut, err = amount(&outRaw, &outDec); err != nil {
		return q, err
	}
	if q.ExpectedOutputUSD, err = decPtr(expOut); err != nil {
		return q, err
	}
	if q.GasUSD, err = decPtr(gasUSD); err != nil {
		return q, err
	}
	if q.GasEstimate, err = amountPtr(gasRaw, gasDec); err != nil {
		return q, err
	}
	if q.PriceImpactPct, err = decPtr(impact); err != nil {
		return q, err
	}
	if q.SlippagePct, err = decPtr(slippage); err != nil {
		return q, err
	}
	if len(legs) > 0 {
		_ = json.Unmarshal(legs, &q.Legs)
	}
	finalizeProvenance(&q.Provenance, &q.QuotedAt)
	return q, nil
}

func scanDexDeployment(row pgx.Rows) (canon.DexDeployment, error) {
	var (
		d           canon.DexDeployment
		factory     *string
		router      *string
		other       []byte
		addressKind *string
	)
	err := row.Scan(&d.DeploymentID, &d.NaturalKey, &d.ProtocolID, &d.ChainID, &factory,
		&router, &other, &addressKind, &d.Provenance.SourceProvider, &d.Provenance.NormalizedAt)
	if err != nil {
		return d, fmt.Errorf("repo: scan dex_deployment: %w", err)
	}
	if factory != nil {
		d.Factory = *factory
	}
	if router != nil {
		d.Router = *router
	}
	if addressKind != nil {
		d.AddressKind = *addressKind
	}
	if len(other) > 0 {
		_ = json.Unmarshal(other, &d.OtherContracts)
	}
	finalizeProvenance(&d.Provenance, nil)
	return d, nil
}

func scanProviderHealth(row pgx.Rows) (dexstore.ProviderHealth, error) {
	var (
		h       dexstore.ProviderHealth
		window  time.Time
		lastS   *time.Time
		lastF   *time.Time
		lastSUn *int64
		lastFUn *int64
	)
	err := row.Scan(&h.Provider, &window, &h.AvailabilityPct, &h.LatencyP50Ms, &h.LatencyP95Ms,
		&h.LatencyP99Ms, &h.ErrorCount, &h.SuccessCount, &h.RateLimitEvents,
		&lastS, &lastF, &h.StalenessSeconds, &h.State)
	if err != nil {
		return h, fmt.Errorf("repo: scan dex_provider_health: %w", err)
	}
	h.WindowStart = window.Unix()
	if lastS != nil {
		v := lastS.Unix()
		lastSUn = &v
	}
	if lastF != nil {
		v := lastF.Unix()
		lastFUn = &v
	}
	h.LastSuccessUnix = lastSUn
	h.LastFailureUnix = lastFUn
	return h, nil
}

func scanQualityStatus(row pgx.Rows) (dexstore.QualityStatus, error) {
	var (
		q  dexstore.QualityStatus
		at time.Time
	)
	err := row.Scan(&q.SubjectKey, &q.Dataset, &at, &q.State, &q.Reasons, &q.Detail)
	if err != nil {
		return q, fmt.Errorf("repo: scan dex_quality_status: %w", err)
	}
	q.AtUnix = at.Unix()
	return q, nil
}
