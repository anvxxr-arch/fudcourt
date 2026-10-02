package main

// Wire-contract tests for the frozen HTTP surface. These use a fake fetcher so
// every error body, header and refusal can be proven without touching
// upstream; the live smoke test lives in smoke-data.sh.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/chainrank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinglass"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/cryptorank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/khala"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/llama"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/news"
)

type fakeFetcher struct {
	mu    sync.Mutex
	ttls  []int
	calls []string
	resp  func(route, target string) (*cryptorank.HelperOut, error)
	err   error
}

func (f *fakeFetcher) Fetch(_ context.Context, route, target string, ttl int) (*cryptorank.HelperOut, error) {
	f.mu.Lock()
	f.ttls = append(f.ttls, ttl)
	f.calls = append(f.calls, route+" "+target)
	fn, err := f.resp, f.err
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if fn != nil {
		return fn(route, target)
	}
	// Minimal happy payload: every mode's envelope refuses loudly without its
	// expected slice, so a per-mode fixture is supplied by the test.
	return &cryptorank.HelperOut{OK: true, Path: target, Route: route, FetchedAt: 1790000000, Cache: "MISS"}, nil
}

func get(t *testing.T, f *fakeFetcher, url string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	srv := newServer(f, 60, khala.Service{}, llama.Service{}, news.Service{}, chainrank.Service{}, coinglass.Service{}, coinank.Service{})
	srv.retryBase = 0 // prove the retry policy without sleeping
	srv.mux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("response is not JSON (%d): %s", rec.Code, rec.Body.String())
	}
	return m
}

func TestHealthz(t *testing.T) {
	rec := get(t, &fakeFetcher{}, "/healthz")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	body := decode(t, rec)
	if body["ok"] != true {
		t.Errorf("ok=%v", body["ok"])
	}
	if body["build"] != "28 modes" {
		t.Errorf("build=%v", body["build"])
	}
	// khala is a second family with its own mode table; healthz reports both,
	// and the cryptorank count above must stay untouched by its arrival.
	if body["khala"] != "3 modes" {
		t.Errorf("khala=%v", body["khala"])
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type %q", ct)
	}
}

func TestUnknownModeIs400WithAllModes(t *testing.T) {
	for _, url := range []string{"/api/cryptorank", "/api/cryptorank?mode=lolnope", "/api/cryptorank?mode="} {
		rec := get(t, &fakeFetcher{}, url)
		if rec.Code != 400 {
			t.Fatalf("%s: status %d", url, rec.Code)
		}
		body := decode(t, rec)
		if body["error"] != "unknown mode" {
			t.Errorf("%s: error=%v", url, body["error"])
		}
		modes, ok := body["modes"].([]interface{})
		if !ok || len(modes) != 28 {
			t.Fatalf("%s: modes=%v", url, body["modes"])
		}
	}
	rec := get(t, &fakeFetcher{}, "/api/cryptorank?mode=lolnope")
	if got := decode(t, rec)["got"]; got != "lolnope" {
		t.Errorf("got=%v", got)
	}
	// A missing mode is JS null, not "".
	rec = get(t, &fakeFetcher{}, "/api/cryptorank")
	if got, present := decode(t, rec)["got"]; !present || got != nil {
		t.Errorf("missing mode: got=%v present=%v", got, present)
	}
}

func TestDisabledModesAre503WithVerbatimReason(t *testing.T) {
	for _, mode := range []string{"funding", "unlocks"} {
		rec := get(t, &fakeFetcher{}, "/api/cryptorank?mode="+mode)
		if rec.Code != 503 {
			t.Fatalf("%s: status %d", mode, rec.Code)
		}
		body := decode(t, rec)
		if body["disabled"] != true {
			t.Errorf("%s: disabled=%v", mode, body["disabled"])
		}
		if body["kind"] != mode {
			t.Errorf("%s: kind=%v", mode, body["kind"])
		}
		reason, _ := body["error"].(string)
		if !strings.HasPrefix(reason, "upstream /_next/data serves synthetic decoy") {
			t.Errorf("%s: reason=%q", mode, reason)
		}
		if !strings.Contains(reason, "(2026-09-27) -- disabled until the slug-404 + independent-source tests pass") {
			t.Errorf("%s: reason tail=%q", mode, reason)
		}
		if body["reverify"] != "scripts/verify-cryptorank.py (nonexistent-slug must 404 + independent ground-truth match)" {
			t.Errorf("%s: reverify=%v", mode, body["reverify"])
		}
		if body["upstream"] != "https://cryptorank.io/funding-rounds" && body["upstream"] != "https://cryptorank.io/token-unlock" {
			t.Errorf("%s: upstream=%v", mode, body["upstream"])
		}
	}
}

