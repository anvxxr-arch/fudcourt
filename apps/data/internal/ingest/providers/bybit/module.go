package bybit

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "bybit"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The first
// rows of every fetch opportunistically upsert the entities they imply:
// the venue and the instruments the subject symbols mint.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var err error
	switch f.dataset {
	case "ohlcv":
		tf := "1m"
		if s, ok := job.Cursor["timeframe"].(string); ok && s != "" {
			tf = s
		}
		written, rejected, err = f.client.klines(ctx, w, job, tf, 1000)
	case "funding":
		written, rejected, err = f.client.funding(ctx, w, job, 200)
	case "open-interest":
		written, rejected, err = f.client.openInterest(ctx, w, job, 200)
	case "ticker":
		written, rejected, err = f.client.ticker(ctx, w, job)
	case "instruments":
		written, rejected, err = f.client.instruments(ctx, w, job)
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
		Next:         ingest.Cursor{},
	}, nil
}

// Module is the bybit adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the bybit module with an optional injected Doer (tests).
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"ohlcv":         &fetcher{dataset: "ohlcv", client: m.client},
		"funding":       &fetcher{dataset: "funding", client: m.client},
		"open-interest": &fetcher{dataset: "open-interest", client: m.client},
		"ticker":        &fetcher{dataset: "ticker", client: m.client},
		"instruments":   &fetcher{dataset: "instruments", client: m.client},
	}
}

// Jobs is the seed registry: ohlcv BTC/ETH poll 1m, funding and oi BTC/ETH
// poll 5m, tickers stream 30s, and the one-shot instrument listing. Subjects
// carry the market for klines ("spot:BTCUSDT"); funding/oi are linear-perp
// only so the bare symbol means the USDⓈ-M linear perp.
func (m *Module) Jobs() []ingest.JobSpec {
	specs := []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "ohlcv", Subject: "spot:BTCUSDT",
			Mode: "poll", Schedule: time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "ohlcv", Subject: "spot:ETHUSDT",
			Mode: "poll", Schedule: time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "ohlcv", Subject: "linear_perp:BTCUSDT",
			Mode: "poll", Schedule: time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "ohlcv", Subject: "linear_perp:ETHUSDT",
			Mode: "poll", Schedule: time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "funding", Subject: "BTCUSDT",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "funding", Subject: "ETHUSDT",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "open-interest", Subject: "BTCUSDT",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "open-interest", Subject: "ETHUSDT",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "ticker", Subject: "",
			Mode: "stream", Schedule: 30 * time.Second, Priority: 4, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "instruments", Subject: "spot",
			Mode: "backfill", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "instruments", Subject: "linear_perp",
			Mode: "backfill", Schedule: 24 * time.Hour, Priority: 5, Enabled: true,
		},
	}
	return specs
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
