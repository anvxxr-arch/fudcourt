package dune

import (
	"context"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// fakeDoer answers every request with a canned status+body and records the
// requests (method + URL + auth header presence, never the key value).
type fakeDoer struct {
	status int
	body   string
	seen   []string
	auth   []string // "header" | "query" | "" per request
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, r.Method+" "+r.URL.String())
	if r.Header.Get("X-DUNE-API-KEY") != "" {
		f.auth = append(f.auth, "header")
	} else if r.URL.Query().Get("api_key") != "" {
		f.auth = append(f.auth, "query")
	} else {
		f.auth = append(f.auth, "")
	}
	return &http.Response{
		StatusCode: f.status,
		Body:       newReadCloser(f.body),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

// newReadCloser is a tiny io.ReadCloser over a string.
func newReadCloser(s string) ioReadCloser { return ioReadCloser{strings.NewReader(s)} }

type ioReadCloser struct{ *strings.Reader }

func (ioReadCloser) Close() error { return nil }

// spyWriter counts the writes each dataset performs.
type spyWriter struct {
	series  []canon.SeriesMeta
	pts     map[string][]canon.MetricPoint
	err     error
	failKey string // when set, WriteMetric fails for this series id
}

func (w *spyWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertChains(ctx context.Context, rows []canon.Chain) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertVenues(ctx context.Context, rows []canon.Venue) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertInstruments(ctx context.Context, rows []canon.Instrument) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertProtocols(ctx context.Context, rows []canon.Protocol) (int, error) {
	return 0, w.err
}
func (w *spyWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.series = append(w.series, rows...)
	return len(rows), nil
}
func (w *spyWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	return 0, w.err
}
func (w *spyWriter) WriteOhlcv(ctx context.Context, rows []canon.Ohlcv) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteTrades(ctx context.Context, rows []canon.Trade) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteQuotes(ctx context.Context, rows []canon.Quote) (int, int, error) {
	return 0, 0, w.err
}

func (w *spyWriter) WriteOrderbook(ctx context.Context, rows []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteFunding(ctx context.Context, rows []canon.FundingRate) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOpenInterest(ctx context.Context, rows []canon.OpenInterest) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WritePools(ctx context.Context, rows []canon.Pool) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteArticles(ctx context.Context, rows []canon.Article) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WritePredictionMarkets(ctx context.Context, rows []canon.PredictionMarket) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteChainTVL(ctx context.Context, rows []canon.ChainTVL) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteProtocolTVL(ctx context.Context, rows []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteSupply(ctx context.Context, rows []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteMetric(ctx context.Context, seriesID string, points []canon.MetricPoint) (int, error) {
	if w.err != nil || (w.failKey != "" && w.failKey == seriesID) {
		return 0, w.err
	}
	if w.pts == nil {
		w.pts = map[string][]canon.MetricPoint{}
	}
	w.pts[seriesID] = append(w.pts[seriesID], points...)
	return len(points), nil
}

// Fixtures trimmed from the real endpoint (shape-true, values real). The
// response envelope is {"result":{"rows":[...],"metadata":{...}},"state":...}.
const resultsFixture = `{"execution_id":"01HKZJ2683PHF9Q9PHHQ8FW4Q1",
 "query_id":1234,"state":"QUERY_STATE_COMPLETED",
 "result":{"rows":[
   {"block_date":"2026-01-01 00:00:00","volume":123.4,"chain":"ethereum"},
   {"block_date":"2026-01-02 00:00:00","volume":"130.5","chain":"ethereum"}],
  "metadata":{"column_names":["block_date","volume","chain"],
   "column_types":["timestamp with time zone","double","varchar"],
   "row_count":2,"total_row_count":2}}}`
const statePendingFixture = `{"state":"QUERY_STATE_PENDING","result":{"rows":[],"metadata":{}}}`
const authErrFixture = `{"error":"Invalid API key"}`

// withTestKey sets DUNE_API_KEY for one test and restores it after.
func withTestKey(t *testing.T) {
	t.Helper()
	old, had := os.LookupEnv(APIKeyEnv)
	os.Setenv(APIKeyEnv, "test-dune-key")
	t.Cleanup(func() {
		if had {
			os.Setenv(APIKeyEnv, old)
		} else {
			os.Unsetenv(APIKeyEnv)
		}
	})
}

// testJob builds one configured query job.
func testJob() ingest.Job {
	return ingest.Job{
		Provider: "dune", Dataset: "query", Subject: "", Mode: "poll",
		Cursor: ingest.Cursor{
			"query_id":    "1234",
			"domain":      "onchain",
			"time_column": "block_date",
			"columns":     map[string]any{"volume": "dex_volume_24h_usd"},
		},
	}
}
func TestQueryMapping(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 200, body: resultsFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	res, err := (&fetcher{dataset: "query", client: c}).Fetch(context.Background(), testJob(), w)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	// Two rows, one mapped column -> two points on one series.
	if res.RowsWritten != 2 || len(w.pts) != 1 {
		t.Fatalf("rows: %d/%d, series: %d", res.RowsWritten, len(w.pts), len(w.series))
	}
	if len(fd.seen) != 1 || fd.seen[0] != "GET https://api.dune.com/api/v1/query/1234/results?limit=1000" {
		t.Fatalf("url: %v", fd.seen)
	}
	// The key rides in the header, never the URL.
	if len(fd.auth) != 1 || fd.auth[0] != "header" {
		t.Fatalf("auth: %v", fd.auth)
	}
	seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey("onchain", "dex_volume_24h_usd", "global"))
	pts := w.pts[seriesID]
	if len(pts) != 2 {
		t.Fatalf("points: %d", len(pts))
	}
	// Number and numeric-string columns both parse.
	if *pts[0].Value != 123.4 || *pts[1].Value != 130.5 {
		t.Fatalf("values: %v %v", *pts[0].Value, *pts[1].Value)
	}
	// The time column places the points on the timeline.
	want1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	want2 := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	if !pts[0].At.Equal(want1) || !pts[1].At.Equal(want2) {
		t.Fatalf("times: %v %v", pts[0].At, pts[1].At)
	}
	// The series row was upserted before the points, with the right shape.
	if len(w.series) != 1 || w.series[0].SeriesID != seriesID ||
		w.series[0].Domain != "onchain" || w.series[0].Metric != "dex_volume_24h_usd" ||
		w.series[0].SubjectKey != "global" {
		t.Fatalf("series: %+v", w.series)
	}
}
func TestQueryRequiresConfig(t *testing.T) {
	withTestKey(t)
	cases := []struct {
		name string
		job  ingest.Job
	}{
		{"no cursor", ingest.Job{Provider: "dune", Dataset: "query"}},
		{"no columns", ingest.Job{Provider: "dune", Dataset: "query",
			Cursor: ingest.Cursor{"query_id": "1234"}}},
	}
	for _, tc := range cases {
		fd := &fakeDoer{status: 200, body: resultsFixture}
		c := newClient(fd, 0)
		_, err := (&fetcher{dataset: "query", client: c}).Fetch(context.Background(), tc.job, &spyWriter{})
		he, ok := err.(*HardError)
		if !ok || he.Kind != "shape" {
			t.Fatalf("%s: want shape HardError, got %v", tc.name, err)
		}
		if len(fd.seen) != 0 {
			t.Fatalf("%s: requests made without config: %v", tc.name, fd.seen)
		}
	}
}
func TestQuerySubjectFallback(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 200, body: resultsFixture}
	c := newClient(fd, 0)
	w := &spyWriter{}
	job := ingest.Job{Provider: "dune", Dataset: "query", Subject: "query:1234",
		Cursor: ingest.Cursor{"columns": map[string]any{"volume": "dex_volume_24h_usd"}}}
	res, err := (&fetcher{dataset: "query", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("subject fallback: %v", err)
	}
	if fd.seen[0] != "GET https://api.dune.com/api/v1/query/1234/results?limit=1000" {
		t.Fatalf("url: %s", fd.seen[0])
	}
	if res.RowsWritten != 2 {
		t.Fatalf("rows: %d", res.RowsWritten)
	}
	// Without a time column, points land on the fetch time (not zero).
	seriesID := canon.MintID(canon.KindSeries, canon.SeriesKey("onchain", "dex_volume_24h_usd", "global"))
	pts := w.pts[seriesID]
	if len(pts) != 2 || pts[0].At.IsZero() {
		t.Fatalf("points: %+v", pts)
	}
}
func TestQueryRejectsNonNumeric(t *testing.T) {
	withTestKey(t)
	body := `{"state":"QUERY_STATE_COMPLETED","result":{"rows":[
	 {"block_date":"2026-01-01","volume":5.0},
	 {"block_date":"2026-01-02","volume":"not-a-number"},
	 {"block_date":"2026-01-03"}],
	 "metadata":{"column_names":["block_date","volume"]}}}`
	fd := &fakeDoer{status: 200, body: body}
	c := newClient(fd, 0)
	w := &spyWriter{}
	res, err := (&fetcher{dataset: "query", client: c}).Fetch(context.Background(), testJob(), w)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	// One good row written; the string value and the missing value count as
	// rejected, never faked with zero.
	if res.RowsWritten != 1 || res.RowsRejected != 2 {
		t.Fatalf("rows: %d/%d", res.RowsWritten, res.RowsRejected)
	}
}
func TestQueryPendingStateIsHardError(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 200, body: statePendingFixture}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "query", client: c}).Fetch(context.Background(), testJob(), &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "api-error" || !strings.Contains(he.Detail, "QUERY_STATE_PENDING") {
		t.Fatalf("want api-error HardError, got %v", err)
	}
}
func TestQueryAuthErrorIsHardError(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 401, body: authErrFixture}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "query", client: c}).Fetch(context.Background(), testJob(), &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "api-error" || he.Status != 401 {
		t.Fatalf("want api-error HardError, got %v", err)
	}
	// The error carries Dune's message, not the key.
	if strings.Contains(he.Error(), "test-dune-key") {
		t.Fatalf("api key leaked into error: %s", he.Error())
	}
}
func TestNoCredentialsIsHardError(t *testing.T) {
	os.Unsetenv(APIKeyEnv)
	fd := &fakeDoer{status: 200, body: resultsFixture}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "query", client: c}).Fetch(context.Background(), testJob(), &spyWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "no-credentials" {
		t.Fatalf("want no-credentials HardError, got %v", err)
	}
	if len(fd.seen) != 0 {
		t.Fatalf("requests made without key: %v", fd.seen)
	}
}
func TestJobsSeedNoneButModuleRegistered(t *testing.T) {
	os.Unsetenv(APIKeyEnv)
	m := NewModule(nil)
	if m.Provider() != "dune" {
		t.Fatalf("provider: %s", m.Provider())
	}
	if len(m.Jobs()) != 0 {
		t.Fatalf("dune must seed no jobs: %+v", m.Jobs())
	}
	fetchers := m.Fetchers()
	if _, ok := fetchers["query"]; !ok {
		t.Fatalf("missing fetcher query")
	}
	if m.HasCredentials() {
		t.Fatalf("HasCredentials with empty env")
	}
}
func TestKeyNeverInURL(t *testing.T) {
	withTestKey(t)
	fd := &fakeDoer{status: 200, body: resultsFixture}
	c := newClient(fd, 0)
	if _, err := (&fetcher{dataset: "query", client: c}).Fetch(context.Background(), testJob(), &spyWriter{}); err != nil {
		t.Fatalf("query: %v", err)
	}
	for _, u := range fd.seen {
		if strings.Contains(u, "test-dune-key") {
			t.Fatalf("api key in url: %s", u)
		}
	}
}
func TestParseTime(t *testing.T) {
	cases := []struct {
		v    any
		ok   bool
		want time.Time
	}{
		{"2026-01-02 03:04:05", true, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)},
		{"2026-01-02", true, time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)},
		{"2026-01-02T03:04:05Z", true, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)},
		{1767225600.0, true, time.Unix(1767225600, 0).UTC()},
		{"garbage", false, time.Time{}},
		{nil, false, time.Time{}},
	}
	for _, c := range cases {
		got, ok := parseTime(c.v)
		if ok != c.ok || (ok && !got.Equal(c.want)) {
			t.Fatalf("parseTime(%v) = %v, %v; want %v, %v", c.v, got, ok, c.want, c.ok)
		}
	}
}
func TestLimitFromCursor(t *testing.T) {
	withTestKey(t)
	job := testJob()
	job.Cursor["limit"] = float64(25)
	fd := &fakeDoer{status: 200, body: resultsFixture}
	c := newClient(fd, 0)
	if _, err := (&fetcher{dataset: "query", client: c}).Fetch(context.Background(), job, &spyWriter{}); err != nil {
		t.Fatalf("query: %v", err)
	}
	if fd.seen[0] != "GET https://api.dune.com/api/v1/query/1234/results?limit=25" {
		t.Fatalf("url: %s", fd.seen[0])
	}
}
