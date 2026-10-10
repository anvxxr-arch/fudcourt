package worldbank

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

// Fixtures trimmed from the real endpoint (shape-true, values real).
// country.id carries the ISO2 ("ID"/"US"); countryiso3code the ISO3.
const gdpPageFixture = `[{"page":1,"pages":1,"per_page":20000,"total":5,"sourceid":"2","lastupdated":"2026-10-08"},
[{"indicator":{"id":"NY.GDP.MKTP.CD","value":"GDP (current US$)"},"country":{"id":"ID","value":"Indonesia"},"countryiso3code":"IDN","date":"2025","value":3956067115771.63,"unit":"","obs_status":"","decimal":0},
{"indicator":{"id":"NY.GDP.MKTP.CD","value":"GDP (current US$)"},"country":{"id":"US","value":"United States"},"countryiso3code":"USA","date":"2024","value":27360935000000.0,"unit":"","obs_status":"","decimal":0},
{"indicator":{"id":"NY.GDP.MKTP.CD","value":"GDP (current US$)"},"country":{"id":"US","value":"United States"},"countryiso3code":"USA","date":"2023","value":null,"unit":"","obs_status":"","decimal":0},
{"indicator":{"id":"NY.GDP.MKTP.CD","value":"GDP (current US$)"},"country":{"id":"1A","value":"Arab World"},"countryiso3code":"ARB","date":"2023","value":4213456789.0,"unit":"","obs_status":"","decimal":0},
{"indicator":{"id":"NY.GDP.MKTP.CD","value":"GDP (current US$)"},"country":{"id":"ID","value":"Indonesia"},"countryiso3code":"IDN","date":"2022","value":3350000000000.0,"unit":"","obs_status":"","decimal":0}]]`

func TestIndicatorsMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: gdpPageFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	job := ingest.Job{Provider: "worldbank", Dataset: "indicators", Subject: "indicator:NY.GDP.MKTP.CD", Mode: "poll"}
	res, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("indicators: %v", err)
	}
	// One request per seed country (page 1 declares pages=1).
	if len(fd.seen) != 2 {
		t.Fatalf("requests: %d (%v)", len(fd.seen), fd.seen)
	}
	if !strings.HasPrefix(fd.seen[0], "https://api.worldbank.org/v2/country/ID/indicator/NY.GDP.MKTP.CD?format=json&per_page=20000&page=1") {
		t.Fatalf("url: %s", fd.seen[0])
	}

	// One series per (indicator, seed country) that had rows.
	if len(w.series) != 2 {
		t.Fatalf("series: %d", len(w.series))
	}
	metric := "ny_gdp_mktp_cd"
	wantIN := canon.MintID(canon.KindSeries, canon.SeriesKey("economy", metric, "country:id"))
	wantUS := canon.MintID(canon.KindSeries, canon.SeriesKey("economy", metric, "country:us"))
	bySubject := map[string]canon.SeriesMeta{}
	for _, sm := range w.series {
		bySubject[sm.SubjectKey] = sm
	}
	inMeta := bySubject["country:id"]
	usMeta := bySubject["country:us"]
	if inMeta.SeriesID != wantIN || usMeta.SeriesID != wantUS {
		t.Fatalf("series ids: %s / %s", inMeta.SeriesID, usMeta.SeriesID)
	}
	if inMeta.Frequency != "annual" || inMeta.Domain != "economy" || inMeta.Metric != metric {
		t.Fatalf("series fields: %+v", inMeta)
	}
	if inMeta.ProviderSeriesID != "NY.GDP.MKTP.CD:ID" || usMeta.ProviderSeriesID != "NY.GDP.MKTP.CD:US" {
		t.Fatalf("provider series ids: %s / %s", inMeta.ProviderSeriesID, usMeta.ProviderSeriesID)
	}
	if inMeta.Title == nil || *inMeta.Title != "GDP (current US$)" {
		t.Fatalf("title: %v", inMeta.Title)
	}
	if inMeta.CountryID == nil || *inMeta.CountryID != canon.MintID(canon.KindCountry, canon.CountryKey("ID")) {
		t.Fatalf("country: %v", inMeta.CountryID)
	}
	if inMeta.SchemaVersion != "v1" || inMeta.NormalizationVersion != "v1" {
		t.Fatalf("versions: %s/%s", inMeta.SchemaVersion, inMeta.NormalizationVersion)
	}

	// Rows: ID 2025, ID 2022, US 2024 write; US 2023 (null value) and the
	// "1A" Arab World aggregate (non-ISO2 country.id) skip.
	if res.RowsWritten != 3 || len(w.observations) != 3 {
		t.Fatalf("observations: res %d, captured %d", res.RowsWritten, len(w.observations))
	}
	for _, o := range w.observations {
		if o.Value == nil {
			t.Fatalf("nil value written: %+v", o)
		}
		if o.Period != "2025" && o.Period != "2024" && o.Period != "2022" {
			t.Fatalf("unexpected period written: %s", o.Period)
		}
		if o.Source != "worldbank" || o.Revision != "latest" {
			t.Fatalf("source/revision: %s/%s", o.Source, o.Revision)
		}
		if o.ObservedAt.Month() != 1 || o.ObservedAt.Day() != 1 {
			t.Fatalf("observed_at not Jan 1: %v", o.ObservedAt)
		}
	}

	// The cursor pins the last observed year per ISO2.
	lp := res.Next["last_year"].(map[string]any)
	if lp["ID"] != 2025 || lp["US"] != 2024 {
		t.Fatalf("cursor last_year: %v", lp)
	}
}

