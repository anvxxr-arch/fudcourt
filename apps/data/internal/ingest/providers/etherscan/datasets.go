package etherscan

import (
	"context"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"time"
)

// supplyEnv is the {"status":"1","result":"<wei string>"} ethsupply envelope.
type supplyEnv struct {
	Status string `json:"status"`
	Result string `json:"result"`
}

// supply fetches one chain's native-coin total supply:
// GET /v2/api?chainid={id}&module=stats&action=ethsupply
// -> {"status":"1","message":"OK","result":"120473186340000000000000000"} -
// wei as a decimal string. The result is written as ONE SupplySnapshot row on
// the chain's native coin: canon.WriteSupply(chain, address "", total_supply).
// The row's At is the fetch time: the endpoint reports a live balance, not a
// dated series (the ethsupplyexport history is not in the free plan for most
// chains, so the adapter makes no free-plan-dependent history claim).
func (c *client) supply(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	chainName := job.Subject
	id, ok := chainID(chainName)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "unsupported chain " + chainName +
			" (not in the adapter's chainid map)"}
	}
	url := c.supplyURL(id)
	var env supplyEnv
	if err := c.getJSON(ctx, url, &env); err != nil {
		return 0, 0, err
	}
	total, ok := weiToETH(env.Result)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", URL: redact(url), Detail: "ethsupply wei string " + preview(env.Result)}
	}
	chain := canon.MintID(canon.KindChain, canon.ChainKey(chainName))
	native := canon.MintID(canon.KindAsset, canon.AssetKey(canon.AssetNative, nativeSymbol(chainName)))
	now := time.Now().UTC()
	rows := []canon.SupplySnapshot{{
		ChainID:     chain,
		Address:     "",
		AssetID:     &native,
		TotalSupply: &total,
		At:          now,
		Source:      providerName,
	}}
	return w.WriteSupply(ctx, rows)
}

// gasEnv is the gasoracle envelope: result is an object of decimal strings.
type gasEnv struct {
	Result struct {
		SafeGasPrice    string `json:"SafeGasPrice"`
		ProposeGasPrice string `json:"ProposeGasPrice"`
		FastGasPrice    string `json:"FastGasPrice"`
	} `json:"result"`
}

// gas fetches one chain's gas oracle:
// GET /v2/api?chainid={id}&module=gastracker&action=gasoracle
// -> {"result":{"SafeGasPrice":"0.47","ProposeGasPrice":"0.47",
// "FastGasPrice":"0.48"}} - gwei decimal strings. The three recommendations
// become one MetricPoint per tier on series gas_price_gwei, subject
// chain:<chain_id>, domain blockchain; the tier is recorded in the point's
// meta. The metric row's At is the fetch time (the oracle is a live snapshot).
func (c *client) gas(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	chainName := job.Subject
	id, ok := chainID(chainName)
	if !ok {
		return 0, 0, &HardError{Kind: "shape", Detail: "unsupported chain " + chainName +
			" (not in the adapter's chainid map)"}
	}
	url := c.gasURL(id)
	var env gasEnv
	if err := c.getJSON(ctx, url, &env); err != nil {
		return 0, 0, err
	}
	chain := canon.MintID(canon.KindChain, canon.ChainKey(chainName))
	seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey(domainBlockchain, metricGasPrice, "chain:"+chain))
	now := time.Now().UTC()
	// tiers iterates in a fixed order so a partial oracle (a missing tier)
	// still writes the present ones without faking the absent ones.
	tiers := []struct {
		name  string
		price string
	}{
		{"safe", env.Result.SafeGasPrice},
		{"propose", env.Result.ProposeGasPrice},
		{"fast", env.Result.FastGasPrice},
	}
	var points []canon.MetricPoint
	for _, t := range tiers {
		if t.price == "" {
			continue
		}
		v, ok := f64(t.price)
		if !ok {
			return 0, 0, &HardError{Kind: "shape", URL: redact(url),
				Detail: "gasoracle " + t.name + " price " + preview(t.price)}
		}
		points = append(points, canon.MetricPoint{
			At:     now,
			Value:  &v,
			Meta:   map[string]any{"tier": t.name, "chain": chainName},
			Source: providerName,
		})
	}
	if len(points) == 0 {
		return 0, 0, &HardError{Kind: "shape", URL: redact(url), Detail: "gasoracle returned no price tiers"}
	}
	// The metric rows need their series rows to exist; the fetch upserts the
	// series meta it writes into.
	if _, err := w.UpsertSeries(ctx, []canon.SeriesMeta{gasSeriesMeta(chainName, chain, seriesID)}); err != nil {
		return 0, 0, err
	}
	written, err := w.WriteMetric(ctx, seriesID, points)
	return written, 0, err
}
