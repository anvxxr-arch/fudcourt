package bps

import (
	"context"
	"net/http"
	"strings"
	"testing"

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
func (w *spyWriter) WriteLiquidations(ctx context.Context, rows []canon.Liquidation) (int, int, error) {
	return 0, 0, w.err
}
func (w *spyWriter) WriteOptionQuotes(ctx context.Context, rows []canon.OptionQuote) (int, int, error) {
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

// Fixture: the real dynamicdata shape — status, label vocabularies (var with
// unit, tphr period labels), and datacontent keyed by period id with
// string-number values.
const varDataFixture = `{"status":"OK","datacontent":{"113":"2.88","114":"3.05","115":"-"},"var":[{"val":"347","label":"Inflation (Year on Year)","unit":"%"}],"turvar":[{"val":"4","label":"Year on Year"}],"tphr":[{"val":"113","label":"2023"},{"val":"114","label":"2024"},{"val":"115","label":"2025"}]}`

func TestVarDataMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: varDataFixture}
	c := newClient(fd, 0, "key", "id")
	w := &captureWriter{}
	job := ingest.Job{Provider: "bps", Dataset: "var-data", Subject: "var/347", Mode: "poll"}
	res, err := (&fetcher{dataset: "var-data", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("var-data: %v", err)
	}
	if len(fd.seen) != 1 {
		t.Fatalf("requests: %d", len(fd.seen))
	}
	if !strings.HasPrefix(fd.seen[0], "https://webapi.bps.go.id/v1/api/list/model/data/lang/eng/domain/0000/key/key/id/id/var/347/turvar/4/verunit/9") {
		t.Fatalf("url: %s", fd.seen[0])
	}

	if len(w.series) != 1 {
		t.Fatalf("series: %d", len(w.series))
	}
	sm := w.series[0]
	if sm.Metric != "inflation_year_on_year" || sm.SubjectKey != "country:id" || sm.Domain != "economy" {
		t.Fatalf("series fields: %+v", sm)
	}
	if sm.Unit == nil || *sm.Unit != "%" {
		t.Fatalf("unit: %v", sm.Unit)
	}
	if sm.ProviderSeriesID != "var/347" || sm.Provider != "bps" || sm.Source != "bps" {
		t.Fatalf("ids: %s/%s/%s", sm.ProviderSeriesID, sm.Provider, sm.Source)
	}
	if sm.CountryID == nil || *sm.CountryID != canon.MintID(canon.KindCountry, canon.CountryKey("ID")) {
		t.Fatalf("country: %v", sm.CountryID)
	}
	if sm.SchemaVersion != "v1" || sm.NormalizationVersion != "v1" {
		t.Fatalf("versions: %s/%s", sm.SchemaVersion, sm.NormalizationVersion)
	}

	// Two observations: period 115's "-" skips (never 0).
	if res.RowsWritten != 2 || len(w.observations) != 2 {
		t.Fatalf("observations: res %d, captured %d", res.RowsWritten, len(w.observations))
	}
	first := w.observations[0]
	if first.Period != "2023" || first.Value == nil || *first.Value != 2.88 {
		t.Fatalf("first obs: %+v %v", first, first.Value)
	}
	if first.ObservedAt.Year() != 2023 || first.ObservedAt.Month() != 1 || first.ObservedAt.Day() != 1 {
		t.Fatalf("observed_at: %v", first.ObservedAt)
	}
	if w.observations[1].Period != "2024" || *w.observations[1].Value != 3.05 {
		t.Fatalf("second obs: %+v", w.observations[1])
	}
	// Cursor pins the last stored period id per var.
	lp := res.Next["last_period"].(map[string]any)
	if lp["347"] != "114" {
		t.Fatalf("cursor last_period: %v", lp)
	}
}

func TestVarDataIncrementalCursor(t *testing.T) {
	fd := &fakeDoer{status: 200, body: varDataFixture}
	c := newClient(fd, 0, "key", "id")
	job := ingest.Job{
		Provider: "bps", Dataset: "var-data", Subject: "var/347", Mode: "poll",
		Cursor: ingest.Cursor{"last_period": map[string]any{"347": "113"}},
	}
	if _, err := (&fetcher{dataset: "var-data", client: c}).Fetch(context.Background(), job, &captureWriter{}); err != nil {
		t.Fatalf("var-data: %v", err)
	}
	// Period 113 is at the cursor: skipped. Only 114 writes.
	if len(fd.seen) != 1 {
		t.Fatalf("requests: %d", len(fd.seen))
	}
}

func TestEmptyKeysAreNoCredentials(t *testing.T) {
	fd := &fakeDoer{status: 200, body: varDataFixture}
	c := newClient(fd, 0, "", "id")
	job := ingest.Job{Provider: "bps", Dataset: "var-data", Subject: "var/347", Mode: "poll"}
	_, err := (&fetcher{dataset: "var-data", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "no-credentials" {
		t.Fatalf("want no-credentials HardError, got %v", err)
	}
	if len(fd.seen) != 0 {
		t.Fatalf("requests made without keys: %v", fd.seen)
	}
	// Half a key pair is still no credentials.
	c2 := newClient(&fakeDoer{status: 200, body: varDataFixture}, 0, "key", "")
	if _, err := (&fetcher{dataset: "var-data", client: c2}).Fetch(context.Background(), job, &captureWriter{}); err == nil {
		t.Fatalf("expected no-credentials for half a key pair")
	}
}

func TestBadSubjectIsShapeError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "{}"}, 0, "k", "i")
	job := ingest.Job{Provider: "bps", Dataset: "var-data", Subject: "347", Mode: "poll"}
	_, err := (&fetcher{dataset: "var-data", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestErrorEnvelopeIsAPIError(t *testing.T) {
	// BPS answers bad keys with the Error envelope.
	fd := &fakeDoer{status: 403, body: `{"status":"Error","message":"Wrong key or user id"}`}
	c := newClient(fd, 0, "k", "i")
	job := ingest.Job{Provider: "bps", Dataset: "var-data", Subject: "var/347", Mode: "poll"}
	_, err := (&fetcher{dataset: "var-data", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "api-error" {
		t.Fatalf("want api-error HardError, got %v", err)
	}
}

func TestWAFBlockIsStatusError(t *testing.T) {
	// The BPS perimeter WAF answers some requests with HTML (observed live).
	fd := &fakeDoer{status: 200, body: `<!doctype html><head><title>Perimeter WAF Block</title>`}
	c := newClient(fd, 0, "k", "i")
	job := ingest.Job{Provider: "bps", Dataset: "var-data", Subject: "var/347", Mode: "poll"}
	_, err := (&fetcher{dataset: "var-data", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestJobsRegistered(t *testing.T) {
	// With keys: job enabled.
	m := NewModuleWithKeys(nil, "k", "i")
	if m.Provider() != "bps" {
		t.Fatalf("provider: %s", m.Provider())
	}
	if _, ok := m.Fetchers()["var-data"]; !ok {
		t.Fatalf("missing fetcher var-data")
	}
	jobs := m.Jobs()
	if len(jobs) != 1 || !jobs[0].Enabled || jobs[0].Subject != "var/347" ||
		jobs[0].Schedule != 24*60*60*1_000_000_000 {
		t.Fatalf("jobs with keys: %+v", jobs)
	}
	// Without keys: module still registers, job seeds disabled.
	m2 := NewModuleWithKeys(nil, "", "")
	jobs2 := m2.Jobs()
	if len(jobs2) != 1 || jobs2[0].Enabled {
		t.Fatalf("jobs without keys: %+v", jobs2)
	}
}
