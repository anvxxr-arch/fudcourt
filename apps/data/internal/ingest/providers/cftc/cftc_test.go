package cftc

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fakeDoer answers every request with a canned status+body and records the
// last URL (tests assert the endpoint+query shape).
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

// spyWriter counts the writes each dataset performs.
type spyWriter struct {
	assets  int
	series  int
	obs     int
	provSym int
	err     error
}

func (w *spyWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.assets += len(rows)
	return len(rows), nil
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
	w.series += len(rows)
	return len(rows), nil
}

func (w *spyWriter) UpsertProviderSymbols(ctx context.Context, rows []canon.ProviderSymbol) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.provSym += len(rows)
	return len(rows), nil
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
	if w.err != nil {
		return 0, 0, w.err
	}
	w.obs += len(rows)
	return len(rows), 0, nil
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

// Fixtures trimmed from the real Socrata endpoint (shape-true, values real).
const cotFixture = `[

 {"market_and_exchange_names":"WHEAT-SRW - CHICAGO BOARD OF TRADE",
  "report_date_as_yyyy_mm_dd":"2022-09-13T00:00:00.000",
  "cftc_contract_market_code":"001602",
  "open_interest_all":"287046",
  "noncomm_positions_long_all":"88091",
  "noncomm_positions_short_all":"96219",
  "comm_positions_long_all":"119219",
  "comm_positions_short_all":"106242"},
 {"market_and_exchange_names":"GOLD - COMMODITY EXCHANGE INC.",
  "report_date_as_yyyy_mm_dd":"2022-09-13T00:00:00.000",
  "cftc_contract_market_code":"088691",
  "open_interest_all":"491895",
  "noncomm_positions_long_all":"158238",
  "noncomm_positions_short_all":"104448",
  "comm_positions_long_all":"294892",
  "comm_positions_short_all":"38325"},
 {"market_and_exchange_names":"MIKRO BREWERY FUTURES - UNTRACKED EXCHANGE",
  "report_date_as_yyyy_mm_dd":"2022-09-13T00:00:00.000",
  "cftc_contract_market_code":"999999",
  "open_interest_all":"42",
  "noncomm_positions_long_all":"1",
  "noncomm_positions_short_all":"2",
  "comm_positions_long_all":"3",
  "comm_positions_short_all":"4"}
]`

// captureWriter spies and keeps the rows for identity assertions.
type captureWriter struct {
	spyWriter
	assets []canon.Asset
	series []canon.SeriesMeta
	obs    []canon.Observation
}

func (w *captureWriter) UpsertAssets(ctx context.Context, rows []canon.Asset) (int, error) {
	w.assets = append(w.assets, rows...)
	return w.spyWriter.UpsertAssets(ctx, rows)
}

func (w *captureWriter) UpsertSeries(ctx context.Context, rows []canon.SeriesMeta) (int, error) {
	w.series = append(w.series, rows...)
	return w.spyWriter.UpsertSeries(ctx, rows)
}

func (w *captureWriter) WriteObservations(ctx context.Context, rows []canon.Observation) (int, int, error) {
	w.obs = append(w.obs, rows...)
	return w.spyWriter.WriteObservations(ctx, rows)
}

