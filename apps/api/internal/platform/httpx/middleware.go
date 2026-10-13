package httpx

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"
)

// Response hardening: three middlewares, one concern each (package-doc rule —
// no business logic). They stamp headers on the shared header map before any
// body byte exists; Gzip sits innermost in the chain because its decision
// needs the final status, Content-Type and size.

// Harden stamps the hardening headers on every response.
//
// This API serves JSON only — there is no HTML document here to protect with
// a loose policy, so the CSP is deliberately maximally restrictive:
// default-src 'none' plus frame-ancestors 'none' says "this origin renders
// nothing, embeds nothing, and may not be embedded" — correct for a pure
// JSON body and identical in spirit to the web tier's report-only CSP
// (next.config.js) without its unsafe-inline escape hatches.
//
// HSTS is a TLS-terminating concern, and TLS terminates at the Cloudflare
// tunnel (DR-002) — the listener itself is loopback HTTP, so r.TLS is nil on
// the deployed path. The header is therefore emitted when the request arrived
// over TLS (r.TLS set: a future TLS-terminating listener) or when the tunnel
// forwarded proto says https. A forger on the loopback hop can only attach
// HSTS to a plaintext response, and browsers ignore HSTS carried over
// plaintext, so spoofing buys nothing.
func Harden(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		if r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// cacheControlByPath is the Cache-Control policy, keyed by exact path (the
// mux patterns are exact and the query string never decides caching).
//
//	probes       no-store — /healthz and /readyz are ops truth; a cached
//	             "ok" is a lie that outlives the thing it reported.
//	admin list   private, max-age=30 — the body is cookie-gated per-user
//	             data, so `private` keeps every shared cache out (it must
//	             never be stored by a proxy), while max-age=30 lets the
//	             BROWSER replay it within 30s. That window is deliberately
//	             shorter than the server's 60s stale-while-revalidate TTL:
//	             the client may never be staler than the server would be.
//	             no-store here would be safe too, but it forfeits the whole
//	             cache story on the browser side for an admin panel that
//	             re-reads on every render.
//	auth routes  no-store — login/callback/logout set or retire the session
//	             cookie; a stored redirect replays auth state.
var cacheControlByPath = map[string]string{
	"/healthz":           "no-store",
	"/readyz":            "no-store",
	"/api/admin/members": "private, max-age=30",
	"/api/auth/login":    "no-store",
	"/api/auth/callback": "no-store",
	"/api/auth/logout":   "no-store",
}

// CacheControl stamps the per-route Cache-Control from cacheControlByPath.
// Routes absent from the map (the 404 envelope, 405 refusals) get no header:
// no policy was decided for them, and inventing one here would be a guess.
func CacheControl(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if v, ok := cacheControlByPath[r.URL.Path]; ok {
			w.Header().Set("Cache-Control", v)
		}
		next.ServeHTTP(w, r)
	})
}

// gzipMinBytes is the compression floor. Below it the gzip stream header
// (~10 bytes before a single payload byte) buys nothing measurable while the
// CPU cost lands directly on p50, so health probes (28 B) and error
// envelopes (~150-230 B) always take the identity path untouched.
const gzipMinBytes = 1 << 10

// Gzip compresses response bodies when — and only when — every condition
// holds: the client accepts gzip, the status may carry a body, the type is
// application/json (the only body type this API has), the body is at least
// gzipMinBytes, and the result is actually smaller.
//
// The response is buffered — this API's bodies are small, handler-produced
// JSON, never a stream — so the decision is made once with the final status,
// type and size in hand: exact Content-Length either way (identity bodies are
// byte-identical to a server without this middleware), no double-wrapping,
// and a failed or larger-than-original gzip silently falls back to identity.
// Vary: Accept-Encoding rides on every JSON response, because negotiation
// can vary for a later request even when this one stayed identity.
func Gzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gw := &gzipResponseWriter{ResponseWriter: w}
		next.ServeHTTP(gw, r)
		gw.flush(r)
	})
}

