package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/chainrank"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/coinank"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/coinglass"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/coinmarketcap"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/khala"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/llama"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/news"
)

// caFixtureDir is the family's recorded testdata: REAL upstream bodies captured
// live (see each .meta.json). The handler tests run the real fetcher, real
// signature and real envelope over those bytes rather than a hand-made double, so
// a drift in any of the three shows up here.
const caFixtureDir = "internal/research/coinank/testdata"

// caDoer serves a recorded fixture (or a canned refusal) instead of the network,
// and records every request it was asked to make. The request log is what lets
// the validation tests assert the stronger claim: a rejected param never reached
// upstream at all.
type caDoer struct {
	fixture string // fixture name WITHOUT extension, e.g. "real-liquidation"
	status  int
	// refusal, when set, is served as the body with HTTP 200 — exactly how
	// CoinAnk reports a refusal.
	refusal string
	// failAfter, when >0, switches the doer to serving `refusal` once that
	// many calls have passed -- the shape of an upstream wall landing on a
	// warm cache. Zero keeps the old always-refuse behaviour.
	failAfter int
	reqs      []string
}

func (d *caDoer) Do(req *http.Request) (*http.Response, error) {
	d.reqs = append(d.reqs, req.URL.String())
	serveRefusal := d.refusal != "" && (d.failAfter == 0 || len(d.reqs) > d.failAfter)
	body := d.refusal
	if !serveRefusal {
		b, err := os.ReadFile(filepath.Join(caFixtureDir, d.fixture+".body"))
		if err != nil {
			return nil, err
		}
		body = string(b)
	}
	status := d.status
	if status == 0 {
		status = 200
	}
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(body)),
	}, nil
}

// caServer builds a server whose coinank family reads a fixture.
func caServer(t *testing.T, d *caDoer) http.Handler {
	t.Helper()
	f, err := coinank.New(coinank.Options{
		Client:   d,
		CacheDir: t.TempDir(),
		NoCache:  true,
	})
	if err != nil {
		t.Fatalf("coinank.New: %v", err)
	}
	return newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{},
		chainrank.Service{}, coinglass.Service{}, coinank.Service{F: f}, coinmarketcap.Service{}).mux()
}

