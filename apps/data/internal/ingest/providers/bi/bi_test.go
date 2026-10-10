package bi

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fakeDoer answers every request with the same canned status+body, records
// every URL, and echoes the request headers it saw.
type fakeDoer struct {
	status  int
	body    string
	seen    []string
	headers []http.Header
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, r.URL.String())
	f.headers = append(f.headers, r.Header)
	return &http.Response{
		StatusCode: f.status,
		Body:       newReadCloser(f.body),
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

// Fixture: the real series shape — status envelope, sifat/date/value rows,
// string numbers.
const seriesFixture = `{"status":"success","data":[{"sifat":"FB","date":"2024-01-31","value":"6.00"},{"sifat":"FB","date":"2024-02-29","value":"6.25"},{"sifat":"FB","date":"2024-03-29","value":"-"}]}`

func TestSeriesMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: seriesFixture}
	c := newClient(fd, 0, "test-key")
	w := &captureWriter{}
	job := ingest.Job{Provider: "bi", Dataset: "series", Subject: "bi-rate", Mode: "poll"}
	res, err := (&fetcher{dataset: "series", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("series: %v", err)
	}
	if len(fd.seen) != 1 {
		t.Fatalf("requests: %d", len(fd.seen))
	}
	if fd.seen[0] != "https://api.bi.go.id/v1/public/seki/bi_rate" {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// The configured key rides in X-API-KEY.
	if got := fd.headers[0].Get("X-API-KEY"); got != "test-key" {
		t.Fatalf("X-API-KEY: %q", got)
	}
	if got := fd.headers[0].Get("User-Agent"); got != UA {
		t.Fatalf("User-Agent: %q", got)
	}

	if len(w.series) != 1 {
		t.Fatalf("series: %d", len(w.series))
	}
	sm := w.series[0]
	if sm.Metric != "bi_rate" || sm.SubjectKey != "country:id" || sm.Domain != "economy" || sm.Frequency != "daily" {
		t.Fatalf("series fields: %+v", sm)
	}
	if sm.Unit == nil || *sm.Unit != "percent" {
		t.Fatalf("unit: %v", sm.Unit)
	}
	if sm.ProviderSeriesID != "bi-rate" || sm.Provider != "bi" || sm.Source != "bi" {
		t.Fatalf("ids: %s/%s/%s", sm.ProviderSeriesID, sm.Provider, sm.Source)
	}
	if sm.CountryID == nil || *sm.CountryID != canon.MintID(canon.KindCountry, canon.CountryKey("ID")) {
		t.Fatalf("country: %v", sm.CountryID)
	}
	if sm.SchemaVersion != "v1" || sm.NormalizationVersion != "v1" {
		t.Fatalf("versions: %s/%s", sm.SchemaVersion, sm.NormalizationVersion)
	}

	// Two observations: the "-" value row skips (never 0).
	if res.RowsWritten != 2 || len(w.observations) != 2 {
		t.Fatalf("observations: res %d, captured %d", res.RowsWritten, len(w.observations))
	}
	first := w.observations[0]
	if first.Period != "2024-01-31" || first.Value == nil || *first.Value != 6.0 {
		t.Fatalf("first obs: %+v %v", first, first.Value)
	}
	if first.Source != "bi" || first.Revision != "latest" {
		t.Fatalf("source/revision: %s/%s", first.Source, first.Revision)
	}
	if got := res.Next["last_date"]; got != "2024-02-29" {
		t.Fatalf("cursor last_date: %v", got)
	}
}

func TestSeriesIncrementalCursor(t *testing.T) {
	fd := &fakeDoer{status: 200, body: seriesFixture}
	c := newClient(fd, 0, "k")
	job := ingest.Job{
		Provider: "bi", Dataset: "series", Subject: "bi-rate", Mode: "poll",
		Cursor: ingest.Cursor{"last_date": "2024-01-31"},
	}
	if _, err := (&fetcher{dataset: "series", client: c}).Fetch(context.Background(), job, &captureWriter{}); err != nil {
		t.Fatalf("series: %v", err)
	}
	// The Jan 31 row is at the cursor: skipped. Only Feb 29 writes.
}

func TestKursEndpoint(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `{"status":"success","data":[{"sifat":"FB","date":"2024-01-31","value":"15705"}]}`}
	c := newClient(fd, 0, "k")
	w := &captureWriter{}
	job := ingest.Job{Provider: "bi", Dataset: "series", Subject: "kurs:USD", Mode: "poll"}
	res, err := (&fetcher{dataset: "series", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("series: %v", err)
	}
	if fd.seen[0] != "https://api.bi.go.id/v1/public/seki/kurs_tengah/USD" {
		t.Fatalf("url: %s", fd.seen[0])
	}
	if res.RowsWritten != 1 || len(w.observations) != 1 {
		t.Fatalf("observations: %d", len(w.observations))
	}
	if w.series[0].Metric != "kurs_usd" || w.series[0].ProviderSeriesID != "kurs:USD" {
		t.Fatalf("series: %+v", w.series[0])
	}
	if *w.observations[0].Value != 15705.0 {
		t.Fatalf("value: %v", *w.observations[0].Value)
	}
}

func TestUnknownSubjectIsShapeError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "{}"}, 0, "k")
	job := ingest.Job{Provider: "bi", Dataset: "series", Subject: "nope", Mode: "poll"}
	_, err := (&fetcher{dataset: "series", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestEmptyKeyIsNoCredentials(t *testing.T) {
	// Endpoints whose config demands X-API-KEY fail at fetch start with no
	// key; no request is made.
	fd := &fakeDoer{status: 200, body: seriesFixture}
	c := newClient(fd, 0, "")
	job := ingest.Job{Provider: "bi", Dataset: "series", Subject: "bi-rate", Mode: "poll"}
	_, err := (&fetcher{dataset: "series", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "no-credentials" {
		t.Fatalf("want no-credentials HardError, got %v", err)
	}
	if len(fd.seen) != 0 {
		t.Fatalf("requests made without a key: %v", fd.seen)
	}
}

func TestErrorEnvelopeIsAPIError(t *testing.T) {
	fd := &fakeDoer{status: 403, body: `{"status":"error","message":"invalid api key"}`}
	c := newClient(fd, 0, "bad")
	job := ingest.Job{Provider: "bi", Dataset: "series", Subject: "bi-rate", Mode: "poll"}
	_, err := (&fetcher{dataset: "series", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "api-error" {
		t.Fatalf("want api-error HardError, got %v", err)
	}
}

func TestBadStatusIsAPIError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `{"status":"error","data":[]}`}
	c := newClient(fd, 0, "k")
	job := ingest.Job{Provider: "bi", Dataset: "series", Subject: "bi-rate", Mode: "poll"}
	_, err := (&fetcher{dataset: "series", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "api-error" {
		t.Fatalf("want api-error HardError, got %v", err)
	}
}

func TestBadDateIsShapeError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `{"status":"success","data":[{"sifat":"FB","date":"not-a-date","value":"6.00"}]}`}
	c := newClient(fd, 0, "k")
	job := ingest.Job{Provider: "bi", Dataset: "series", Subject: "bi-rate", Mode: "poll"}
	_, err := (&fetcher{dataset: "series", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestJobsRegistered(t *testing.T) {
	// With a key: both jobs enabled.
	m := NewModuleWithKey(nil, "k")
	if m.Provider() != "bi" {
		t.Fatalf("provider: %s", m.Provider())
	}
	if _, ok := m.Fetchers()["series"]; !ok {
		t.Fatalf("missing fetcher series")
	}
	jobs := m.Jobs()
	if len(jobs) != 2 {
		t.Fatalf("jobs: %d", len(jobs))
	}
	subjects := map[string]bool{}
	for _, j := range jobs {
		if j.Provider != "bi" || j.Dataset != "series" || j.Mode != "poll" ||
			j.Schedule != 24*60*60*1_000_000_000 || !j.Enabled {
			t.Fatalf("job spec: %+v", j)
		}
		subjects[j.Subject] = true
	}
	if !subjects["bi-rate"] || !subjects["kurs:USD"] {
		t.Fatalf("subjects: %v", subjects)
	}
	// Without a key: module still registers, jobs seed disabled.
	m2 := NewModuleWithKey(nil, "")
	for _, j := range m2.Jobs() {
		if j.Enabled {
			t.Fatalf("job enabled without a key: %+v", j)
		}
	}
}
