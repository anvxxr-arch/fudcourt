package dune

import (
	"context"
	"fmt"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"strconv"
	"time"
)

// providerName is the data.job provider column value.
const providerName = "dune"

// queryConfig is the job's adapter config, read from the cursor: which query
// to fetch and which columns become which metrics. An operator registers a
// job by seeding data.job with this cursor (the module itself seeds none).
type queryConfig struct {
	queryID    string
	domain     string            // series domain; default "onchain"
	columns    map[string]string // row column -> metric name
	timeColumn string            // row column carrying the point time (optional)
	limit      int
}

// configFromJob extracts the query config from a job. The cursor is the
// source of truth; the subject is the fallback query id (subject "1234" or
// "query:1234"). Missing columns map or query id is a shape HardError: the
// adapter cannot guess which columns are metrics.
func configFromJob(job ingest.Job) (queryConfig, error) {
	cfg := queryConfig{domain: "onchain", limit: defaultLimit, columns: map[string]string{}}
	if job.Cursor != nil {
		if s, ok := job.Cursor["query_id"].(string); ok && s != "" {
			cfg.queryID = s
		} else if f, ok := job.Cursor["query_id"].(float64); ok && f > 0 {
			cfg.queryID = strconv.FormatInt(int64(f), 10)
		}
		if s, ok := job.Cursor["domain"].(string); ok && s != "" {
			cfg.domain = s
		}
		if s, ok := job.Cursor["time_column"].(string); ok && s != "" {
			cfg.timeColumn = s
		}
		if m, ok := job.Cursor["columns"].(map[string]any); ok {
			for col, metric := range m {
				s, ok := metric.(string)
				if !ok || s == "" {
					return cfg, &HardError{Kind: "shape",
						Detail: fmt.Sprintf("cursor columns[%q] must name a metric", col)}
				}
				cfg.columns[col] = s
			}
		}
		if f, ok := job.Cursor["limit"].(float64); ok && f > 0 {
			cfg.limit = int(f)
		}
	}
	// Subject fallback: "1234" or "query:1234".
	if cfg.queryID == "" {
		s := job.Subject
		if len(s) > 6 && s[:6] == "query:" {
			s = s[6:]
		}
		cfg.queryID = s
	}
	if cfg.queryID == "" {
		return cfg, &HardError{Kind: "shape",
			Detail: "job needs a query id (cursor query_id or subject)"}
	}
	if len(cfg.columns) == 0 {
		return cfg, &HardError{Kind: "shape",
			Detail: "job needs a column->metric mapping (cursor columns)"}
	}
	return cfg, nil
}

// resultsURL builds the results request for one query id and limit.
func resultsURL(queryID string, limit int) string {
	return Base + "/query/" + queryID + "/results?limit=" + strconv.Itoa(limit)
}

// resultsEnv is the GET /query/{id}/results envelope (trimmed). Rows are
// free-form objects; metadata carries the column names.
type resultsEnv struct {
	State  string `json:"state"`
	Result struct {
		Rows []map[string]any `json:"rows"`
		Meta struct {
			ColumnNames   []string `json:"column_names"`
			TotalRowCount int      `json:"total_row_count"`
		} `json:"metadata"`
	} `json:"result"`
}

