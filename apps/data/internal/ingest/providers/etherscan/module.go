package etherscan

import (
	"context"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"time"
)

// providerName is the data.job provider column value.
const providerName = "etherscan"

// domainBlockchain and metricGasPrice are the series namespace the gas
// dataset writes into: series/blockchain/gas_price_gwei/chain:<chain_id>.
const (
	domainBlockchain = "blockchain"
	metricGasPrice   = "gas_price_gwei"
)

// nativeSymbols is each mapped chain's native coin symbol, the AssetKey
// input for the supply row's asset anchor.
var nativeSymbols = map[string]string{
	"ethereum": "ETH",
	"bsc":      "BNB",
	"polygon":  "POL",
	"arbitrum": "ETH",
	"optimism": "ETH",
	"base":     "ETH",
}

// nativeSymbol resolves a chain's native coin symbol; an unmapped chain has
// no supply job, so this only guards against map drift.
func nativeSymbol(chainName string) string {
	if s, ok := nativeSymbols[chainName]; ok {
		return s
	}
	return ""
}

// gasSeriesMeta builds the series row the gas dataset writes metric points
// into: domain blockchain, metric gas_price_gwei, subject chain:<chain_id>,
// provider etherscan. The provider series id pins the chain so each chain's
// oracle is its own series.
func gasSeriesMeta(chainName, chainID, seriesID string) canon.SeriesMeta {
	chain := chainID
	return canon.SeriesMeta{
		SeriesID:             seriesID,
		Domain:               domainBlockchain,
		Metric:               metricGasPrice,
		SubjectKey:           "chain:" + chain,
		Title:                strPtr(chainName + " gas price (gwei)"),
		Unit:                 strPtr("gwei"),
		Frequency:            "event",
		ChainID:              &chain,
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     "gasoracle:" + chainName,
		SchemaVersion:        "v1",
		NormalizationVersion: "v1",
	}
}

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

// Fetch runs ONE synchronous attempt (the engine owns retries).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	var written, rejected int
	var next = ingest.Cursor{}
	var err error
	switch f.dataset {
	case "supply":
		written, rejected, err = f.client.supply(ctx, w, job)
	case "gas":
		written, rejected, err = f.client.gas(ctx, w, job)
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

// Module is the etherscan adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the etherscan module. The API key is read from
// ETHERSCAN_API_KEY once, here; with no key every fetch fails with a
// no-credentials HardError before any request is made, and Jobs seeds the
// jobs disabled.
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

// HasCredentials reports whether an API key is configured; the seeder uses it
// to decide the seed jobs' enabled flag.
func (m *Module) HasCredentials() bool { return m.client.apiKey != "" }
func (m *Module) Provider() string     { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"supply": &fetcher{dataset: "supply", client: m.client},
		"gas":    &fetcher{dataset: "gas", client: m.client},
	}
}

// Jobs is the seed registry, pinned by the task: supply ethereum daily (the
// native supply moves slowly; one snapshot a day) and gas ethereum 5m. The
// jobs enable only when an API key is configured - a disabled seed keeps the
// identity tuple registered without failing on every tick. Other chains in
// the chainid map stay fetchable by subject (a job row with Subject "bsc"
// etc.) but are not seeded.
func (m *Module) Jobs() []ingest.JobSpec {
	enabled := m.HasCredentials()
	return []ingest.JobSpec{
		{
			Provider: providerName, Dataset: "supply", Subject: "ethereum",
			Mode: "poll", Schedule: 24 * time.Hour, Priority: 5, Enabled: enabled,
		},
		{
			Provider: providerName, Dataset: "gas", Subject: "ethereum",
			Mode: "poll", Schedule: 5 * time.Minute, Priority: 4, Enabled: enabled,
		},
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
