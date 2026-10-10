package oecd

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "oecd"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The dataflow
// fetch upserts the series rows (one per REF_AREA country) and appends the
// observations since the cursor's last period.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	switch f.dataset {
	case "dataflow":
		written, rejected, next, err := f.client.dataflow(ctx, w, job)
		if err != nil {
			return ingest.FetchResult{}, err
		}
		return ingest.FetchResult{
			RowsIn:       written + rejected,
			RowsWritten:  written,
			RowsRejected: rejected,
			Next:         next,
		}, nil
	default:
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown dataset " + f.dataset}
	}
}

// Module is the oecd adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the oecd module with an optional injected Doer (tests).
// Public keyless API: no credentials.
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"dataflow": &fetcher{dataset: "dataflow", client: m.client},
	}
}

// Jobs is the seed registry: the RGD (regional GDP) dataflow's annual slice
// since 2015, poll daily. The subject is the full request path
// "{agency},{df},{version}/{key}"; the flow's column mapping lives in
// flowConfigs. NOTE: the flow id is pinned per the seed spec; if the OECD
// registry retires a dataflow (the SDMX registry answers "Could not find
// Dataflow and/or DSD"), the attempt fails with a status HardError and the
// engine's backoff/breaker handles it like any upstream outage.
func (m *Module) Jobs() []ingest.JobSpec {
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "dataflow",
			Subject: "OECD.SDD.TPS,DSD_RGD@DF_RGD,1.1.0/A.....",
			Mode:    "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
