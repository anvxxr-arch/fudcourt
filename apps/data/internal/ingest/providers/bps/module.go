package bps

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "bps"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The var-data
// fetch upserts the series row and appends the observations since the
// cursor's last period id.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	switch f.dataset {
	case "var-data":
		written, rejected, next, err := f.client.varData(ctx, w, job)
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

// Module is the bps adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the bps module. The key pair comes from BPS_API_KEY +
// BPS_API_ID; with either half empty the seed job registers Enabled=false
// (the engine never schedules it) and a manual fetch attempt fails with
// HardError{Kind:"no-credentials"}.
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0, apiKeyFromEnv(), apiIDFromEnv())}
}

// NewModuleWithKeys builds the module with an explicit key pair (tests).
func NewModuleWithKeys(d canon.Doer, apiKey, apiID string) *Module {
	return &Module{client: newClient(d, 0, apiKey, apiID)}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"var-data": &fetcher{dataset: "var-data", client: m.client},
	}
}

// Jobs is the seed registry: one variable (var/347, inflation YoY) poll
// daily. The job's Enabled mirrors the credential presence: without the key
// pair the row seeds disabled so the engine does not spin on guaranteed
// no-credentials failures.
func (m *Module) Jobs() []ingest.JobSpec {
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "var-data", Subject: "var/" + seedVar,
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5,
			Enabled: m.client.hasCredentials(),
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
