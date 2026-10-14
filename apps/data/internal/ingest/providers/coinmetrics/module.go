package coinmetrics

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fetcher is the dataset's Fetcher implementation.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	switch f.dataset {
	case "asset-metrics":
		written, rejected, err := f.client.metrics(ctx, w, job.Subject)
		if err != nil {
			return ingest.FetchResult{}, err
		}
		return ingest.FetchResult{
			RowsIn:       written + rejected,
			RowsWritten:  written,
			RowsRejected: rejected,
			Next:         ingest.Cursor{},
		}, nil
	default:
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown dataset " + f.dataset}
	}
}

// Module is the coinmetrics adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the coinmetrics module (keyless community tier).
func NewModule(d canon.Doer) *Module { return &Module{client: newClient(d, 0)} }

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"asset-metrics": &fetcher{dataset: "asset-metrics", client: m.client},
	}
}

// Jobs is the seed registry: one daily BTC market-data pull.
func (m *Module) Jobs() []ingest.JobSpec {
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "asset-metrics", Subject: "btc",
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
