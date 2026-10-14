// module.go — the The Graph subgraph adapter (plan §41, tier S2).

// This adapter targets the canonical Uniswap-v3-style subgraph schema, and the
// two queries below are written against it explicitly. Two hazards that schema
// creates are handled in datasets.go rather than left to the reader:
//
//  1. `Swap.amount0`/`amount1` are BigDecimal STRINGS in token units (e.g.
//     "-1.234"), NOT raw integers, and the Swap entity carries NO token
//     relations — decimals live on `pool.token0`/`pool.token1`. The query
//     descends pool -> token so the amounts can be re-scaled to exact raw via
//     the real exponents; reading decimals off the swap would yield 0 and a
//     1e18-scale error on every row.
//  2. The amounts are POOL-perspective: positive = the taker sent that token
//     (input), negative = the taker received it (output). The sign is the
//     direction; see swapLegs.
//
// A DIFFERENT subgraph (V2 `pairs`, Sushi, a custom schema) needs its own query
// and field mapping; this file does not pretend one shape covers them all.
package thegraph

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "thegraph"

// chainSolana is unused here but keeps the chain vocabulary explicit: The Graph
// is EVM-only in this adapter, so every subject names an EVM chain.
const (
	// SubgraphEnv is the base for the gateway URL read once at construction
	// (a subgraph deployment id is appended). It is a credential the operator
	// supplies, so it lives in the environment, never in source.
	SubgraphEnv = "THEGRAPH_SUBGRAPH_URL"
	// defaultTimeout bounds one upstream request.
	defaultTimeout = 30 * time.Second
	// sourceType/tier classify the provider on every written row; this is the
	// WRITE-side class and must match canon.ClassifyProvider's entry for
	// "thegraph" (indexer / S2). TestWriterClassAgreesWithClassify pins it.
	sourceType = "indexer"
)

// fetcher is one dataset's Fetcher implementation. dw is the DEX writer the
// swaps dataset needs (Fetch can only reach canon.Writer).
type fetcher struct {
	dataset string
	client  *client
	dw      dexstore.Writer
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The subgraph's
// swaps dataset carries an explicit block cursor, so a page advances it; the
// pool-day-data dataset is a windowed read with no cursor.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var next ingest.Cursor
	var err error
	switch f.dataset {
	case "swaps":
		written, rejected, next, err = f.client.swaps(ctx, w, f.dw, job)
	case "pool-day-data":
		written, rejected, err = f.client.poolDayData(ctx, w, f.dw, job)
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

// Module is the thegraph adapter's registration.
type Module struct {
	client *client
	dw     dexstore.Writer
}

// NewModule builds the thegraph module. The subgraph URL is read from the
// environment once, here; with no URL every fetch fails with a no-credentials
// HardError BEFORE any request, and Jobs seeds the jobs disabled — a paid
// subgraph must never fail the build or hammer a missing endpoint.
func NewModule(d canon.Doer, dw dexstore.Writer) *Module {
	return &Module{client: newClient(d, 0), dw: dw}
}

// HasCredentials reports whether a subgraph URL is configured.
func (m *Module) HasCredentials() bool { return m.client.baseURL != "" }
func (m *Module) Provider() string     { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"swaps":         &fetcher{dataset: "swaps", client: m.client, dw: m.dw},
		"pool-day-data": &fetcher{dataset: "pool-day-data", client: m.client, dw: m.dw},
	}
}

// Jobs is the seed registry: one swaps backfill (block-cursor paged) and one
// daily pool-stats poll. Both enable only with a configured subgraph AND a DEX
// writer, so a missing credential is a disabled seed rather than a failing tick.
func (m *Module) Jobs() []ingest.JobSpec {
	enabled := m.HasCredentials() && m.dw != nil
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "swaps", Subject: seedPool,
			Mode: "backfill", Schedule: time.Hour, Priority: 4, Enabled: enabled,
		},
		{
			Provider: providerName, Dataset: "pool-day-data", Subject: seedPool,
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: enabled,
		},
	}
}

// seedPool is the seeded subject: the canonical Uniswap v3 WETH/USDT 0.05% pool
// the other adapters already track, so this adapter's rows land on a pool that
// exists rather than minting a second identity for the same venue.
const seedPool = "ethereum:0x11b815efb8f581194ae79006d24e0d814b7697f6"

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
