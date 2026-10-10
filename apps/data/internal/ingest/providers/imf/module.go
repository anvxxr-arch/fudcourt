package imf

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "imf"

// seedCountriesISO3 is the DataMapper country spelling set one indicators
// request pins in the URL (the seed jobs cover the US and Indonesia).
var seedCountriesISO3 = []string{"USA", "IDN"}

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The
// indicators fetch upserts the series rows (one per indicator+country) and
// appends the observations since the cursor's last year.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	switch f.dataset {
	case "indicators":
		written, rejected, next, err := f.client.indicators(ctx, w, job)
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

// Module is the imf adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the imf module with an optional injected Doer (tests).
// Public keyless API: no credentials.
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"indicators": &fetcher{dataset: "indicators", client: m.client},
	}
}

// Jobs is the seed registry: real GDP growth, headline inflation and
// unemployment-rate projections for USA and IDN, poll daily. The subject is
// the comma-separated DataMapper indicator list.
func (m *Module) Jobs() []ingest.JobSpec {
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "indicators", Subject: "NGDP_RPCH,PCPIPCH,LUR",
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
