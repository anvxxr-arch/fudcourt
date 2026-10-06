package research

import "net/http"

// Doer is the subset of *http.Client the fetchers use.
type Doer interface {
	Do(*http.Request) (*http.Response, error)
}

// SliceBody truncates s to at most n bytes at a rune boundary. It is the
// shared, rune-safe replacement for each family's local truncate/sliceBody
// helper: a naive s[:n] can split a UTF-8 sequence and emit invalid bytes
// into a JSON detail field, so the cut is pushed back to the last rune start.
func SliceBody(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	if cut == 0 {
		// Defensive: n should always be > 0 in practice, so a rune cannot
		// straddle the very start. Fall back to a hard cut rather than
		// returning an empty detail.
		return s[:n]
	}
	return s[:cut]
}

// SliceBodyEllipsis is SliceBody with a trailing marker kept for the callers
// that documented their detail field as "truncated to N bytes".
func SliceBodyEllipsis(s string, n int, ellipsis string) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	if cut == 0 {
		return s[:n] + ellipsis
	}
	return s[:cut] + ellipsis
}

// utf8Start reports whether b can start a UTF-8 rune.
func utf8Start(b byte) bool { return b&0xC0 != 0x80 }
