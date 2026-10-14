package derived

import (
	"context"
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/derive"
)

// zeroTime is the unbounded-window sentinel the canon Reader uses.
var zeroTime = time.Time{}

// onchain series ids the mempool provider writes, read here for the mining
// charts.
var (
	hashrateSeriesID = canon.MintID(canon.KindSeries, canon.SeriesKey("onchain", "hashrate", "bitcoin"))
	issuanceSeriesID = canon.MintID(canon.KindSeries, canon.SeriesKey("onchain", "daily_issuance_btc", "bitcoin"))
	feesSeriesID     = canon.MintID(canon.KindSeries, canon.SeriesKey("onchain", "daily_fees_btc", "bitcoin"))
)

// miningSpecs are the hashrate moving averages (the Hash Ribbons pair: the
// chart renders sma_30, sma_60 and price; the capitulation cross is computed in
// the card, not here).
func miningSpecs() []derive.MetricSpec {
	s := func(metric string, params map[string]string) derive.MetricSpec {
		return derive.MetricSpec{Domain: "onchain", Metric: metric, SubjectKey: "bitcoin", Params: params}
	}
	return []derive.MetricSpec{
		s("sma", map[string]string{"period": "30"}),
		s("sma", map[string]string{"period": "60"}),
	}
}

// runMining derives the mining charts: the hashrate moving averages plus two
// directly-computed series (miner revenue in USD = daily issuance + fees, times
// the BTC close; and the Puell multiple = revenue / its 365-day mean). It is
// best-effort: an empty hashrate series returns (0, nil) so a sidecar without
// mempool data does not fail the whole derive pass.
func runMining(ctx context.Context, r canon.Reader, w canon.Writer, btc []canon.MetricPoint) (int, error) {
	hash, err := r.ReadTimeseries(ctx, hashrateSeriesID, zeroTime, zeroTime, 0)
	if err != nil {
		return 0, fmt.Errorf("derived: reading hashrate: %w", err)
	}
	if len(hash) == 0 {
		return 0, nil
	}
	hashPts := observationsToPointsLocal(hash)

	written := 0
	for _, spec := range miningSpecs() {
		reg, err := registryFor(spec)
		if err != nil {
			return written, err
		}
		p := derive.NewPipeline(r, w, reg, 0)
		if err := p.RunPoints(ctx, spec, hashrateSeriesID, hashPts); err != nil {
			return written, fmt.Errorf("derived: mining spec %s: %w", spec.Metric, err)
		}
		written++
	}

	issuance, err := r.ReadTimeseries(ctx, issuanceSeriesID, zeroTime, zeroTime, 0)
	if err != nil {
		return written, fmt.Errorf("derived: reading issuance: %w", err)
	}
	fees, err := r.ReadTimeseries(ctx, feesSeriesID, zeroTime, zeroTime, 0)
	if err != nil {
		return written, fmt.Errorf("derived: reading fees: %w", err)
	}
	rev := minerRevenueUSD(issuance, fees, btc)
	if len(rev) > 0 {
		if err := writeOnchainMetric(ctx, w, "miner_revenue_usd", rev); err != nil {
			return written, err
		}
		written++
	}
	if puell := puellMultiple(rev); len(puell) > 0 {
		if err := writeOnchainMetric(ctx, w, "puell_multiple", puell); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

// observationsToPointsLocal converts observation rows to metric points (the
// derive package's converter is unexported; this mirrors it).
func observationsToPointsLocal(obs []canon.Observation) []canon.MetricPoint {
	out := make([]canon.MetricPoint, len(obs))
	for i := range obs {
		out[i] = canon.MetricPoint{At: obs[i].ObservedAt, Value: obs[i].Value, Source: obs[i].Source}
	}
	return out
}

// dayKey is the epoch second of the UTC midnight starting t's day.
func dayKey(t time.Time) int64 {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC).Unix()
}

// minerRevenueUSD aligns (issuance + fees) with the BTC close on the UTC day
// and multiplies. A day missing the close is skipped (never faked).
func minerRevenueUSD(issuance, fees []canon.Observation, btc []canon.MetricPoint) []canon.MetricPoint {
	closeByDay := map[int64]float64{}
	for _, p := range btc {
		if p.Value != nil {
			closeByDay[dayKey(p.At)] = *p.Value
		}
	}
	issByDay := map[int64]float64{}
	for _, o := range issuance {
		if o.Value != nil {
			issByDay[dayKey(o.ObservedAt)] = *o.Value
		}
	}
	feeByDay := map[int64]float64{}
	for _, o := range fees {
		if o.Value != nil {
			feeByDay[dayKey(o.ObservedAt)] = *o.Value
		}
	}
	out := make([]canon.MetricPoint, 0, len(issByDay))
	for day, iss := range issByDay {
		close, ok := closeByDay[day]
		if !ok {
			continue
		}
		v := (iss + feeByDay[day]) * close
		out = append(out, canon.MetricPoint{At: time.Unix(day, 0).UTC(), Value: &v, Source: "derived"})
	}
	sortPoints(out)
	return out
}

// puellMultiple is revenue / SMA(revenue, 365).
func puellMultiple(rev []canon.MetricPoint) []canon.MetricPoint {
	if len(rev) == 0 {
		return nil
	}
	x := make([]float64, len(rev))
	for i := range rev {
		if rev[i].Value != nil {
			x[i] = *rev[i].Value
		} else {
			x[i] = math.NaN()
		}
	}
	mean := derive.SMA(x, 365)
	out := make([]canon.MetricPoint, len(rev))
	for i := range rev {
		out[i] = canon.MetricPoint{At: rev[i].At, Source: "derived"}
		if !math.IsNaN(mean[i]) && mean[i] > 0 && !math.IsNaN(x[i]) {
			v := x[i] / mean[i]
			out[i].Value = &v
		}
	}
	return out
}

// sortPoints orders points chronologically.
func sortPoints(pts []canon.MetricPoint) {
	slices.SortFunc(pts, func(a, b canon.MetricPoint) int { return a.At.Compare(b.At) })
}

// writeOnchainMetric upserts the series row and writes the points.
func writeOnchainMetric(ctx context.Context, w canon.Writer, metric string, pts []canon.MetricPoint) error {
	subject := "bitcoin"
	id := canon.MintID(canon.KindSeries, canon.SeriesKey("onchain", metric, subject))
	unit := ""
	meta := canon.SeriesMeta{
		SeriesID: id, Domain: "onchain", Metric: metric, SubjectKey: subject,
		Unit: &unit, Frequency: "daily", Source: "derived", Provider: "derived",
		ProviderSeriesID: metric + ":binance:spot:BTCUSDT:1d", Revision: "latest",
		IsDerived: true, SchemaVersion: "v1", NormalizationVersion: "none",
	}
	if _, err := w.UpsertSeries(ctx, []canon.SeriesMeta{meta}); err != nil {
		return err
	}
	if _, err := w.WriteMetric(ctx, id, pts); err != nil {
		return fmt.Errorf("derived: writing %s: %w", metric, err)
	}
	return nil
}
