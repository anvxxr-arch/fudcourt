package helius

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "helius"

// seedAddress is the seeded watch address: the wrapped-SOL mint, the
// highest-traffic swap address on Solana. Operators add their own
// pool/wallet subjects as further job rows on the same datasets.
const seedAddress = "solana:So11111111111111111111111111111111111111112"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve. dw is the DEX
// writer: swaps and wallet activity land in the data.dex_* tables through
// it, while entities (chains, venues) still go through the engine writer w.
type fetcher struct {
	dataset string
	client  *client
	dw      dexstore.Writer
}

// Fetch runs ONE synchronous attempt (the engine owns retries).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	if f.dw == nil {
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "no dex writer wired"}
	}
	var written, rejected int
	var next ingest.Cursor
	var err error
	switch f.dataset {
	case "swaps":
		written, rejected, next, err = f.client.swaps(ctx, w, f.dw, job)
	case "wallet":
		written, rejected, next, err = f.client.wallet(ctx, w, f.dw, job)
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

// Module is the helius adapter's registration.
type Module struct {
	client *client
	dw     dexstore.Writer
}

// NewModule builds the helius module. The API keys are read from
// HELIUS_API_KEYS (a list) and HELIUS_API_KEY (single) once, here, and requests
// round-robin across them; with no key every fetch fails with a
// no-credentials HardError before any request is made, and Jobs seeds the
// jobs disabled. dw is the DEX writer the fetchers write swaps and wallet
// activity through; a nil dw fails loudly at Fetch time, never silently.
func NewModule(d canon.Doer, dw dexstore.Writer) *Module {
	return &Module{client: newClient(d, 0), dw: dw}
}

// HasCredentials reports whether an API key is configured; the seeder uses it
// to decide the seed jobs' enabled flag.
func (m *Module) HasCredentials() bool { return len(m.client.apiKeys) > 0 }
func (m *Module) Provider() string     { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"swaps":  &fetcher{dataset: "swaps", client: m.client, dw: m.dw},
		"wallet": &fetcher{dataset: "wallet", client: m.client, dw: m.dw},
	}
}

// Jobs is the seed registry: one swaps backfill and one wallet backfill over
// the wrapped-SOL mint, hourly. Both page backward through the address
// history via the {"before": signature} cursor. The jobs enable only when an
// API key is configured - a disabled seed keeps the identity tuple
// registered without failing on every tick.
func (m *Module) Jobs() []ingest.JobSpec {
	enabled := m.HasCredentials()
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "swaps", Subject: seedAddress,
			Mode: "backfill", Schedule: time.Hour, Priority: 5, Enabled: enabled,
		},
		{
			Provider: providerName, Dataset: "wallet", Subject: seedAddress,
			Mode: "backfill", Schedule: time.Hour, Priority: 4, Enabled: enabled,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
