package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/chainrank"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/coinank"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/coinglass"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/coinmarketcap"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/khala"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/llama"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/news"
)

// cmcDoer serves a canned body and records every request, so a rejected param
// can be asserted to have never reached upstream at all.
type cmcDoer struct {
	body   string
	status int
	reqs   []string
}

func (d *cmcDoer) Do(req *http.Request) (*http.Response, error) {
	d.reqs = append(d.reqs, req.URL.String())
	status := d.status
	if status == 0 {
		status = 200
	}
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(d.body)),
	}, nil
}

const cmcListingOK = `{"data":{"cryptoCurrencyList":[{"id":1},{"id":2},{"id":3}],"totalCount":"8138"},"status":{"error_code":"0"}}`

func cmcServer(t *testing.T, d *cmcDoer, noCache bool) http.Handler {
	t.Helper()
	f, err := coinmarketcap.New(coinmarketcap.Options{
		Client:   d,
		CacheDir: t.TempDir(),
		NoCache:  noCache,
	})
	if err != nil {
		t.Fatalf("coinmarketcap.New: %v", err)
	}
	return newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{},
		chainrank.Service{}, coinglass.Service{}, coinank.Service{}, coinmarketcap.Service{F: f}).mux()
}

func cmcGet(t *testing.T, h http.Handler, url string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

func TestCmcMethodNotAllowed(t *testing.T) {
	h := cmcServer(t, &cmcDoer{body: cmcListingOK}, true)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/coinmarketcap?mode=listing", nil))
	if rec.Code != 405 {
		t.Fatalf("POST = %d, want 405", rec.Code)
	}
}

func TestCmcUnknownMode(t *testing.T) {
	d := &cmcDoer{body: cmcListingOK}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=nope")
	if rec.Code != 400 {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
	var body struct {
		Error string   `json:"error"`
		Modes []string `json:"modes"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Error != coinmarketcap.ErrUnknownMode {
		t.Errorf("error = %q", body.Error)
	}
	if len(body.Modes) != coinmarketcap.ModeCount {
		t.Errorf("modes = %v, want the full table", body.Modes)
	}
	if len(d.reqs) != 0 {
		t.Errorf("unknown mode reached upstream: %v", d.reqs)
	}
}

func TestCmcUnexpectedParam(t *testing.T) {
	// slug is not a listing param; upstream would IGNORE it, so we must refuse.
	d := &cmcDoer{body: cmcListingOK}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=listing&slug=bitcoin")
	if rec.Code != 400 {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
	if len(d.reqs) != 0 {
		t.Errorf("bad param reached upstream: %v", d.reqs)
	}
}

func TestCmcMarketPairsNeedsSlug(t *testing.T) {
	d := &cmcDoer{body: cmcListingOK}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=marketPairs")
	if rec.Code != 400 {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
	if len(d.reqs) != 0 {
		t.Errorf("missing slug reached upstream: %v", d.reqs)
	}
}

func TestCmcMarketPairsBadSlug(t *testing.T) {
	d := &cmcDoer{body: cmcListingOK}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=marketPairs&slug=Bit%20Coin")
	if rec.Code != 400 {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
	if len(d.reqs) != 0 {
		t.Errorf("bad slug reached upstream: %v", d.reqs)
	}
}

func TestCmcLimitZeroRefusedLocally(t *testing.T) {
	// The empty-list trap: upstream would answer limit=0 with a success
	// envelope carrying an empty list, so it must be refused BEFORE the fetch.
	d := &cmcDoer{body: `{"data":{"cryptoCurrencyList":[],"totalCount":"8138"},"status":{"error_code":"0"}}`}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=listing&limit=0")
	if rec.Code != 400 {
		t.Fatalf("limit=0 = %d, want 400", rec.Code)
	}
	if len(d.reqs) != 0 {
		t.Errorf("limit=0 reached upstream: %v", d.reqs)
	}
}

func TestCmcLimitNonIntegerRefusedLocally(t *testing.T) {
	d := &cmcDoer{body: cmcListingOK}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=listing&limit=abc")
	if rec.Code != 400 {
		t.Fatalf("limit=abc = %d, want 400", rec.Code)
	}
	if len(d.reqs) != 0 {
		t.Errorf("limit=abc reached upstream: %v", d.reqs)
	}
}

func TestCmcStartOutOfRangeRefused(t *testing.T) {
	d := &cmcDoer{body: cmcListingOK}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=listing&start=0")
	if rec.Code != 400 {
		t.Fatalf("start=0 = %d, want 400", rec.Code)
	}
	if len(d.reqs) != 0 {
		t.Errorf("start=0 reached upstream: %v", d.reqs)
	}
}

func TestCmcGlobalRejectsPagination(t *testing.T) {
	d := &cmcDoer{body: `{"data":{"btcDominance":59.0},"status":{"error_code":"0"}}`}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=global&limit=10")
	if rec.Code != 400 {
		t.Fatalf("global&limit = %d, want 400", rec.Code)
	}
	if len(d.reqs) != 0 {
		t.Errorf("global pagination reached upstream: %v", d.reqs)
	}
}

func TestCmcListingHappyPath(t *testing.T) {
	d := &cmcDoer{body: cmcListingOK}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=listing")
	if rec.Code != 200 {
		t.Fatalf("code = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var env coinmarketcap.CmcEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if env.UpstreamCount == nil || *env.UpstreamCount != 3 {
		t.Errorf("upstreamCount = %v, want 3", env.UpstreamCount)
	}
	if env.Auth != coinmarketcap.AuthNote {
		t.Errorf("auth = %q", env.Auth)
	}
	if rec.Header().Get("X-CMC-Cache") != "MISS" {
		t.Errorf("X-CMC-Cache = %q", rec.Header().Get("X-CMC-Cache"))
	}
	if len(d.reqs) != 1 {
		t.Fatalf("upstream calls = %d, want 1", len(d.reqs))
	}
	if !strings.Contains(d.reqs[0], "/cryptocurrency/listing") {
		t.Errorf("upstream url = %q", d.reqs[0])
	}
}

func TestCmcUpstreamRefusalIs502(t *testing.T) {
	// HTTP 200 + error_code != "0" must surface as 502 carrying upstream's code.
	d := &cmcDoer{body: `{"status":{"error_code":"500","error_message":"The system is busy, please try again later!"}}`}
	h := cmcServer(t, d, true)
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=listing")
	if rec.Code != 502 {
		t.Fatalf("code = %d, want 502", rec.Code)
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Error != coinmarketcap.ErrUpstream || body.Code != "500" {
		t.Errorf("body = %+v, want upstream refusal with code 500", body)
	}
}

func TestCmcFreshBypassesCache(t *testing.T) {
	d := &cmcDoer{body: cmcListingOK}
	h := cmcServer(t, d, false) // cache enabled
	_ = cmcGet(t, h, "/api/coinmarketcap?mode=listing")
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=listing&fresh=1")
	if rec.Code != 200 {
		t.Fatalf("code = %d, want 200", rec.Code)
	}
	if rec.Header().Get("X-CMC-Cache") != "MISS" {
		t.Errorf("fresh X-CMC-Cache = %q, want MISS", rec.Header().Get("X-CMC-Cache"))
	}
	if len(d.reqs) != 2 {
		t.Errorf("upstream calls = %d, want 2 (fresh bypassed the cache)", len(d.reqs))
	}
}

func TestCmcDefaultRequestIsCached(t *testing.T) {
	d := &cmcDoer{body: cmcListingOK}
	h := cmcServer(t, d, false)
	_ = cmcGet(t, h, "/api/coinmarketcap?mode=listing")
	rec := cmcGet(t, h, "/api/coinmarketcap?mode=listing")
	if rec.Header().Get("X-CMC-Cache") != "HIT" {
		t.Errorf("second request X-CMC-Cache = %q, want HIT", rec.Header().Get("X-CMC-Cache"))
	}
	if len(d.reqs) != 1 {
		t.Errorf("upstream calls = %d, want 1", len(d.reqs))
	}
}
