// Wire-contract tests for the chainrank family (PLAN G13 SG-13.3).
//
// OFFLINE and deterministic: a fake Doer serves canned bodies per URL, so the
// handler -- mode defaulting, the unknown-mode 400, the relayed pagination, the
// X-Cache header, the shape refusals and every error status -- is provable
// without touching chainrank.fyi. The live oracle run belongs to
// scripts/verify/verify-chainrank.py.
package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/apicalls/internal/chainrank"
	"github.com/anvxxr-arch/fudcourt/apps/apicalls/internal/khala"
	"github.com/anvxxr-arch/fudcourt/apps/apicalls/internal/llama"
	"github.com/anvxxr-arch/fudcourt/apps/apicalls/internal/news"
)

// crDoer serves one canned body per path and records the URLs it was asked for,
// so "the pagination reached upstream verbatim" is observable rather than
// asserted from our own URL builder.
type crDoer struct {
	body  map[string]string
	code  int
	urls  []string
	count int
}

func (d *crDoer) Do(req *http.Request) (*http.Response, error) {
	u := req.URL.String()
	d.urls = append(d.urls, u)
	d.count++
	code := d.code
	if code == 0 {
		code = 200
	}
	body, ok := d.body[u]
	if !ok {
		if strings.Contains(u, chainrank.PathStats) {
			body = `{"online":42,"totalClicks":1234,"listings":7,"totalUsdCents":999900,"topUsdCents":500000,"claimTopCents":100}`
		} else {
			body = `{"rows":[{"id":"a","key":"a","kind":"handle","rank":1}],"page":1,"pageSize":50,"total":7,"totalPages":1}`
		}
	}
	return &http.Response{
		StatusCode: code,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    req,
	}, nil
}

func crGet(t *testing.T, d *crDoer, url string) *httptest.ResponseRecorder {
	t.Helper()
	f, err := chainrank.New(chainrank.Options{Client: d, TTL: 15})
	if err != nil {
		t.Fatalf("chainrank.New: %v", err)
	}
	rec := httptest.NewRecorder()
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{}, chainrank.Service{F: f})
	srv.mux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

func TestChainrankHealthzReportsFiveFamilies(t *testing.T) {
	rec := crGet(t, &crDoer{}, "/healthz")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	body := decode(t, rec)
	for k, want := range map[string]string{
		"build": "28 modes", "khala": "3 modes", "llama": "3 modes",
		"news": "1 feeds", "chainrank": "2 modes",
	} {
		if got := body[k]; got != want {
			t.Errorf("healthz[%q] = %v, want %q", k, got, want)
		}
	}
}

func TestChainrankDefaultsToStats(t *testing.T) {
	d := &crDoer{}
	rec := crGet(t, d, "/api/chainrank")
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["kind"] != "stats" {
		t.Fatalf("kind = %v, want stats (the default mode)", body["kind"])
	}
	for _, f := range []string{"online", "totalClicks", "listings", "totalUsdCents", "topUsdCents", "claimTopCents", "upstream", "fetchedAt"} {
		if _, ok := body[f]; !ok {
			t.Errorf("stats body missing %q: %v", f, body)
		}
	}
	if !strings.Contains(body["upstream"].(string), "chainrank.fyi/api/stats") {
		t.Errorf("upstream = %v", body["upstream"])
	}
	if got := rec.Header().Get("X-Cache"); got != "MISS" {
		t.Fatalf("X-Cache = %q, want MISS", got)
	}
}

func TestChainrankRelaysPaginationToUpstreamVerbatim(t *testing.T) {
	// The whole honesty contract: upstream's own clamping is what the board
	// shows, so the value must arrive at upstream unchanged.
	for _, raw := range []string{"page=0", "page=-1", "page=abc", "pageSize=0", "pageSize=1000"} {
		d := &crDoer{}
		rec := crGet(t, d, "/api/chainrank?mode=listings&"+raw)
		if rec.Code != 200 {
			t.Fatalf("%s: status %d", raw, rec.Code)
		}
		if len(d.urls) != 1 {
			t.Fatalf("%s: upstream calls = %d", raw, len(d.urls))
		}
		want := chainrank.Base + chainrank.PathListings + "?" + raw
		if d.urls[0] != want {
			t.Errorf("%s: upstream URL = %q, want %q (pagination must be relayed untouched)", raw, d.urls[0], want)
		}
		if got := decode(t, rec)["kind"]; got != "listings" {
			t.Errorf("%s: kind = %v", raw, got)
		}
	}
}