func TestCotMapping(t *testing.T) {
	fd := &fakeDoer{status: 200, body: cotFixture}
	c := newClient(fd, 0)
	w := &captureWriter{}
	job := ingest.Job{Provider: "cftc", Dataset: "cot", Subject: "", Mode: "poll"}
	res, err := (&fetcher{dataset: "cot", client: c}).Fetch(context.Background(), job, w)
	if err != nil {
		t.Fatalf("cot: %v", err)
	}
	// Two tracked rows x five metrics; the untracked contract is rejected.
	if res.RowsWritten != 10 || res.RowsRejected != 1 {
		t.Fatalf("cot rows: written %d rejected %d", res.RowsWritten, res.RowsRejected)
	}
	if len(w.obs) != 10 || len(w.series) != 10 || len(w.assets) != 2 {
		t.Fatalf("counts: obs %d series %d assets %d", len(w.obs), len(w.series), len(w.assets))
	}
	wantCot := "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$select=" +
		strings.Join(cotFields, ",") + "&$limit=50000&$offset=0"
	if !strings.HasPrefix(fd.seen[0], wantCot) {
		t.Fatalf("url: %s", fd.seen[0])
	}
	// Cursor carries the next offset.
	if got, ok := res.Next["offset"].(float64); !ok || got != 3 {
		t.Fatalf("next offset: %v", res.Next["offset"])
	}
	// The gold asset mints with kind other; XAU id is stable.
	wantAsset := canon.MintID(canon.KindAsset, canon.AssetKey(canon.AssetOther, "XAU"))
	foundGold := false
	for _, a := range w.assets {
		if a.Symbol == "XAU" {
			foundGold = true
			if a.AssetID != wantAsset {
				t.Fatalf("XAU asset id %q, want %q", a.AssetID, wantAsset)
			}
		}
	}
	if !foundGold {
		t.Fatal("no XAU asset upserted")
	}
	// One wheat observation: the noncomm long series, value 88091.
	wheatAsset := canon.MintID(canon.KindAsset, canon.AssetKey(canon.AssetOther, "WHEAT"))
	wantSeries := canon.MintID(canon.KindSeries,
		canon.SeriesKey("positioning", "cot_noncomm_long", "asset:"+wheatAsset))
	wantAt := time.Date(2022, 9, 13, 0, 0, 0, 0, time.UTC)
	var gotObs *canon.Observation
	for i, o := range w.obs {
		if o.SeriesID == wantSeries {
			gotObs = &w.obs[i]
			break
		}
	}
	if gotObs == nil {
		t.Fatal("no cot_noncomm_long observation for WHEAT")
	}
	if gotObs.Period != "2022-09-13" || !gotObs.ObservedAt.Equal(wantAt) {
		t.Fatalf("period %s at %v", gotObs.Period, gotObs.ObservedAt)
	}
	if gotObs.Value == nil || *gotObs.Value != 88091 {
		t.Fatalf("value %v", gotObs.Value)
	}
	if gotObs.Source != "cftc" || gotObs.RetrievedAt.IsZero() {
		t.Fatalf("source %q retrieved %v", gotObs.Source, gotObs.RetrievedAt)
	}
	// Series metadata pins provider identity: code+metric, weekly.
	for _, s := range w.series {
		if s.Provider != "cftc" || s.Frequency != "weekly" || s.ProviderSeriesID == "" {
			t.Fatalf("series meta %+v", s)
		}
	}
}

func TestCotBlankFieldSkipsObservationOnly(t *testing.T) {
	body := `[
	 {"market_and_exchange_names":"WHEAT-SRW - CHICAGO BOARD OF TRADE",
	  "report_date_as_yyyy_mm_dd":"2022-09-13T00:00:00.000",
	  "cftc_contract_market_code":"001602",
	  "open_interest_all":"287046",
	  "noncomm_positions_long_all":"",
	  "noncomm_positions_short_all":"96219",
	  "comm_positions_long_all":"119219",
	  "comm_positions_short_all":"106242"}
	]`
	fd := &fakeDoer{status: 200, body: body}
	c := newClient(fd, 0)
	w := &spyWriter{}
	res, err := (&fetcher{dataset: "cot", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "cftc", Dataset: "cot", Mode: "poll"}, w)
	if err != nil {
		t.Fatalf("cot: %v", err)
	}
	// Four metrics present, one absent: the absent one is skipped, never 0.
	if w.obs != 4 || w.series != 5 || res.RowsRejected != 0 {
		t.Fatalf("obs %d series %d rejected %d", w.obs, w.series, res.RowsRejected)
	}
}

func TestCotCursorYearFiltersWindow(t *testing.T) {
	fd := &fakeDoer{status: 200, body: "[]"}
	c := newClient(fd, 0)
	job := ingest.Job{
		Provider: "cftc", Dataset: "cot", Mode: "poll",
		Cursor: ingest.Cursor{"offset": float64(50000), "year": float64(2026)},
	}
	if _, err := (&fetcher{dataset: "cot", client: c}).Fetch(context.Background(), job, &spyWriter{}); err != nil {
		t.Fatalf("cot: %v", err)
	}
	want := "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$select=" +
		strings.Join(cotFields, ",") +
		"&$limit=50000&$offset=50000&$where=report_date between '2026-01-01T00:00:00' and '2026-12-31T23:59:59'"
	if fd.seen[0] != want {
		t.Fatalf("url: %s", fd.seen[0])
	}
}

func TestStatusErrorIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 500, body: "<html>oops</html>"}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "cot", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "cftc", Dataset: "cot"}, &spyWriter{})
	var he *HardError
	if err == nil || !errorsAs(err, &he) || he.Kind != "status" || he.Status != 500 {
		t.Fatalf("want status HardError, got %v", err)
	}
}

func TestNonJSONIsHardError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: "not json"}
	c := newClient(fd, 0)
	_, err := (&fetcher{dataset: "cot", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "cftc", Dataset: "cot"}, &spyWriter{})
	var he *HardError
	if err == nil || !errorsAs(err, &he) || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