// gzipResponseWriter buffers the handler's output. Header() is the real
// writer's header map (via the embedded ResponseWriter), so headers stamped
// by outer middlewares and by the handler share one map that flush consults.
type gzipResponseWriter struct {
	http.ResponseWriter
	status      int
	body        bytes.Buffer
	wroteHeader bool
}

// WriteHeader records the first status; later calls are ignored, exactly as
// net/http treats them.
func (g *gzipResponseWriter) WriteHeader(code int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	g.status = code
}

// Write buffers bytes and implies 200 when no status was set.
func (g *gzipResponseWriter) Write(p []byte) (int, error) {
	if !g.wroteHeader {
		g.wroteHeader = true
		g.status = http.StatusOK
	}
	return g.body.Write(p)
}

// Unwrap exposes the real writer to http.ResponseController, so a future
// Flush/CloseWrite on this chain reaches the connection instead of silently
// vanishing into the buffer.
func (g *gzipResponseWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

// flush emits the buffered response: identity by default, gzip only when
// every eligibility rule holds.
func (g *gzipResponseWriter) flush(r *http.Request) {
	if !g.wroteHeader {
		return // handler produced nothing; the server answers its own default
	}
	payload := g.body.Bytes()
	h := g.Header()
	isJSON := strings.HasPrefix(h.Get("Content-Type"), "application/json")
	if isJSON {
		// Negotiation can vary even for responses sent identity this time.
		h.Set("Vary", "Accept-Encoding")
		if acceptsGzip(r.Header.Get("Accept-Encoding")) &&
			mayCompressStatus(g.status) &&
			len(payload) >= gzipMinBytes {
			if packed, ok := gzipBestSpeed(payload); ok {
				h.Set("Content-Encoding", "gzip")
				payload = packed
			}
		}
	}
	h.Set("Content-Length", strconv.Itoa(len(payload)))
	g.ResponseWriter.WriteHeader(g.status)
	if len(payload) > 0 {
		_, _ = g.ResponseWriter.Write(payload)
	}
}

// gzipBestSpeed compresses at BestSpeed and reports ok only when the result
// is a strict improvement — any encoder error or expansion keeps the
// original bytes, so gzip can never make a response worse.
func gzipBestSpeed(payload []byte) ([]byte, bool) {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
	if err != nil {
		return nil, false
	}
	if _, err := zw.Write(payload); err != nil {
		return nil, false
	}
	if err := zw.Close(); err != nil {
		return nil, false
	}
	if buf.Len() >= len(payload) {
		return nil, false
	}
	return buf.Bytes(), true
}

// mayCompressStatus reports whether a response at code may carry a body at
// all: the bodyless statuses (1xx, 204, 205, 304) are excluded; everything
// else is gated by type and size anyway.
func mayCompressStatus(code int) bool {
	switch {
	case code < 200:
		return false
	case code == http.StatusNoContent, code == http.StatusResetContent, code == http.StatusNotModified:
		return false
	}
	return true
}

// acceptsGzip parses Accept-Encoding with q-values: `gzip;q=0` is a refusal,
// a bare `gzip` (or `*` when gzip itself is silent) is consent, and an
// explicit gzip entry overrides any wildcard.
func acceptsGzip(header string) bool {
	sawGzip, gzipYes, wildcardYes := false, false, false
	for _, item := range strings.Split(header, ",") {
		parts := strings.Split(item, ";")
		name := strings.TrimSpace(parts[0])
		positive := true
		for _, param := range parts[1:] {
			kv := strings.SplitN(param, "=", 2)
			if len(kv) == 2 && strings.TrimSpace(kv[0]) == "q" {
				if q, err := strconv.ParseFloat(strings.TrimSpace(kv[1]), 64); err == nil && q <= 0 {
					positive = false
				}
			}
		}
		switch {
		case strings.EqualFold(name, "gzip"):
			sawGzip, gzipYes = true, positive
		case name == "*" && positive:
			wildcardYes = true
		}
	}
	if sawGzip {
		return gzipYes
	}
	return wildcardYes
}
