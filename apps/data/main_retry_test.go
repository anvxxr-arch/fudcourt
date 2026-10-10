package main

// Delta-2 QA: red-first coverage for the 429 retry policy in fetchWithRetry
// (apps/data/main.go) — first the proof that the backoff has NO jitter, then
// (once HelperErr carries the header) that Retry-After is ignored. The
// assertions below were written against the pre-hardening implementation and
// failed there; the implementation change lands only after both are red.

import (
	"context"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research/cryptorank"
)

// The linear backoff is retryBase*(attempt+1): with no jitter every run of
// the same 429 storm sleeps the identical total (300 ms here), so N runs
// cannot spread. Jitter must keep each run inside ±20% of the nominal total
// (240–360 ms + scheduling slack) while making the runs disagree by at least
// 30 ms — both properties fail on the pre-hardening code (zero spread).
func TestFetchWithRetryJitters429Backoff(t *testing.T) {
	const (
		runs    = 8
		base    = 100 * time.Millisecond
		nominal = 300 * time.Millisecond // base*1 + base*2 (two sleeps of three attempts)
	)
	var totals []time.Duration
	for i := 0; i < runs; i++ {
		f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
			return nil, &cryptorank.HelperErr{Status: 429, Err: "upstream HTTP 429"}
		}}
		start := time.Now()
		_, err := fetchWithRetry(context.Background(), f, "coins", "/all-coins-list", 60, base)
		elapsed := time.Since(start)
		if err == nil {
			t.Fatalf("run %d: want the exhausted-429 error, got nil", i)
		}
		if elapsed < nominal-80*time.Millisecond {
			t.Fatalf("run %d: elapsed %v, the backoff did not wait its nominal ~%v", i, elapsed, nominal)
		}
		if elapsed > nominal+100*time.Millisecond {
			t.Fatalf("run %d: elapsed %v, backoff overshot nominal %v by more than +100 ms", i, elapsed, nominal)
		}
		totals = append(totals, elapsed)
	}
	min, max := totals[0], totals[0]
	for _, d := range totals[1:] {
		if d < min {
			min = d
		}
		if d > max {
			max = d
		}
	}
	if spread := max - min; spread < 30*time.Millisecond {
		t.Errorf("no jitter: %d runs span only %v (totals=%v); ±20%% jitter on %v nominal must spread runs by >= 30 ms",
			runs, spread, totals, nominal)
	}
}

// Red-first: with retryBase=0 the pre-hardening loop slept nothing between
// attempts, so an upstream "Retry-After: 1" was ignored and the run returned
// in milliseconds. Honoring the header means waiting ~1s before the retry.
func TestFetchWithRetryHonorsRetryAfter(t *testing.T) {
	var calls int
	f := &fakeFetcher{resp: func(route, target string) (*cryptorank.HelperOut, error) {
		calls++
		if calls == 1 {
			return nil, &cryptorank.HelperErr{
				Status:     429,
				Err:        "upstream HTTP 429",
				RetryAfter: time.Second,
			}
		}
		return &cryptorank.HelperOut{OK: true, FetchedAt: 1790000000, Cache: "MISS",
			PageProps: map[string]interface{}{"coins": []interface{}{}}}, nil
	}}
	start := time.Now()
	out, err := fetchWithRetry(context.Background(), f, "coins", "/all-coins-list", 60, 0)
	elapsed := time.Since(start)
	if err != nil || out == nil {
		t.Fatalf("out=%v err=%v, want the retried success", out, err)
	}
	if calls != 2 {
		t.Errorf("calls=%d want 2", calls)
	}
	if elapsed < 900*time.Millisecond {
		t.Errorf("Retry-After: 1 was ignored — finished in %v (want >= ~1s)", elapsed)
	}
}

// The delay policy in isolation: the Retry-After cap is hard, an honored
// header is exact, a zero base never sleeps (the retryBase=0 route tests
// depend on it), and the jittered branch stays inside ±20% of the
// attempt-scaled nominal over a large sample.
func TestNextDelayPolicy(t *testing.T) {
	if got := nextDelay(0, 3*time.Second, 120*time.Second); got != maxRetryAfter {
		t.Errorf("cap: nextDelay = %v, want %v", got, maxRetryAfter)
	}
	if got := nextDelay(1, 3*time.Second, 5*time.Second); got != 5*time.Second {
		t.Errorf("honor: nextDelay = %v, want exactly 5s", got)
	}
	if got := nextDelay(0, 0, 0); got != 0 {
		t.Errorf("zero base: nextDelay = %v, want 0", got)
	}
	if got := nextDelay(0, 0, 90*time.Second); got != maxRetryAfter {
		t.Errorf("cap applies even with a zero base: got %v, want %v", got, maxRetryAfter)
	}
	const base = 100 * time.Millisecond
	for i := 0; i < 10000; i++ {
		d0 := nextDelay(0, base, 0)
		if d0 < 80*time.Millisecond || d0 > 120*time.Millisecond {
			t.Fatalf("attempt 0 jitter out of ±20%%: %v (want 80–120ms)", d0)
		}
		d1 := nextDelay(1, base, 0)
		if d1 < 160*time.Millisecond || d1 > 240*time.Millisecond {
			t.Fatalf("attempt 1 jitter out of ±20%%: %v (want 160–240ms)", d1)
		}
	}
}