// query fetches one query's latest result and writes one metric point per
// mapped column of every row. The series are
// series/<domain>/<metric>/global; each series row is upserted before its
// points (WriteMetric requires the series row). Points key on the row's
// time column when the config names one (RFC3339 or "2006-01-02" spellings
// are both seen in the wild); without a time column every point lands on the
// fetch time. Rows whose mapped value is absent or non-numeric are counted
// as rejected, never faked.
func (c *client) query(ctx context.Context, w canon.Writer, job ingest.Job) (int, int, error) {
	cfg, err := configFromJob(job)
	if err != nil {
		return 0, 0, err
	}
	url := resultsURL(cfg.queryID, cfg.limit)
	var env resultsEnv
	if err := c.getJSON(ctx, url, &env); err != nil {
		return 0, 0, err
	}
	if env.State != "" && env.State != "QUERY_STATE_COMPLETED" {
		return 0, 0, &HardError{Kind: "api-error", URL: url,
			Detail: "query state " + env.State}
	}
	now := time.Now().UTC()
	type seriesKey struct{ seriesID, metric string }
	series := map[string]canon.SeriesMeta{}
	points := map[string][]canon.MetricPoint{}
	rejected := 0
	for _, row := range env.Result.Rows {
		at := now
		if cfg.timeColumn != "" {
			if raw, ok := row[cfg.timeColumn]; ok {
				if t, ok := parseTime(raw); ok {
					at = t
				} else {
					rejected++
					continue
				}
			} else {
				// The configured time column is missing from the row: the
				// row cannot be placed on a timeline, so it is rejected.
				rejected++
				continue
			}
		}
		for col, metric := range cfg.columns {
			raw, ok := row[col]
			if !ok {
				rejected++
				continue
			}
			v, ok := f64(raw)
			if !ok {
				rejected++
				continue
			}
			subject := "global"
			seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey(cfg.domain, metric, subject))
			if _, done := series[seriesID]; !done {
				series[seriesID] = seriesMeta(cfg, metric, seriesID)
			}
			points[seriesID] = append(points[seriesID], canon.MetricPoint{
				At:     at,
				Value:  &v,
				Meta:   map[string]any{"query_id": cfg.queryID, "column": col},
				Source: providerName,
			})
		}
	}
	if len(series) == 0 {
		if rejected > 0 {
			return 0, rejected, nil
		}
		return 0, 0, nil
	}
	metas := make([]canon.SeriesMeta, 0, len(series))
	for _, id := range sortedKeys(series) {
		metas = append(metas, series[id])
	}
	if _, err := w.UpsertSeries(ctx, metas); err != nil {
		return 0, rejected, err
	}
	written := 0
	for _, id := range sortedKeys(points) {
		n, err := w.WriteMetric(ctx, id, points[id])
		written += n
		if err != nil {
			return written, rejected, err
		}
	}
	return written, rejected, nil
}

// seriesMeta builds one series row for one metric of one query config.
func seriesMeta(cfg queryConfig, metric, seriesID string) canon.SeriesMeta {
	return canon.SeriesMeta{
		SeriesID:             seriesID,
		Domain:               cfg.domain,
		Metric:               metric,
		SubjectKey:           "global",
		Title:                strPtr("dune query " + cfg.queryID + " " + metric),
		Unit:                 nil, // the operator's query defines the unit; none is faked
		Frequency:            "event",
		Source:               providerName,
		Provider:             providerName,
		ProviderSeriesID:     "query:" + cfg.queryID + ":" + metric,
		SchemaVersion:        "v1",
		NormalizationVersion: "v1",
	}
}

// parseTime parses a row timestamp: RFC3339, the date-only spelling DuneSQL
// DATE columns render as, or a UNIX-seconds number.
func parseTime(v any) (time.Time, bool) {
	switch t := v.(type) {
	case string:
		for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02"} {
			if ts, err := time.Parse(layout, t); err == nil {
				return ts.UTC(), true
			}
		}
		return time.Time{}, false
	case float64:
		return time.Unix(int64(t), 0).UTC(), true
	default:
		return time.Time{}, false
	}
}

// fetcher is one dataset's Fetcher implementation. The dataset name is the
// registry key the engine and /api/data/ingest/run resolve.
type fetcher struct {
	dataset string
	client  *client
}

// Fetch runs ONE synchronous attempt (the engine owns retries).
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	switch f.dataset {
	case "query":
		written, rejected, err := f.client.query(ctx, w, job)
		if err != nil {
			return ingest.FetchResult{}, err
		}
		return ingest.FetchResult{
			RowsIn:       written + rejected,
			RowsWritten:  written,
			RowsRejected: rejected,
			Next:         ingest.Cursor{},
		}, nil
	default:
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown dataset " + f.dataset}
	}
}

// Module is the dune adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the dune module. The API key is read from DUNE_API_KEY
// once, here; with no key every fetch fails with a no-credentials HardError
// before any request is made.
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

// HasCredentials reports whether an API key is configured.
func (m *Module) HasCredentials() bool { return m.client.apiKey != "" }
func (m *Module) Provider() string     { return providerName }

// Fetchers returns one fetcher per dataset, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{
		"query": &fetcher{dataset: "query", client: m.client},
	}
}

// Jobs seeds nothing: a Dune job is operator-configured (which query, which
// columns are metrics is deployment-specific knowledge the adapter cannot
// guess). The module is registered so /api/data/ingest/run and manual job
// rows work.
func (m *Module) Jobs() []ingest.JobSpec {
	return nil
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
