package mempool

import (
	"context"
	"fmt"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// blockRow is one row of GET /api/v1/mining/blocks/{rewards|fees}/{period}.
// These rows are ALREADY aggregated into variable-size buckets (avgHeight
// steps ~2 for 1w, ~5 for 1m, ~50 for 1y), and AvgRewards/AvgFees is the
// average per BLOCK in that bucket. The adapter reconstructs a daily total by
// weighting each row's per-block value by the number of blocks it spans.
type blockRow struct {
	AvgHeight  int64   `json:"avgHeight"`
	Timestamp  int64   `json:"timestamp"`
	AvgRewards float64 `json:"avgRewards"` // satoshi per block
	AvgFees    float64 `json:"avgFees"`    // satoshi per block
}

// rewards fetches per-block rewards and reconstructs a daily BTC issuance
// series.
func (c *client) rewards(ctx context.Context, w canon.Writer, period string) (int, int, error) {
	rows, err := c.blocks(ctx, "rewards", period)
	if err != nil {
		return 0, 0, err
	}
	return writeDailyBTC(ctx, w, "daily_issuance_btc", rows, func(r blockRow) float64 { return r.AvgRewards })
}

// fees fetches per-block fees and reconstructs a daily BTC fee series.
func (c *client) fees(ctx context.Context, w canon.Writer, period string) (int, int, error) {
	rows, err := c.blocks(ctx, "fees", period)
	if err != nil {
		return 0, 0, err
	}
	return writeDailyBTC(ctx, w, "daily_fees_btc", rows, func(r blockRow) float64 { return r.AvgFees })
}

// blocks fetches one blocks dataset.
func (c *client) blocks(ctx context.Context, kind, period string) ([]blockRow, error) {
	url := fmt.Sprintf("%s/api/v1/mining/blocks/%s/%s", Base, kind, period)
	var rows []blockRow
	if err := c.getJSON(ctx, url, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// writeDailyBTC reconstructs a daily BTC total from the bucket rows: each
// row's per-block value (satoshi) times the number of blocks it spans (the
// height delta to the next row), summed into the UTC day of the row's
// timestamp. A row with no forward neighbor reuses the previous span. The
// result is a real daily total, never a fabricated per-block figure.
func writeDailyBTC(ctx context.Context, w canon.Writer, metric string, rows []blockRow, pick func(blockRow) float64) (int, int, error) {
	meta := onchainSeriesMeta(metric, "BTC")
	if _, err := w.UpsertSeries(ctx, []canon.SeriesMeta{meta}); err != nil {
		return 0, 0, err
	}
	sums := map[int64]float64{}
	lastSpan := int64(1)
	for i, r := range rows {
		if r.Timestamp <= 0 || r.AvgHeight <= 0 {
			continue
		}
		span := lastSpan
		if i+1 < len(rows) {
			if d := rows[i+1].AvgHeight - r.AvgHeight; d > 0 {
				span = d
			}
		}
		lastSpan = span
		day := utcDay(r.Timestamp)
		sums[day] += pick(r) * float64(span)
	}
	now := time.Now().UTC()
	obs := make([]canon.Observation, 0, len(sums))
	for day, sats := range sums {
		v := sats / 1e8 // satoshi -> BTC
		at := time.Unix(day, 0).UTC()
		obs = append(obs, canon.Observation{
			SeriesID:    meta.SeriesID,
			Period:      at.Format("2006-01-02"),
			ObservedAt:  at,
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

// utcDay is the epoch second of the UTC midnight starting ts's day.
func utcDay(ts int64) int64 {
	t := time.Unix(ts, 0).UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC).Unix()
}