func TestIndicatorsIncrementalCursor(t *testing.T) {
	fd := &fakeDoer{status: 200, body: gdpPageFixture}
	c := newClient(fd, 0)
	job := ingest.Job{
		Provider: "worldbank", Dataset: "indicators", Subject: "indicator:NY.GDP.MKTP.CD", Mode: "poll",
		Cursor: ingest.Cursor{"last_year": map[string]any{"ID": 2020, "US": 2020}},
	}
	if _, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, &captureWriter{}); err != nil {
		t.Fatalf("indicators: %v", err)
	}
	// The date=YYYY:YYYY+20 bounded range must appear in both requests.
	if !strings.Contains(fd.seen[0], "date=2020:2040") {
		t.Fatalf("ID url: %s", fd.seen[0])
	}
	if !strings.Contains(fd.seen[1], "date=2020:2040") {
		t.Fatalf("US url: %s", fd.seen[1])
	}
}

func TestIndicatorsPagingWalk(t *testing.T) {
	page1 := `[{"page":1,"pages":2,"per_page":20000,"total":4},` +
		`[{"indicator":{"id":"NY.GDP.MKTP.CD","value":"GDP (current US$)"},"country":{"id":"IN","value":"India"},"countryiso3code":"IND","date":"2025","value":1.0}]]`
	page2 := `[{"page":2,"pages":2,"per_page":20000,"total":4},` +
		`[{"indicator":{"id":"NY.GDP.MKTP.CD","value":"GDP (current US$)"},"country":{"id":"IN","value":"India"},"countryiso3code":"IND","date":"2024","value":2.0}]]`
	fd := &seqDoer{status: 200, bodies: []string{page1, page2, page1, page2}}
	c := newClient(fd, 0)
	w := &captureWriter{}
	job := ingest.Job{Provider: "worldbank", Dataset: "indicators", Subject: "indicator:NY.GDP.MKTP.CD", Mode: "poll"}
	if _, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("indicators: %v", err)
	}
	if len(fd.seen) != 4 {
		t.Fatalf("requests: %d (%v)", len(fd.seen), fd.seen)
	}
	if !strings.HasSuffix(fd.seen[1], "page=2") {
		t.Fatalf("page2 url: %s", fd.seen[1])
	}
	// Only the IN rows are in scope for series minting (US page rows are
	// duplicates of the IN ones here): one series, two observations.
	if len(w.series) != 1 || len(w.observations) != 2 {
		t.Fatalf("series/obs: %d/%d", len(w.series), len(w.observations))
	}
}

// seqDoer answers consecutive requests from a canned list.
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

func TestBadSubjectIsShapeError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "[]"}, 0)
	job := ingest.Job{Provider: "worldbank", Dataset: "indicators", Subject: "NY.GDP.MKTP.CD", Mode: "poll"}
	_, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 429, body: `<html>blocked</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "worldbank", Dataset: "indicators", Subject: "indicator:NY.GDP.MKTP.CD", Mode: "poll"}
	_, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 429 {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestNonJSONIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `<html>blocked</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "worldbank", Dataset: "indicators", Subject: "indicator:NY.GDP.MKTP.CD", Mode: "poll"}
	_, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestSourcesListing(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `[{"page":1,"pages":1,"per_page":50,"total":2},[{"id":"2","value":"World Development Indicators"},{"id":"15","value":"Global Economic Prospects"}]]`}
	c := newClient(fd, 0)
	rows, err := c.sources(context.Background())
	if err != nil {
		t.Fatalf("sources: %v", err)
	}
	if len(rows) != 2 || rows[0].ID != "2" || rows[0].Value != "World Development Indicators" {
		t.Fatalf("sources: %+v", rows)
	}
}

func TestISO2Validation(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want bool
	}{{"IN", true}, {"us", true}, {"1A", false}, {"IND", false}, {"", false}} {
		if _, ok := iso2Of(tc.in); ok != tc.want {
			t.Fatalf("iso2Of(%q) ok=%v, want %v", tc.in, ok, tc.want)
		}
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "worldbank" {
		t.Fatalf("provider: %s", m.Provider())
	}
	fetchers := m.Fetchers()
	for _, ds := range []string{"indicators"} {
		if _, ok := fetchers[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
	jobs := m.Jobs()
	if len(jobs) != 3 {
		t.Fatalf("jobs: %d", len(jobs))
	}
	want := map[string]bool{"indicator:NY.GDP.MKTP.CD": false, "indicator:FP.CPI.TOTL": false, "indicator:SL.UEM.TOTL.ZS": false}
	for _, j := range jobs {
		if j.Provider != "worldbank" || j.Dataset != "indicators" || j.Mode != "poll" ||
			j.Schedule != 24*60*60*1_000_000_000 || !j.Enabled {
			t.Fatalf("job spec: %+v", j)
		}
		if _, ok := want[j.Subject]; !ok {
			t.Fatalf("unexpected subject: %s", j.Subject)
		}
		want[j.Subject] = true
	}
	for s, seen := range want {
		if !seen {
			t.Fatalf("missing seed job for %s", s)
		}
	}
}