// TestTruncatedBodyIsLoudShapeError pins the fix for the live "unexpected end
// of JSON input on HTTP 200": a body that fills the cap byte-for-byte is a
// shape HardError, never a silent truncation that a later unmarshal would
// misreport as a parse failure.
func TestTruncatedBodyIsLoudShapeError(t *testing.T) {
	fd := &fakeDoer{status: 200, body: strings.Repeat("x", maxBodyBytes)}
	c := newClient(fd, 0)
	res, err := (&fetcher{dataset: "cot", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "cftc", Dataset: "cot"}, &spyWriter{})
	var he *HardError
	if err == nil || !errorsAs(err, &he) || he.Kind != "shape" {
		t.Fatalf("want shape HardError for a capped body, got %v", err)
	}
	if res.RowsWritten != 0 || res.RowsRejected != 0 {
		t.Fatalf("rows on error: %+v", res)
	}
	if !strings.Contains(he.Detail, "cap") {
		t.Fatalf("detail must name the cap: %s", he.Detail)
	}
}

// TestCotLiveArrayShape pins the wire contract the live endpoint returned:
// a top-level JSON ARRAY (one object per market), report_date carrying the
// "T00:00:00.000" floating-time suffix, and every numeric as a string. One
// row must produce its five metric observations.
func TestCotLiveArrayShape(t *testing.T) {
	body := `[{"id":"000601","market_and_exchange_names":"GOLD - COMMODITY EXCHANGE INC.",
	 "report_date_as_yyyy_mm_dd":"2022-09-13T00:00:00.000","cftc_contract_market_code":"088691",
	 "open_interest_all":"491895","noncomm_positions_long_all":"158238",
	 "noncomm_positions_short_all":"120455","comm_positions_long_all":"220000",
	 "comm_positions_short_all":"310000"}]`
	fd := &fakeDoer{status: 200, body: body}
	c := newClient(fd, 0)
	res, err := (&fetcher{dataset: "cot", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "cftc", Dataset: "cot", Mode: "poll"}, &spyWriter{})
	if err != nil {
		t.Fatalf("cot: %v", err)
	}
	if res.RowsWritten != 5 || res.RowsRejected != 0 {
		t.Fatalf("rows: written %d rejected %d", res.RowsWritten, res.RowsRejected)
	}
}

func TestUnknownDatasetIsHardError(t *testing.T) {
	c := newClient(&fakeDoer{status: 200, body: "[]"}, 0)
	_, err := (&fetcher{dataset: "nope", client: c}).Fetch(context.Background(),
		ingest.Job{Provider: "cftc", Dataset: "nope"}, &spyWriter{})
	if err == nil {
		t.Fatal("unknown dataset must be a HardError")
	}
}

func TestJobsRegistered(t *testing.T) {
	m := NewModule(nil)
	if m.Provider() != "cftc" {
		t.Fatalf("provider %q", m.Provider())
	}
	js := m.Jobs()
	if len(js) != 1 || js[0].Dataset != "cot" || js[0].Mode != "poll" || !js[0].Enabled {
		t.Fatalf("jobs: %+v", js)
	}
	if js[0].Schedule != 7*24*time.Hour {
		t.Fatalf("schedule %v", js[0].Schedule)
	}
	f := m.Fetchers()
	if len(f) != 1 {
		t.Fatalf("fetchers: %v", f)
	}
	if _, ok := f["cot"]; !ok {
		t.Fatal("no cot fetcher")
	}
}

// TestParseDateWireSpellings pins the report-week decode: the live
// "T00:00:00.000" rendering, a time without the fraction, a bare date, and an
// off-precision fraction (Socrata has emitted 1-6 digits) all resolve to the
// same UTC calendar day; garbage stays unparseable.
func TestParseDateWireSpellings(t *testing.T) {
	want := time.Date(2022, 9, 13, 0, 0, 0, 0, time.UTC)
	for _, s := range []string{
		"2022-09-13T00:00:00.000",
		"2022-09-13T00:00:00",
		"2022-09-13",
		"2022-09-13T00:00:00.123456",
	} {
		got, ok := parseDate(s)
		if !ok || !got.Equal(want) {
			t.Fatalf("parseDate(%q) = %v, %v", s, got, ok)
		}
	}
	if _, ok := parseDate("not-a-date"); ok {
		t.Fatal("garbage parsed")
	}
}

// errorsAs is a two-type-assertion errors.As local (the package has no
// errors import otherwise).
func errorsAs(err error, target **HardError) bool {
	for e := err; e != nil; e = nil {
		if he, ok := e.(*HardError); ok {
			*target = he
			return true
		}
	}
	return false
}