func TestChainrankUnknownModeIs400(t *testing.T) {
	d := &crDoer{}
	rec := crGet(t, d, "/api/chainrank?mode=bogus")
	if rec.Code != 400 {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	body := decode(t, rec)
	if body["error"] != "unknown mode 'bogus'" {
		t.Fatalf("error = %v", body["error"])
	}
	if body["detail"] != "expected one of stats, listings" {
		t.Fatalf("detail = %v", body["detail"])
	}
	if d.count != 0 {
		t.Fatal("a refused mode must not reach upstream")
	}
}

func TestChainrankShapeRefusalsAre502(t *testing.T) {
	cases := []struct {
		mode string
		body string
	}{
		{"stats", `{"online":null,"totalClicks":1,"listings":1,"totalUsdCents":1,"topUsdCents":1,"claimTopCents":1}`},
		{"stats", `{"totalClicks":1}`},
		{"listings", `{"page":1}`},
		{"listings", `{"rows":null}`},
	}
	for _, c := range cases {
		u := chainrank.Base + chainrank.PathStats
		if c.mode == "listings" {
			u = chainrank.Base + chainrank.PathListings
		}
		d := &crDoer{body: map[string]string{u: c.body}}
		rec := crGet(t, d, "/api/chainrank?mode="+c.mode)
		if rec.Code != 502 {
			t.Errorf("%s %s: status %d, want 502 (never a fake 200 with empty data)", c.mode, c.body, rec.Code)
			continue
		}
		if got := decode(t, rec)["error"]; !strings.Contains(got.(string), "unrecognised shape") {
			t.Errorf("%s: error = %v", c.mode, got)
		}
	}
}

func TestChainrankErrorsKeepTheRealStatus(t *testing.T) {
	cases := []struct {
		code int
		frag string
	}{
		{405, "405 (method gate)"},
		{429, "rate limited (429)"},
		{500, "HTTP 500"},
		{503, "HTTP 503"},
	}
	for _, c := range cases {
		d := &crDoer{code: c.code, body: map[string]string{chainrank.Base + chainrank.PathStats: "<html>wall</html>"}}
		rec := crGet(t, d, "/api/chainrank?mode=stats")
		if rec.Code != c.code {
			t.Errorf("upstream %d -> status %d, want the real status", c.code, rec.Code)
		}
		body := decode(t, rec)
		if got, _ := body["error"].(string); !strings.Contains(got, c.frag) {
			t.Errorf("upstream %d: error = %q, want it to contain %q", c.code, got, c.frag)
		}
		if body["detail"] == nil {
			t.Errorf("upstream %d must quote the real body", c.code)
		}
	}
}

func TestChainrankNonJSONIsLoud(t *testing.T) {
	d := &crDoer{body: map[string]string{chainrank.Base + chainrank.PathStats: "<html>error page</html>"}}
	rec := crGet(t, d, "/api/chainrank?mode=stats")
	if rec.Code != 502 {
		t.Fatalf("status %d, want 502", rec.Code)
	}
	if got := decode(t, rec)["error"]; !strings.Contains(got.(string), "non-JSON body") {
		t.Fatalf("error = %v", got)
	}
}

func TestChainrankRejectsNonGet(t *testing.T) {
	// Writes are NOT proxied: their paths are not on the mux at all, and the
	// read handler refuses any verb but GET/HEAD.
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{}, chainrank.Service{})
	mux := srv.mux()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/chainrank?mode=stats", nil))
	if rec.Code != 405 {
		t.Fatalf("POST status %d, want 405", rec.Code)
	}
	// A write endpoint must not exist on this service, whatever the verb.
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/click", nil))
	if rec.Code != 404 {
		t.Fatalf("POST /api/click status %d, want 404 (writes are never proxied)", rec.Code)
	}
}

func TestChainrankCacheIsPerURL(t *testing.T) {
	d := &crDoer{}
	f, err := chainrank.New(chainrank.Options{Client: d, TTL: 15})
	if err != nil {
		t.Fatal(err)
	}
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{}, chainrank.Service{F: f}).mux()
	do := func(u string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, u, nil))
		return rec
	}
	if got := do("/api/chainrank?mode=listings&pageSize=7").Header().Get("X-Cache"); got != "MISS" {
		t.Fatalf("first = %q, want MISS", got)
	}
	if got := do("/api/chainrank?mode=listings&pageSize=7").Header().Get("X-Cache"); got != "HIT" {
		t.Fatalf("repeat = %q, want HIT", got)
	}
	// A different page IS a different upstream URL, so it must not be served
	// from the first entry -- pagination genuinely selects different data here.
	if got := do("/api/chainrank?mode=listings&pageSize=8").Header().Get("X-Cache"); got != "MISS" {
		t.Fatalf("a different pageSize = %q, want MISS (distinct upstream slices)", got)
	}
	if d.count != 2 {
		t.Fatalf("upstream calls = %d, want 2", d.count)
	}
}

func TestChainrankParamOrderSharesOneCacheEntry(t *testing.T) {
	d := &crDoer{}
	f, err := chainrank.New(chainrank.Options{Client: d, TTL: 15})
	if err != nil {
		t.Fatal(err)
	}
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{}, chainrank.Service{F: f}).mux()
	do := func(u string) string {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, u, nil))
		return rec.Header().Get("X-Cache")
	}
	first := do("/api/chainrank?mode=listings&page=2&pageSize=7")
	second := do("/api/chainrank?mode=listings&pageSize=7&page=2")
	if first != "MISS" || second != "HIT" {
		t.Fatalf("param order produced two entries: %q then %q (want MISS then HIT)", first, second)
	}
	if d.count != 1 {
		t.Fatalf("upstream calls = %d, want 1", d.count)
	}
}
