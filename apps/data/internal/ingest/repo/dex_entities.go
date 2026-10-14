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

// This file implements the entity half of dexstore.Writer (docs/dex/audit.md
// §4). It lives on the SAME *Repo as the market store — one pool, one
// transaction surface — but writes the data.dex_* tables, which the frozen
// canon.Writer deliberately does not cover.
//
// The compile-time assertions make a missing or mis-typed method a BUILD error
// rather than a runtime surprise.
var (
	_ dexstore.Writer = (*Repo)(nil)
	_ dexstore.Reader = (*Repo)(nil)
)

// UpsertDexDeployments implements dexstore.Writer. A row with an empty
// deployment id, protocol, chain or natural key is REJECTED and counted, never
// written with a guess (never-fake).
func (r *Repo) UpsertDexDeployments(ctx context.Context, rows []canon.DexDeployment) (int, error) {
	if err := validateEntities("dex_deployment", len(rows), func(i int) error {
		row := rows[i]
		if row.DeploymentID == "" || row.ProtocolID == "" || row.ChainID == "" || row.NaturalKey == "" {
			return fmt.Errorf("dex_deployment[%d]: empty id, protocol, chain or natural key", i)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	err := r.execBatchStrict(ctx, len(rows), func(b *pgx.Batch) {
		for _, row := range rows {
			b.Queue(`INSERT INTO data.dex_deployment
				(deployment_id, natural_key, protocol_id, chain_id, factory, router,
				 other_contracts, address_kind, source, retrieved_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
				ON CONFLICT (deployment_id) DO UPDATE SET
					natural_key = EXCLUDED.natural_key, protocol_id = EXCLUDED.protocol_id,
					chain_id = EXCLUDED.chain_id, factory = EXCLUDED.factory,
					router = EXCLUDED.router, other_contracts = EXCLUDED.other_contracts,
					address_kind = EXCLUDED.address_kind, source = EXCLUDED.source,
					retrieved_at = EXCLUDED.retrieved_at`,
				row.DeploymentID, row.NaturalKey, row.ProtocolID, row.ChainID,
				nilIfEmpty(row.Factory), nilIfEmpty(row.Router),
				jsonOrNil(row.OtherContracts), nilIfEmpty(row.AddressKind),
				row.Provenance.SourceProvider, nullTime(row.Provenance.NormalizedAt))
		}
	})
	if err != nil {
		return 0, fmt.Errorf("repo: upsert dex_deployment: %w", err)
	}
	return len(rows), nil
}

// UpsertPoolTokens implements dexstore.Writer. canon.PoolToken carries no
// timestamp of its own (a composition is a state, not an event), so the batch's
// evaluation instant is used for the partition column `at` — the same
// "now is the snapshot time" convention WritePools' callers use. A row with an
// empty pool or token id is rejected.
func (r *Repo) UpsertPoolTokens(ctx context.Context, rows []canon.PoolToken) (int, error) {
	at := time.Now().UTC()
	if err := validateEntities("dex_pool_token", len(rows), func(i int) error {
		row := rows[i]
		if row.PoolID == "" || row.TokenID == "" {
			return fmt.Errorf("dex_pool_token[%d]: empty pool_id or token_id", i)
		}
		return nil
	}); err != nil {
		return 0, err
	}
	err := r.execBatchStrict(ctx, len(rows), func(b *pgx.Batch) {
		for _, row := range rows {
			b.Queue(`INSERT INTO data.dex_pool_token
				(pool_id, token_id, pool_index, reserve_raw, reserve_decimals, weight, is_base, source, at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
				ON CONFLICT (pool_id, token_id, at) DO UPDATE SET
					pool_index = EXCLUDED.pool_index, reserve_raw = EXCLUDED.reserve_raw,
					reserve_decimals = EXCLUDED.reserve_decimals, weight = EXCLUDED.weight,
					is_base = EXCLUDED.is_base, source = EXCLUDED.source`,
				row.PoolID, row.TokenID, row.Index,
				rawOrNil(row.Reserve), decimalsOrNil(row.Reserve),
				decOrNil(row.Weight), row.IsBase, "dex_pool_token", at)
		}
	})
	if err != nil {
		return 0, fmt.Errorf("repo: upsert dex_pool_token: %w", err)
	}
	return len(rows), nil
}

// --- shared helpers for the DEX writers -------------------------------------

// jsonOrNil marshals v to jsonb, returning nil for an empty map so the column
// stays SQL NULL rather than "{}" (never-fake prefers NULL over an empty map).
func jsonOrNil(v any) any {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil || len(b) == 0 || string(b) == "{}" || string(b) == "null" || string(b) == "[]" {
		return nil
	}
	return b
}

// rawOrNil renders a TokenAmount's raw integer for a numeric column, or nil.
func rawOrNil(a *canon.TokenAmount) any {
	if a == nil || a.Raw == nil {
		return nil
	}
	return a.RawString()
}

// decimalsOrNil renders a TokenAmount's decimals, or nil.
func decimalsOrNil(a *canon.TokenAmount) any {
	if a == nil {
		return nil
	}
	return a.Decimals
}

// decOrNil renders an exact Dec for a numeric column, or nil when absent.
// A PRESENT Dec renders its exact decimal string — never a float.
func decOrNil(d *canon.Dec) any {
	if d == nil || !d.Present() {
		return nil
	}
	return d.String()
}

// decValOrNil is decOrNil for a by-value Dec (the canonical structs carry the
// required ones by value).
func decValOrNil(d canon.Dec) any {
	if !d.Present() {
		return nil
	}
	return d.String()
}

// jsonBytesOrNil renders a payload for a bytea column.
func jsonBytesOrNil(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}
