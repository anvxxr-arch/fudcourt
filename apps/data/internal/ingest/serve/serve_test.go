package serve

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// writerStore is the JobStore + canon.Writer test double used by the trigger
// tests: it implements ingest.JobStore (no-op) and embeds *testWriter so
// server.writer's dynamic assertion finds a real Writer.
type writerStore struct{ *testWriter }

func newTestServer(t *testing.T) (http.Handler, *fakeReader, *testWriter) {
	t.Helper()
	r := &fakeReader{}
	w := &testWriter{}
	stub := &stubModule{provider: "stub", fetchers: map[string]stubFetcher{
		"klines": {res: ingest.FetchResult{RowsIn: 5, RowsWritten: 5}},
	}}
	h := New(r, writerStore{w}, func() []ingest.Module { return []ingest.Module{stub} }, nil)
	return h, r, w
}

func (writerStore) EnsureJobs(ctx context.Context, specs []ingest.JobSpec) error { return nil }
func (writerStore) DueJobs(ctx context.Context, now time.Time, limit int) ([]ingest.Job, error) {
	return nil, nil
}
func (writerStore) MarkAttempt(ctx context.Context, job ingest.Job, at time.Time, lastErr error) error {
	return nil
}
func (writerStore) MarkSuccess(ctx context.Context, job ingest.Job, at time.Time, cursor ingest.Cursor) error {
	return nil
}
func (writerStore) ListEnabled(ctx context.Context) ([]ingest.Job, error) { return nil, nil }

func get(t *testing.T, h http.Handler, path string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var body map[string]any
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: body is not JSON: %v\n%s", path, err, rec.Body.String())
		}
	}
	return rec, body
}

func TestHealthShape(t *testing.T) {
	h, _, _ := newTestServer(t)
	rec, body := get(t, h, "/api/data/health")
	if rec.Code != 200 {
		t.Fatalf("health: got %d", rec.Code)
	}
	if body["ok"] != true {
		t.Fatalf("health ok = %v", body["ok"])
	}
	if body["db"] != true {
		t.Fatalf("health db = %v", body["db"])
	}
	if _, ok := body["runs"]; !ok {
		t.Fatalf("health missing runs")
	}
	provs, ok := body["providers"].([]any)
	if !ok || len(provs) != 1 || provs[0] != "stub" {
		t.Fatalf("health providers = %v", body["providers"])
	}
}

