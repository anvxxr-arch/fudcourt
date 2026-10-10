package cftc

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "cftc"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The first
// rows of every fetch opportunistically upsert the entities they imply: the
// tracked assets and the positioning series.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var next = ingest.Cursor{}
	var err error
	switch f.dataset {
	case "cot":
		written, rejected, next, err = f.client.cot(ctx, w, job)
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

// Module is the cftc adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the cftc module with an optional injected Doer (tests).
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"cot": &fetcher{dataset: "cot", client: m.client},
	}
}

// Jobs is the seed registry: the COT report poll weekly (the CFTC publishes
// Fridays, data final Tuesday). The subject is empty — the Socrata resource
// IS the dataset — and the cursor carries the paging/year state.
func (m *Module) Jobs() []ingest.JobSpec {
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "cot", Subject: "",
			Mode: "poll", Schedule: 7 * 24 * time.Hour, Priority: 5, Enabled: true,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
