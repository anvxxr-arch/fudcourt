package worldbank

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// indicatorRow is one /country/.../indicator row (trimmed to the fields the
// adapter reads). Value stays json.RawMessage so a JSON null is
// distinguishable from 0 (never-fake).
type indicatorRow struct {
	Indicator struct {
		ID    string `json:"id"`
		Value string `json:"value"`
	} `json:"indicator"`
	Country struct {
		ID    string `json:"id"`
		Value string `json:"value"`
	} `json:"country"`
	CountryISO3 string          `json:"countryiso3code"`
	Date        string          `json:"date"`
	Value       json.RawMessage `json:"value"`
}

// indicators fetches every page of one indicator for the job's countries and
// writes the canonical series + observations. The subject is
// "indicator:<ID>" (e.g. "indicator:NY.GDP.MKTP.CD"); the seed set (currently
// ID, US) drives the requests, but series identity comes from each row's
// country.id (ISO2) — one series per (indicator, country) pair the rows
// contain, minted once, and one observation per (series, period) even when a
// re-served page repeats a row. The cursor pins the seed country's own last
// observed year so the next run only requests rows at or after it.
func (c *client) indicators(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	indicator, err := subjectIndicator(job.Subject)
	if err != nil {
		return 0, 0, nil, err
	}
	now := time.Now().UTC()
	lastYears := lastYearMap(job.Cursor)

	var metas []canon.SeriesMeta
	var obs []canon.Observation
	seriesByISO := map[string]canon.SeriesMeta{}
	seenObs := map[string]bool{}
	written, rejected := 0, 0
	for _, iso2 := range seedCountries {
		startYear := lastYears[iso2]
		rows, err := c.fetchIndicator(ctx, indicator, iso2, startYear)
		if err != nil {
			return written, rejected, nil, err
		}
		if len(rows) == 0 {
			continue
		}
		maxYear := startYear
		for _, r := range rows {
			// The subject identity comes from country.id (ISO2); a row whose
			// country.id is not a 2-char code is an aggregate/region: skip.
			iso, ok := iso2Of(r.Country.ID)
			if !ok {
				continue
			}
			year, ok := parseYear(r.Date)
			if !ok {
				continue
			}
			if iso == iso2 && year > maxYear {
				maxYear = year
			}
			v, ok := parseF64(r.Value)
			if !ok {
				continue // null/absent value: skip, never 0
			}
			sm, ok := seriesByISO[iso]
			if !ok {
				sm = seriesMeta(indicator, r.Indicator.Value, iso)
				seriesByISO[iso] = sm
				metas = append(metas, sm)
			}
			key := sm.SeriesID + "\x00" + r.Date
			if seenObs[key] {
				continue // re-served duplicate: one observation per (series, period)
			}
			seenObs[key] = true
			obs = append(obs, canon.Observation{
				SeriesID:    sm.SeriesID,
				Period:      r.Date,
				ObservedAt:  time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC),
				Value:       &v,
				Revision:    "latest",
				Source:      providerName,
				RetrievedAt: now,
			})
		}
		lastYears[iso2] = maxYear
	}
	if len(metas) > 0 {
		if _, err := w.UpsertSeries(ctx, metas); err != nil {
			return 0, 0, nil, err
		}
	}
	if len(obs) > 0 {
		written, rejected, err = w.WriteObservations(ctx, obs)
		if err != nil {
			return written, rejected, nil, err
		}
	}
	return written, rejected, ingest.Cursor{"last_year": anyMap(lastYears)}, nil
}

