package cryptorank

import (
	"testing"
	"time"
)

// Delta-2 QA: both RFC 9110 Retry-After forms parse, everything else reads
// as "no directive" (0), and the parse is raw — the cap lives in the caller.
func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		in   string
		want time.Duration
	}{
		{"", 0},
		{"   ", 0},
		{"5", 5 * time.Second},
		{" 7 ", 7 * time.Second},
		{"9999", 9999 * time.Second}, // raw; the consumer caps
		{"0", 0},
		{"-3", 0},
		{"garbage", 0},
		{"Sun, 11 Oct 2026 12:00:00 GMT", 24 * time.Hour}, // future HTTP-date
		{"Sat, 10 Oct 2026 13:00:00 GMT", time.Hour},      // future HTTP-date (+1h)
		{"Sat, 10 Oct 2026 11:00:00 GMT", 0},              // already past
	}
	for _, c := range cases {
		if got := parseRetryAfter(c.in, now); got != c.want {
			t.Errorf("parseRetryAfter(%q, now) = %v, want %v", c.in, got, c.want)
		}
	}
}