func TestInvalidKeyIs400(t *testing.T) {
	cases := []struct {
		url    string
		mode   string
		key    string
		detail string
	}{
		{"/api/cryptorank?mode=coin&key=%21%21%21", "coin", "!!!", "key must match ^[a-z0-9][a-z0-9-]{0,63}$ (lowercase alnum + dashes, 1-64)"},
		{"/api/cryptorank?mode=coin&key=", "coin", "bitcoin", ""}, // empty -> default, NOT an error
		{"/api/cryptorank?mode=rwaasset&key=gold", "rwaasset", "gold", "key must be <plural-type>/<slug>, plural-type in bonds|commodities|etfs|stocks (never clamped)"},
		{"/api/cryptorank?mode=rwaasset&key=bonds/BAD", "rwaasset", "bonds/BAD", "key must be <plural-type>/<slug>, plural-type in bonds|commodities|etfs|stocks (never clamped)"},
	}
	for _, tc := range cases {
		f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
			return nil, &cryptorank.HelperErr{Status: 200, Err: "stop"}
		}}
		rec := get(t, f, tc.url)
		body := decode(t, rec)
		if tc.detail == "" {
			// default key: the request must have gone through to the fetch layer
			if len(f.calls) == 0 {
				t.Fatalf("%s: empty key was treated as invalid: %v", tc.url, body)
			}
			continue
		}
		if rec.Code != 400 {
			t.Fatalf("%s: status %d (%v)", tc.url, rec.Code, body)
		}
		if body["error"] != "invalid key" || body["detail"] != tc.detail {
			t.Errorf("%s: error=%v detail=%v", tc.url, body["error"], body["detail"])
		}
		if body["mode"] != tc.mode || body["key"] != tc.key {
			t.Errorf("%s: mode=%v key=%v", tc.url, body["mode"], body["key"])
		}
	}
}

func TestInvalidListKeysAre400(t *testing.T) {
	cases := []struct {
		url, errName string
		allowed      int
		key          string
	}{
		{"/api/cryptorank?mode=exchanges&key=nope", "invalid exchange list", 4, "nope"},
		{"/api/cryptorank?mode=launchpool&key=nope", "invalid launchpool list", 3, "nope"},
		{"/api/cryptorank?mode=nodesale&key=nope", "invalid nodesale list", 3, "nope"},
	}
	for _, tc := range cases {
		rec := get(t, &fakeFetcher{}, tc.url)
		if rec.Code != 400 {
			t.Fatalf("%s: status %d", tc.url, rec.Code)
		}
		body := decode(t, rec)
		if body["error"] != tc.errName {
			t.Errorf("%s: error=%v", tc.url, body["error"])
		}
		allowed, ok := body["allowed"].([]interface{})
		if !ok || len(allowed) != tc.allowed {
			t.Errorf("%s: allowed=%v", tc.url, body["allowed"])
		}
		if body["key"] != tc.key {
			t.Errorf("%s: key=%v", tc.url, body["key"])
		}
	}
}

func TestKeyedPathsAndDefaults(t *testing.T) {
	cases := []struct {
		url      string
		path     string
		upstream string
	}{
		{"/api/cryptorank?mode=coin", "/price/bitcoin", "https://cryptorank.io/price/bitcoin"},
		{"/api/cryptorank?mode=coin&key=ethereum", "/price/ethereum", "https://cryptorank.io/price/ethereum"},
		{"/api/cryptorank?mode=exchanges", "/exchanges/cex/spot", "https://cryptorank.io/exchanges/cex/spot"},
		{"/api/cryptorank?mode=exchanges&key=dex/spot", "/exchanges/dex/spot", "https://cryptorank.io/exchanges/dex/spot"},
		{"/api/cryptorank?mode=launchpool&key=upcoming", "/upcoming-launchpool", "https://cryptorank.io/upcoming-launchpool"},
		{"/api/cryptorank?mode=nodesale&key=active", "/active-nodesale", "https://cryptorank.io/active-nodesale"},
		{"/api/cryptorank?mode=rwaasset", "/rwa/stocks/wendy-s", "https://cryptorank.io/rwa/stocks/wendy-s"},
		{"/api/cryptorank?mode=categories", "/categories/chain", "https://cryptorank.io/categories/chain"},
		{"/api/cryptorank?mode=home", "/", "https://cryptorank.io/"},
	}
	for _, tc := range cases {
		f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
			return nil, &cryptorank.HelperErr{Status: 599, Err: "sentinel"}
		}}
		rec := get(t, f, tc.url)
		body := decode(t, rec)
		if body["upstream"] != tc.upstream {
			t.Errorf("%s: upstream=%v want %v", tc.url, body["upstream"], tc.upstream)
		}
		if len(f.calls) != 1 || f.calls[0] != "html "+tc.path {
			t.Errorf("%s: fetched %v want html %s", tc.url, f.calls, tc.path)
		}
	}
}

