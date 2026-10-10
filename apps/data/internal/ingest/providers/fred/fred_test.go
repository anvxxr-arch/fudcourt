package fred

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fakeDoer answers every request with the same canned status+body and records
// every URL it saw.
type fakeDoer struct {
	status int
	body   string
	seen   []string
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, r.URL.String())
	return &http.Response{
		StatusCode: f.status,
		Body:       newReadCloser(f.body),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

// seqDoer answers consecutive requests from a canned list (meta call first,
// then one observations call per series id) and records every URL.
type seqDoer struct {
	bodies []string
	status int
	seen   []string
}

func (f *seqDoer) Do(r *http.Request) (*http.Response, error) {
	i := len(f.seen)
	f.seen = append(f.seen, r.URL.String())
	body := ""
	if i < len(f.bodies) {
		body = f.bodies[i]
	}
	return &http.Response{
		StatusCode: f.status,
		Body:       newReadCloser(body),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
	}, nil
}

// captureWriter spies on the writes and keeps the rows for identity checks.
type captureWriter struct {
	spyWriter
	series       []canon.SeriesMeta
	observations []canon.Observation
}

func (w *captureWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	w.series = append(w.series, rows...)
	return w.spyWriter.UpsertSeries(ctx, rows)
}

func (w *captureWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	w.observations = append(w.observations, rows...)
	return w.spyWriter.WriteObservations(ctx, rows)
}

// spyWriter implements the rest of the canon.Writer surface: every family
// writes nothing but observations, so those methods only carry the injected
// error.
type spyWriter struct {
	err error
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
	return len(rows), w.err
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
	return len(rows), 0, w.err
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
	return 0, w.err
}

// newReadCloser is a tiny io.ReadCloser over a string.
func newReadCloser(s string) ioReadCloser { return ioReadCloser{strings.NewReader(s)} }

type ioReadCloser struct{ *strings.Reader }

func (ioReadCloser) Close() error { return nil }

// Fixtures trimmed from the real endpoints (shape-true, values real). FRED
// without a key answers the error envelope in errorFixture.
const seriesFixture = `{"seriess":[{"id":"CPIAUCSL","title":"Consumer Price Index for All Urban Consumers: All Items in U.S. City Average","units":"Index 1982-84=100","frequency":"Monthly","seasonal_adjustment":"Not Seasonally Adjusted","observation_start":"1913-01-01","observation_end":"2026-09-01"},
{"id":"UNRATE","title":"Unemployment Rate","units":"Percent","frequency":"Monthly","observation_start":"1948-01-01","observation_end":"2026-09-01"}]}`

const observationsFixture = `{"realtime_start":"2026-10-09","realtime_end":"2026-10-09","observation_start":"2024-01-01","units":"Index 1982-84=100","observations":[
{"realtime_start":"2026-10-09","realtime_end":"2026-10-09","date":"2024-01-01","value":"310.332"},
{"realtime_start":"2026-10-09","realtime_end":"2026-10-09","date":"2024-02-01","value":"." },
{"realtime_start":"2026-10-09","realtime_end":"2026-10-09","date":"2024-03-01","value":"312.332"}]}`

const errorFixture = `{"error_code":400,"error_message":"Bad Request.  Variable api_key is not set."}`

func TestObservationsMapping(t *testing.T) {
	// meta call, then one observations call per subject id (deduped: UNRATE
	// appears twice in the subject but fetches once).
	fd := &seqDoer{status: 200, bodies: []string{seriesFixture, observationsFixture, observationsFixture}}
	c := newClient(fd, 0, "test-key")
	w := &captureWriter{}
	job := ingest.Job{
		Provider: "fred", Dataset: "observations", Subject: "CPIAUCSL,UNRATE,UNRATE", Mode: "poll",
	}
	res, err := (&fetcher{dataset: "observations", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("observations: %v", err)
	}
	if len(fd.seen) != 3 {
		t.Fatalf("requests: %d (%v)", len(fd.seen), fd.seen)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.stlouisfed.org/fred/series?series_id=CPIAUCSL,UNRATE&api_key=test-key&file_type=json") {
		t.Fatalf("meta url: %s", fd.seen[0])
	}
	if !strings.Contains(fd.seen[1], "/fred/series/observations?series_id=CPIAUCSL&file_type=json&observation_start=") {
		t.Fatalf("obs url: %s", fd.seen[1])
	}

	// Two series rows upserted, both economy/country:us with unit+frequency.
	if len(w.series) != 2 {
		t.Fatalf("series upserts: %d", len(w.series))
	}
	wantCPI := canon.MintID(canon.KindSeries, canon.SeriesKey("economy", "consumer_price_index_for_all_urban_consumers_all_items_in_u_s_city_average", "country:us"))
	var cpiMeta canon.SeriesMeta
	for _, sm := range w.series {
		if sm.ProviderSeriesID == "CPIAUCSL" {
			cpiMeta = sm
		}
	}
	if cpiMeta.SeriesID != wantCPI {
		t.Fatalf("cpi series id: %s, want %s", cpiMeta.SeriesID, wantCPI)
	}
	if cpiMeta.Domain != "economy" || cpiMeta.SubjectKey != "country:us" {
		t.Fatalf("cpi domain/subject: %s/%s", cpiMeta.Domain, cpiMeta.SubjectKey)
	}
	if cpiMeta.Unit == nil || *cpiMeta.Unit != "Index 1982-84=100" || cpiMeta.Frequency != "monthly" {
		t.Fatalf("cpi unit/frequency: %v/%s", cpiMeta.Unit, cpiMeta.Frequency)
	}
	if cpiMeta.CountryID == nil || *cpiMeta.CountryID != canon.MintID(canon.KindCountry, canon.CountryKey("US")) {
		t.Fatalf("cpi country: %v", cpiMeta.CountryID)
	}
	if cpiMeta.SchemaVersion != "v1" || cpiMeta.NormalizationVersion != "v1" || cpiMeta.Revision != "latest" {
		t.Fatalf("cpi versions: %s/%s/%s", cpiMeta.SchemaVersion, cpiMeta.NormalizationVersion, cpiMeta.Revision)
	}

	// 3 fixture rows per series x 2 series = 6, minus the "." row in each =
	// 4 written; missing values never become 0 rows.
	if res.RowsWritten != 4 || len(w.observations) != 4 {
		t.Fatalf("observations: res %d, captured %d", res.RowsWritten, len(w.observations))
	}
	for _, o := range w.observations {
		if o.Value == nil {
			t.Fatalf("nil value written: %+v", o)
		}
		if o.Period == "2024-02-01" {
			t.Fatalf("missing-value period written: %+v", o)
		}
		if o.Source != "fred" || o.Revision != "latest" {
			t.Fatalf("observation source/revision: %s/%s", o.Source, o.Revision)
		}
	}
	first := w.observations[0]
	if first.ObservedAt != time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC) {
		t.Fatalf("observed_at: %v", first.ObservedAt)
	}
	if first.Value == nil || *first.Value != 310.332 {
		t.Fatalf("value: %v", first.Value)
	}

	// The cursor pins the last observed period per series id.
	if got := res.Next["last_period"].(map[string]any)["CPIAUCSL"]; got != "2024-03-01" {
		t.Fatalf("cursor last_period CPIAUCSL: %v", got)
	}
}

func TestObservationsIncrementalCursor(t *testing.T) {
	fd := &seqDoer{status: 200, bodies: []string{seriesFixture, observationsFixture, observationsFixture}}
	c := newClient(fd, 0, "test-key")
	w := &captureWriter{}
	job := ingest.Job{
		Provider: "fred", Dataset: "observations", Subject: "CPIAUCSL,UNRATE", Mode: "poll",
		Cursor: ingest.Cursor{"last_period": map[string]any{"CPIAUCSL": "2024-01-01", "UNRATE": "2023-06-01"}},
	}
	if _, err := (&fetcher{dataset: "observations", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("observations: %v", err)
	}
	if !strings.Contains(fd.seen[1], "observation_start=2024-01-01") {
		t.Fatalf("CPIAUCSL start: %s", fd.seen[1])
	}
	if !strings.Contains(fd.seen[2], "observation_start=2023-06-01") {
		t.Fatalf("UNRATE start: %s", fd.seen[2])
	}
}

func TestEmptyKeyIsNoCredentials(t *testing.T) {
	fd := &fakeDoer{status: 200, body: seriesFixture}
	c := newClient(fd, 0, "")
	job := ingest.Job{Provider: "fred", Dataset: "observations", Subject: "CPIAUCSL", Mode: "poll"}
	_, err := (&fetcher{dataset: "observations", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "no-credentials" {
		t.Fatalf("want no-credentials HardError, got %v", err)
	}
	// Nothing was fetched and nothing written: the engine journals the
	// failure and the job stays scheduled.
	if len(fd.seen) != 0 {
		t.Fatalf("requests made without a key: %v", fd.seen)
	}
}

func TestMissingSubjectIsShapeError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "{}"}, 0, "k")
	job := ingest.Job{Provider: "fred", Dataset: "observations", Subject: "", Mode: "poll"}
	_, err := (&fetcher{dataset: "observations", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestErrorEnvelopeIsAPIError(t *testing.T) {
	// The real no-key response: a 400 with FRED's error envelope.
	fd := &fakeDoer{status: 400, body: errorFixture}
	c := newClient(fd, 0, "bad-key")
	job := ingest.Job{Provider: "fred", Dataset: "observations", Subject: "CPIAUCSL", Mode: "poll"}
	_, err := (&fetcher{dataset: "observations", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "api-error" || he.Status != 400 {
		t.Fatalf("want api-error HardError, got %v", err)
	}
}

func TestStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 429, body: `{"error_code":429,"error_message":"Too Many Requests"}`}
	c := newClient(fd, 0, "k")
	job := ingest.Job{Provider: "fred", Dataset: "observations", Subject: "CPIAUCSL", Mode: "poll"}
	_, err := (&fetcher{dataset: "observations", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "api-error" || he.Status != 429 {
		t.Fatalf("want api-error HardError, got %v", err)
	}
}

func TestUnknownDatasetIsShapeError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "{}"}, 0, "k")
	_, err := (&fetcher{dataset: "nope", client: c}).Fetch(
		context.Background(), ingest.Job{Provider: "fred", Dataset: "nope"}, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestFrequencyMapping(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Monthly", "monthly"}, {"Quarterly", "quarterly"}, {"Weekly", "weekly"},
		{"Daily", "daily"}, {"Annual", "annual"}, {"Semiannual", "semiannual"},
	} {
		if got := frequencyFromFRED(tc.in); got != tc.want {
			t.Fatalf("frequency %q: got %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestParseSubjects(t *testing.T) {
	got := parseSubjects(" CPIAUCSL, ,UNRATE,CPIAUCSL")
	if len(got) != 2 || got[0] != "CPIAUCSL" || got[1] != "UNRATE" {
		t.Fatalf("parseSubjects: %v", got)
	}
}

func TestSlug(t *testing.T) {
	if got := slug("Unemployment Rate"); got != "unemployment_rate" {
		t.Fatalf("slug: %q", got)
	}
	if got := slug("  --  "); got != "" {
		t.Fatalf("empty slug: %q", got)
	}
	// A title that yields nothing falls back to the series id.
	sm := seriesMeta(seriesMetaRow{ID: "GDP", Title: ""})
	if sm.Metric != "gdp" {
		t.Fatalf("fallback metric: %q", sm.Metric)
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModuleWithKey(nil, "k")
	if m.Provider() != "fred" {
		t.Fatalf("provider: %s", m.Provider())
	}
	fetchers := m.Fetchers()
	for _, ds := range []string{"observations"} {
		if _, ok := fetchers[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
	jobs := m.Jobs()
	if len(jobs) != 1 {
		t.Fatalf("jobs: %d", len(jobs))
	}
	j := jobs[0]
	if j.Provider != "fred" || j.Dataset != "observations" ||
		j.Subject != "CPIAUCSL,FEDFUNDS,GDP,UNRATE" ||
		j.Mode != "poll" || j.Schedule != 24*time.Hour || !j.Enabled {
		t.Fatalf("job spec: %+v", j)
	}
}
