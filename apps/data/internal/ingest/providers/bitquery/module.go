// module.go — the Bitquery indexer adapter (plan §41, tier S2).

// Bitquery is a GraphQL indexer over its own EVM/Solana cubes. This adapter
// targets the documented v2 EVM `DEXTrades` cube, which carries the swap's buy
// and sell legs in ONE row (unlike a subgraph's per-swap amount0/amount1), so
// the direction is explicit: `Sell` is what the taker gave (input), `Buy` is
// what the taker received (output). `Buy.Amount`/`Sell.Amount` are decimal
// strings in whole-token units and the token decimals ride on
// `Currency.Decimals`, so the adapter re-scales to exact raw the same way the
// subgraph adapter does — never through a float.
//
// The schema shape is encoded from Bitquery's published v2 documentation; it has
// NOT been exercised against a live key (none is configured here), so the
// fixture tests pin the mapping, not upstream fidelity. A key is required to run
// it, and the jobs seed DISABLED without one.
package bitquery

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "bitquery"

// APIKeyEnv is the credential the adapter reads once at construction; it rides
// the Authorization header and never reaches a URL, a log line or an error.
const APIKeyEnv = "BITQUERY_API_KEY"

// sourceType classifies every written row (indexer / S2); it must match
// canon.ClassifyProvider's entry, which TestWriterClassAgreesWithClassify pins.
const sourceType = "indexer"

// seedPool is the seeded subject: the canonical Uniswap v3 WETH/USDT 0.05% pool
// the other adapters track, so this adapter's rows land on an existing pool.
const seedPool = "ethereum:0x11b815efb8f581194ae79006d24e0d814b7697f6"

// fetcher is one dataset's Fetcher. dw is the DEX writer the swaps dataset
// needs (Fetch can only reach canon.Writer, which cannot write data.dex_*).
type fetcher struct {
	dataset string
	client  *client
	dw      dexstore.Writer
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var next ingest.Cursor
	var err error
	switch f.dataset {
	case "dex-trades":
		written, rejected, next, err = f.client.dexTrades(ctx, w, f.dw, job)
	default:
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown dataset " + f.dataset}
	}
	if err != nil {
		return ingest.FetchResult{}, err
	}
	if next == nil {
		next = ingest.Cursor{}
	}
	return ingest.FetchResult{
		RowsIn:       written + rejected,
		RowsWritten:  written,
		RowsRejected: rejected,
		Next:         next,
	}, nil
}

// Module is the bitquery adapter's registration.
type Module struct {
	client *client
	dw     dexstore.Writer
}

// NewModule builds the bitquery module. The API key is read from the environment
// once, here; with no key every fetch fails with a no-credentials HardError
// BEFORE any request and Jobs seeds the jobs disabled — a paid indexer must
// never fail the build or hammer a keyless endpoint.
func NewModule(d canon.Doer, dw dexstore.Writer) *Module {
	return &Module{client: newClient(d, 0), dw: dw}
}

// HasCredentials reports whether an API key is configured.
func (m *Module) HasCredentials() bool { return m.client.apiKey != "" }
func (m *Module) Provider() string     { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"dex-trades": &fetcher{dataset: "dex-trades", client: m.client, dw: m.dw},
	}
}

// Jobs seeds one swaps backfill (block-number paged). It enables only with a
// configured key AND a DEX writer, so a missing credential is a disabled seed
// rather than a failing tick.
func (m *Module) Jobs() []ingest.JobSpec {
	enabled := m.HasCredentials() && m.dw != nil
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "dex-trades", Subject: seedPool,
			Mode: "backfill", Schedule: 6 * time.Hour, Priority: 4, Enabled: enabled,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
