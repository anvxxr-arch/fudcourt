package okx

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "okx"

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The first
// rows of every fetch opportunistically upsert the entities they imply:
// the venue and the instruments the subject instrument ids mint.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var err error
	switch f.dataset {
	case "ohlcv":
		tf := "1m"
		if s, ok := job.Cursor["timeframe"].(string); ok && s != "" {
			tf = s
		}
		written, rejected, err = f.client.candles(ctx, w, job, tf, 300)
	case "funding":
		written, rejected, err = f.client.funding(ctx, w, job, 100)
	case "open-interest":
		written, rejected, err = f.client.openInterest(ctx, w, job, 0)
	case "ticker":
		written, rejected, err = f.client.ticker(ctx, w, job)
	case "trades":
		written, rejected, err = f.client.trades(ctx, w, job, 100)
	case "depth":
		written, rejected, err = f.client.depth(ctx, w, job, 100)
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

// Module is the okx adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the okx module with an optional injected Doer (tests).
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
		"trades":        &fetcher{dataset: "trades", client: m.client},
		"depth":         &fetcher{dataset: "depth", client: m.client},
		"instruments":   &fetcher{dataset: "instruments", client: m.client},
	}
}

// Jobs is the seed registry: ohlcv BTC/ETH poll 1m, funding and oi BTC/ETH
// poll 5m, tickers stream 30s, and the one-shot instrument listings. Subjects
// carry the market; the linear_perp subject spells the SPOT pair and the
// adapter appends -SWAP for the SWAP instId.
func (m *Module) Jobs() []ingest.JobSpec {
	specs := []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "ohlcv", Subject: "spot:BTC-USDT",
			Mode: "poll", Schedule: time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "ohlcv", Subject: "spot:ETH-USDT",
			Mode: "poll", Schedule: time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "ohlcv", Subject: "linear_perp:BTC-USDT",
			Mode: "poll", Schedule: time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "ohlcv", Subject: "linear_perp:ETH-USDT",
			Mode: "poll", Schedule: time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "funding", Subject: "linear_perp:BTC-USDT",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "funding", Subject: "linear_perp:ETH-USDT",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "open-interest", Subject: "linear_perp:BTC-USDT",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "open-interest", Subject: "linear_perp:ETH-USDT",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 3, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "ticker", Subject: "",
			Mode: "stream", Schedule: 30 * time.Second, Priority: 4, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "trades", Subject: "spot:BTC-USDT",
			Mode: "poll", Schedule: time.Minute, Priority: 2, Enabled: true,
		},
		{
			Provider: providerName, Dataset: "depth", Subject: "spot:BTC-USDT",
			Mode: "poll", Schedule: 30 * time.Second, Priority: 2, Enabled: true,
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
