package coinmetrics

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// providerName is the data.job provider column value.
const providerName = "coinmetrics"

// communityMetrics are the CoinMetrics metrics the community tier serves
// without a key (catalog "community": true). Realized-cap metrics are NOT here
// on purpose: CapRealUSD/NUPL answer HTTP 403 keylessly, so the valuation
// family is a later phase.
var communityMetrics = []string{"PriceUSD", "CapMrktEstUSD"}

// metricSeries pairs a CoinMetrics metric with its canonical series shape.
var metricSeries = map[string]struct {
	metric string // onchain metric name
	unit   string
}{
	"PriceUSD":      {"price_usd", "USD"},
	"CapMrktEstUSD": {"market_cap_usd", "USD"},
}

// assetMetricsResponse is one page of GET /v4/timeseries/asset-metrics. Each
// data row carries the requested metric names as decimal STRINGS.
type assetMetricsResponse struct {
	Data []map[string]any `json:"data"`
	Next string           `json:"next_page_url"`
}

// metrics fetches the community metric pages and writes one observation series
// per metric. It follows next_page_url to the end.
func (c *client) metrics(ctx context.Context, w canon.Writer, asset string) (int, int, error) {
	if asset == "" {
		asset = "btc"
	}
	url := fmt.Sprintf("%s/timeseries/asset-metrics?assets=%s&metrics=%s&frequency=1d&page_size=10000",
		Base, asset, strings.Join(communityMetrics, ","))

	metas := make([]canon.SeriesMeta, 0, len(communityMetrics))
	byMetric := map[string]canon.SeriesMeta{}
	for _, m := range communityMetrics {
		sm := seriesMeta(m, asset)
		metas = append(metas, sm)
		byMetric[m] = sm
	}
	if _, err := w.UpsertSeries(ctx, metas); err != nil {
		return 0, 0, err
	}

	now := time.Now().UTC()
	var obs []canon.Observation
	rejected := 0
	for url != "" {
		var page assetMetricsResponse
		if err := c.getJSON(ctx, url, &page); err != nil {
			return 0, 0, err
		}
		for _, row := range page.Data {
			at, ok := parseTime(row["time"])
			if !ok {
				rejected++
				continue
			}
			for m, sm := range byMetric {
				raw, ok := row[m].(string)
				if !ok {
					continue
				}
				v, err := strconv.ParseFloat(raw, 64)
				if err != nil {
					rejected++ // never zero a bad value
					continue
				}
				obs = append(obs, canon.Observation{
					SeriesID:    sm.SeriesID,
					Period:      at.Format("2006-01-02"),
					ObservedAt:  at,
					Value:       &v,
					Revision:    "latest",
					Source:      providerName,
					RetrievedAt: now,
				})
			}
		}
		url = page.Next
	}
	if len(obs) == 0 {
		return 0, rejected, nil
	}
	written, rej, err := w.WriteObservations(ctx, obs)
	return written, rejected + rej, err
}

// seriesMeta mints the canonical series row for one CoinMetrics metric.
func seriesMeta(cmMetric, asset string) canon.SeriesMeta {
	ms := metricSeries[cmMetric]
	subject := "bitcoin"
	unit := ms.unit
	return canon.SeriesMeta{
		SeriesID:             canon.MintID(canon.KindSeries, canon.SeriesKey("onchain", ms.metric, subject)),
		Domain:               "onchain",
		Metric:               ms.metric,
		SubjectKey:           subject,
		Unit:                 &unit,
		Frequency:            "daily",
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     cmMetric,
		Revision:             "latest",
		SchemaVersion:        "v1",
		NormalizationVersion: "v1",
	}
}

// parseTime parses CoinMetrics' RFC3339 nanosecond timestamp.
func parseTime(v any) (time.Time, bool) {
	s, ok := v.(string)
	if !ok {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}
