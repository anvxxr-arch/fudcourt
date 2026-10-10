package oecd

import (
	"context"
	"encoding/csv"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// flowConfig maps one dataflow's columns onto the canonical fields and names
// the series the rows mint. Column names differ per flow, so the config (not
// the parser) owns the flow's vocabulary; the label columns the real
// csvfilewithlabels payloads carry alongside the id columns (e.g.
// "REF_AREA,Reference area") are matched by exact header name.
type flowConfig struct {
	// Metric is the canonical metric slug for every row of the flow.
	Metric string
	// Unit is the canonical unit label (nil when the flow has no single one).
	Unit *string
	// Columns maps canonical field -> CSV header names to try, in order.
	// TIME_PERIOD carries the period, OBS_VALUE the value, REF_AREA the ISO2
	// country code.
	Columns map[string][]string
	// Frequency is the canonical frequency label for the flow's rows.
	Frequency string
}

// canonicalColumns is the default column vocabulary: the SDMX standard
// concept ids. A flow whose labels differ overrides per field.
func canonicalColumns() map[string][]string {
	return map[string][]string{
		"TIME_PERIOD": {"TIME_PERIOD"},
		"OBS_VALUE":   {"OBS_VALUE"},
		"REF_AREA":    {"REF_AREA"},
	}
}

// flowConfigs is the dataset registry: one entry per seed dataflow, keyed by
// the dataflow id portion of the subject. Unknown flows fall back to the
// canonical column vocabulary with the metric derived from the flow id.
func flowConfigs() map[string]flowConfig {
	unit := "index"
	return map[string]flowConfig{
		"DSD_RGD@DF_RGD": {
			Metric: "rgdp",
			Unit:   &unit,
			// The real CSV labels are the SDMX concepts; per-flow overrides
			// would add alternates (e.g. "Observation value") here.
			Columns:   canonicalColumns(),
			Frequency: "annual",
		},
	}
}

// dataflow fetches one dataflow's CSV and writes the canonical series +
// observations. The subject is the request path "{agency},{df},{version}/{key}"
// (e.g. "OECD.SDD.TPS,DSD_RGD@DF_RGD,1.1.0/A....."). The cursor pins the last
// observed TIME_PERIOD so the next run advances startPeriod past it.
func (c *client) dataflow(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, ingest.Cursor, error) {
	subject := strings.TrimSpace(job.Subject)
	if subject == "" {
		return 0, 0, nil, &HardError{Kind: "shape", Detail: "oecd/dataflow job needs subject {agency},{df},{version}/{key}"}
	}
	cfg, flowID := configFor(subject)

	start := startPeriodFrom(job.Cursor)
	url := fmt.Sprintf("%s/%s?format=csvfilewithlabels&dimensionAtObservation=AllDimensions", Base, subject)
	if start != "" {
		url += "&startPeriod=" + start
	}
	body, err := c.getCSV(ctx, url)
	if err != nil {
		return 0, 0, nil, err
	}
	rows, err := parseCSV(body, cfg)
	if err != nil {
		return 0, 0, nil, err
	}

	now := time.Now().UTC()
	var metas []canon.SeriesMeta
	metasByArea := make(map[string]canon.SeriesMeta)
	var obs []canon.Observation
	lastPeriod := start
	for _, r := range rows {
		period := r[cfg.Columns["TIME_PERIOD"][0]]
		if period == "" {
			continue
		}
		v, ok := parseF64(r[cfg.Columns["OBS_VALUE"][0]])
		if !ok {
			continue // empty/non-numeric value: skip, never 0
		}
		iso2 := normalizeISO2(r[cfg.Columns["REF_AREA"][0]])
		if iso2 == "" {
			continue // rows outside the ISO2 vocabulary (aggregates) skip
		}
		if p, ok := periodKey(period); ok {
			if pk, ok2 := periodKey(lastPeriod); !ok2 || p > pk {
				lastPeriod = period
			}
			if start != "" {
				if pk0, ok3 := periodKey(start); ok3 && p <= pk0 {
					continue // at or before the cursor's period: already stored
				}
			}
		}
		sm, ok := metasByArea[iso2]
		if !ok {
			sm = seriesMeta(cfg, flowID, subject, iso2)
			metasByArea[iso2] = sm
			metas = append(metas, sm)
		}
		obs = append(obs, canon.Observation{
			SeriesID:    sm.SeriesID,
			Period:      period,
			ObservedAt:  observedAt(period),
			Value:       &v,
			Revision:    "latest",
			Source:      providerName,
			RetrievedAt: now,
		})
	}
	if _, err := w.UpsertSeries(ctx, metas); err != nil {
		return 0, 0, nil, err
	}
	if len(obs) > 0 {
		written, rejected, err := w.WriteObservations(ctx, obs)
		if err != nil {
			return written, rejected, nil, err
		}
		return written, rejected, ingest.Cursor{"last_period": lastPeriod}, nil
	}
	return 0, 0, ingest.Cursor{"last_period": lastPeriod}, nil
}

// parseCSV parses one csvfilewithlabels payload generically: read the header,
// resolve the configured columns against it, then map every row into
// header->value records. A configured column missing from the header is a
// shape HardError (the config and the flow disagree - fail loud).
func parseCSV(body string, cfg flowConfig) ([]map[string]string, error) {
	cr := csv.NewReader(strings.NewReader(body))
	cr.FieldsPerRecord = -1 // rows may trail optional columns; header governs
	records, err := cr.ReadAll()
	if err != nil {
		return nil, &HardError{Kind: "shape", Detail: "csv: " + err.Error()}
	}
	if len(records) < 1 {
		return nil, &HardError{Kind: "shape", Detail: "csv: empty payload"}
	}
	header := records[0]
	colIndex := make(map[string]int, len(header))
	for i, h := range header {
		colIndex[strings.TrimSpace(h)] = i
	}
	resolved := make(map[string]string, len(cfg.Columns))
	for field, candidates := range cfg.Columns {
		found := ""
		for _, cand := range candidates {
			if _, ok := colIndex[cand]; ok {
				found = cand
				break
			}
		}
		if found == "" {
			return nil, &HardError{Kind: "shape",
				Detail: fmt.Sprintf("csv header lacks configured %s column (tried %v); header has %v", field, candidates, header)}
		}
		resolved[field] = found
	}
	var out []map[string]string
	for _, rec := range records[1:] {
		row := make(map[string]string, len(resolved))
		for _, col := range resolved {
			i := colIndex[col]
			if i < len(rec) {
				row[col] = strings.TrimSpace(rec[i])
			}
		}
		out = append(out, row)
	}
	return out, nil
}

// configFor resolves the flow config for a subject "{agency},{df},{version}/{key}":
// the dataflow id is the second comma segment's id part before '@'
// ("DSD_RGD@DF_RGD" -> flow id "DF_RGD"); unknown flows get the canonical
// column vocabulary and a metric slug derived from the flow id.
func configFor(subject string) (flowConfig, string) {
	flowID := subject
	if i := strings.IndexByte(subject, '/'); i >= 0 {
		flowID = subject[:i]
	}
	if parts := strings.Split(flowID, ","); len(parts) >= 2 {
		flowID = parts[1]
	}
	if cfg, ok := flowConfigs()[flowID]; ok {
		return cfg, flowID
	}
	// "DSD_STAN@DF_STAN" -> "stan"; a plain "DF_RGD" -> "rgd".
	metric := flowID
	if i := strings.IndexByte(metric, '@'); i >= 0 {
		metric = metric[i+1:]
	}
	metric = strings.TrimPrefix(strings.ToLower(metric), "df_")
	return flowConfig{
		Metric:    metric,
		Unit:      nil,
		Columns:   canonicalColumns(),
		Frequency: "annual",
	}, flowID
}

// seriesMeta maps one flow + REF_AREA country to the canonical series row:
// metric from the flow config, subject country:<iso2 lower>, unit/frequency
// from the config, provider_series_id = "<subject>:<iso2>" (the store keys
// series on (provider, provider_series_id, revision), so the country lives
// in the id).
func seriesMeta(cfg flowConfig, flowID, subject, iso2 string) canon.SeriesMeta {
	return canon.SeriesMeta{
		SeriesID:             canon.MintID(canon.KindSeries, canon.SeriesKey("economy", cfg.Metric, "country:"+strings.ToLower(iso2))),
		Domain:               "economy",
		Metric:               cfg.Metric,
		SubjectKey:           "country:" + strings.ToLower(iso2),
		Title:                strPtr(flowID),
		Unit:                 cfg.Unit,
		Frequency:            cfg.Frequency,
		CountryID:            countryID(iso2),
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     subject + ":" + iso2,
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

// normalizeISO2 uppercases a REF_AREA when it is a 2- or 3-letter ISO code
// (the SDMX feeds key REF_AREA on ISO2 or ISO3 country spellings); aggregates
// (WLD, OECD) and anything else return "" and the row skips.
var aggregateAreas = map[string]bool{"WLD": true, "OECD": true}

func normalizeISO2(area string) string {
	s := strings.ToUpper(strings.TrimSpace(area))
	if len(s) < 2 || len(s) > 3 {
		return ""
	}
	for _, r := range s {
		if r < 'A' || r > 'Z' {
			return ""
		}
	}
	if aggregateAreas[s] {
		return ""
	}
	return s
}

// periodKey converts a TIME_PERIOD into a sortable key. Annual ("2023") and
// monthly ("2023-01") / quarterly ("2023-Q1") spellings map onto comparable
// strings; unknown spellings report ok=false and keep full-string compares.
func periodKey(period string) (string, bool) {
	p := strings.TrimSpace(period)
	if len(p) == 4 && isDigits(p) {
		return p, true
	}
	if len(p) >= 7 && isDigits(p[:4]) && p[4] == '-' {
		return p, true
	}
	if len(p) == 7 && isDigits(p[:4]) && (p[4] == 'Q' || p[4] == 'q') {
		return p[:4] + "-Q" + p[6:], true
	}
	return p, false
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

// observedAt maps a TIME_PERIOD to its period-start instant (annual -> Jan 1,
// monthly -> the 1st, quarterly -> quarter start; unknown spellings use the
// string's year when it has one, else the zero time is avoided by keeping the
// row's period-only identity - the engine never sees a fabricated clock).
func observedAt(period string) time.Time {
	if t, err := time.Parse("2006-01-02", period); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse("2006-01", period); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse("2006", period); err == nil {
		return t.UTC()
	}
	if len(period) == 6 && (period[4] == 'Q' || period[4] == 'q') && isDigits(period[5:]) {
		if y, err := time.Parse("2006", period[:4]); err == nil {
			month := (int(period[5]-'0')-1)*3 + 1
			return time.Date(y.Year(), time.Month(month), 1, 0, 0, 0, 0, time.UTC)
		}
	}
	return time.Time{}.UTC()
}

// parseF64 parses a CSV numeric value; empty or non-numeric is absent
// (skip, never 0). strconv.ParseFloat (not Sscanf) so "12abc" is a value
// error, not a silent 12.
func parseF64(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// startPeriodFrom reads the cursor's last_period.
func startPeriodFrom(c ingest.Cursor) string {
	if c == nil {
		return ""
	}
	s, _ := c["last_period"].(string)
	return s
}

// strPtr is a non-empty string as a pointer; "" stays nil (never-fake).
func strPtr(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}
