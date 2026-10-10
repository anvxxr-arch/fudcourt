package bps

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// seedVar is the seeded variable: var 347, inflation year-on-year.
const seedVar = "347"

// varData fetches the configured variable's data and writes the canonical
// series + observations. The subject is "var/<id>" (seeded "var/347"); the
// series is economy/<label slug>/country:id. The cursor pins the last period
// id ("tval" key) so the next run skips stored periods.
func (c *client) varData(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	if !c.hasCredentials() {
		return 0, 0, nil, errNoCredentials()
	}
	varID, err := subjectVar(job.Subject)
	if err != nil {
		return 0, 0, nil, err
	}

	// The dynamicdata call: var + turvar (turvar 4 = year-on-year growth is
	// BPS's conventional inflation YoY slice) + verunit (9 = percent).
	url := fmt.Sprintf("%s/list/model/data/lang/eng/domain/0000/key/%s/id/%s/var/%s/turvar/4/verunit/9/ver/124/tphr/1/th/113",
		Base, c.apiKey, c.apiID, varID)
	var res dataResponse
	if err := c.getJSON(ctx, url, &res); err != nil {
		return 0, 0, nil, err
	}
	if res.Status != "OK" && res.Status != "" {
		return 0, 0, nil, &HardError{Kind: "api-error", URL: url, Detail: "status " + res.Status}
	}
	label := res.varLabel(varID)
	if label == "" {
		return 0, 0, nil, &HardError{Kind: "shape", URL: url, Detail: "response missing var vocabulary entry for var/" + varID}
	}

	unit := res.varUnit(varID)
	lastPeriods := lastPeriodMap(job.Cursor)
	now := time.Now().UTC()

	sm := seriesMeta(label, unit, varID)
	if _, err := w.UpsertSeries(ctx, []canon.SeriesMeta{sm}); err != nil {
		return 0, 0, nil, err
	}

	// datacontent carries the variable's rows keyed by period id; the
	// "tval"/period vocabulary (per phrase) labels each id. Rows without a
	// numeric value skip, never write 0.
	var obs []canon.Observation
	written, rejected := 0, 0
	for _, periodID := range sortedKeys(res.Datacontent) {
		if lastPeriods[varID] != "" {
			if a, ok1 := atoi(periodID); ok1 {
				if b, ok2 := atoi(lastPeriods[varID]); ok2 && a <= b {
					continue // at or before the cursor: already stored
				}
			}
		}
		raw := res.Datacontent[periodID]
		v, ok := parseValue(raw)
		if !ok {
			continue
		}
		periodLabel := res.periodLabel(periodID)
		lastPeriods[varID] = periodID
		obs = append(obs, canon.Observation{
			SeriesID:    sm.SeriesID,
			Period:      periodLabel,
			ObservedAt:  observedAt(periodLabel, periodID),
			Value:       &v,
			Revision:    "latest",
			Source:      providerName,
			RetrievedAt: now,
		})
	}
	if len(obs) > 0 {
		written, rejected, err = w.WriteObservations(ctx, obs)
		if err != nil {
			return written, rejected, nil, err
		}
	}
	return written, rejected, ingest.Cursor{"last_period": cursorAnyMap(lastPeriods)}, nil
}

// dataResponse is the dynamicdata payload (trimmed to the fields the adapter
// reads): {"status":"OK","var":[{"val":"347","label":"...","unit":"..."}],
// "turvar":[...],"tphr":[...],"datacontent":{"<period id>":"<value>"}}.
// RawMessage keeps the value field flexible (BPS sends numbers as strings).
type dataResponse struct {
	Status      string                     `json:"status"`
	Var         []vocabRow                 `json:"var"`
	Turvar      []vocabRow                 `json:"turvar"`
	Tphr        []vocabRow                 `json:"tphr"`
	Datacontent map[string]json.RawMessage `json:"datacontent"`
}

// vocabRow is one entry of the response's label vocabularies:
// {"val":"347","label":"...","unit":"%"}.
type vocabRow struct {
	Val   string          `json:"val"`
	Label string          `json:"label"`
	Unit  json.RawMessage `json:"unit"`
}

