package coinmetrics

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// TestLiveSmoke hits the real CoinMetrics community endpoint through the adapter.
func TestLiveSmoke(t *testing.T) {
	if testing.Short() {
		t.Skip("live")
	}
	c := newClient(nil, 0)
	w := &captureWriter{}
	res, err := (&fetcher{dataset: "asset-metrics", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "coinmetrics", Dataset: "asset-metrics", Subject: "btc", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("live: %v", err)
	}
	t.Logf("written=%d rejected=%d series=%d obs=%d", res.RowsWritten, res.RowsRejected, len(w.series), len(w.observations))
	if res.RowsWritten == 0 {
		t.Fatal("no rows")
	}
	var minT, maxT time.Time
	for _, o := range w.observations {
		if minT.IsZero() || o.ObservedAt.Before(minT) {
			minT = o.ObservedAt
		}
		if o.ObservedAt.After(maxT) {
			maxT = o.ObservedAt
		}
	}
	t.Logf("range %s .. %s", minT.Format("2006-01-02"), maxT.Format("2006-01-02"))
	// BTC price sanity: the max over history must be 4-figure..7-figure USD.
	pid := seriesMeta("PriceUSD", "btc").SeriesID
	var maxP float64
	for _, o := range w.observations {
		if o.SeriesID == pid && o.Value != nil && *o.Value > maxP {
			maxP = *o.Value
		}
	}
	t.Logf("max BTC price = %.2f", maxP)
	if maxP < 1000 || maxP > 10_000_000 {
		t.Fatalf("implausible max BTC price %v", maxP)
	}
}
