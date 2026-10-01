package main

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Cookie and URL serialization — byte-compatible with Next's own serializers
// (next/server's ResponseCookies and WHATWG URL, measured 2026-10-01) so a
// Set-Cookie or Location emitted here is indistinguishable from the one the TS
// routes emitted:
//
//	fud_session=<token>; Path=/; Expires=<http.TimeFormat>; Max-Age=604800; Secure; HttpOnly; SameSite=lax
//	fud_oauth_state=<enc>; Path=/; Expires=<http.TimeFormat>; Max-Age=600; Secure; HttpOnly; SameSite=lax
//	fud_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax          (retire)
//
// Attribute order, `Max-Age=N` spelling, `SameSite=lax` casing and the
// omission of Expires on a maxAge-0 retire are all part of that byte contract.

// cookieOptions are SESSION_COOKIE_OPTIONS in session.ts: the shared attribute
// set login/callback/logout all emit. Applied by writeCookie.
type cookieOptions struct {
	MaxAge int // seconds; 0 retires the cookie (no Expires attribute, per Next)
}

// jsEncodeURIComponent percent-encodes a cookie value exactly like JavaScript's
// encodeURIComponent (the serializer Next applies to cookie values, measured):
// unreserved are A-Za-z0-9-_.!~*'() and every other byte is %XX (UTF-8,
// uppercase hex).
func jsEncodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	// Byte-wise: a multi-byte rune must encode byte by byte (measured: `ü` is
	// two %XX escapes, never one truncated byte).
	for i := range len(s) {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '.', c == '_', c == '!', c == '~', c == '*', c == '\'', c == '(', c == ')':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0F])
		}
	}
	return b.String()
}

// jsEncodeFormComponent percent-encodes one query component exactly like
// URLSearchParams (WHATWG form serialization, measured against Bun):
// unreserved are A-Za-z0-9*-._, space is '+', every other byte is %XX (UTF-8).
// Note `~` and `'` encode here but stay literal in cookie values — the two
// codecs are genuinely different, and both are pinned by measurement.
func jsEncodeFormComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := range len(s) {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '.', c == '_', c == '*':
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0F])
		}
	}
	return b.String()
}

// jsEncodeURLPath percent-encodes a site-relative path exactly like
// `new URL(path, origin).toString()` (WHATWG path percent-encode set, measured):
// C0 controls, space, `"`, `<`, `>`, backtick, `{`, `}` and every non-ASCII
// byte become %XX (UTF-8); everything else stays literal. Inputs are
// isSafeNext paths, so `?`, `#` and `%` never occur and the encoding cannot
// become ambiguous.
func jsEncodeURLPath(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := range len(s) {
		c := s[i]
		switch {
		case c < 0x21, c > 0x7E,
			c == '"', c == '<', c == '>', c == '`', c == '{', c == '}':
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0F])
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// writeCookie appends one Set-Cookie header in Next's serialized form.
func writeCookie(w http.ResponseWriter, name, value string, now time.Time, opts cookieOptions) {
	var b strings.Builder
	b.WriteString(name)
	b.WriteByte('=')
	b.WriteString(jsEncodeURIComponent(value))
	b.WriteString("; Path=/")
	if opts.MaxAge > 0 {
		b.WriteString("; Expires=")
		b.WriteString(now.Add(time.Duration(opts.MaxAge)*time.Second).UTC().Format(http.TimeFormat))
	}
	b.WriteString("; Max-Age=")
	b.WriteString(strconv.Itoa(opts.MaxAge))
	// SESSION_COOKIE_OPTIONS: secure + httpOnly + sameSite 'lax', always.
	b.WriteString("; Secure; HttpOnly; SameSite=lax")
	w.Header().Add("Set-Cookie", b.String())
}

// readCookieValue reads one cookie the way next/headers' cookie store hands it
// to the TS routes: the raw header value with one decodeURIComponent applied
// (measured — the store decodes values). A value that does not decode reads as
// absent: a tampered cookie is never a session and never a valid OAuth state.
func readCookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil || c.Value == "" {
		return ""
	}
	decoded, err := url.PathUnescape(c.Value)
	if err != nil {
		return ""
	}
	return decoded
}

// requestOrigin rebuilds the public origin the TS routes derived from
// request.url. The Go listener only ever sees the loopback proxy hop, so the
// original scheme/host arrive as X-Forwarded-Proto / X-Forwarded-Host (set by
// the thin proxy). These are routing/redirect inputs ONLY — identity comes
// exclusively from the signed cookie.
func requestOrigin(r *http.Request) string {
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		proto = "http"
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	return proto + "://" + host
}

// methodGuard answers the methods a TS route handler exported and 405s the
// rest (Next does the same for unexported methods). Body shape is the route
// refusal envelope because Next's own 405 has no JSON body to be compatible
// with (documented divergence).
func methodGuard(w http.ResponseWriter, r *http.Request, allowed ...string) bool {
	for _, m := range allowed {
		if r.Method == m {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(allowed, ", "))
	writeRefusal(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "validation", "method not allowed")
	return false
}