// varLabel returns the requested variable's label (the var vocabulary row
// whose val matches varID).
func (r *dataResponse) varLabel(varID string) string {
	for _, row := range r.Var {
		if row.Val == varID && row.Label != "" {
			return row.Label
		}
	}
	return ""
}

// varUnit returns the requested variable's unit label when the response
// carries one ("" stays absent).
func (r *dataResponse) varUnit(varID string) string {
	for _, row := range r.Var {
		if row.Val == varID {
			u := strings.Trim(strings.TrimSpace(string(row.Unit)), `"`)
			if u != "" && u != "null" {
				return u
			}
		}
	}
	return ""
}

// periodLabel maps a period id to its label via the tphr vocabulary
// ("113" -> "2023"), falling back to the raw id.
func (r *dataResponse) periodLabel(periodID string) string {
	for _, row := range r.Tphr {
		if row.Val == periodID && row.Label != "" {
			return row.Label
		}
	}
	return periodID
}

// parseValue decodes one datacontent value: a JSON number or numeric string
// is a value; null/empty/unparseable is absent (skip, never 0).
func parseValue(b json.RawMessage) (float64, bool) {
	s := strings.TrimSpace(string(b))
	s = strings.Trim(s, `"`)
	if s == "" || s == "null" || s == "-" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// subjectVar parses "var/<id>".
func subjectVar(subject string) (string, error) {
	s := strings.TrimSpace(subject)
	if rest, ok := strings.CutPrefix(s, "var/"); ok && strings.TrimSpace(rest) != "" {
		return strings.TrimSpace(rest), nil
	}
	return "", &HardError{Kind: "shape", Detail: "bps/var-data job needs subject var/<id>, got " + subject}
}

// seriesMeta maps the variable to the canonical series row: metric = label
// slug, subject country:id, provider_series_id = "var/<id>".
func seriesMeta(label, unit, varID string) canon.SeriesMeta {
	metric := slug(label)
	if metric == "" {
		metric = "var_" + varID
	}
	return canon.SeriesMeta{
		SeriesID:             canon.MintID(canon.KindSeries, canon.SeriesKey("economy", metric, "country:id")),
		Domain:               "economy",
		Metric:               metric,
		SubjectKey:           "country:id",
		Title:                strPtr(label),
		Unit:                 strPtr(unit),
		Frequency:            "monthly",
		CountryID:            countryID("ID"),
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     "var/" + varID,
		Revision:             "latest",
		SchemaVersion:        "v1",
		NormalizationVersion: "v1",
	}
}

// observedAt maps a BPS period to its start instant: a "2024" year label is
// Jan 1; "2024-05" (monthly tphr labels BPS emits as YYYYMM ids) parses via
// the period id when it is 6 digits (YYYYMM). Unknown labels fall back to the
// period id's year when present, else the zero time.
func observedAt(periodLabel, periodID string) time.Time {
	if t, err := time.Parse("2006", periodLabel); err == nil {
		return time.Date(t.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	}
	if t, err := time.Parse("2006-01", periodLabel); err == nil {
		return t.UTC()
	}
	if len(periodID) == 6 && isDigits(periodID) {
		if t, err := time.Parse("200601", periodID); err == nil {
			return t.UTC()
		}
	}
	if len(periodLabel) >= 4 && isDigits(periodLabel[:4]) {
		if y, err := strconv.Atoi(periodLabel[:4]); err == nil {
			return time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC)
		}
	}
	return time.Time{}.UTC()
}

// isDigits reports whether s is nonempty ASCII digits.
func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// atoi parses a period id int.
func atoi(s string) (int, bool) {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return n, true
}

// slug lowercases and replaces every non-alphanumeric run with one underscore.
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

// sortedKeys gives deterministic iteration over the datacontent map.
func sortedKeys(m map[string]json.RawMessage) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	for i := 1; i < len(ks); i++ {
		for j := i; j > 0 && ks[j] < ks[j-1]; j-- {
			ks[j], ks[j-1] = ks[j-1], ks[j]
		}
	}
	return ks
}

// lastPeriodMap reads the cursor's per-var last period id (map[string]string
// in-process, map[string]any after a jsonb round-trip).
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

// cursorAnyMap converts the per-var map into the jsonb-friendly any-map the
// Cursor stores.
func cursorAnyMap(m map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