func caGet(t *testing.T, h http.Handler, url string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

// TestCoinankLiquidationArray: the happy path over a REAL recorded body. It
// asserts the payload actually reached the wire — a fetcher that silently
// produced nothing (bad signature, dropped envelope) fails here, which is the
// point.
func TestCoinankLiquidationArray(t *testing.T) {
	h := caServer(t, &caDoer{fixture: "real-liquidation"})
	rec := caGet(t, h, "/api/coinank?mode=liquidation&interval=1h")
	if rec.Code != 200 {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-CA-Cache"); got != "MISS" {
		t.Fatalf("X-CA-Cache = %q, want MISS", got)
	}
	if got := rec.Header().Get("X-CA-Upstream"); !strings.Contains(got, "interval=1h") {
		t.Fatalf("X-CA-Upstream = %q, want it to carry the explicit interval", got)
	}
	var env struct {
		Kind          string           `json:"kind"`
		Auth          string           `json:"auth"`
		Interval      string           `json:"interval"`
		UpstreamCount *int             `json:"upstreamCount"`
		Data          []map[string]any `json:"data"`
		Derived       string           `json:"derived"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("envelope: %v", err)
	}
	if env.Kind != "liquidation" || env.Interval != "1h" {
		t.Fatalf("envelope head wrong: %+v", env)
	}
	if env.Auth != coinank.AuthNote {
		t.Fatalf("auth = %q, want %q", env.Auth, coinank.AuthNote)
	}
	if env.UpstreamCount == nil || *env.UpstreamCount == 0 {
		t.Fatalf("upstreamCount = %v, want a positive count", env.UpstreamCount)
	}
	if len(env.Data) != *env.UpstreamCount {
		t.Fatalf("data has %d rows but upstreamCount = %d", len(env.Data), *env.UpstreamCount)
	}
	// The payload is upstream verbatim: the recorded row set has exchangeName.
	if _, ok := env.Data[0]["exchangeName"]; !ok {
		t.Fatalf("first row lacks exchangeName; data was re-shaped: %v", env.Data[0])
	}
	if !strings.Contains(env.Derived, "rows") {
		t.Fatalf("derived should state the row count: %q", env.Derived)
	}
}

// TestCoinankWhalesObject: an OBJECT payload must leave upstreamCount ABSENT, not
// zero. Reporting 0 would assert a measurement upstream never made.
func TestCoinankWhalesObject(t *testing.T) {
	h := caServer(t, &caDoer{fixture: "real-whales"})
	rec := caGet(t, h, "/api/coinank?mode=whales")
	if rec.Code != 200 {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var env struct {
		UpstreamCount *int           `json:"upstreamCount"`
		Interval      string         `json:"interval"`
		Data          map[string]any `json:"data"`
		Derived       string         `json:"derived"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("envelope: %v", err)
	}
	if env.UpstreamCount != nil {
		t.Fatalf("object payload must not carry upstreamCount, got %d", *env.UpstreamCount)
	}
	if env.Interval != "" {
		t.Fatalf("whales takes no interval and must not echo one, got %q", env.Interval)
	}
	if env.Data["list"] == nil {
		t.Fatalf("data.list missing: %v", env.Data)
	}
	if !strings.Contains(env.Derived, "object") {
		t.Fatalf("derived should say the payload is an object: %q", env.Derived)
	}
}

// TestCoinankValidation pins the local 400s. Every one is a REFUSAL: none of
// these values may be clamped, defaulted or ignored.
func TestCoinankValidation(t *testing.T) {
	cases := []struct {
		name     string
		url      string
		wantCode int
		wantErr  string
	}{
		{"no mode", "/api/coinank", 400, coinank.ErrUnknownMode},
		{"unknown mode", "/api/coinank?mode=bogus", 400, coinank.ErrUnknownMode},
		{"unscoped param", "/api/coinank?mode=etf&symbol=BTC", 400, coinank.ErrUnexpected},
		{"no-op param is refused", "/api/coinank?mode=fundingRate&symbol=BTC", 400, coinank.ErrUnexpected},
		{"interval on the wrong mode", "/api/coinank?mode=etf&interval=1h", 400, coinank.ErrUnexpected},
		{"unknown param", "/api/coinank?mode=etf&day=1", 400, coinank.ErrUnexpected},
		// The all-zero trap: upstream ANSWERS these with 200 + zeros, so they
		// must be refused here and never sent.
		{"interval 8h (upstream returns all-zero)", "/api/coinank?mode=liquidation&interval=8h", 400, coinank.ErrInvalidParam},
		{"interval 24h (upstream returns all-zero)", "/api/coinank?mode=liquidation&interval=24h", 400, coinank.ErrInvalidParam},
		{"interval 7d (upstream returns all-zero)", "/api/coinank?mode=liquidation&interval=7d", 400, coinank.ErrInvalidParam},
		{"interval bogus", "/api/coinank?mode=liquidation&interval=bogus", 400, coinank.ErrInvalidParam},
		{"interval uppercase 1H", "/api/coinank?mode=liquidation&interval=1H", 400, coinank.ErrInvalidParam},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &caDoer{fixture: "real-liquidation"}
			h := caServer(t, d)
			rec := caGet(t, h, tc.url)
			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantCode, rec.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("body: %v", err)
			}
			if body["error"] != tc.wantErr {
				t.Fatalf("error = %v, want %q", body["error"], tc.wantErr)
			}
			// The stronger claim: a rejected request never reached upstream.
			if len(d.reqs) != 0 {
				t.Fatalf("a rejected request still hit upstream: %v", d.reqs)
			}
		})
	}

	// The unknown-mode body must ship the whole table so a caller can recover.
	d := &caDoer{fixture: "real-liquidation"}
	rec := caGet(t, caServer(t, d), "/api/coinank?mode=bogus")
	var body struct {
		Modes []string `json:"modes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(body.Modes) != coinank.ModeCount {
		t.Fatalf("modes = %v, want %d entries", body.Modes, coinank.ModeCount)
	}
	// The interval refusal must name the accepted values and say why.
	rec = caGet(t, caServer(t, &caDoer{fixture: "real-liquidation"}), "/api/coinank?mode=liquidation&interval=8h")
	var ib struct {
		Detail string `json:"detail"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &ib)
	for _, want := range []string{"1h", "1d", "all-zero"} {
		if !strings.Contains(ib.Detail, want) {
			t.Fatalf("interval detail %q should mention %q", ib.Detail, want)
		}
	}
}

