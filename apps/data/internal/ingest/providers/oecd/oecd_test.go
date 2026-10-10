package oecd

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
		Header:     http.Header{"Content-Type": []string{"text/csv"}},
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

// Fixture: the real csvfilewithlabels header shape captured from
// DSD_PDB@DF_PDB (34 columns, id + label pairs), trimmed to the columns the
// parser maps plus a few distractors. Column order and the label-pair
// pattern are real; values are real-shape.
const csvFixture = "STRUCTURE,STRUCTURE_ID,STRUCTURE_NAME,ACTION,REF_AREA,Reference area,FREQ,Frequency of observation,MEASURE,Measure,UNIT_MEASURE,Unit of measure,TIME_PERIOD,Time period,OBS_VALUE,Observation value,OBS_STATUS,Observation status\n" +
	"DATAFLOW,OECD.SDD.TPS:DSD_RGD@DF_RGD(1.1.0),Regional GDP,I,POL,Poland,A,Annual,RGDP,Gross domestic product,XDC,National currency,2023,2023,3085935,,A,Normal value\n" +
	"DATAFLOW,OECD.SDD.TPS:DSD_RGD@DF_RGD(1.1.0),Regional GDP,I,USA,United States,A,Annual,RGDP,Gross domestic product,XDC,National currency,2023,2023,25460000,,A,Normal value\n" +
	"DATAFLOW,OECD.SDD.TPS:DSD_RGD@DF_RGD(1.1.0),Regional GDP,I,WLD,World,A,Annual,RGDP,Gross domestic product,XDC,National currency,2023,2023,999999,,A,Normal value\n" +
	"DATAFLOW,OECD.SDD.TPS:DSD_RGD@DF_RGD(1.1.0),Regional GDP,I,DEU,Germany,A,Annual,RGDP,Gross domestic product,XDC,National currency,2023,2023,,A,Normal value\n"

const subject = "OECD.SDD.TPS,DSD_RGD@DF_RGD,1.1.0/A....."

func TestDataflowMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: csvFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	job := ingest.Job{Provider: "oecd", Dataset: "dataflow", Subject: subject, Mode: "poll"}
	res, err := (&fetcher{dataset: "dataflow", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("dataflow: %v", err)
	}
	if len(fd.seen) != 1 {
		t.Fatalf("requests: %d", len(fd.seen))
	}
	wantURL := "https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_RGD@DF_RGD,1.1.0/A.....?format=csvfilewithlabels&dimensionAtObservation=AllDimensions"
	if fd.seen[0] != wantURL {
		t.Fatalf("url: %s", fd.seen[0])
	}

	// One series per REF_AREA country present in the rows (POL, USA; WLD is
	// an aggregate and DEU's value is empty -> both skip).
	if len(w.series) != 2 {
		t.Fatalf("series: %d", len(w.series))
	}
	wantPOL := canon.MintID(canon.KindSeries, canon.SeriesKey("economy", "rgdp", "country:pol"))
	wantUSA := canon.MintID(canon.KindSeries, canon.SeriesKey("economy", "rgdp", "country:usa"))
	bySubject := map[string]canon.SeriesMeta{}
	for _, sm := range w.series {
		bySubject[sm.SubjectKey] = sm
	}
	if bySubject["country:pol"].SeriesID != wantPOL || bySubject["country:usa"].SeriesID != wantUSA {
		t.Fatalf("series ids: %s / %s", bySubject["country:pol"].SeriesID, bySubject["country:usa"].SeriesID)
	}
	pol := bySubject["country:pol"]
	if pol.Metric != "rgdp" || pol.Frequency != "annual" || pol.Domain != "economy" {
		t.Fatalf("series fields: %+v", pol)
	}
	if pol.Unit == nil || *pol.Unit != "index" {
		t.Fatalf("unit: %v", pol.Unit)
	}
	if pol.ProviderSeriesID != subject+":POL" {
		t.Fatalf("provider series id: %s", pol.ProviderSeriesID)
	}
	if pol.CountryID == nil || *pol.CountryID != canon.MintID(canon.KindCountry, canon.CountryKey("POL")) {
		t.Fatalf("country: %v", pol.CountryID)
	}
	if pol.SchemaVersion != "v1" || pol.NormalizationVersion != "v1" {
		t.Fatalf("versions: %s/%s", pol.SchemaVersion, pol.NormalizationVersion)
	}

	// Two observations; the aggregate row and the empty-value row skip.
	if res.RowsWritten != 2 || len(w.observations) != 2 {
		t.Fatalf("observations: res %d, captured %d", res.RowsWritten, len(w.observations))
	}
	for _, o := range w.observations {
		if o.Value == nil {
			t.Fatalf("nil value written: %+v", o)
		}
		if o.Source != "oecd" || o.Revision != "latest" {
			t.Fatalf("source/revision: %s/%s", o.Source, o.Revision)
		}
		if o.ObservedAt.Month() != 1 || o.ObservedAt.Day() != 1 || o.ObservedAt.Year() != 2023 {
			t.Fatalf("observed_at: %v", o.ObservedAt)
		}
	}
	if got := res.Next["last_period"]; got != "2023" {
		t.Fatalf("cursor last_period: %v", got)
	}
}

