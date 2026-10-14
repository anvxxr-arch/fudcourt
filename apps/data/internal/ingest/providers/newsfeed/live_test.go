//go:build live

// Live smoke tests: real network fetches against the working sources. These
// are separated from the CI suite by the `live` build tag because they touch
// third-party endpoints and must respect each publisher's rate policy (one
// request per source, sequential, polite UA, no retries).
//
//	go test -tags live ./apps/data/internal/ingest/providers/newsfeed/ -run TestLive -v
//
// A source that fails here is reported, never silently passed: the point of
// the smoke is to confirm the audited evidence still holds.
package newsfeed

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// countingWriter records what a live fetch produced without a database.
type countingWriter struct {
	rows []canon.Article
}

func (c *countingWriter) WriteArticles(_ context.Context, rows []canon.Article) (int, int, error) {
	c.rows = append(c.rows, rows...)
	var bad int
	for _, a := range rows {
		if a.ArticleID == "" || a.Headline == "" || a.URL == "" || a.Source == "" || a.RetrievedAt.IsZero() {
			bad++
		}
	}
	return len(rows) - bad, bad, nil
}

func (c *countingWriter) UpsertAssets(context.Context, []canon.Asset) (int, error) { return 0, nil }
func (c *countingWriter) UpsertChains(context.Context, []canon.Chain) (int, error) { return 0, nil }
func (c *countingWriter) UpsertVenues(context.Context, []canon.Venue) (int, error) { return 0, nil }
func (c *countingWriter) UpsertInstruments(context.Context, []canon.Instrument) (int, error) {
	return 0, nil
}
func (c *countingWriter) UpsertProtocols(context.Context, []canon.Protocol) (int, error) {
	return 0, nil
}
func (c *countingWriter) UpsertSeries(context.Context, []canon.SeriesMeta) (int, error) {
	return 0, nil
}
func (c *countingWriter) UpsertProviderSymbols(context.Context, []canon.ProviderSymbol) (int, error) {
	return 0, nil
}
func (c *countingWriter) WriteOhlcv(context.Context, []canon.Ohlcv) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteTrades(context.Context, []canon.Trade) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteQuotes(context.Context, []canon.Quote) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteOrderbook(context.Context, []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteLiquidations(context.Context, []canon.Liquidation) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteOptionQuotes(context.Context, []canon.OptionQuote) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteObservations(context.Context, []canon.Observation) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteFunding(context.Context, []canon.FundingRate) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteOpenInterest(context.Context, []canon.OpenInterest) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WritePools(context.Context, []canon.Pool) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WritePredictionMarkets(context.Context, []canon.PredictionMarket) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteChainTVL(context.Context, []canon.ChainTVL) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteProtocolTVL(context.Context, []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteSupply(context.Context, []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, nil
}
func (c *countingWriter) WriteMetric(context.Context, string, []canon.MetricPoint) (int, error) {
	return 0, nil
}

var _ canon.Writer = (*countingWriter)(nil)

// TestLiveSources fetches every working source once and reports the outcome.
func TestLiveSources(t *testing.T) {
	m := NewModule(nil)
	fetchers := m.Fetchers()
	for _, s := range EnabledSources() {
		f, ok := fetchers[s.ID]
		if !ok {
			t.Errorf("%s: no fetcher", s.ID)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		w := &countingWriter{}
		res, err := f.Fetch(ctx, ingest.Job{Dataset: s.ID}, w)
		cancel()
		if err != nil {
			t.Errorf("%s: BLOCKED %v", s.ID, err)
		} else {
			t.Logf("%s: OK rows_in=%d written=%d rejected=%d", s.ID, res.RowsIn, res.RowsWritten, res.RowsRejected)
		}
		time.Sleep(2 * time.Second) // polite gap between publishers
	}
}
