package coingecko

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "coingecko"

// defaultMaxPages caps the markets page walk when the job config doesn't
// carry one (250 rows/page -> 1000 coins by default).
const defaultMaxPages = 4

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
	cfg     Config
}

func (f *fetcher) Dataset() string { return f.dataset }

// Config carries the module-level knobs (tests set them; production uses the
// defaults).
type Config struct {
	// MaxPages caps the markets page walk (default 4).
	MaxPages int
}

// Fetch runs ONE synchronous attempt (the engine owns retries). The first
// rows of every fetch opportunistically upsert the entities they imply:
// the assets and the (gecko id -> asset id) provider symbols.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var next = ingest.Cursor{}
	var err error
	switch f.dataset {
	case "markets":
		written, rejected, err = f.client.markets(ctx, w, job, f.cfg)
	case "global":
		written, rejected, err = f.client.global(ctx, w, job)
	case "market-chart":
		written, rejected, next, err = f.client.marketChart(ctx, w, job)
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

// Module is the coingecko adapter's registration.
type Module struct {
	client *client
	cfg    Config
}

// NewModule builds the coingecko module with an optional injected Doer
// (tests) and default config.
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

// NewModuleWithConfig builds the module with explicit knobs.
func NewModuleWithConfig(d canon.Doer, cfg Config) *Module {
	return &Module{client: newClient(d, 0), cfg: cfg}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"markets":      &fetcher{dataset: "markets", client: m.client, cfg: m.cfg},
		"global":       &fetcher{dataset: "global", client: m.client},
		"market-chart": &fetcher{dataset: "market-chart", client: m.client},
	}
}

// Jobs is the seed registry: markets poll 5m (the universe + spot series),
// global poll 5m, and one market-chart backfill job per tracked coin poll 1h
// (cursor pins the gecko id + symbol; 90 days of hourly points per run).
func (m *Module) Jobs() []ingest.JobSpec {
	specs := []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "markets", Subject: "",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "global", Subject: "",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 4, Enabled: true,
		},
	}
	// market-chart backfills: one job per tracked coin, poll 1h. The subject
	// is the gecko id; markets.go's seedSymbols owns the id -> symbol pair.
	for _, id := range []string{"bitcoin", "ethereum"} {
		specs = append(specs, ingest.JobSpec{
			Provider: providerName, Dataset: "market-chart", Subject: id,
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
