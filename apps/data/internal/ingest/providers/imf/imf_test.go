package imf

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

// Fixture trimmed from the real endpoint (shape-true, values real):
// {"values":{"NGDP_RPCH":{"SDN":{"1980":2.5,...},"AFG":{...}}}} — indicator
// -> country (ISO3) -> year -> value (null possible).
const ngdpFixture = `{"values":{"NGDP_RPCH":{"USA":{"2022":2.5,"2023":null,"2024":2.8,"2025":2.0},"IDN":{"2022":5.3,"2023":5.0}}}}`

const pcpipchFixture = `{"values":{"PCPIPCH":{"USA":{"2024":3.0,"2025":2.4}}}}`

func TestIndicatorsMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: ngdpFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	job := ingest.Job{Provider: "imf", Dataset: "indicators", Subject: "NGDP_RPCH", Mode: "poll"}
	res, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("indicators: %v", err)
	}
	// One request per indicator, countries pinned in the URL.
	if len(fd.seen) != 1 {
		t.Fatalf("requests: %d (%v)", len(fd.seen), fd.seen)
	}
	if !strings.HasPrefix(fd.seen[0], "https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/USA,IDN") {
		t.Fatalf("url: %s", fd.seen[0])
	}

	// One series per (indicator, mapped country): USA->US, IDN->ID.
	if len(w.series) != 2 {
		t.Fatalf("series: %d", len(w.series))
	}
	wantUS := canon.MintID(canon.KindSeries, canon.SeriesKey("economy", "ngdp_rpch", "country:us"))
	wantID := canon.MintID(canon.KindSeries, canon.SeriesKey("economy", "ngdp_rpch", "country:id"))
	bySubject := map[string]canon.SeriesMeta{}
	for _, sm := range w.series {
		bySubject[sm.SubjectKey] = sm
	}
	if bySubject["country:us"].SeriesID != wantUS || bySubject["country:id"].SeriesID != wantID {
		t.Fatalf("series ids: %s / %s", bySubject["country:us"].SeriesID, bySubject["country:id"].SeriesID)
	}
	usMeta := bySubject["country:us"]
	if usMeta.Frequency != "annual" || usMeta.Domain != "economy" || usMeta.Metric != "ngdp_rpch" {
		t.Fatalf("series fields: %+v", usMeta)
	}
	if usMeta.ProviderSeriesID != "NGDP_RPCH:US" {
		t.Fatalf("provider series id: %s", usMeta.ProviderSeriesID)
	}
	if usMeta.CountryID == nil || *usMeta.CountryID != canon.MintID(canon.KindCountry, canon.CountryKey("US")) {
		t.Fatalf("country: %v", usMeta.CountryID)
	}
	if usMeta.SchemaVersion != "v1" || usMeta.NormalizationVersion != "v1" {
		t.Fatalf("versions: %s/%s", usMeta.SchemaVersion, usMeta.NormalizationVersion)
	}

	// Values: US 2022/2024/2025 write, US 2023 (null) skips; ID 2022/2023
	// write. 5 observations total, none with a nil or faked value.
	if res.RowsWritten != 5 || len(w.observations) != 5 {
		t.Fatalf("observations: res %d, captured %d", res.RowsWritten, len(w.observations))
	}
	for _, o := range w.observations {
		if o.Value == nil {
			t.Fatalf("nil value written: %+v", o)
		}
		if o.Period == "2023" && o.SeriesID == wantUS {
			t.Fatalf("null-value period written: %+v", o)
		}
		if o.Source != "imf" || o.Revision != "latest" {
			t.Fatalf("source/revision: %s/%s", o.Source, o.Revision)
		}
		if o.ObservedAt.Month() != 1 || o.ObservedAt.Day() != 1 {
			t.Fatalf("observed_at not Jan 1: %v", o.ObservedAt)
		}
	}
	// The cursor pins the last observed year per indicator.
	ly := res.Next["last_year"].(map[string]any)
	if ly["NGDP_RPCH"] != 2025 {
		t.Fatalf("cursor last_year: %v", ly)
	}
}