func TestListEndpointsEnvelopeAndLimit(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.assets = []canon.Asset{
		{AssetID: "asset:a", Symbol: "BTC", Kind: "crypto"},
		{AssetID: "asset:b", Symbol: "ETH", Kind: "crypto"},
		{AssetID: "asset:c", Symbol: "SOL", Kind: "crypto"},
	}
	rec, body := get(t, h, "/api/data/assets?limit=2")
	if rec.Code != 200 {
		t.Fatalf("assets: got %d", rec.Code)
	}
	data, ok := body["data"].([]any)
	if !ok || len(data) != 2 {
		t.Fatalf("assets data = %v", body["data"])
	}

	// cap: limit=9999 is clamped, not an error.
	rec, body = get(t, h, "/api/data/assets?limit=9999")
	if rec.Code != 200 || len(body["data"].([]any)) != 3 {
		t.Fatalf("limit cap: %d %v", rec.Code, body["data"])
	}

	// bad limit -> 400.
	rec, _ = get(t, h, "/api/data/assets?limit=nope")
	if rec.Code != 400 {
		t.Fatalf("bad limit: got %d", rec.Code)
	}
	var errEnv struct {
		Error apiError `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &errEnv); err != nil || errEnv.Error.Code != "bad_request" {
		t.Fatalf("bad limit envelope: %s", rec.Body.String())
	}
}

func TestUnknownPath404Envelope(t *testing.T) {
	h, _, _ := newTestServer(t)
	rec, body := get(t, h, "/api/data/nope")
	if rec.Code != 404 {
		t.Fatalf("unknown path: got %d", rec.Code)
	}
	errObj, _ := body["error"].(map[string]any)
	if errObj == nil || errObj["code"] != "not_found" {
		t.Fatalf("404 envelope = %v", body)
	}
}

func TestStoreOutageIsLoud503(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.err = errStoreDown
	rec, body := get(t, h, "/api/data/assets")
	if rec.Code != 503 {
		t.Fatalf("outage: got %d", rec.Code)
	}
	errObj, _ := body["error"].(map[string]any)
	if errObj == nil || errObj["code"] != "unavailable" || !strings.Contains(errObj["message"].(string), "store down") {
		t.Fatalf("503 envelope = %v", body)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	h, _, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/data/assets", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 405 {
		t.Fatalf("POST assets: got %d", rec.Code)
	}
}

func TestInstrumentsFiltersAndRequiredParams(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.instruments = []canon.Instrument{
		{InstrumentID: "i1", VenueID: "venue:binance", MarketType: "spot", BaseSymbol: "BTC", QuoteSymbol: "USDT"},
		{InstrumentID: "i2", VenueID: "venue:binance", MarketType: "linear_perp", BaseSymbol: "BTC", QuoteSymbol: "USDT"},
		{InstrumentID: "i3", VenueID: "venue:okx", MarketType: "spot", BaseSymbol: "ETH", QuoteSymbol: "USDT"},
	}
	rec, body := get(t, h, "/api/data/instruments?venue=venue:binance&market_type=linear_perp")
	if rec.Code != 200 {
		t.Fatalf("instruments: %d", rec.Code)
	}
	data := body["data"].([]any)
	if len(data) != 1 {
		t.Fatalf("filters: %v", data)
	}
}

func TestTimeseriesWindowAndParams(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.observations = []canon.Observation{
		{SeriesID: "s1", Period: "2026-01-01", ObservedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		{SeriesID: "s1", Period: "2026-02-01", ObservedAt: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)},
	}
	rec, body := get(t, h, "/api/data/timeseries?series_id=s1&start=2026-01-15")
	if rec.Code != 200 {
		t.Fatalf("timeseries: %d %s", rec.Code, rec.Body.String())
	}
	if got := len(body["data"].([]any)); got != 1 {
		t.Fatalf("window: %v", body["data"])
	}
	// missing series_id -> 400
	rec, _ = get(t, h, "/api/data/timeseries")
	if rec.Code != 400 {
		t.Fatalf("missing series_id: %d", rec.Code)
	}
	// bad date -> 400
	rec, _ = get(t, h, "/api/data/timeseries?series_id=s1&start=yesterday")
	if rec.Code != 400 {
		t.Fatalf("bad start: %d", rec.Code)
	}
}

func TestOhlcvAndDerivativeParams(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.ohlcv = []canon.Ohlcv{{InstrumentID: "i1", VenueID: "venue:binance", Timeframe: "1m"}}
	r.funding = []canon.FundingRate{{InstrumentID: "i1", VenueID: "venue:binance"}}
	r.oi = []canon.OpenInterest{{InstrumentID: "i1", VenueID: "venue:binance"}}

	if rec, _ := get(t, h, "/api/data/ohlcv?instrument=i1"); rec.Code != 200 {
		t.Fatalf("ohlcv: %d", rec.Code)
	}
	if rec, _ := get(t, h, "/api/data/ohlcv"); rec.Code != 400 {
		t.Fatalf("ohlcv missing instrument: %d", rec.Code)
	}
	if rec, _ := get(t, h, "/api/data/derivatives/funding?instrument=i1"); rec.Code != 200 {
		t.Fatalf("funding: %d", rec.Code)
	}
	if rec, _ := get(t, h, "/api/data/derivatives/funding"); rec.Code != 400 {
		t.Fatalf("funding missing key: %d", rec.Code)
	}
	if rec, _ := get(t, h, "/api/data/derivatives/open-interest?asset=asset:x"); rec.Code != 200 {
		t.Fatalf("oi by asset: %d", rec.Code)
	}
}

func TestDefiAndMiscLists(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.chainTVL = []canon.ChainTVL{{ChainID: "chain:ethereum", TVLUSD: 1}}
	r.protocolTVL = []canon.ProtocolTVL{{ProtocolID: "proto:aave", TVLUSD: 2}}
	r.pools = []canon.Pool{{PoolID: "p1", ChainID: "chain:ethereum", DEXVenueID: "venue:uniswap"}}
	r.articles = []canon.Article{{ArticleID: "a1", Headline: "hi"}}
	r.predictions = []canon.PredictionMarket{{MarketID: "m1", Question: "q"}}
	r.series = []canon.SeriesMeta{{SeriesID: "s1", Domain: "crypto", Metric: "market_cap"}}

	for _, path := range []string{
		"/api/data/defi/chains", "/api/data/defi/protocols", "/api/data/dex/pools",
		"/api/data/news", "/api/data/prediction", "/api/data/series?domain=crypto",
	} {
		if rec, _ := get(t, h, path); rec.Code != 200 {
			t.Fatalf("%s: %d", path, rec.Code)
		}
	}
}

func TestRuns(t *testing.T) {
	h, r, _ := newTestServer(t)
	now := time.Now()
	r.runs = []canon.RunRecord{{ID: 1, Provider: "binance", Dataset: "ohlcv", Status: "success", StartedAt: now}}
	rec, body := get(t, h, "/api/data/runs")
	if rec.Code != 200 {
		t.Fatalf("runs: %d", rec.Code)
	}
	if got := len(body["data"].([]any)); got != 1 {
		t.Fatalf("runs data: %v", body["data"])
	}
}

func TestIngestRunTrigger(t *testing.T) {
	h, _, _ := newTestServer(t)

	// success: POST with JSON body
	req := httptest.NewRequest(http.MethodPost, "/api/data/ingest/run",
		bytes.NewBufferString(`{"provider":"stub","dataset":"klines"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("ingest/run: %d %s", rec.Code, rec.Body.String())
	}
	var res ingest.FetchResult
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil || res.RowsIn != 5 {
		t.Fatalf("FetchResult body: %s", rec.Body.String())
	}

	// backfill=1 query form
	req = httptest.NewRequest(http.MethodPost, "/api/data/ingest/run?provider=stub&dataset=klines&backfill=1", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("ingest/run query form: %d", rec.Code)
	}

	// unknown provider -> 400
	req = httptest.NewRequest(http.MethodPost, "/api/data/ingest/run",
		bytes.NewBufferString(`{"provider":"nope","dataset":"klines"}`))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("unknown provider: %d", rec.Code)
	}

	// unknown dataset -> 400
	req = httptest.NewRequest(http.MethodPost, "/api/data/ingest/run",
		bytes.NewBufferString(`{"provider":"stub","dataset":"nope"}`))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("unknown dataset: %d", rec.Code)
	}

	// GET -> 405
	req = httptest.NewRequest(http.MethodGet, "/api/data/ingest/run", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 405 {
		t.Fatalf("GET ingest/run: %d", rec.Code)
	}

	// fetcher error -> 503 loud
	failStore := &writerStore{&testWriter{}}
	failMod := &stubModule{provider: "bad", fetchers: map[string]stubFetcher{
		"boom": {err: errStoreDown},
	}}
	hb := New(&fakeReader{}, failStore, func() []ingest.Module { return []ingest.Module{failMod} }, nil)
	req = httptest.NewRequest(http.MethodPost, "/api/data/ingest/run",
		bytes.NewBufferString(`{"provider":"bad","dataset":"boom"}`))
	rec = httptest.NewRecorder()
	hb.ServeHTTP(rec, req)
	if rec.Code != 503 {
		t.Fatalf("fetcher error: %d %s", rec.Code, rec.Body.String())
	}
}

