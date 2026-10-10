package dexscreener

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value.
const providerName = "dexscreener"

// assetKinds is the closed symbol -> AssetKind vocabulary for the pool sides
// this adapter anchors. The reference artifact keys BTC/ETH/... as native and
// USDT/USDC/... as stablecoin; minting those with kind "other" would fork the
// canonical asset identity, so the known symbols keep their reference kinds
// and everything else defaults to other.
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
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries). The first
// rows of every fetch opportunistically upsert the entities they imply: the
// chains, the DEX venues and the pool-side assets.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var err error
	switch f.dataset {
	case "pools":
		written, rejected, err = f.client.pools(ctx, w, job)
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

// Module is the dexscreener adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the dexscreener module with an optional injected Doer
// (tests).
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"pools": &fetcher{dataset: "pools", client: m.client},
	}
}

// Jobs is the seed registry: one pool poll per configured subject, 5m (the
// endpoint is a live snapshot and 5m is the freshest the API serves). The
// subject spelling is chain:address — the seed pins the USDT pair universe
// on ethereum and solana; more subjects ride the same dataset.
func (m *Module) Jobs() []ingest.JobSpec {
	subjects := []string{
		"ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
		"ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
		"solana:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
	}
	specs := make([]ingest.JobSpec, 0, len(subjects))
	for _, s := range subjects {
		specs = append(specs, ingest.JobSpec{
			Provider: providerName, Dataset: "pools", Subject: s,
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 4, Enabled: true,
		})
	}
	return specs
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