func TestIndicatorsMultipleAndCursor(t *testing.T) {
	// Two indicators, one request each, in subject order. The NGDP cursor
	// (last_year 2024) is applied client-side by skipping years <= cursor:
	// US 2022/2023/2024 drop out, US 2025 and the unmetered PCPIPCH years
	// write.
	seq := &seqDoer{status: 200, bodies: []string{ngdpFixture, pcpipchFixture}}
	c := newClient(seq, 0)
	w := &captureWriter{}
	job := ingest.Job{
		Provider: "imf", Dataset: "indicators", Subject: "NGDP_RPCH,PCPIPCH", Mode: "poll",
		Cursor: ingest.Cursor{"last_year": map[string]any{"NGDP_RPCH": 2024}},
	}
	res, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("indicators: %v", err)
	}
	// NGDP: US 2025 (1) + ID none (2022/2023 <= cursor). PCPIPCH: US 2024,
	// US 2025 (2). Three observations, none from 2022.
	if res.RowsWritten != 3 || len(w.observations) != 3 {
		t.Fatalf("observations: res %d, captured %d", res.RowsWritten, len(w.observations))
	}
	counts := map[string]int{}
	for _, o := range w.observations {
		counts[o.Period]++
	}
	if counts["2022"] != 0 || counts["2023"] != 0 {
		t.Fatalf("cursor years written: %v", counts)
	}
	if counts["2024"] != 1 || counts["2025"] != 2 {
		t.Fatalf("period counts: %v", counts)
	}
	// Series: NGDP US/ID + PCPIPCH US (ID absent from the PCPIPCH fixture).
	if len(w.series) != 3 {
		t.Fatalf("series: %d", len(w.series))
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

func TestEmptySubjectIsShapeError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "{}"}, 0)
	job := ingest.Job{Provider: "imf", Dataset: "indicators", Subject: "", Mode: "poll"}
	_, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestErrorEnvelopeIsAPIError(t *testing.T) {
	// Real DataMapper envelope for an unknown indicator (HTTP 404).
	fd := &fakeDoer{status: 404, body: `{"error":true,"errors":"Invalid indicator"}`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "imf", Dataset: "indicators", Subject: "NOPE_1", Mode: "poll"}
	_, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "api-error" {
		t.Fatalf("want api-error HardError, got %v", err)
	}
}

func TestStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 429, body: `<html>blocked</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "imf", Dataset: "indicators", Subject: "NGDP_RPCH", Mode: "poll"}
	_, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 429 {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestNonJSONIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: `<html>blocked</html>`}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "imf", Dataset: "indicators", Subject: "NGDP_RPCH", Mode: "poll"}
	_, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestUnmappedCountrySkipped(t *testing.T) {
	// A country spelling outside the ISO3->ISO2 map mints no series.
	fd := &fakeDoer{status: 200, body: `{"values":{"NGDP_RPCH":{"ZZZ":{"2024":1.5},"USA":{"2024":2.0}}}}`}
	c := newClient(fd, 0)
	w := &captureWriter{}
	job := ingest.Job{Provider: "imf", Dataset: "indicators", Subject: "NGDP_RPCH", Mode: "poll"}
	if _, err := (&fetcher{dataset: "indicators", client: c}).Fetch(context.Background(), job, w); err != nil {
		t.Fatalf("indicators: %v", err)
	}
	if len(w.series) != 1 || len(w.observations) != 1 {
		t.Fatalf("series/obs: %d/%d", len(w.series), len(w.observations))
	}
}

func TestParseSubjects(t *testing.T) {
	got := parseSubjects(" NGDP_RPCH, ,PCPIPCH,NGDP_RPCH")
	if len(got) != 2 || got[0] != "NGDP_RPCH" || got[1] != "PCPIPCH" {
		t.Fatalf("parseSubjects: %v", got)
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "imf" {
		t.Fatalf("provider: %s", m.Provider())
	}
	fetchers := m.Fetchers()
	for _, ds := range []string{"indicators"} {
		if _, ok := fetchers[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
	jobs := m.Jobs()
	if len(jobs) != 1 {
		t.Fatalf("jobs: %d", len(jobs))
	}
	j := jobs[0]
	if j.Provider != "imf" || j.Dataset != "indicators" || j.Subject != "NGDP_RPCH,PCPIPCH,LUR" ||
		j.Mode != "poll" || j.Schedule != 24*60*60*1_000_000_000 || !j.Enabled {
		t.Fatalf("job spec: %+v", j)
	}
}