func TestDataflowIncrementalCursor(t *testing.T) {
	fd := &fakeDoer{status: 200, body: csvFixture}
	c := newClient(fd, 0)
	job := ingest.Job{
		Provider: "oecd", Dataset: "dataflow", Subject: subject, Mode: "poll",
		Cursor: ingest.Cursor{"last_period": "2020"},
	}
	if _, err := (&fetcher{dataset: "dataflow", client: c}).Fetch(context.Background(), job, &captureWriter{}); err != nil {
		t.Fatalf("dataflow: %v", err)
	}
	if !strings.HasSuffix(fd.seen[0], "&startPeriod=2020") {
		t.Fatalf("url: %s", fd.seen[0])
	}
}

func TestMissingColumnIsShapeError(t *testing.T) {
	// A flow whose header lacks OBS_VALUE must fail loud (config/flow
	// disagreement), never parse empty values.
	body := "REF_AREA,TIME_PERIOD\nPOL,2023\n"
	fd := &fakeDoer{status: 200, body: body}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "oecd", Dataset: "dataflow", Subject: subject, Mode: "poll"}
	_, err := (&fetcher{dataset: "dataflow", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestSDMXErrorBodyIsStatusError(t *testing.T) {
	// The registry answers retired flows with 200 + a bare error token
	// (observed live: "Could not find Dataflow and/or DSD related with this
	// data request").
	fd := &fakeDoer{status: 200, body: "Could not find Dataflow and/or DSD related with this data request"}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "oecd", Dataset: "dataflow", Subject: subject, Mode: "poll"}
	_, err := (&fetcher{dataset: "dataflow", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 404, body: "No Results Found"}
	c := newClient(fd, 0)
	job := ingest.Job{Provider: "oecd", Dataset: "dataflow", Subject: subject, Mode: "poll"}
	_, err := (&fetcher{dataset: "dataflow", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "status" || he.Status != 404 {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestEmptySubjectIsShapeError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: ""}, 0)
	job := ingest.Job{Provider: "oecd", Dataset: "dataflow", Subject: "", Mode: "poll"}
	_, err := (&fetcher{dataset: "dataflow", client: c}).Fetch(context.Background(), job, &captureWriter{})
	he, ok := err.(*HardError)
	if !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestUnknownFlowFallsBackToCanonicalColumns(t *testing.T) {
	// A flow without a config entry derives its metric from the flow id and
	// keeps the canonical SDMX column vocabulary.
	cfg, flowID := configFor("OECD.STI.PIE,DSD_STAN@DF_STAN,1.0/A....")
	if flowID != "DSD_STAN@DF_STAN" {
		t.Fatalf("flow id: %q", flowID)
	}
	if cfg.Metric != "stan" || cfg.Frequency != "annual" {
		t.Fatalf("config: %+v", cfg)
	}
	if cfg.Columns["OBS_VALUE"][0] != "OBS_VALUE" {
		t.Fatalf("columns: %v", cfg.Columns)
	}
	if cfg2, _ := configFor("OECD.CFE.EDS,DF_RGD,1.0/A"); cfg2.Metric != "rgd" {
		t.Fatalf("plain DF metric: %q", cfg2.Metric)
	}
}

func TestNormalizeISO2(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want string
	}{{"POL", "POL"}, {"us", "US"}, {"WLD", ""}, {"OECD", ""}, {"", ""}, {"1A", ""}} {
		if got := normalizeISO2(tc.in); got != tc.want {
			t.Fatalf("normalizeISO2(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestObservedAt(t *testing.T) {
	if got := observedAt("2023"); got.Year() != 2023 || got.Month() != 1 || got.Day() != 1 {
		t.Fatalf("annual: %v", got)
	}
	if got := observedAt("2023-05"); got.Month() != 5 || got.Day() != 1 {
		t.Fatalf("monthly: %v", got)
	}
	if got := observedAt("2023Q2"); got.Month() != 4 || got.Day() != 1 {
		t.Fatalf("quarterly: %v", got)
	}
	if got := observedAt("garbage"); !got.IsZero() {
		t.Fatalf("garbage: %v", got)
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "oecd" {
		t.Fatalf("provider: %s", m.Provider())
	}
	fetchers := m.Fetchers()
	for _, ds := range []string{"dataflow"} {
		if _, ok := fetchers[ds]; !ok {
			t.Fatalf("missing fetcher %s", ds)
		}
	}
	jobs := m.Jobs()
	if len(jobs) != 1 {
		t.Fatalf("jobs: %d", len(jobs))
	}
	j := jobs[0]
	if j.Provider != "oecd" || j.Dataset != "dataflow" ||
		j.Subject != "OECD.SDD.TPS,DSD_RGD@DF_RGD,1.1.0/A....." ||
		j.Mode != "poll" || j.Schedule != 24*60*60*1_000_000_000 || !j.Enabled {
		t.Fatalf("job spec: %+v", j)
	}
}
