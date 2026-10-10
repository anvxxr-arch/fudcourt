package repo

import (
	"context"
	"fmt"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/jackc/pgx/v5"
)

// Entity upserts (canon.Writer half 1). Entities are the canonical registry
// (DR-036): rows are keyed by minted ids, the natural-key uniqueness is the
// storage layer's restatement of the minting rule, and the upsert is
// idempotent. Validation per contract §35 is all-or-nothing per CALL here:
// an empty id, empty natural key or (for provider_symbol) a kind/namespace
// mismatch rejects the whole call with an error before any SQL runs — an
// entity with an empty key is a wiring bug (the fetcher lost a field), not
// bad data to skip.
//
// Written counts exclude rows the database refused (per-row errors are
// collected and the FIRST one is returned with the partial count — a batch
// is not required to be atomic, contract Writer).

// execBatchStrict runs the queued statements; any per-row error fails the
// call (entities).
func (r *Repo) execBatchStrict(ctx context.Context, n int, queue func(b *pgx.Batch)) error {
	if n == 0 {
		return nil
	}
	b := &pgx.Batch{}
	queue(b)
	br := r.pool.SendBatch(ctx, b)
	defer br.Close()
	for range n {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

// execBatchTolerant runs the queued statements; per-row errors are counted
// as not-written and the first one is returned (facts).
func (r *Repo) execBatchTolerant(ctx context.Context, n int, queue func(b *pgx.Batch)) (int, error) {
	if n == 0 {
		return 0, nil
	}
	b := &pgx.Batch{}
	queue(b)
	br := r.pool.SendBatch(ctx, b)
	defer br.Close()
	written := 0
	var firstErr error
	for range n {
		if _, err := br.Exec(); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		written++
	}
	return written, firstErr
}

// UpsertAssets implements canon.Writer.
func (r *Repo) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	if err := validateEntities("asset", len(rows), func(i int) error {
		row := rows[i]
		if row.AssetID == "" || row.Symbol == "" || row.Kind == "" {
			return fmt.Errorf("asset[%d]: empty asset_id, symbol or kind", i)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	return r.execBatchTolerant(ctx, len(rows), func(b *pgx.Batch) {
		for _, row := range rows {
			b.Queue(`INSERT INTO data.asset (asset_id, symbol, name, kind, chain_id, decimals)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT (asset_id) DO UPDATE SET
					symbol = EXCLUDED.symbol, name = EXCLUDED.name, kind = EXCLUDED.kind,
					chain_id = EXCLUDED.chain_id, decimals = EXCLUDED.decimals,
					updated_at = now()`,
				row.AssetID, row.Symbol, row.Name, string(row.Kind), row.ChainID, row.Decimals)
		}
	})
}

// UpsertChains implements canon.Writer.
func (r *Repo) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	if err := validateEntities("chain", len(rows), func(i int) error {
		row := rows[i]
		if row.ChainID == "" || row.Name == "" || row.Kind == "" {
			return fmt.Errorf("chain[%d]: empty chain_id, name or kind", i)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	return r.execBatchTolerant(ctx, len(rows), func(b *pgx.Batch) {
		for _, row := range rows {
			b.Queue(`INSERT INTO data.chain (chain_id, name, display_name, kind, native_asset_id, chain_numeric_id)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT (chain_id) DO UPDATE SET
					name = EXCLUDED.name, display_name = EXCLUDED.display_name, kind = EXCLUDED.kind,
					native_asset_id = EXCLUDED.native_asset_id, chain_numeric_id = EXCLUDED.chain_numeric_id,
					updated_at = now()`,
				row.ChainID, row.Name, row.DisplayName, row.Kind, row.NativeAssetID, row.ChainNumericID)
		}
	})
}

// UpsertVenues implements canon.Writer.
func (r *Repo) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	if err := validateEntities("venue", len(rows), func(i int) error {
		row := rows[i]
		if row.VenueID == "" || row.Kind == "" {
			return fmt.Errorf("venue[%d]: empty venue_id or kind", i)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	return r.execBatchTolerant(ctx, len(rows), func(b *pgx.Batch) {
		for _, row := range rows {
			b.Queue(`INSERT INTO data.venue (venue_id, name, kind, known, market_types, url)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT (venue_id) DO UPDATE SET
					name = EXCLUDED.name, kind = EXCLUDED.kind, known = EXCLUDED.known,
					market_types = EXCLUDED.market_types, url = EXCLUDED.url,
					updated_at = now()`,
				row.VenueID, row.Name, row.Kind, row.Known, row.MarketTypes, row.URL)
		}
	})
}

// UpsertInstruments implements canon.Writer. The natural key comes from
// canon.InstrumentKey (the minting input); instruments whose id does not
// match a remint from their natural coordinates are rejected — the store
// never mints, but it refuses a row whose id/natural-key pair is incoherent
// (a fetcher carrying the wrong id). Status defaults to 'active' when the
// struct's Status is empty (CASE on $18/$19 in the SQL).
func (r *Repo) UpsertInstruments(ctx context.Context, rows []canon.Instrument) (int, error) {
	if err := validateEntities("instrument", len(rows), func(i int) error {
		row := rows[i]
		if row.InstrumentID == "" || row.VenueID == "" || row.MarketType == "" ||
			row.BaseSymbol == "" || row.QuoteSymbol == "" {
			return fmt.Errorf("instrument[%d]: empty id, venue, market_type or symbol", i)
		}
		ref := canon.InstrumentRef{
			VenueID:    venueNaturalKey(row),
			MarketType: row.MarketType,
			Base:       row.BaseSymbol,
			Quote:      row.QuoteSymbol,
			Expiry:     row.Expiry,
			Strike:     row.Strike,
			OptionType: row.OptionType,
		}
		if canon.MintID(canon.KindInstrument, canon.InstrumentKey(ref)) != row.InstrumentID {
			return fmt.Errorf("instrument[%d]: id %q does not match natural key", i, row.InstrumentID)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	return r.execBatchTolerant(ctx, len(rows), func(b *pgx.Batch) {
		for _, row := range rows {
			ref := canon.InstrumentRef{
				VenueID:    venueNaturalKey(row),
				MarketType: row.MarketType,
				Base:       row.BaseSymbol,
				Quote:      row.QuoteSymbol,
				Expiry:     row.Expiry,
				Strike:     row.Strike,
				OptionType: row.OptionType,
			}
			b.Queue(`INSERT INTO data.instrument
				(instrument_id, natural_key, venue_id, market_type, base_asset_id, quote_asset_id,
				 base_symbol, quote_symbol, expiry, strike, option_type, tick_size, lot_size,
				contract_size, isin, cusip, figi, ticker, status)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
				ON CONFLICT (instrument_id) DO UPDATE SET
					natural_key = EXCLUDED.natural_key, venue_id = EXCLUDED.venue_id,
					market_type = EXCLUDED.market_type, base_asset_id = EXCLUDED.base_asset_id,
					quote_asset_id = EXCLUDED.quote_asset_id, base_symbol = EXCLUDED.base_symbol,
					quote_symbol = EXCLUDED.quote_symbol, expiry = EXCLUDED.expiry,
					strike = EXCLUDED.strike, option_type = EXCLUDED.option_type,
					tick_size = EXCLUDED.tick_size, lot_size = EXCLUDED.lot_size,
					contract_size = EXCLUDED.contract_size, isin = EXCLUDED.isin,
					cusip = EXCLUDED.cusip, figi = EXCLUDED.figi, ticker = EXCLUDED.ticker,
					status = EXCLUDED.status, updated_at = now()`,
				row.InstrumentID, canon.InstrumentKey(ref), row.VenueID, row.MarketType,
				row.BaseAssetID, row.QuoteAssetID, row.BaseSymbol, row.QuoteSymbol,
				row.Expiry, row.Strike, nilIfEmpty(row.OptionType), row.TickSize, row.LotSize,
				row.ContractSize, row.ISIN, row.CUSIP, row.FIGI, row.Ticker, statusOrDefault(row.Status))
		}
	})
}

// statusOrDefault applies the instrument status column's DEFAULT 'active'
// semantics for empty struct fields (a writer spelling absence as "").
func statusOrDefault(status string) string {
	if status == "" {
		return "active"
	}
	return status
}

// venueNaturalKey resolves the natural-key venue string for an instrument
// row: the fetcher-carried VenueName (the string InstrumentKey was minted
// over) wins; an id that is itself name-shaped (legacy direct construction)
// passes through; the minted "venue:<hex>" form alone is NOT reversible, so
// an empty name with a minted id can only fail validation loudly.
func venueNaturalKey(row canon.Instrument) string {
	if row.VenueName != "" {
		return row.VenueName
	}
	if _, ok := strings.CutPrefix(row.VenueID, "venue:"); ok {
		return ""
	}
	return row.VenueID
}

// UpsertProtocols implements canon.Writer.
func (r *Repo) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	if err := validateEntities("protocol", len(rows), func(i int) error {
		row := rows[i]
		if row.ProtocolID == "" || row.Slug == "" {
			return fmt.Errorf("protocol[%d]: empty protocol_id or slug", i)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	return r.execBatchTolerant(ctx, len(rows), func(b *pgx.Batch) {
		for _, row := range rows {
			b.Queue(`INSERT INTO data.protocol (protocol_id, slug, name, category)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (protocol_id) DO UPDATE SET
					slug = EXCLUDED.slug, name = EXCLUDED.name, category = EXCLUDED.category,
					updated_at = now()`,
				row.ProtocolID, row.Slug, row.Name, row.Category)
		}
	})
}

// UpsertSeries implements canon.Writer.
func (r *Repo) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	if err := validateEntities("series", len(rows), func(i int) error {
		row := rows[i]
		if row.SeriesID == "" || row.Domain == "" || row.Metric == "" || row.Frequency == "" ||
			row.Source == "" || row.Provider == "" || row.ProviderSeriesID == "" ||
			row.SchemaVersion == "" || row.NormalizationVersion == "" {
			return fmt.Errorf("series[%d]: empty required field", i)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	return r.execBatchTolerant(ctx, len(rows), func(b *pgx.Batch) {
		for _, row := range rows {
			revision := row.Revision
			if revision == "" {
				revision = "latest"
			}
			subject := row.SubjectKey
			if subject == "" {
				subject = "global"
			}
			b.Queue(`INSERT INTO data.series
				(series_id, domain, metric, subject_key, title, unit, frequency, country_id,
				 asset_id, instrument_id, chain_id, protocol_id, venue_id, source, provider,
				 provider_series_id, revision, is_derived, schema_version, normalization_version)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
				ON CONFLICT (series_id) DO UPDATE SET
					domain = EXCLUDED.domain, metric = EXCLUDED.metric,
					subject_key = EXCLUDED.subject_key, title = EXCLUDED.title,
					unit = EXCLUDED.unit, frequency = EXCLUDED.frequency,
					country_id = EXCLUDED.country_id, asset_id = EXCLUDED.asset_id,
					instrument_id = EXCLUDED.instrument_id, chain_id = EXCLUDED.chain_id,
					protocol_id = EXCLUDED.protocol_id, venue_id = EXCLUDED.venue_id,
					source = EXCLUDED.source, provider = EXCLUDED.provider,
					provider_series_id = EXCLUDED.provider_series_id,
					revision = EXCLUDED.revision, is_derived = EXCLUDED.is_derived,
					schema_version = EXCLUDED.schema_version,
					normalization_version = EXCLUDED.normalization_version, updated_at = now()`,
				row.SeriesID, row.Domain, row.Metric, subject, row.Title, row.Unit,
				row.Frequency, row.CountryID, row.AssetID, row.InstrumentID, row.ChainID,
				row.ProtocolID, row.VenueID, row.Source, row.Provider, row.ProviderSeriesID,
				revision, row.IsDerived, row.SchemaVersion, row.NormalizationVersion)
		}
	})
}

// UpsertProviderSymbols implements canon.Writer. The kind/canonical-id
// namespace check (§35 + the storage CHECK) rejects the whole call when any
// row is incoherent — a wrong-namespace mapping would be refused by the
// database anyway, and surfacing it here keeps the error next to the fetcher
// that produced it.
func (r *Repo) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	if err := validateEntities("provider_symbol", len(rows), func(i int) error {
		row := rows[i]
		if row.Provider == "" || row.ProviderSymb == "" || row.Kind == "" || row.CanonicalID == "" {
			return fmt.Errorf("provider_symbol[%d]: empty provider, symbol, kind or canonical id", i)
		}
		if !hasKindPrefix(row.Kind, row.CanonicalID) {
			return fmt.Errorf("provider_symbol[%d]: canonical id %q lacks %q prefix", i, row.CanonicalID, row.Kind)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	return r.execBatchTolerant(ctx, len(rows), func(b *pgx.Batch) {
		for _, row := range rows {
			b.Queue(`INSERT INTO data.provider_symbol (provider, provider_symbol, kind, canonical_id, verified, last_seen_at)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT (provider, provider_symbol, kind) DO UPDATE SET
					canonical_id = EXCLUDED.canonical_id, verified = EXCLUDED.verified,
					last_seen_at = EXCLUDED.last_seen_at`,
				row.Provider, row.ProviderSymb, row.Kind, row.CanonicalID, row.Verified, row.LastSeenAt)
		}
	})
}

// hasKindPrefix mirrors the provider_symbol CHECK: canonical_id must spell
// "<kind>:<rest>".
func hasKindPrefix(kind, canonicalID string) bool {
	if len(canonicalID) <= len(kind)+1 {
		return false
	}
	return canonicalID[:len(kind)] == kind && canonicalID[len(kind)] == ':'
}

// validateEntities runs all-or-nothing entity validation.
func validateEntities(what string, n int, check func(i int) error) error {
	for i := range n {
		if err := check(i); err != nil {
			return fmt.Errorf("repo: upsert %s: %w", what, err)
		}
	}
	return nil
}
