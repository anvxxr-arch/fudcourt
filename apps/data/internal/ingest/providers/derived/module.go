// Package derived is the ingest adapter that runs the derive engine over
// canonical source data and lands the results in data.metric. It exists so the
// derive pipeline is scheduled by the SAME engine that owns every other
// provider's jobs (rate limiter, circuit breaker, run journal) instead of a
// bespoke ticker: Provider "derived" seeds one "metrics" job, and its fetcher
// reads the BTC daily close bars, runs each registered MetricSpec through
// derive.Pipeline.RunPoints, and writes the derived series.
package derived

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "derived"

// fetcher is the dataset's Fetcher. It holds the canon.Reader the pipeline
// reads source data through; the engine hands it the Writer per call.
type fetcher struct {
	r canon.Reader
}

func (f *fetcher) Dataset() string { return "metrics" }

// Fetch runs ONE derive pass: read BTC daily closes, then run every P0 spec
// through the pipeline. A spec failure stops the pass and surfaces loudly (the
// engine journals it and backs off); rows written before the failure are
// reported so the count is honest.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	btc, err := f.btcDailyCloses(ctx)
	if err != nil {
		return ingest.FetchResult{}, err
	}
	written, err := runSpecs(ctx, f.r, w, btc)
	if err != nil {
		return ingest.FetchResult{RowsIn: written, RowsWritten: written}, err
	}
	// Mining charts are best-effort: an absent mempool hashrate series is not a
	// failure (the sidecar may run before mempool's first poll).
	mw, err := runMining(ctx, f.r, w, btc)
	if err != nil {
		return ingest.FetchResult{RowsIn: written + mw, RowsWritten: written + mw}, err
	}
	written += mw
	return ingest.FetchResult{RowsIn: written, RowsWritten: written}, nil
}

// Module is the derived adapter's registration.
type Module struct {
	r canon.Reader
}

// NewModule builds the derived module over the canon reader the sidecar
// already owns.
func NewModule(r canon.Reader) *Module { return &Module{r: r} }

func (m *Module) Provider() string { return providerName }

// Fetchers returns the single metrics fetcher.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{"metrics": &fetcher{r: m.r}}
}

// Jobs is the seed registry: one metrics pass on a 30-minute cadence.
func (m *Module) Jobs() []ingest.JobSpec {
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "metrics", Subject: "btc",
			Mode: "poll", Schedule: 30 * time.Minute, Priority: 4, Enabled: true,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
