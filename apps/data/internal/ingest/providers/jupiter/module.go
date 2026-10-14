package jupiter

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "jupiter"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve. The fetcher holds
// the DEX writer: Fetch gives only a canon.Writer, which cannot write DEX
// tables, so swaps/candles/snapshots/quotes go through dw while entities
// (chains, venues, assets, provider symbols) go through w.
type fetcher struct {
	dataset string
	client  *client
	dw      dexstore.Writer
}

// Fetch runs ONE synchronous attempt (the engine owns retries).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var err error
	switch f.dataset {
	case "quote":
		written, rejected, err = f.client.quote(ctx, w, f.dw, job)
	case "tokens":
		written, rejected, err = f.client.tokens(ctx, w, job)
	default:
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown dataset " + f.dataset}
	}
	if err != nil {
		return ingest.FetchResult{}, err
	}
	return ingest.FetchResult{
		RowsIn:       written + rejected,
		RowsWritten:  written,
		RowsRejected: rejected,
		Next:         ingest.Cursor{},
	}, nil
}

// Module is the jupiter adapter's registration.
type Module struct {
	client *client
	dw     dexstore.Writer
}

// NewModule builds the jupiter module. The optional API key is read from
// JUPITER_API_KEY once, here; the provider serves a keyless tier, so the
// module builds and fetches with or without it. dw is the DEX write port the
// quote fetcher needs (Fetch cannot reach DEX tables through canon.Writer).
func NewModule(d canon.Doer, dw dexstore.Writer) *Module {
	return &Module{client: newClient(d, 0), dw: dw}
}

// HasCredentials reports whether an API key is configured. It is recorded
// for the operator only: Jobs seeds enabled either way.
func (m *Module) HasCredentials() bool { return m.client.apiKey != "" }
func (m *Module) Provider() string     { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"quote":  &fetcher{dataset: "quote", client: m.client, dw: m.dw},
		"tokens": &fetcher{dataset: "tokens", client: m.client, dw: m.dw},
	}
}

// Jobs is the seed registry: one quote poll (30s; quotes decay fast) and one
// daily token-list refresh. Both seed ENABLED with or without a key: the
// keyless tier serves them, so gating on the key would idle a working
// provider.
func (m *Module) Jobs() []ingest.JobSpec {
	// defaultQuoteSubject quotes SOL -> USDC; both mints are in knownDecimals,
	// so the raw amounts normalize correctly (an unknown mint fails loudly
	// rather than assuming 0 decimals — see decimalsFor).
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "quote", Subject: defaultQuoteSubject,
			Mode: "poll", Schedule: 30 * time.Second, Priority: 4, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "tokens", Subject: chainSolana,
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
