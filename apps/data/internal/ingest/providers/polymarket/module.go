package polymarket

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "polymarket"

// defaultMaxPages caps the markets page walk (100 rows/page -> 400 open
// markets by default; the cursor resumes the walk on the next run).
const defaultMaxPages = 4

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset  string
	client   *client
	maxPages int
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The first
// rows of every fetch opportunistically upsert the entities they imply: the
// provider symbols (gamma id -> prediction id).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var next = ingest.Cursor{}
	var err error
	switch f.dataset {
	case "markets":
		written, rejected, next, err = f.client.markets(ctx, w, job, f.maxPages)
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
		Next:         next,
	}, nil
}

// Module is the polymarket adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the polymarket module with an optional injected Doer
// (tests).
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"markets": &fetcher{dataset: "markets", client: m.client, maxPages: defaultMaxPages},
	}
}

// Jobs is the seed registry: the open-market walk polls 5m (prices move;
// liquidity/volume refresh on the same pass). The subject is empty — the
// open universe IS the dataset — and the cursor carries the paging state.
func (m *Module) Jobs() []ingest.JobSpec {
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "markets", Subject: "",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 4, Enabled: true,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
