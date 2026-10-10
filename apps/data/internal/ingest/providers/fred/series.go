package fred

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// seriesMetaRow is the /fred/series row (trimmed to the fields the adapter
// reads): {"id":"CPIAUCSL","title":"Consumer Price Index for All Urban
// Consumers: All Items in U.S. City Average","units":"Index 1982-84=100",
// "frequency":"Monthly","observation_start":"1913-01-01",...}.
type seriesMetaRow struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	Units            string `json:"units"`
	Frequency        string `json:"frequency"`
	ObservationStart string `json:"observation_start"`
}

// seriesResponse is the /fred/series envelope.
type seriesResponse struct {
	Series []seriesMetaRow `json:"seriess"`
}

// obsRow is one /fred/series/observations row:
// {"date":"2024-01-01","value":"312.332"}. A value of "." or "" is a
// published-but-missing period.
type obsRow struct {
	Date  string `json:"date"`
	Value string `json:"value"`
}

// obsResponse is the /fred/series/observations envelope.
type obsResponse struct {
	Observations []obsRow `json:"observations"`
}

// errNoCredentials is the typed no-credentials failure. FRED requires a free
// API key: without one nothing can be fetched, so the attempt fails at start,
// the engine journals it, and the job stays scheduled.
func errNoCredentials() *HardError {
	return &HardError{Kind: "no-credentials", Detail: "FRED_API_KEY is empty: FRED requires a free API key"}
}

// observations fetches meta + observations for every series id in the job
// subject (comma-separated FRED ids, e.g. "CPIAUCSL,FEDFUNDS"). Each series
// upserts its series row (unit/frequency/title from the /series response) and
// appends its observations; missing values (".", "") skip the row, never
// write 0. The cursor pins the last observed period per series id so the next
// run asks FRED for observation_start=<that period> (inclusive overlap is
// idempotent: observations are keyed (series, period, observed_at, revision)).
func (c *client) observations(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	if c.apiKey == "" {
		return 0, 0, nil, errNoCredentials()
	}
	ids := parseSubjects(job.Subject)
	if len(ids) == 0 {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "fred/observations job needs comma-separated FRED series ids in the subject"}
	}

	// Meta first: it names the series rows and carries unit/frequency/title.
	metas, err := c.fetchSeriesMeta(ctx, ids)
	if err != nil {
		return 0, 0, nil, err
	}
	metasByID := make(map[string]seriesMetaRow, len(metas))
	for _, m := range metas {
		metasByID[m.ID] = m
	}

	lastPeriods := lastPeriodMap(job.Cursor)
	now := time.Now().UTC()
	var metasOut []canon.SeriesMeta
	var obs []canon.Observation
	written, rejected := 0, 0
	for _, id := range ids {
		meta, ok := metasByID[id]
		if !ok {
			return written, rejected, nil, &HardError{
				Kind: "shape", Detail: "no /series metadata returned for " + id,
			}
		}
		sm := seriesMeta(meta)
		metasOut = append(metasOut, sm)

		start := lastPeriods[id]
		rows, err := c.fetchObservations(ctx, id, start)
		if err != nil {
			return written, rejected, nil, err
		}
		for _, r := range rows {
			at, v, ok := observation(r)
			if !ok {
				continue // published-but-missing period: skip, never 0
			}
			obs = append(obs, canon.Observation{
				SeriesID:    sm.SeriesID,
				Period:      r.Date,
				ObservedAt:  at,
				Value:       v,
				Revision:    "latest",
				Source:      providerName,
				RetrievedAt: now,
			})
		}
		if n := len(rows); n > 0 {
			lastPeriods[id] = rows[n-1].Date
		}
	}
	if len(metasOut) > 0 {
		if _, err := w.UpsertSeries(ctx, metasOut); err != nil {
			return 0, 0, nil, err
		}
	}
	if len(obs) > 0 {
		var werr error
		written, rejected, werr = w.WriteObservations(ctx, obs)
		if werr != nil {
			return written, rejected, nil, werr
		}
	}
	return written, rejected, ingest.Cursor{"last_period": cursorAnyMap(lastPeriods)}, nil
}

// fetchSeriesMeta calls GET /fred/series?series_id=a,b&api_key=...&file_type=json.
// FRED accepts a comma-separated list and answers with a seriess array.
func (c *client) fetchSeriesMeta(ctx context.Context, ids []string) ([]seriesMetaRow, error) {
	url := fmt.Sprintf("%s/fred/series?series_id=%s&api_key=%s&file_type=json",
		Base, strings.Join(ids, ","), c.apiKey)
	var res seriesResponse
	if err := c.getJSON(ctx, url, &res); err != nil {
		return nil, err
	}
	return res.Series, nil
}