// TestIngestRunWithWriterOverride pins the manual-run writer wiring: a server
// whose store is NOT a canon.Writer must hand the fetch WithWriter's override,
// not the loud failingWriter. bareJobStore implements ONLY ingest.JobStore —
// deliberately NOT embedding writerStore/testWriter, whose promoted methods
// would satisfy the Writer assertion (writerStore{&testWriter{}} IS a
// canon.Writer via embed promotion). The stub fetcher reports which Writer
// the run actually handed it.
type bareJobStore struct{}

func (bareJobStore) EnsureJobs(context.Context, []ingest.JobSpec) error { return nil }
func (bareJobStore) DueJobs(context.Context, time.Time, int) ([]ingest.Job, error) {
	return nil, nil
}
func (bareJobStore) MarkAttempt(context.Context, ingest.Job, time.Time, error) error { return nil }
func (bareJobStore) MarkSuccess(context.Context, ingest.Job, time.Time, ingest.Cursor) error {
	return nil
}
func (bareJobStore) ListEnabled(context.Context) ([]ingest.Job, error) { return nil, nil }

func TestIngestRunWithWriterOverride(t *testing.T) {
	// Without an override the fetcher receives the failingWriter: every write
	// it makes errors loud (the pre-WithWriter behavior for manual runs).
	var noOverrideErr error
	base2 := New(&fakeReader{}, bareJobStore{}, func() []ingest.Module {
		return []ingest.Module{&stubModule{provider: "stub", fetchers: map[string]stubFetcher{
			"klines": stubFetcher{res: ingest.FetchResult{RowsIn: 3, RowsWritten: 3},
				write: func(w canon.Writer) error {
					_, noOverrideErr = w.UpsertInstruments(context.Background(), []canon.Instrument{{InstrumentID: "instrument:x"}})
					return nil
				}},
		}}}
	}, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/data/ingest/run",
		bytes.NewBufferString(`{"provider":"stub","dataset":"klines"}`))
	rec := httptest.NewRecorder()
	base2.ServeHTTP(rec, req)
	if rec.Code != 200 || noOverrideErr == nil {
		t.Fatalf("no-override run: %d err=%v (failingWriter must be loud)", rec.Code, noOverrideErr)
	}

	// WithWriter routes the run through the given writer: a real write through
	// it succeeds and the spy records the call.
	w := &testWriter{}
	over := WithWriter(New(&fakeReader{}, bareJobStore{}, func() []ingest.Module {
		return []ingest.Module{&stubModule{provider: "stub", fetchers: map[string]stubFetcher{
			"klines": stubFetcher{res: ingest.FetchResult{RowsIn: 3, RowsWritten: 3},
				write: func(cw canon.Writer) error {
					_, err := cw.UpsertInstruments(context.Background(), []canon.Instrument{{InstrumentID: "instrument:x"}})
					return err
				}},
		}}}
	}, nil), w)
	req = httptest.NewRequest(http.MethodPost, "/api/data/ingest/run",
		bytes.NewBufferString(`{"provider":"stub","dataset":"klines"}`))
	rec = httptest.NewRecorder()
	over.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("override run: %d %s", rec.Code, rec.Body.String())
	}
	if w.instr == 0 {
		t.Fatal("override writer saw no instrument writes")
	}
	var res ingest.FetchResult
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil || res.RowsWritten != 3 {
		t.Fatalf("override FetchResult: %s", rec.Body.String())
	}

	// A nil writer keeps New's behavior (no panic, no change).
	noop := New(&fakeReader{}, bareJobStore{}, func() []ingest.Module {
		return []ingest.Module{&stubModule{provider: "stub", fetchers: map[string]stubFetcher{}}}
	}, nil)
	if got := WithWriter(noop, nil); got != http.Handler(noop) {
		t.Fatal("nil override must return the handler unchanged")
	}
}
