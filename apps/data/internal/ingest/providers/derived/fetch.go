package derived

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/derive"
)

// btcVenueID and btcInstrumentID are the canonical ids of the spot BTC/USDT
// instrument the binance adapter mints (klines.go), which is where the daily
// bars live.
var (
	btcVenueID      = canon.MintID(canon.KindVenue, canon.VenueKey("binance"))
	btcInstrumentID = canon.MintID(canon.KindInstrument, canon.InstrumentKey(canon.InstrumentRef{
		VenueID: "binance", MarketType: "spot", Base: "BTC", Quote: "USDT",
	}))
)

// btcSourceID is the provenance label recorded on every derived series: the
// binance daily close the values came from.
const btcSourceID = "binance:spot:BTCUSDT:1d"

// btcDailyCloses reads the full daily BTC/USDT close history through the
// windowed reader: ReadOhlcv keeps the NEWEST `limit` bars per call (ORDER BY
// open_time DESC), so a single call would cap history at 1000 bars and starve
// a 200-week MA. The loop walks BACKWARD from now, appending each page's
// window, until a page is short (history exhausted) or a page returns exactly
// the limit with a boundary far in the past (loud failure, never a silent
// truncation).
func (f *fetcher) btcDailyCloses(ctx context.Context) ([]canon.MetricPoint, error) {
	const page = 1000
	var all []canon.Ohlcv
	end := time.Time{}
	for {
		bars, err := f.r.ReadOhlcv(ctx, btcInstrumentID, btcVenueID, "1d", time.Time{}, end, page)
		if err != nil {
			return nil, fmt.Errorf("derived: reading btc daily bars: %w", err)
		}
		if len(bars) == 0 {
			break
		}
		all = append(all, bars...)
		if len(bars) < page {
			break
		}
		// Advance the cursor to just before the oldest bar of this page.
		end = bars[0].OpenTime
	}
	if len(all) == 0 {
		return nil, nil
	}
	// Reader returns ASC within a page but pages arrive newest-first; sort by
	// time so the derived series is chronological.
	sortOhlcvByTime(all)
	pts := make([]canon.MetricPoint, 0, len(all))
	for i := range all {
		v := all[i].C
		pts = append(pts, canon.MetricPoint{At: all[i].OpenTime, Value: &v, Source: "binance"})
	}
	return pts, nil
}

// runSpecs runs every P0 spec through a pipeline built for that spec's own
// parameters, and returns the number of specs written. The pipeline needs a
// reader even though RunPoints takes the points directly: ensureSeries calls
// reader.ListSeries to avoid re-upserting an existing series row. It stops on
// the first spec error, returning what was written so far.
func runSpecs(ctx context.Context, r canon.Reader, w canon.Writer, btc []canon.MetricPoint) (int, error) {
	if len(btc) == 0 {
		return 0, nil
	}
	written := 0
	for _, spec := range specs() {
		reg, err := registryFor(spec)
		if err != nil {
			return written, err
		}
		p := derive.NewPipeline(r, w, reg, 0)
		if err := p.RunPoints(ctx, spec, btcSourceID, btc); err != nil {
			return written, fmt.Errorf("derived: spec %s/%s: %w", spec.Domain, spec.Metric, err)
		}
		written++
	}
	return written, nil
}

// sortOhlcvByTime orders the concatenated pages chronologically (each page is
// internally ascending, but pages arrive newest-first).
func sortOhlcvByTime(bars []canon.Ohlcv) {
	slices.SortFunc(bars, func(a, b canon.Ohlcv) int { return a.OpenTime.Compare(b.OpenTime) })
}
