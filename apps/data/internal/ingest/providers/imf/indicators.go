package imf

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// indicatorValues is one indicator's slice of the values envelope:
// {"NGDP_RPCH":{"SDN":{"1980":2.5,...},"AFG":{...}}}. Country keys are the
// ISO3 spellings DataMapper uses in its data (the /countries vocabulary maps
// them to ISO2 identity); year keys are 4-digit strings, values may be null.
type indicatorValues map[string]map[string]json.RawMessage

// valuesResponse is the top-level envelope: {"values":{...}} (optionally
// "info" alongside when multiple indicators are requested).
type valuesResponse struct {
	Values indicatorValues `json:"values"`
}

// iso2ByISO3 maps the DataMapper country spellings of the seed jobs (and a
// few common ones) to ISO2 identity. DataMapper's /values data keys on ISO3
// for most economies; the subject key the platform canon mints is ISO2.
var iso2ByISO3 = map[string]string{
	"IND": "IN", "IDN": "ID", "USA": "US", "SDN": "SD", "AFG": "AF",
	"ARG": "AR", "AUS": "AU", "BRA": "BR", "CAN": "CA", "CHE": "CH",
	"CHN": "CN", "DEU": "DE", "ESP": "ES", "FRA": "FR", "GBR": "GB",
	"JPN": "JP", "KOR": "KR", "MEX": "MX", "MYS": "MY", "NLD": "NL",
	"PHL": "PH", "SGP": "SG", "THA": "TH", "TUR": "TR", "VNM": "VN",
	"ZAF": "ZA", "SAU": "SA", "ARE": "AE", "ITA": "IT", "POL": "PL",
	"SWE": "SE", "NOR": "NO", "DNK": "DK", "FIN": "FI", "NZL": "NZ",
}

// indicators fetches every indicator in the job subject (comma-separated
// DataMapper indicator ids, e.g. "NGDP_RPCH,PCPIPCH") and writes the canonical
// series + observations. The cursor pins the last observed year per indicator
// so the next run skips years at or before it.
func (c *client) indicators(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	ids := parseSubjects(job.Subject)
	if len(ids) == 0 {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "imf/indicators job needs comma-separated DataMapper indicator ids in the subject"}
	}
	lastYears := lastYearMap(job.Cursor)

	// One request per indicator (DataMapper takes /{indicator}/{country}).
	responses := make(map[string]indicatorValues, len(ids))
	for _, id := range ids {
		res, err := c.fetchIndicator(ctx, id, seedCountriesISO3)
		if err != nil {
			return 0, 0, nil, err
		}
		responses[id] = res
	}

	now := time.Now().UTC()
	var metas []canon.SeriesMeta
	var obs []canon.Observation
	for _, id := range ids {
		countries, ok := responses[id][id]
		if !ok {
			return 0, 0, nil, &HardError{Kind: "shape", Detail: "no values for indicator " + id}
		}
		minYear := lastYears[id]
		for _, iso3 := range sortedKeys(countries) {
			iso2, ok := iso2ByISO3[iso3]
			if !ok {
				continue // unmapped country spelling: skip, never guess
			}
			var years map[string]json.RawMessage
			if err := json.Unmarshal(countries[iso3], &years); err != nil {
				return 0, 0, nil, &HardError{Kind: "shape", Detail: "country values not an object for " + iso3}
			}
			sm := seriesMeta(id, iso2)
			metas = append(metas, sm)
			maxYear := minYear
			for _, year := range sortedKeys[json.RawMessage](years) {
				y, ok := parseYear(year)
				if !ok {
					continue
				}
				if y > maxYear {
					maxYear = y
				}
				if minYear > 0 && y <= minYear {
					continue // at or before the cursor's year: already stored
				}
				v, ok := parseValue(years[year])
				if !ok {
					continue // null/absent value: skip, never 0
				}
				obs = append(obs, canon.Observation{
					SeriesID:    sm.SeriesID,
					Period:      year,
					ObservedAt:  time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC),
					Value:       &v,
					Revision:    "latest",
					Source:      providerName,
					RetrievedAt: now,
				})
			}
			if maxYear > lastYears[id] {
				lastYears[id] = maxYear
			}
		}
	}
	if len(metas) > 0 {
		if _, err := w.UpsertSeries(ctx, metas); err != nil {
			return 0, 0, nil, err
		}
	}
	if len(obs) > 0 {
		written, rejected, err := w.WriteObservations(ctx, obs)
		if err != nil {
			return written, rejected, nil, err
		}
		return written, rejected, ingest.Cursor{"last_year": anyMap(lastYears)}, nil
	}
	return 0, 0, ingest.Cursor{"last_year": anyMap(lastYears)}, nil
}

// fetchIndicator calls GET /{indicator}/{countries} and returns the inner
// indicator map. The URL pins the country list so a fresh job does not pull
// the whole world's values.
func (c *client) fetchIndicator(ctx context.Context, indicator string, countries []string) (indicatorValues, error) {
	url := Base + "/" + indicator + "/" + strings.Join(countries, ",")
	var res valuesResponse
	if err := c.getJSON(ctx, url, &res); err != nil {
		return nil, err
	}
	if _, ok := res.Values[indicator]; !ok {
		return nil, &HardError{Kind: "shape", URL: url, Detail: "values missing indicator " + indicator}
	}
	return res.Values, nil
}

// seriesMeta maps one (indicator, country) pair to the canonical series row:
// metric = indicator lower, subject = country:<iso2 lower>, frequency annual,
// provider_series_id = "<indicator>:<iso2>".
func seriesMeta(indicator, iso2 string) canon.SeriesMeta {
	metric := strings.ToLower(indicator)
	subject := "country:" + strings.ToLower(iso2)
	return canon.SeriesMeta{
		SeriesID:             canon.MintID(canon.KindSeries, canon.SeriesKey("economy", metric, subject)),
		Domain:               "economy",
		Metric:               metric,
		SubjectKey:           subject,
		Title:                nil, // the values envelope carries no display title; absent stays nil
		Unit:                 nil,
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

// parseValue decodes one year value: a JSON number (or numeric string) is a
// value; null/unparseable is absent (skip, never 0).
func parseValue(b json.RawMessage) (float64, bool) {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(b, &f); err == nil {
		return f, true
	}
	var str string
	if err := json.Unmarshal(b, &str); err == nil {
		if g, err := strconv.ParseFloat(strings.TrimSpace(str), 64); err == nil {
			return g, true
		}
	}
	return 0, false
}

// parseYear parses a 4-digit year key.
func parseYear(s string) (int, bool) {
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

// parseSubjects splits a comma-separated subject into trimmed, non-empty,
// de-duplicated indicator ids in stable order.
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

// sortedKeys gives deterministic iteration over the envelope maps.
func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// countryID mints the canonical country id for an ISO2 code.
func countryID(iso2 string) *string {
	id := canon.MintID(canon.KindCountry, canon.CountryKey(iso2))
	return &id
}

// lastYearMap reads the cursor's per-indicator last observed year
// (map[string]int in-process, map[string]any after a jsonb round-trip).
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

// anyMap converts the per-indicator map into the jsonb-friendly any-map the
// Cursor stores.
func anyMap(m map[string]int) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