// fetchIndicator walks GET /country/{iso2}/indicator/{id}?format=json&per_page=20000&page=N
// until meta.pages is exhausted. When startYear > 0 the URL pins a bounded
// date range date=<startYear>:<startYear+20> (the API rejects an open-ended
// "YYYY:" range; 20 annual rows per page is far beyond any real annual lag),
// so the incremental resume re-reads only the tail years.
func (c *client) fetchIndicator(ctx context.Context, indicator, iso2 string, startYear int) ([]indicatorRow, error) {
	const perPage = 20000
	var out []indicatorRow
	for page := 1; ; page++ {
		url := fmt.Sprintf("%s/country/%s/indicator/%s?format=json&per_page=%d&page=%d",
			Base, iso2, indicator, perPage, page)
		if startYear > 0 {
			url += fmt.Sprintf("&date=%d:%d", startYear, startYear+20)
		}
		var envelope []json.RawMessage
		if err := c.getJSON(ctx, url, &envelope); err != nil {
			return nil, err
		}
		if len(envelope) < 2 {
			return nil, &HardError{Kind: "shape", URL: url,
				Detail: fmt.Sprintf("envelope has %d elements, want [meta, rows]", len(envelope))}
		}
		var meta struct {
			Page  int `json:"page"`
			Pages int `json:"pages"`
		}
		if err := json.Unmarshal(envelope[0], &meta); err != nil {
			return nil, &HardError{Kind: "shape", URL: url, Detail: "meta: " + err.Error()}
		}
		var rows []indicatorRow
		if err := json.Unmarshal(envelope[1], &rows); err != nil {
			return nil, &HardError{Kind: "shape", URL: url, Detail: "rows: " + err.Error()}
		}
		out = append(out, rows...)
		if meta.Pages <= page {
			break
		}
	}
	return out, nil
}

// seriesMeta maps one indicator + country to the canonical series row.
// metric = indicator id lowercased with dots -> underscores (ny_gdp_mktp_cd),
// subject = country:<iso2 lower>, frequency annual, provider_series_id =
// "<indicator>:<iso2>" (the store keys series on
// (provider, provider_series_id, revision), so the country lives in the id).
func seriesMeta(indicator, indicatorName, iso2 string) canon.SeriesMeta {
	metric := strings.ReplaceAll(strings.ToLower(indicator), ".", "_")
	subject := "country:" + strings.ToLower(iso2)
	return canon.SeriesMeta{
		SeriesID:             canon.MintID(canon.KindSeries, canon.SeriesKey("economy", metric, subject)),
		Domain:               "economy",
		Metric:               metric,
		SubjectKey:           subject,
		Title:                strPtr(indicatorName),
		Unit:                 nil, // the v2 indicator rows carry no unit; absent stays nil
		Frequency:            "annual",
		CountryID:            countryID(iso2),
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     indicator + ":" + iso2,
		Revision:             "latest",
		SchemaVersion:        "v1",
		NormalizationVersion: "v1",
	}
}

// iso2Of validates the country.id ISO2 code: exactly two letters, else the
// row is an aggregate (region codes are 3+ chars or numeric) and mints no
// series.
func iso2Of(countryID string) (string, bool) {
	s := strings.TrimSpace(countryID)
	if len(s) != 2 {
		return "", false
	}
	for _, r := range s {
		if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')) {
			return "", false
		}
	}
	return strings.ToUpper(s), true
}

// parseYear parses the wire's 4-digit year string.
func parseYear(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if len(s) != 4 {
		return 0, false
	}
	y := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
		y = y*10 + int(r-'0')
	}
	return y, true
}

// subjectIndicator parses "indicator:<ID>".
func subjectIndicator(subject string) (string, error) {
	s := strings.TrimSpace(subject)
	if rest, ok := strings.CutPrefix(s, "indicator:"); ok && strings.TrimSpace(rest) != "" {
		return strings.TrimSpace(rest), nil
	}
	return "", &HardError{Kind: "shape", Detail: "worldbank/indicators job needs subject indicator:<ID>, got " + subject}
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

// lastYearMap reads the cursor's per-ISO2 last observed year (in-process
// map[string]int or jsonb map[string]any).
func lastYearMap(c ingest.Cursor) map[string]int {
	out := map[string]int{}
	if c == nil {
		return out
	}
	switch m := c["last_year"].(type) {
	case map[string]int:
		for k, v := range m {
			out[k] = v
		}
	case map[string]any:
		for k, v := range m {
			switch n := v.(type) {
			case float64:
				out[k] = int(n)
			case int:
				out[k] = n
			}
		}
	}
	return out
}

// anyMap converts the per-ISO2 map into the jsonb-friendly any-map the Cursor
// stores.
func anyMap(m map[string]int) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
