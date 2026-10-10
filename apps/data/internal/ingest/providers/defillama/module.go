package defillama

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "defillama"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The first
// rows of every fetch opportunistically upsert the entities they imply:
// the protocols and chains the rows name.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var next = ingest.Cursor{}
	var err error
	switch f.dataset {
	case "protocols-tvl":
		written, rejected, err = f.client.protocolsTVL(ctx, w, job)
	case "chains-tvl":
		written, rejected, err = f.client.chainTVL(ctx, w, job)
	case "protocol-history":
		var n ingest.Cursor
		written, rejected, n, err = f.client.protocolHistory(ctx, w, job)
		next = n
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

// Module is the defillama adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the defillama module with an optional injected Doer (tests).
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"protocols-tvl":    &fetcher{dataset: "protocols-tvl", client: m.client},
		"chains-tvl":       &fetcher{dataset: "chains-tvl", client: m.client},
		"protocol-history": &fetcher{dataset: "protocol-history", client: m.client},
	}
}

// Jobs is the seed registry: the protocol and chain universes poll 5m; one
// protocol-history backfill job per tracked protocol poll 1h (the subject is
// the slug; the cursor carries slug + backfill window).
func (m *Module) Jobs() []ingest.JobSpec {
	specs := []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "protocols-tvl", Subject: "",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 4, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "chains-tvl", Subject: "",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 4, Enabled: true,
		},
	}
	for _, slug := range []string{"aave", "uniswap"} {
		specs = append(specs, ingest.JobSpec{
			Provider: providerName, Dataset: "protocol-history", Subject: slug,
			Mode: "backfill", Schedule: time.Hour, Priority: 5, Enabled: true,
		})
	}
	return specs
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
