package mempool

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// providerName is the data.job provider column value.
const providerName = "mempool"

// hashrateResponse is GET /api/v1/mining/hashrate/{period}: daily hashrate
// points plus the difficulty retarget points.
type hashrateResponse struct {
	Hashrates []struct {
		Timestamp   int64   `json:"timestamp"`
		AvgHashrate float64 `json:"avgHashrate"`
	} `json:"hashrates"`
	Difficulty []struct {
		Time       int64   `json:"time"`
		Height     int64   `json:"height"`
		Difficulty float64 `json:"difficulty"`
	} `json:"difficulty"`
}

// hashrate fetches the daily hashrate series and the difficulty retarget
// series from one endpoint and writes both. Both are genuinely time-bucketed
// (hashrate rows are exactly 86400s apart; difficulty rows step one retarget
// each), so neither needs re-bucketing.
func (c *client) hashrate(ctx context.Context, w canon.Writer, period string) (int, int, error) {
	url := fmt.Sprintf("%s/api/v1/mining/hashrate/%s", Base, period)
	var res hashrateResponse
	if err := c.getJSON(ctx, url, &res); err != nil {
		return 0, 0, err
	}
	now := time.Now().UTC()
	hashMeta := onchainSeriesMeta("hashrate", "EH/s")
	diffMeta := onchainSeriesMeta("difficulty", "difficulty")
	if _, err := w.UpsertSeries(ctx, []canon.SeriesMeta{hashMeta, diffMeta}); err != nil {
		return 0, 0, err
	}
	obs := make([]canon.Observation, 0, len(res.Hashrates)+len(res.Difficulty))
	for _, h := range res.Hashrates {
		if h.Timestamp <= 0 {
			continue
		}
		v := h.AvgHashrate / 1e18 // H/s -> EH/s
		obs = append(obs, canon.Observation{
			SeriesID:    hashMeta.SeriesID,
			Period:      time.Unix(h.Timestamp, 0).UTC().Format("2006-01-02"),
			ObservedAt:  time.Unix(h.Timestamp, 0).UTC(),
			Value:       &v,
			Revision:    "latest",
			Source:      providerName,
			RetrievedAt: now,
		})
	}
	for _, d := range res.Difficulty {
		if d.Time <= 0 {
			continue
		}
		v := d.Difficulty
		obs = append(obs, canon.Observation{
			SeriesID:    diffMeta.SeriesID,
			Period:      time.Unix(d.Time, 0).UTC().Format("2006-01-02"),
			ObservedAt:  time.Unix(d.Time, 0).UTC(),
			Value:       &v,
			Revision:    "latest",
			Source:      providerName,
			RetrievedAt: now,
		})
	}
	if len(obs) == 0 {
		return 0, 0, nil
	}
	written, rejected, err := w.WriteObservations(ctx, obs)
	return written, rejected, err
}

// onchainSeriesMeta mints the canonical series row for an onchain Bitcoin
// metric: domain "onchain", subject "bitcoin", source/provider mempool.
func onchainSeriesMeta(metric, unit string) canon.SeriesMeta {
	subject := "bitcoin"
	return canon.SeriesMeta{
		SeriesID:             canon.MintID(canon.KindSeries, canon.SeriesKey("onchain", metric, subject)),
		Domain:               "onchain",
		Metric:               metric,
		SubjectKey:           subject,
		Unit:                 &unit,
		Frequency:            "daily",
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     metric,
		Revision:             "latest",
		SchemaVersion:        "v1",
		NormalizationVersion: "v1",
	}
}
