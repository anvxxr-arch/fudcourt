package bi

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "bi"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The series
// fetch upserts the series row and appends the observations since the
// cursor's last date.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	switch f.dataset {
	case "series":
		written, rejected, next, err := f.client.series(ctx, w, job)
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

// Module is the bi adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the bi module. The gateway key comes from BI_API_KEY;
// with it empty the seeded jobs register Enabled=false (the gateway demands
// X-API-KEY) and a manual fetch attempt fails with
// HardError{Kind:"no-credentials"}.
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0, apiKeyFromEnv())}
}

// NewModuleWithKey builds the module with an explicit key (tests).
func NewModuleWithKey(d canon.Doer, apiKey string) *Module {
	return &Module{client: newClient(d, 0, apiKey)}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"series": &fetcher{dataset: "series", client: m.client},
	}
}

// Jobs is the seed registry: the BI rate and the USD middle rate, poll daily.
// Enabled mirrors the credential presence: without BI_API_KEY the rows seed
// disabled so the engine does not spin on guaranteed no-credentials failures.
func (m *Module) Jobs() []ingest.JobSpec {
	enabled := m.client.apiKey != ""
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "series", Subject: "bi-rate",
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: enabled,
		},
		{
			Provider: providerName, Dataset: "series", Subject: "kurs:USD",
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: enabled,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