// TestCoinankIntervalDefaultsTo1h: an omitted interval is accepted and the
// effective value is echoed, so a reader never has to re-derive the default.
func TestCoinankIntervalDefaultsTo1h(t *testing.T) {
	d := &caDoer{fixture: "real-liquidation"}
	h := caServer(t, d)
	rec := caGet(t, h, "/api/coinank?mode=liquidation")
	if rec.Code != 200 {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var env struct {
		Interval string `json:"interval"`
		Upstream string `json:"upstream"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("envelope: %v", err)
	}
	if env.Interval != "1h" || !strings.Contains(env.Upstream, "interval=1h") {
		t.Fatalf("omitted interval must resolve to an explicit 1h: interval=%q upstream=%s", env.Interval, env.Upstream)
	}
	// It IS sent explicitly, so upstream was actually asked for 1h.
	if len(d.reqs) != 1 || !strings.Contains(d.reqs[0], "interval=1h") {
		t.Fatalf("upstream request did not carry interval=1h: %v", d.reqs)
	}
}

// TestCoinankUpstreamRefusalIs502: CoinAnk reports a refusal with HTTP 200 and
// success:false. That is a REAL answer and must reach the caller as a 502
// carrying upstream's own code and message — never as a 200 whose data is empty.
func TestCoinankUpstreamRefusalIs502(t *testing.T) {
	h := caServer(t, &caDoer{refusal: `{"success":false,"code":"0","extCode":null,"msg":"system error!","data":null}`})
	rec := caGet(t, h, "/api/coinank?mode=etf")
	if rec.Code != 502 {
		t.Fatalf("status = %d, want 502 (body %s)", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if body["error"] != coinank.ErrUpstream {
		t.Fatalf("error = %v, want %q", body["error"], coinank.ErrUpstream)
	}
	if body["code"] != "0" {
		t.Fatalf("code = %v, want upstream's own 0", body["code"])
	}
	if d, _ := body["detail"].(string); !strings.Contains(d, "system error!") {
		t.Fatalf("upstream's message was lost: %v", body["detail"])
	}
}

// TestCoinankMethodNotAllowed: the family is read-only.
func TestCoinankMethodNotAllowed(t *testing.T) {
	h := caServer(t, &caDoer{fixture: "real-liquidation"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/coinank?mode=liquidation", strings.NewReader("{}")))
	if rec.Code != 405 {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

// TestCoinankHealthzNamesTheFamily: the family must be visible from one probe,
// labelled keyless AND distinguished from coinglass's different keyless scheme.
func TestCoinankHealthzNamesTheFamily(t *testing.T) {
	h := caServer(t, &caDoer{fixture: "real-liquidation"})
	rec := caGet(t, h, "/healthz")
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("healthz: %v", err)
	}
	got, _ := body["coinank"].(string)
	if !strings.Contains(got, "keyless") {
		t.Fatalf("healthz coinank = %q, want it to say keyless", got)
	}
	if !strings.Contains(got, "client signature") {
		t.Fatalf("healthz coinank = %q, want it to distinguish the scheme from coinglass's decryption", got)
	}
	// The cryptorank `build` key must stay untouched (existing gates assert it).
	if b, _ := body["build"].(string); !strings.Contains(b, "modes") {
		t.Fatalf("healthz build = %q", b)
	}
}

// caTransientRefusal is CoinAnk's measured self-clearing refusal, inline
// because the identically-shaped constant in the coinank package is
// unexported and this test lives in the main package.
const caTransientRefusal = `{"success":false,"code":"403","extCode":null,` +
	`"msg":"please sub api to get data","data":null}`

// TestCoinankStaleIsLabelledOnTheWire: with a warm cache and a wall upstream,
// the route answers 200 carrying the LAST GOOD body, X-CA-Cache: STALE and
// stale/staleAgeSec in the envelope -- the boards keep their data and the
// label tells the truth. fresh=1 must NOT take the fallback: the live verifier
// depends on a fresh read failing loudly rather than serving old data.
func TestCoinankStaleIsLabelledOnTheWire(t *testing.T) {
	clock := time.Unix(1790969044000, 0)
	d := &caDoer{
		fixture:   "real-liquidation",
		refusal:   caTransientRefusal,
		failAfter: 1,
	}
	f, err := coinank.New(coinank.Options{
		Client:   d,
		CacheDir: t.TempDir(),
		Now:      func() time.Time { return clock },
	})
	if err != nil {
		t.Fatalf("coinank.New: %v", err)
	}
	h := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{},
		chainrank.Service{}, coinglass.Service{}, coinank.Service{F: f}, coinmarketcap.Service{}).mux()

	coinank.Now = func() int64 { return clock.Unix() }
	t.Cleanup(func() { coinank.Now = func() int64 { return time.Now().Unix() } })

	// Prime the cache from the fixture.
	rec := caGet(t, h, "/api/coinank?mode=liquidation&interval=1h")
	if rec.Code != 200 {
		t.Fatalf("prime: status %d, body %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-CA-Cache"); got != "MISS" {
		t.Fatalf("prime X-CA-Cache = %q, want MISS", got)
	}

	// Move past the liquidation TTL (300s); upstream now refuses every call.
	clock = clock.Add(600 * time.Second)
	rec = caGet(t, h, "/api/coinank?mode=liquidation&interval=1h")
	if rec.Code != 200 {
		t.Fatalf("stale serve must be a 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-CA-Cache"); got != "STALE" {
		t.Errorf("X-CA-Cache = %q, want STALE", got)
	}
	var body struct {
		Stale         bool  `json:"stale"`
		StaleAgeSec   int64 `json:"staleAgeSec"`
		FetchedAt     int64 `json:"fetchedAt"`
		UpstreamCount *int  `json:"upstreamCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("stale body: %v", err)
	}
	if !body.Stale || body.StaleAgeSec != 600 {
		t.Errorf("stale=%v staleAgeSec=%d, want true/600", body.Stale, body.StaleAgeSec)
	}
	if want := clock.Add(-600 * time.Second).Unix(); body.FetchedAt != want {
		t.Errorf("fetchedAt = %d, want %d (the moment the data was true)", body.FetchedAt, want)
	}
	if body.UpstreamCount == nil || *body.UpstreamCount == 0 {
		t.Errorf("the stale body must still carry its row count, got %v", body.UpstreamCount)
	}

	// fresh=1 over the wall: loud 502, never the stale fallback.
	rec = caGet(t, h, "/api/coinank?mode=liquidation&interval=1h&fresh=1")
	if rec.Code != 502 {
		t.Errorf("fresh over a wall must be 502, got %d: %s", rec.Code, rec.Body.String())
	}
}
