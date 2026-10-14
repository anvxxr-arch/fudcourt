package mempool

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fetcher is one dataset's Fetcher implementation.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	period := "all"
	if p, ok := job.Cursor["period"].(string); ok && p != "" {
		period = p
	}
	var written, rejected int
	var err error
	switch f.dataset {
	case "hashrate":
		written, rejected, err = f.client.hashrate(ctx, w, period)
	case "rewards":
		written, rejected, err = f.client.rewards(ctx, w, period)
	case "fees":
		written, rejected, err = f.client.fees(ctx, w, period)
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
		Next:         ingest.Cursor{"period": period},
	}, nil
}

// Module is the mempool adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the mempool module (keyless).
func NewModule(d canon.Doer) *Module { return &Module{client: newClient(d, 0)} }

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"hashrate": &fetcher{dataset: "hashrate", client: m.client},
		"rewards":  &fetcher{dataset: "rewards", client: m.client},
		"fees":     &fetcher{dataset: "fees", client: m.client},
	}
}

// Jobs is the seed registry: three keyless Bitcoin network datasets on a daily
// cadence. The period "all" pulls full history, which the bucket/write path
// handles idempotently (observations upsert on (series, observed_at)).
func (m *Module) Jobs() []ingest.JobSpec {
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "hashrate", Subject: "bitcoin",
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "rewards", Subject: "bitcoin",
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "fees", Subject: "bitcoin",
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
