package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/health"
)

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	newServer(health.NewRegistry()).handler().ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != true || body["service"] != "api" {
		t.Fatalf("healthz body = %v", body)
	}
}

func TestReadyzReportsEachDependency(t *testing.T) {
	reg := health.NewRegistry()
	reg.Register("postgres", func(ctx context.Context) error { return nil })
	rec := httptest.NewRecorder()
	newServer(reg).handler().ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (all deps healthy)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"name":"postgres"`) {
		t.Fatalf("readyz must enumerate dependencies: %s", rec.Body.String())
	}

	reg.Register("valkey", func(ctx context.Context) error { return errors.New("down") })
	rec = httptest.NewRecorder()
	newServer(reg).handler().ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != 503 {
		t.Fatalf("status = %d, want 503 (a down dependency blocks readiness)", rec.Code)
	}
}

func TestUnknownPathIsTheErrorEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()
	newServer(health.NewRegistry()).handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/nope", nil))
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"error"`) || !strings.Contains(rec.Body.String(), `"request_id"`) {
		t.Fatalf("404 must be the normalized envelope: %s", rec.Body.String())
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("every response must carry a correlation id")
	}
}

// TestResponseHardening pins the middleware chain on the three response kinds
// this API emits — health probe, authenticated admin JSON, not-found
// envelope — plus the boundary rules: HSTS only behind TLS/the tunnel hop,
// tiny bodies untouched even when gzip is offered, and an end-to-end gzip
// round trip on a body large enough to cross the compression floor. do()
// sends X-Forwarded-Proto: https, i.e. the deployed tunnel hop (DR-002).
func TestResponseHardening(t *testing.T) {
	srv := newTestServer(t)
	for _, tc := range []struct {
		name, path, cookie string
		wantStatus         int
		wantCache          string
	}{
		{"health probe", "/healthz", "", 200, "no-store"},
		{"admin members", "/api/admin/members", adminCookie(t), 200, "private, max-age=30"},
		{"not-found envelope", "/api/nope", "", 404, ""},
	} {
		rec := do(t, srv, "GET", tc.path, tc.cookie, "")
		if rec.Code != tc.wantStatus {
			t.Fatalf("%s: status = %d, want %d", tc.name, rec.Code, tc.wantStatus)
		}
		h := rec.Header()
		for k, want := range map[string]string{
			"X-Content-Type-Options":    "nosniff",
			"Referrer-Policy":           "no-referrer",
			"X-Frame-Options":           "DENY",
			"Permissions-Policy":        "camera=(), microphone=(), geolocation=()",
			"Content-Security-Policy":   "default-src 'none'; frame-ancestors 'none'",
			"Strict-Transport-Security": "max-age=31536000",
		} {
			if got := h.Get(k); got != want {
				t.Fatalf("%s: %s = %q, want %q", tc.name, k, got, want)
			}
		}
		if got := h.Get("Cache-Control"); got != tc.wantCache {
			t.Fatalf("%s: Cache-Control = %q, want %q", tc.name, got, tc.wantCache)
		}
		if got := h.Get("Content-Encoding"); got != "" {
			t.Fatalf("%s: Content-Encoding = %q without an Accept-Encoding offer", tc.name, got)
		}
		if h.Get("X-Request-Id") == "" {
			t.Fatalf("%s: correlation id must survive the chain", tc.name)
		}
	}

	// The plain loopback hop carries no HSTS: TLS terminates at the tunnel
	// (DR-002), and HSTS from a plaintext response would be ignored anyway.
	rec := httptest.NewRecorder()
	srv.handler().ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("HSTS on a plaintext request = %q, want absent", got)
	}

	// gzip offered, but the 28 B probe is under the floor: the threshold
	// decides, and the body stays byte-identical identity.
	rec = httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	srv.handler().ServeHTTP(rec, req)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("healthz encoded as %q — bodies below the floor stay identity", got)
	}
	if body := rec.Body.String(); body != `{"ok":true,"service":"api"}`+"\n" {
		t.Fatalf("identity body drifted: %q", body)
	}
	if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Fatalf("Vary = %q on a JSON response, want Accept-Encoding", got)
	}

	// End-to-end round trip: readiness with enough registered checks crosses
	// the 1 KiB floor; the gunzipped bytes must equal the identity body.
	reg := health.NewRegistry()
	for i := range 120 {
		reg.Register(fmt.Sprintf("dep-%03d", i), func(context.Context) error { return nil })
	}
	wire := &server{health: reg, discord: srv.discord, secret: routeTestSecret}
	plain := httptest.NewRecorder()
	wire.handler().ServeHTTP(plain, httptest.NewRequest("GET", "/readyz", nil))
	if plain.Body.Len() < 1024 {
		t.Fatalf("readyz fixture is only %d B — below the compression floor", plain.Body.Len())
	}
	packedReq := httptest.NewRequest("GET", "/readyz", nil)
	packedReq.Header.Set("Accept-Encoding", "gzip")
	packed := httptest.NewRecorder()
	wire.handler().ServeHTTP(packed, packedReq)
	if got := packed.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("readyz Content-Encoding = %q, want gzip", got)
	}
	zr, err := gzip.NewReader(bytes.NewReader(packed.Body.Bytes()))
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	decoded, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	if err := zr.Close(); err != nil {
		t.Fatalf("gunzip close: %v", err)
	}
	// health.Run iterates a map, so two calls emit the check ARRAY in
	// different orders — compare the semantic content instead of bytes:
	// same verdict, same check set.
	checkSet := func(raw []byte) []string {
		var body struct {
			OK     bool `json:"ok"`
			Checks []struct {
				Name string `json:"name"`
				OK   bool   `json:"ok"`
			} `json:"checks"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("body does not parse as the readiness envelope: %v", err)
		}
		if !body.OK {
			t.Fatal("ok = false inside a 200 readiness body")
		}
		names := make([]string, 0, len(body.Checks))
		for _, c := range body.Checks {
			if !c.OK {
				t.Fatalf("check %q reported not-ok in a 200 body", c.Name)
			}
			names = append(names, c.Name)
		}
		slices.Sort(names)
		return names
	}
	if id, dec := checkSet(plain.Body.Bytes()), checkSet(decoded); !slices.Equal(id, dec) {
		t.Fatalf("round trip changed the checks: identity %v, decoded %v", id, dec)
	}
}

// TestMembersPrewarmServesFirstRequestHot pins the startup prewarm: the
// cache is populated WITHOUT any request, so the first authenticated members
// read adds zero upstream calls and answers hot.
func TestMembersPrewarmServesFirstRequestHot(t *testing.T) {
	srv, fake := membersServer(t, time.Minute)

	// The same call main() runs as `go api.prewarmMembers()`; synchronous
	// here so "prewarm finished before the first request" is proven, not
	// raced for.
	srv.prewarmMembers()
	if got := fake.tries(); got != 1 {
		t.Fatalf("prewarm upstream attempts = %d, want 1", got)
	}

	start := time.Now()
	rec := do(t, srv, "GET", "/api/admin/members", adminCookie(t), "")
	elapsed := time.Since(start)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if got := fake.tries(); got != 1 {
		t.Fatalf("first request added %d upstream calls — the prewarm did not populate the cache", got-1)
	}
	if elapsed > 250*time.Millisecond {
		t.Fatalf("first request took %v — expected a hot read, not an upstream fetch", elapsed)
	}
}

// TestMembersPrewarmFailureFallsBackToColdMiss pins the failure contract: a
// prewarm against a dead upstream returns promptly (its own 2s cap), caches
// nothing, and leaves the server serving — cold misses answer 503 until
// upstream heals. No panic, no hang.
func TestMembersPrewarmFailureFallsBackToColdMiss(t *testing.T) {
	srv, fake := membersServer(t, time.Minute)
	fake.configure(membersPayload("v1"), true)

	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.prewarmMembers()
	}()
	select {
	case <-done:
	case <-time.After(membersFetchTimeout + time.Second):
		t.Fatal("prewarm hung on an unavailable upstream")
	}
	if got := fake.tries(); got != 1 {
		t.Fatalf("prewarm upstream attempts = %d, want 1 (the failed attempt)", got)
	}

	start := time.Now()
	rec := do(t, srv, "GET", "/api/admin/members", adminCookie(t), "")
	if elapsed := time.Since(start); elapsed >= membersFetchTimeout {
		t.Fatalf("cold miss took %v — must fail fast, well inside the %v cap", elapsed, membersFetchTimeout)
	}
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), "discord_unavailable") {
		t.Fatalf("cold miss: status = %d, body = %s (want 503 discord_unavailable)", rec.Code, rec.Body.String())
	}

	fake.configure(membersPayload("v1"), false)
	rec = do(t, srv, "GET", "/api/admin/members", adminCookie(t), "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"globalName":"v1"`) {
		t.Fatalf("after healing: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := fake.tries(); got != 3 {
		t.Fatalf("upstream attempts = %d, want 3 (prewarm, refused cold miss, healed fetch)", got)
	}
}
