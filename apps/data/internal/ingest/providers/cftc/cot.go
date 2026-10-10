package cftc

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// cotFields is the SoQL $select projection: only the fields this adapter
// reads. The COT report carries 400+ columns per row; unprojected, a single
// page of the Legacy Futures Only report is hundreds of MiB and any body cap
// truncates mid-array (a 200 whose JSON just ends — the live "unexpected end
// of JSON input" this adapter once shipped). Projecting server-side keeps
// one page a few MiB, comfortably inside maxBodyBytes.
var cotFields = []string{
	"market_and_exchange_names",
	"report_date_as_yyyy_mm_dd",
	"cftc_contract_market_code",
	"open_interest_all",
	"noncomm_positions_long_all",
	"noncomm_positions_short_all",
	"comm_positions_long_all",
	"comm_positions_short_all",
}

// cot fetches one page of the Legacy Futures Only report:
//
//	GET {Base}/resource/{datasetID}.json?$select={fields}&$limit={pageSize}&$offset={offset}
//
// The job cursor carries "offset" (the next page's SoQL $offset) and "year"
// (a report-year filter spelled as a report_date $where clause; a set year
// keeps repeated poll runs re-reading the same window instead of walking the
// full history every time). Each resolved row upserts its asset, the five
// series (one per metric) and one observation per metric per report week.
// Contract names outside the tracked list are counted as rejected rows, not
// errors — the report covers hundreds of markets and one unknown name must
// not drop the rest.
func (c *client) cot(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	offset := 0
	if n, ok := job.Cursor["offset"].(float64); ok && n > 0 {
		offset = int(n)
	}
	year := 0
	if n, ok := job.Cursor["year"].(float64); ok && n > 0 {
		year = int(n)
	}
	url := fmt.Sprintf("%s/resource/%s.json?$select=%s&$limit=%d&$offset=%d",
		Base, datasetID, strings.Join(cotFields, ","), pageSize, offset)
	if year > 0 {
		url += fmt.Sprintf("&$where=report_date between '%d-01-01T00:00:00' and '%d-12-31T23:59:59'", year, year)
	}
	var raw []reportRow
	if err := c.getJSON(ctx, url, &raw); err != nil {
		return 0, 0, nil, err
	}
	now := time.Now().UTC()
	var assets []canon.Asset
	var series []canon.SeriesMeta
	var obs []canon.Observation
	rejected := 0
	seenAsset := map[string]bool{}
	seenSeries := map[string]bool{}
	for _, r := range raw {
		symbol, ok := resolveAsset(r.MarketAndExchangeNames)
		if !ok {
			rejected++
			continue
		}
		at, ok := parseDate(r.ReportDate)
		if !ok {
			rejected++
			continue
		}
		code := strings.TrimSpace(r.ContractMarketCode)
		aid := assetID(symbol)
		if !seenAsset[aid] {
			assets = append(assets, canon.Asset{
				AssetID: aid,
				Symbol:  symbol,
				Name:    strPtr(r.MarketAndExchangeNames),
				Kind:    assetKinds[symbol],
			})
			seenAsset[aid] = true
		}
		subject := "asset:" + aid
		for _, m := range metrics {
			value, present := parseI64(m.field(r))
			providerSeriesID := code + ":" + m.metric
			seriesID := canon.MintID(canon.KindSeries,
				canon.SeriesKey("positioning", m.metric, subject))
			if !seenSeries[providerSeriesID] {
				series = append(series, canon.SeriesMeta{
					SeriesID:             seriesID,
					Domain:               "positioning",
					Metric:               m.metric,
					SubjectKey:           subject,
					Title:                strPtr(cotTitle(m.metric, symbol)),
					Unit:                 strPtr("contracts"),
					Frequency:            "weekly",
					AssetID:              &aid,
					Source:               Source,
					Provider:             Source,
					ProviderSeriesID:     providerSeriesID,
					Revision:             "latest",
					SchemaVersion:        schemaVersion,
					NormalizationVersion: schemaVersion,
				})
				seenSeries[providerSeriesID] = true
			}
			if !present {
				// A blank field is a real gap in the source: the series row
				// still upserts (the provider publishes the series), but no
				// observation is written for the missing week — never a
				// fake zero.
				continue
			}
			obs = append(obs, canon.Observation{
				SeriesID:    seriesID,
				Period:      period(at),
				ObservedAt:  at,
				Value:       value,
				Revision:    "latest",
				Source:      Source,
				RetrievedAt: now,
			})
		}
	}
	if len(assets) > 0 {
		if _, err := w.UpsertAssets(ctx, assets); err != nil {
			return 0, 0, nil, err
		}
	}
	if len(series) > 0 {
		if _, err := w.UpsertSeries(ctx, series); err != nil {
			return 0, 0, nil, err
		}
	}
	written, rej, err := w.WriteObservations(ctx, obs)
	next := ingest.Cursor{"offset": float64(offset + len(raw))}
	if year > 0 {
		next["year"] = float64(year)
	}
	if err != nil {
		return written, rej + rejected, next, err
	}
	return written, rej + rejected, next, nil
}

// cotTitle renders a series title: "CFTC noncomm long - GOLD" (the metric
// name minus its cot_ prefix, which is storage vocabulary, not prose).
func cotTitle(metric, symbol string) string {
	return "CFTC " + strings.TrimPrefix(metric, "cot_") + " - " + symbol
}

// strPtr is a non-empty string as a pointer; "" stays nil (never-fake).
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