func TestUpstream404Becomes404(t *testing.T) {
	f := &fakeFetcher{err: &cryptorank.HelperErr{Path: "/price/zzznoexist9999", Route: "html", Status: 404, Err: "upstream HTTP 404"}}
	rec := get(t, f, "/api/cryptorank?mode=coin&key=zzznoexist9999")
	if rec.Code != 404 {
		t.Fatalf("status %d", rec.Code)
	}
	body := decode(t, rec)
	if body["error"] != "upstream 404: no such resource" {
		t.Errorf("error=%v", body["error"])
	}
	if body["mode"] != "coin" || body["key"] != "zzznoexist9999" || body["upstreamStatus"] != float64(404) {
		t.Errorf("body=%v", body)
	}
}

func TestNewstagSoft404Becomes404(t *testing.T) {
	f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
		return &cryptorank.HelperOut{OK: true, FetchedAt: 1790000000, Cache: "MISS",
			PageProps: map[string]interface{}{"tag": nil, "news": []interface{}{}}}, nil
	}}
	rec := get(t, f, "/api/cryptorank?mode=newstag&key=nope-tag")
	if rec.Code != 404 {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["error"] != "upstream ships tag:null for this slug (soft-404) -> no such tag" {
		t.Errorf("error=%v", body["error"])
	}
	if body["upstreamStatus"] != float64(200) || body["key"] != "nope-tag" {
		t.Errorf("body=%v", body)
	}
}

func TestChallengeIsLoud502(t *testing.T) {
	f := &fakeFetcher{err: &cryptorank.HardError{
		Kind:   "cf-challenge",
		Status: 403,
		Detail: "upstream cf-mitigated: challenge (Cloudflare wall -- TLS/h2 fingerprint rejected or profile stale)",
		Upstrl: "https://cryptorank.io/all-coins-list",
	}}
	rec := get(t, f, "/api/cryptorank?mode=coins")
	if rec.Code != 502 {
		t.Fatalf("status %d", rec.Code)
	}
	body := decode(t, rec)
	if body["error"] != "upstream cf-mitigated: challenge (Cloudflare wall -- TLS/h2 fingerprint rejected or profile stale)" {
		t.Errorf("error=%v", body["error"])
	}
	if body["upstreamStatus"] != float64(403) {
		t.Errorf("upstreamStatus=%v", body["upstreamStatus"])
	}
	if body["upstream"] != "https://cryptorank.io/all-coins-list" || body["kind"] != "coins" {
		t.Errorf("body=%v", body)
	}
}

func TestUpstream429RetriesThreeAttemptsThenRealVerdict(t *testing.T) {
	var calls int
	f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
		calls++
		if calls < 3 {
			return nil, &cryptorank.HelperErr{Status: 429, Err: "upstream HTTP 429"}
		}
		return &cryptorank.HelperOut{OK: true, FetchedAt: 1790000000, Cache: "MISS",
			PageProps: map[string]interface{}{"coins": []interface{}{}}}, nil
	}}
	rec := get(t, f, "/api/cryptorank?mode=coins")
	if rec.Code != 200 {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	if calls != 3 {
		t.Errorf("calls=%d want 3", calls)
	}
	// Retries exhausted -> the 429 is reported as the real verdict.
	calls = 0
	f2 := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
		calls++
		return nil, &cryptorank.HelperErr{Status: 429, Err: "upstream HTTP 429 (Cloudflare wall or stale route)"}
	}}
	rec = get(t, f2, "/api/cryptorank?mode=coins")
	if rec.Code != 502 || calls != 3 {
		t.Fatalf("status %d calls %d", rec.Code, calls)
	}
	if got := decode(t, rec)["upstreamStatus"]; got != float64(429) {
		t.Errorf("upstreamStatus=%v", got)
	}
}

func TestFreshPassesTTLZeroPerRequest(t *testing.T) {
	f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
		return &cryptorank.HelperOut{OK: true, FetchedAt: 1790000000, Cache: "MISS",
			PageProps: map[string]interface{}{"coins": []interface{}{}}}, nil
	}}
	get(t, f, "/api/cryptorank?mode=coins")
	get(t, f, "/api/cryptorank?mode=coins&fresh=1")
	if fmt.Sprint(f.ttls) != "[60 0]" {
		t.Errorf("ttl per-request values %v want [60 0]", f.ttls)
	}
}

