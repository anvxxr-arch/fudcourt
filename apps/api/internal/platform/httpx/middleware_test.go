package httpx

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// jsonHandler answers with exactly body at status — raw bytes, so a gzip
// round trip can be compared byte-for-byte against what went in.
func jsonHandler(status int, contentType, body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(status)
		io.WriteString(w, body)
	})
}

// bigJSON is comfortably over the 1 KiB compression floor.
var bigJSON = `{"ok":true,"pad":"` + strings.Repeat("x", 4000) + `"}`

// serve runs one request through the handler and returns recorder + request.
func serve(t *testing.T, h http.Handler, target string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestHarden pins the hardening headers on every response and the HSTS
// condition: TLS here, or the tunnel's forwarded https; never on plain HTTP.
func TestHarden(t *testing.T) {
	h := Harden(jsonHandler(http.StatusOK, "application/json", `{"ok":true}`))
	for _, tc := range []struct {
		name     string
		target   string // httptest derives r.TLS from an https URL
		hdr      map[string]string
		wantHSTS bool
	}{
		{name: "plain loopback", target: "http://api.test/healthz"},
		{name: "tunnel forwarded https", target: "http://api.test/healthz",
			hdr: map[string]string{"X-Forwarded-Proto": "https"}, wantHSTS: true},
		{name: "forwarded http", target: "http://api.test/healthz",
			hdr: map[string]string{"X-Forwarded-Proto": "http"}},
		{name: "forwarded garbage is not https", target: "http://api.test/healthz",
			hdr: map[string]string{"X-Forwarded-Proto": "javascript"}},
		{name: "tls terminated here", target: "https://api.test/healthz", wantHSTS: true},
	} {
		rec := serve(t, h, tc.target, tc.hdr)
		got := rec.Header()
		for k, want := range map[string]string{
			"X-Content-Type-Options":  "nosniff",
			"Referrer-Policy":         "no-referrer",
			"X-Frame-Options":         "DENY",
			"Permissions-Policy":      "camera=(), microphone=(), geolocation=()",
			"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
		} {
			if v := got.Get(k); v != want {
				t.Fatalf("%s: %s = %q, want %q", tc.name, k, v, want)
			}
		}
		hsts := got.Get("Strict-Transport-Security")
		if tc.wantHSTS && hsts == "" {
			t.Fatalf("%s: Strict-Transport-Security missing (want max-age=31536000)", tc.name)
		}
		if !tc.wantHSTS && hsts != "" {
			t.Fatalf("%s: Strict-Transport-Security = %q on a plaintext request, want absent", tc.name, hsts)
		}
	}
}

// TestCacheControlPolicy pins the per-route Cache-Control and the absence of
// a header on routes where none was decided (query strings never decide).
func TestCacheControlPolicy(t *testing.T) {
	srv := CacheControl(jsonHandler(http.StatusOK, "application/json", `{}`))
	for _, tc := range []struct{ path, want string }{
		{"/healthz", "no-store"},
		{"/readyz", "no-store"},
		{"/api/admin/members", "private, max-age=30"},
		{"/api/auth/login", "no-store"},
		{"/api/auth/callback", "no-store"},
		{"/api/auth/logout", "no-store"},
		{"/api/admin/members?limit=100", "private, max-age=30"},
		{"/api/nope", ""},
		{"/", ""},
	} {
		rec := serve(t, srv, tc.path, nil)
		if got := rec.Header().Get("Cache-Control"); got != tc.want {
			t.Fatalf("Cache-Control for %s = %q, want %q", tc.path, got, tc.want)
		}
	}
}

// TestGzipRoundTrip pins the compressed path: offered gzip + a body over the
// floor compresses, Content-Length matches the wire bytes exactly, and the
// gunzipped bytes are identical to the source JSON.
func TestGzipRoundTrip(t *testing.T) {
	srv := Gzip(jsonHandler(http.StatusOK, "application/json", bigJSON))
	rec := serve(t, srv, "/", map[string]string{"Accept-Encoding": "gzip"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Fatalf("Vary = %q, want Accept-Encoding", got)
	}
	if got := rec.Header().Get("Content-Length"); got != strconv.Itoa(rec.Body.Len()) {
		t.Fatalf("Content-Length = %q, want %d (wire bytes)", got, rec.Body.Len())
	}
	zr, err := gzip.NewReader(bytes.NewReader(rec.Body.Bytes()))
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
	if !bytes.Equal(decoded, []byte(bigJSON)) {
		t.Fatalf("round trip changed the body: %d bytes in, %d out, equal=%v",
			len(bigJSON), len(decoded), bytes.Equal(decoded, []byte(bigJSON)))
	}
}

// TestGzipEligibility is the decision table: every condition that must keep
// a response on the identity path, and the ones that must not. An identity
// response must be byte-identical to what the handler wrote.
func TestGzipEligibility(t *testing.T) {
	small := `{"ok":true}`
	for _, tc := range []struct {
		name        string
		status      int
		body        string
		accept      string
		contentType string
		wantGzip    bool
	}{
		{name: "gzip accepted, large json", status: http.StatusOK, body: bigJSON,
			accept: "gzip", contentType: "application/json", wantGzip: true},
		{name: "Accept-Encoding absent", status: http.StatusOK, body: bigJSON,
			accept: "", contentType: "application/json", wantGzip: false},
		{name: "q=0 refuses gzip", status: http.StatusOK, body: bigJSON,
			accept: "gzip;q=0", contentType: "application/json", wantGzip: false},
		{name: "q=1 accepts gzip", status: http.StatusOK, body: bigJSON,
			accept: "gzip;q=1.0", contentType: "application/json", wantGzip: true},
		{name: "wildcard covers gzip", status: http.StatusOK, body: bigJSON,
			accept: "*", contentType: "application/json", wantGzip: true},
		{name: "explicit refusal beats wildcard", status: http.StatusOK, body: bigJSON,
			accept: "gzip;q=0, *", contentType: "application/json", wantGzip: false},
		{name: "identity only", status: http.StatusOK, body: bigJSON,
			accept: "identity", contentType: "application/json", wantGzip: false},
		{name: "below the 1KiB floor", status: http.StatusOK, body: small,
			accept: "gzip", contentType: "application/json", wantGzip: false},
		{name: "non-json type", status: http.StatusOK, body: bigJSON,
			accept: "gzip", contentType: "text/plain", wantGzip: false},
		{name: "no-content status carries no body", status: http.StatusNoContent,
			body: "", accept: "gzip", contentType: "application/json", wantGzip: false},
		{name: "error json compresses too", status: http.StatusNotFound, body: bigJSON,
			accept: "gzip", contentType: "application/json", wantGzip: true},
	} {
		srv := Gzip(jsonHandler(tc.status, tc.contentType, tc.body))
		rec := serve(t, srv, "/", map[string]string{"Accept-Encoding": tc.accept})
		if rec.Code != tc.status {
			t.Fatalf("%s: status = %d, want %d", tc.name, rec.Code, tc.status)
		}
		encoded := rec.Header().Get("Content-Encoding") == "gzip"
		if encoded != tc.wantGzip {
			t.Fatalf("%s: Content-Encoding = %q, want gzip=%v", tc.name, rec.Header().Get("Content-Encoding"), tc.wantGzip)
		}
		payload := rec.Body.Bytes()
		if tc.wantGzip {
			zr, err := gzip.NewReader(bytes.NewReader(payload))
			if err != nil {
				t.Fatalf("%s: gzip reader: %v", tc.name, err)
			}
			decoded, err := io.ReadAll(zr)
			if err != nil {
				t.Fatalf("%s: gunzip: %v", tc.name, err)
			}
			if !bytes.Equal(decoded, []byte(tc.body)) {
				t.Fatalf("%s: decoded body differs from source", tc.name)
			}
		} else if !bytes.Equal(payload, []byte(tc.body)) {
			t.Fatalf("%s: identity path altered the body", tc.name)
		}
		if tc.body != "" && rec.Header().Get("Content-Length") != strconv.Itoa(len(payload)) {
			t.Fatalf("%s: Content-Length = %q, want %d", tc.name, rec.Header().Get("Content-Length"), len(payload))
		}
	}
}

// TestGzipSetsVaryOnJSONIdentity pins the negotiation marker: Vary must ride
// even an uncompressed JSON response, because a later request may negotiate
// differently.
func TestGzipSetsVaryOnJSONIdentity(t *testing.T) {
	srv := Gzip(jsonHandler(http.StatusOK, "application/json", `{"ok":true}`))
	rec := serve(t, srv, "/", nil)
	if rec.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("Vary = %q on an identity JSON response, want Accept-Encoding", rec.Header().Get("Vary"))
	}
	if rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("small body must never be encoded, got %q", rec.Header().Get("Content-Encoding"))
	}
}
