package blockscout

import (
	"context"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"time"
)

// providerName is the data.job provider column value.
const providerName = "blockscout"

// domainBlockchain is the series namespace the stats dataset writes into:
// series/blockchain/<metric>/chain:<chain_id>.
const domainBlockchain = "blockchain"

// instance is one configured Blockscout instance: its API base and the
// canonical chain name the instance serves. The list is the adapter's
// configuration; adding a chain is adding a row here.
type instance struct {
	base  string // API base, no trailing slash
	chain string // canonical lowercase chain name (ChainKey input)
}

// instances is the configured instance list: eth.blockscout.com serves
// ethereum, polygon.blockscout.com serves polygon.
var instances = []instance{
	{base: "https://eth.blockscout.com", chain: "ethereum"},
	{base: "https://polygon.blockscout.com", chain: "polygon"},
}

// instanceByChain resolves a canonical chain name to its configured instance.
func instanceByChain(chain string) (instance, bool) {
	for _, in := range instances {
		if in.chain == chain {
			return in, true
		}
	}
	return instance{}, false
}

// metricsRow is the /api/v2/stats response (trimmed to the fields the adapter
// reads). Real shape: counters are decimal STRINGS, average_block_time is a
// NUMBER in milliseconds, gas_prices is an object of numbers in gwei.
type metricsRow struct {
	TotalBlocks       string  `json:"total_blocks"`
	TotalAddresses    string  `json:"total_addresses"`
	TotalTransactions string  `json:"total_transactions"`
	AvgBlockTimeMs    float64 `json:"average_block_time"`
	GasPrices         struct {
		Slow    *float64 `json:"slow"`
		Average *float64 `json:"average"`
		Fast    *float64 `json:"fast"`
	} `json:"gas_prices"`
	GasUsedToday      string `json:"gas_used_today"`
	TransactionsToday string `json:"transactions_today"`
}

// stat is one extracted metric: the series metric name, the value, and the
// unit the series row declares.
type stat struct {
	metric string
	value  float64
	unit   string
	title  string
}

// extract maps a stats row to the canonical metric set. Absent fields are
// skipped (never-fake: the row is real, the absent value is NULL/absent, not
// 0) - a stats response missing gas_prices still yields the counters.
func extract(r metricsRow) []stat {
	var out []stat
	if v, ok := f64(r.TotalAddresses); ok {
		out = append(out, stat{"total_addresses", v, "addresses", "Total addresses"})
	}
	if v, ok := f64(r.TotalTransactions); ok {
		out = append(out, stat{"total_transactions", v, "transactions", "Total transactions"})
	}
	if r.AvgBlockTimeMs > 0 {
		// The wire carries milliseconds; the metric is seconds.
		out = append(out, stat{"avg_block_time_sec", r.AvgBlockTimeMs / 1000, "seconds", "Average block time"})
	}
	if r.GasPrices.Average != nil {
		out = append(out, stat{"gas_price_gwei", *r.GasPrices.Average, "gwei", "Average gas price"})
	}
	return out
}

// stats fetches one instance's chain stats:
// GET {base}/api/v2/stats. Each extracted metric becomes one MetricPoint on
// its series/blockchain/<metric>/chain:<chain_id> series; the series rows are
// upserted before the points (WriteMetric requires the series row).
func (c *client) stats(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	chain := job.Subject
	in, ok := instanceByChain(chain)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "no blockscout instance configured for chain " + chain}
	}
	url := in.base + "/api/v2/stats"
	var row metricsRow
	if err := c.getJSON(ctx, url, &row); err != nil {
		return 0, 0, err
	}
	stats := extract(row)
	if len(stats) == 0 {
		return 0, 0, &HardError{Kind: "shape", URL: url, Detail: "stats row yielded no metrics"}
	}
	chainID := canon.MintID(canon.KindChain, canon.ChainKey(chain))
	now := time.Now().UTC()
	series := make([]canon.SeriesMeta, 0, len(stats))
	bySeries := map[string][]canon.MetricPoint{}
	for _, s := range stats {
		seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey(domainBlockchain, s.metric, "chain:"+chainID))
		series = append(series, seriesMeta(chain, chainID, s, seriesID))
		bySeries[seriesID] = append(bySeries[seriesID], canon.MetricPoint{
			At:     now,
			Value:  &s.value,
			Source: providerName,
		})
	}
	if _, err := w.UpsertSeries(ctx, series); err != nil {
		return 0, 0, err
	}
	written := 0
	for seriesID, points := range bySeries {
		n, err := w.WriteMetric(ctx, seriesID, points)
		written += n
		if err != nil {
			return written, 0, err
		}
	}
	return written, 0, nil
}

// seriesMeta builds one series row for one (chain, metric).
func seriesMeta(chain, chainID string, s stat, seriesID string) canon.SeriesMeta {
	c := chainID
	return canon.SeriesMeta{
		SeriesID:             seriesID,
		Domain:               domainBlockchain,
		Metric:               s.metric,
		SubjectKey:           "chain:" + chainID,
		Title:                strPtr(chain + " " + s.title),
		Unit:                 strPtr(s.unit),
		Frequency:            "event",
		ChainID:              &c,
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     "stats:" + chain + ":" + s.metric,
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
	switch f.dataset {
	case "stats":
		written, rejected, err := f.client.stats(ctx, w, job)
		if err != nil {
			return ingest.FetchResult{}, err
		}
		return ingest.FetchResult{
			RowsIn:       written + rejected,
			RowsWritten:  written,
			RowsRejected: rejected,
			Next:         ingest.Cursor{},
		}, nil
	default:
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown dataset " + f.dataset}
	}
}

// Module is the blockscout adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the blockscout module with an optional injected Doer
// (tests). Keyless: no credentials, no env.
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}
func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"stats": &fetcher{dataset: "stats", client: m.client},
	}
}

// Jobs is the seed registry: one stats job per configured instance, poll 5m,
// enabled (keyless - the job can always run).
func (m *Module) Jobs() []ingest.JobSpec {
	specs := make([]ingest.JobSpec, 0, len(instances))
	for _, in := range instances {
		specs = append(specs, ingest.JobSpec{
			Provider: providerName, Dataset: "stats", Subject: in.chain,
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
