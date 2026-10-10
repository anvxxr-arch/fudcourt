package fred

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "fred"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The
// observations fetch upserts the series rows its subjects imply and appends
// the new observations since the cursor's last period.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	switch f.dataset {
	case "observations":
		written, rejected, next, err := f.client.observations(ctx, w, job)
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

// Module is the fred adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the fred module. The API key comes from FRED_API_KEY; an
// empty key keeps the module (and its jobs) registered but fails every fetch
// attempt with HardError{Kind:"no-credentials"} until the key is provided.
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
		"observations": &fetcher{dataset: "observations", client: m.client},
	}
}

// Jobs is the seed registry: the four U.S. aggregates poll daily. The subject
// is the comma-separated FRED series id list; jobs stay Enabled regardless of
// the key so the registry's shape is stable - a missing key surfaces as
// journaled no-credentials attempts, never as a silently missing job.
func (m *Module) Jobs() []ingest.JobSpec {
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "observations", Subject: "CPIAUCSL,FEDFUNDS,GDP,UNRATE",
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
	}
}

// parseF64 parses a FRED numeric string (strconv wrapper keeps the mapping
// file free of a strconv import).
func parseF64(s string) (float64, error) {
	return strconv.ParseFloat(strings.TrimSpace(s), 64)
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
