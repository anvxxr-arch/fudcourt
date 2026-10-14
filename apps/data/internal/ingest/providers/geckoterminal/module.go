package geckoterminal

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/dexstore"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "geckoterminal"

// assetKinds is the closed symbol -> AssetKind vocabulary for the pool sides
// this adapter anchors (same rule as the coingecko adapter: reference-pinned
// symbols keep their reference kinds, everything else is other).
var assetKinds = func() map[string]canon.AssetKind {
	m := map[string]canon.AssetKind{}
	for _, s := range []string{"BTC", "ETH", "SOL", "BNB", "POL", "TRX"} {
		m[s] = canon.AssetNative
	}
	for _, s := range []string{"USDT", "USDC", "DAI", "FDUSD", "TUSD"} {
		m[s] = canon.AssetStablecoin
	}
	return m
}()

// assetKind reports the canonical AssetKind for a symbol.
func assetKind(symbol string) canon.AssetKind {
	if k, ok := assetKinds[symbol]; ok {
		return k
	}
	return canon.AssetOther
}

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve. dw is the DEX
// writer the `dex-candles` dataset needs (Fetch can only reach canon.Writer,
// which cannot write data.dex_* tables).
type fetcher struct {
	dataset string
	client  *client
	dw      dexstore.Writer
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The fetch
// opportunistically upserts the entities the pool implies: the chain, the
// DEX venue and the pool-side assets.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var next ingest.Cursor
	var err error
	switch f.dataset {
	case "pools":
		written, rejected, err = f.client.pool(ctx, w, job)
	case "network-pools":
		written, rejected, err = f.client.networksPools(ctx, w, job)
	case "dex-candles":
		written, rejected, next, err = f.client.dexCandles(ctx, w, f.dw, job)
	default:
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown dataset " + f.dataset}
	}
	if err != nil {
		return ingest.FetchResult{}, err
	}
	if next == nil {
		next = ingest.Cursor{}
	}
	return ingest.FetchResult{
		RowsIn:       written + rejected,
		RowsWritten:  written,
		RowsRejected: rejected,
		Next:         next,
	}, nil
}

// Module is the geckoterminal adapter's registration.
type Module struct {
	client *client
	dw     dexstore.Writer
}

// NewModule builds the geckoterminal module with an optional injected Doer
// (tests). dw is the DEX write port for the dex-candles dataset; a nil dw fails
// that dataset loudly at Fetch time rather than silently writing nothing.
func NewModule(d canon.Doer, dw dexstore.Writer) *Module {
	return &Module{client: newClient(d, 0), dw: dw}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"pools":         &fetcher{dataset: "pools", client: m.client, dw: m.dw},
		"network-pools": &fetcher{dataset: "network-pools", client: m.client, dw: m.dw},
		"dex-candles":   &fetcher{dataset: "dex-candles", client: m.client, dw: m.dw},
	}
}

// tierA / tierB split the per-network discovery jobs by activity (plan §28):
// the highest-volume chains refresh every 15m, the newer/smaller EVM L1s and
// non-EVM networks every 60m. Together with the engine's per-provider limiter
// (0.5 rps configured) the tier-A batch alone stays inside GeckoTerminal's
// ~30 req/min free budget with headroom for the single-pool pools jobs.
var (
	tierA = []string{"eth", "bsc", "base", "arbitrum", "avax", "optimism", "polygon_pos", "solana"}
	tierB = []string{"hyperliquid", "berachain", "sonic", "plasma", "robinhood", "aptos", "sui-network"}
)

// Jobs is the seed registry: one pool poll per configured subject, 5m (the
// endpoint is a live snapshot). The subject spelling is network:pool_address
// — the seed pins the WETH/USDT 0.05% Uniswap v3 pool; more subjects ride
// the same dataset. The network-pools dataset seeds chain breadth instead:
// one bare-slug subject per supported network, tiered by activity.
func (m *Module) Jobs() []ingest.JobSpec {
	subjects := []string{
		"eth:0x11b815efb8f581194ae79006d24e0d814b7697f6",      // WETH/USDT 0.05% (Uniswap v3)
		"solana:58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", // SOL/USDT (Raydium)
	}
	specs := make([]ingest.JobSpec, 0, len(subjects)*2+len(tierA)+len(tierB))
	for _, s := range subjects {
		specs = append(specs, ingest.JobSpec{
			Provider: providerName, Dataset: "pools", Subject: s,
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 4, Enabled: true,
		})
		// The DEX candle series: the same pools, 5m bars, a 5m cadence so the
		// newest bar is refreshed. The DEX writer must be wired for this job to
		// run; with a nil writer the fetch fails loudly rather than silently.
		specs = append(specs, ingest.JobSpec{
			Provider: providerName, Dataset: "dex-candles", Subject: s,
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 5,
			Enabled: m.dw != nil,
		})
	}
	for _, net := range tierA {
		specs = append(specs, ingest.JobSpec{
			Provider: providerName, Dataset: "network-pools", Subject: net,
			Mode: "poll", Schedule: 15 * time.Minute, Priority: 3, Enabled: true,
		})
	}
	for _, net := range tierB {
		specs = append(specs, ingest.JobSpec{
			Provider: providerName, Dataset: "network-pools", Subject: net,
			Mode: "poll", Schedule: time.Hour, Priority: 4, Enabled: true,
		})
	}
	return specs
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
