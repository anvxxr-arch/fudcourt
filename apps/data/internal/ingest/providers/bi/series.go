package bi

import (
	"context"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// endpointConfig is one statistic's fetch config: the URL path after
// /v1/public, whether the gateway demands X-API-KEY for it, and the series'
// canonical frequency.
type endpointConfig struct {
	Path        string
	RequiresKey bool
	Frequency   string
	Unit        *string
}

// endpoints is the dataset registry, keyed by the job subject (the statistic
// slug). The two seed endpoints are daily SEKI series; requires-key reflects
// the gateway's documented demand for X-API-KEY on the public host.
var endpoints = map[string]endpointConfig{
	"bi-rate": {
		Path:        "/seki/bi_rate",
		RequiresKey: true,
		Frequency:   "daily",
		Unit:        strPtr("percent"),
	},
	"kurs:USD": {
		Path:        "/seki/kurs_tengah/USD",
		RequiresKey: true,
		Frequency:   "daily",
		Unit:        strPtr("IDR per USD"),
	},
}

// series fetches one statistic and writes the canonical series +
// observations. The subject selects the endpoint config ("bi-rate",
// "kurs:USD"). The cursor pins the last observed date (YYYY-MM-DD) so the
// next run skips stored dates.
func (c *client) series(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	subject := strings.TrimSpace(job.Subject)
	cfg, ok := endpoints[subject]
	if !ok {
		return 0, 0, nil, &HardError{Kind: "shape",
			Detail: "bi/series job needs a configured statistic subject (bi-rate, kurs:USD), got " + subject}
	}

	url := Base + cfg.Path
	var res seriesResponse
	if err := c.getJSON(ctx, url, cfg.RequiresKey, &res); err != nil {
		return 0, 0, nil, err
	}
	if res.Status != "success" {
		return 0, 0, nil, &HardError{Kind: "api-error", URL: url, Detail: "status " + res.Status}
	}

	sm := seriesMeta(subject, cfg)
	if _, err := w.UpsertSeries(ctx, []canon.SeriesMeta{sm}); err != nil {
		return 0, 0, nil, err
	}

	lastDate := ""
	if s, ok := job.Cursor["last_date"].(string); ok {
		lastDate = s
	}
	now := time.Now().UTC()
	var obs []canon.Observation
	written, rejected := 0, 0
	for _, row := range res.Data {
		if row.Date == "" || row.Date <= lastDate {
			continue // empty or at/before the cursor: already stored
		}
		v, ok := parseF64(row.Value)
		if !ok {
			continue // absent value: skip, never 0
		}
		at, err := time.Parse("2006-01-02", row.Date)
		if err != nil {
			return written, rejected, nil, &HardError{Kind: "shape", URL: url,
				Detail: "bad date " + row.Date}
		}
		lastDate = row.Date
		obs = append(obs, canon.Observation{
			SeriesID:    sm.SeriesID,
			Period:      row.Date,
			ObservedAt:  at.UTC(),
			Value:       &v,
			Revision:    "latest",
			Source:      providerName,
			RetrievedAt: now,
		})
	}
	if len(obs) > 0 {
		var err error
		written, rejected, err = w.WriteObservations(ctx, obs)
		if err != nil {
			return written, rejected, nil, err
		}
	}
	return written, rejected, ingest.Cursor{"last_date": lastDate}, nil
}

// seriesRow is one data row: {"sifat":"FB","date":"2024-01-31","value":"6.00"}.
type seriesRow struct {
	Sifat string `json:"sifat"`
	Date  string `json:"date"`
	Value string `json:"value"`
}

// seriesResponse is the top-level envelope: {"status":"success","data":[...]}.
type seriesResponse struct {
	Status string      `json:"status"`
	Data   []seriesRow `json:"data"`
}

// seriesMeta maps one statistic to the canonical series row: metric = the
// statistic slug lowercased with ":" and "-" -> "_" (the SEKI endpoint's
// own naming, e.g. bi_rate), subject country:id, provider_series_id = the
// subject.
func seriesMeta(subject string, cfg endpointConfig) canon.SeriesMeta {
	metric := strings.ToLower(strings.NewReplacer(":", "_", "-", "_").Replace(subject))
	return canon.SeriesMeta{
		SeriesID:             canon.MintID(canon.KindSeries, canon.SeriesKey("economy", metric, "country:id")),
		Domain:               "economy",
		Metric:               metric,
		SubjectKey:           "country:id",
		Title:                strPtr(subject),
		Unit:                 cfg.Unit,
		Frequency:            cfg.Frequency,
		CountryID:            countryID("ID"),
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     subject,
		Revision:             "latest",
		SchemaVersion:        "v1",
		NormalizationVersion: "v1",
	}
}

// countryID mints the canonical country id for an ISO2 code.
func countryID(iso2 string) *string {
	id := canon.MintID(canon.KindCountry, canon.CountryKey(iso2))
	return &id
}

// strPtr is a non-empty string as a pointer; "" stays nil (never-fake).
func strPtr(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}