// fetchObservations calls GET /fred/series/observations?series_id=...&file_type=json
// with observation_start=<cursor> when the cursor pins one; an unpinned series
// starts from the default 90-day lookback (the endpoint contract always
// carries the param, and a first poll never asks for the full history). Rows
// come back ascending by date (FRED's default), which is what the incremental
// cursor assumes.
func (c *client) fetchObservations(ctx context.Context, id, start string) ([]obsRow, error) {
	if start == "" {
		start = time.Now().UTC().AddDate(0, 0, -90).Format("2006-01-02")
	}
	url := fmt.Sprintf("%s/fred/series/observations?series_id=%s&file_type=json&observation_start=%s", Base, id, start)
	var res obsResponse
	if err := c.getJSON(ctx, url, &res); err != nil {
		return nil, err
	}
	return res.Observations, nil
}

// seriesMeta maps one /fred/series row to the canonical series row. The
// metric is the slug of the FRED title (falling back to the lowercased series
// id when the title produces nothing), the subject is country:us, and
// provider_series_id is the FRED id - (provider, provider_series_id,
// revision) is the store's series uniqueness key.
func seriesMeta(m seriesMetaRow) canon.SeriesMeta {
	metric := metricFromTitle(m.Title, m.ID)
	subject := "country:us"
	freq := frequencyFromFRED(m.Frequency)
	return canon.SeriesMeta{
		SeriesID:             canon.MintID(canon.KindSeries, canon.SeriesKey("economy", metric, subject)),
		Domain:               "economy",
		Metric:               metric,
		SubjectKey:           subject,
		Title:                strPtr(m.Title),
		Unit:                 strPtr(m.Units),
		Frequency:            freq,
		CountryID:            countryID("US"),
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     m.ID,
		Revision:             "latest",
		SchemaVersion:        "v1",
		NormalizationVersion: "v1",
	}
}

// observation parses one observations row into (observed_at, value). A
// missing value (".", "", or unparseable) reports ok=false: the period is
// real, the value is not, and the never-fake rule says skip - never 0.
func observation(r obsRow) (time.Time, *float64, bool) {
	at, err := time.Parse("2006-01-02", r.Date)
	if err != nil {
		return time.Time{}, nil, false
	}
	t := strings.TrimSpace(r.Value)
	if t == "" || t == "." {
		return time.Time{}, nil, false
	}
	v, err := parseF64(t)
	if err != nil {
		return time.Time{}, nil, false
	}
	return at.UTC(), &v, true
}

// parseSubjects splits a comma-separated subject into trimmed, non-empty,
// de-duplicated series ids in stable (input) order.
func parseSubjects(subject string) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range strings.Split(subject, ",") {
		id := strings.TrimSpace(p)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// metricFromTitle derives the metric slug from the FRED title; an empty slug
// falls back to the lowercased series id.
func metricFromTitle(title, seriesID string) string {
	if s := slug(title); s != "" {
		return s
	}
	return strings.ToLower(strings.TrimSpace(seriesID))
}

// slug lowercases and replaces every non-alphanumeric run with one underscore,
// trimming leading/trailing separators: "Consumer Price Index ... U.S. City
// Average" -> "consumer_price_index_us_city_average"-style slugs.
func slug(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	sep := false
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			sep = false
		default:
			if !sep && b.Len() > 0 {
				b.WriteByte('_')
				sep = true
			}
		}
	}
	return strings.Trim(b.String(), "_")
}

// frequencyFromFRED maps FRED's frequency labels onto the platform's closed
// series vocabulary (canon.ValidTimeframes: monthly/quarterly/weekly/daily/
// annual). Unknown labels lowercase verbatim.
func frequencyFromFRED(f string) string {
	switch strings.ToLower(strings.TrimSpace(f)) {
	case "monthly":
		return "monthly"
	case "quarterly":
		return "quarterly"
	case "weekly":
		return "weekly"
	case "daily":
		return "daily"
	case "annual", "annually", "yearly":
		return "annual"
	default:
		return strings.ToLower(strings.TrimSpace(f))
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

// lastPeriodMap reads the cursor's per-series last observed period. The shape
// is map[string]string in-process and map[string]any after a jsonb round-trip;
// both are accepted.
func lastPeriodMap(c ingest.Cursor) map[string]string {
	out := map[string]string{}
	if c == nil {
		return out
	}
	switch m := c["last_period"].(type) {
	case map[string]string:
		for k, v := range m {
			out[k] = v
		}
	case map[string]any:
		for k, v := range m {
			if s, ok := v.(string); ok {
				out[k] = s
			}
		}
	}
	return out
}

// cursorAnyMap converts the per-series map into the jsonb-friendly any-map
// the Cursor stores.
func cursorAnyMap(m map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
