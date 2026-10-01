package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

// Serialization vectors, all measured against Next's own cookie/URL code
// (next/dist/compiled/@edge-runtime/cookies and Bun's URL/URLSearchParams,
// 2026-10-01). If one of these ever fails, Set-Cookie or Location bytes have
// drifted from what the TS routes emitted and the cutover is no longer
// transparent to browsers.
func TestJSCodecVectors(t *testing.T) {
	cookie := map[string]string{
		"x y+z~!*()'-._": "x%20y%2Bz~!*()'-._", // encodeURIComponent keep-set
		"a./dashboard":   "a.%2Fdashboard",     // state-cookie wire form
		"tok.en":         "tok.en",             // session token is codec-inert
	}
	for in, want := range cookie {
		if got := jsEncodeURIComponent(in); got != want {
			t.Errorf("jsEncodeURIComponent(%q) = %q, want %q", in, got, want)
		}
	}
	form := map[string]string{
		"~!*'() abc":     "%7E%21*%27%28%29+abc", // URLSearchParams keep-set
		"a./dashboard":   "a.%2Fdashboard",
		"identify guilds": "identify+guilds",
	}
	for in, want := range form {
		if got := jsEncodeFormComponent(in); got != want {
			t.Errorf("jsEncodeFormComponent(%q) = %q, want %q", in, got, want)
		}
	}
	path := map[string]string{
		"/a b\"<>`{}ü": "/a%20b%22%3C%3E%60%7B%7D%C3%BC", // WHATWG path set
		"/dashboard":   "/dashboard",
		"/":            "/",
	}
	for in, want := range path {
		if got := jsEncodeURLPath(in); got != want {
			t.Errorf("jsEncodeURLPath(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestSetCookieBytes pins the whole Set-Cookie line, attribute order included,
// against the measured Next serializer output.
func TestSetCookieBytes(t *testing.T) {
	now := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

	rec := httptest.NewRecorder()
	writeCookie(rec, "fud_session", "tok.en", now, cookieOptions{MaxAge: 604800})
	got := rec.Header().Get("Set-Cookie")
	want := "fud_session=tok.en; Path=/; Expires=Thu, 08 Oct 2026 09:00:00 GMT; Max-Age=604800; Secure; HttpOnly; SameSite=lax"
	if got != want {
		t.Errorf("session Set-Cookie = %q\nwant %q", got, want)
	}

	rec = httptest.NewRecorder()
	writeCookie(rec, "fud_oauth_state", "a./dashboard", now, cookieOptions{MaxAge: 600})
	want = "fud_oauth_state=a.%2Fdashboard; Path=/; Expires=Thu, 01 Oct 2026 09:10:00 GMT; Max-Age=600; Secure; HttpOnly; SameSite=lax"
	if got := rec.Header().Get("Set-Cookie"); got != want {
		t.Errorf("state Set-Cookie = %q\nwant %q", got, want)
	}

	rec = httptest.NewRecorder()
	writeCookie(rec, "fud_session", "", now, cookieOptions{MaxAge: 0})
	want = "fud_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax"
	if got := rec.Header().Get("Set-Cookie"); got != want {
		t.Errorf("retire Set-Cookie = %q\nwant %q", got, want)
	}
}