// A fresh populating run must never leave the TTL lowered for a later ordinary
// request, and the two must not be able to observe each other's value.
func TestTTLIsNotSharedState(t *testing.T) {
	f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
		return &cryptorank.HelperOut{OK: true, FetchedAt: 1790000000, Cache: "MISS",
			PageProps: map[string]interface{}{"coins": []interface{}{}}}, nil
	}}
	srv := newServer(f, 60, khala.Service{}, llama.Service{}, news.Service{}, chainrank.Service{}, coinglass.Service{}, coinank.Service{})
	srv.retryBase = 0
	h := srv.mux()
	for i := range 12 {
		url := "/api/cryptorank?mode=coins"
		if i%2 == 0 {
			url += "&fresh=1"
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
		if rec.Code != 200 {
			t.Fatalf("%s: status %d", url, rec.Code)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, ttl := range f.ttls {
		want := 0
		if i%2 == 1 {
			want = 60
		}
		if ttl != want {
			t.Fatalf("call %d: ttl=%d want %d (all=%v)", i, ttl, want, f.ttls)
		}
	}
}

func TestEnvelopeFailureIs502NotAnEmptyEnvelope(t *testing.T) {
	// A live mode whose expected slice is missing must refuse, not fabricate.
	f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
		return &cryptorank.HelperOut{OK: true, FetchedAt: 1790000000, Cache: "MISS",
			PageProps: map[string]interface{}{"unexpected": true}}, nil
	}}
	rec := get(t, f, "/api/cryptorank?mode=blockchains")
	if rec.Code != 502 {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if fmt.Sprint(body["error"]) != "blockchains: missing blockchains array" {
		t.Errorf("error=%v", body["error"])
	}
	// A mode whose upstream slice is legitimately allowed to be absent (coins
	// uses Array.isArray ? : []) must instead answer 200 with count 0 -- that is
	// what the TS route does, and the port must not invent a refusal.
	zero := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
		return &cryptorank.HelperOut{OK: true, FetchedAt: 1790000000, Cache: "MISS",
			PageProps: map[string]interface{}{}}, nil
	}}
	rec = get(t, zero, "/api/cryptorank?mode=coins")
	if rec.Code != 200 {
		t.Fatalf("empty coins: status %d (%s)", rec.Code, rec.Body.String())
	}
	if got := decode(t, rec)["count"]; got != float64(0) {
		t.Errorf("empty coins count=%v", got)
	}
}

func TestEnvelopeHeaders(t *testing.T) {
	f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
		return &cryptorank.HelperOut{OK: true, FetchedAt: 1790000000, Cache: "HIT",
			PageProps: map[string]interface{}{"coins": []interface{}{
				map[string]interface{}{"key": "bitcoin", "name": "Bitcoin", "symbol": "BTC"},
			}}}, nil
	}}
	rec := get(t, f, "/api/cryptorank?mode=coins")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if got := rec.Header().Get("X-CR-Cache"); got != "HIT" {
		t.Errorf("X-CR-Cache=%q", got)
	}
	if got := rec.Header().Get("X-CR-Upstream"); got != "https://cryptorank.io/all-coins-list" {
		t.Errorf("X-CR-Upstream=%q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=30" {
		t.Errorf("Cache-Control=%q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type=%q", got)
	}
	body := decode(t, rec)
	if body["kind"] != "coins" || body["cache"] != "HIT" || body["count"] != float64(1) {
		t.Errorf("body=%v", body)
	}
	if body["upstream"] != rec.Header().Get("X-CR-Upstream") {
		t.Errorf("header upstream %q != body upstream %v", rec.Header().Get("X-CR-Upstream"), body["upstream"])
	}
}

func TestErrorsAreNotReusable(t *testing.T) {
	// sentinel: a non-helper, non-hard error must still be reported as 502 with
	// its real text, never swallowed.
	f := &fakeFetcher{err: errors.New("boom")}
	rec := get(t, f, "/api/cryptorank?mode=coins")
	if rec.Code != 502 {
		t.Fatalf("status %d", rec.Code)
	}
	if got := decode(t, rec)["error"]; got != "boom" {
		t.Errorf("error=%v", got)
	}
	if got, present := decode(t, rec)["upstreamStatus"]; !present || got != nil {
		t.Errorf("upstreamStatus=%v present=%v", got, present)
	}
}
