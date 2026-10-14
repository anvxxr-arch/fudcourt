package dexreliability

import (
	"sync"
	"testing"
	"time"
)

func TestHealthHealthyOnSuccess(t *testing.T) {
	now := time.Unix(1000, 0)
	r := New(Thresholds{}, func() time.Time { return now })
	r.Observe("dex", OutcomeSucceeded, 12)
	if got := r.Health("dex"); got != Healthy {
		t.Fatalf("health = %q, want healthy", got)
	}
}

func TestUnknownProviderIsHealthy(t *testing.T) {
	r := New(Thresholds{}, nil)
	if got := r.Health("never-seen"); got != Healthy {
		t.Fatalf("unknown provider = %q, want healthy", got)
	}
}

func TestDegradedThenUnhealthyByErrorRate(t *testing.T) {
	now := time.Unix(1000, 0)
	r := New(Thresholds{DegradedErrorRate: 0.2, UnhealthyErrorRate: 0.6}, func() time.Time { return now })
	// 1 failure + 4 successes = 20% -> degraded
	r.Observe("p", OutcomeFailed, 5)
	for range 4 {
		r.Observe("p", OutcomeSucceeded, 5)
	}
	if got := r.Health("p"); got != Degraded {
		t.Fatalf("at 20%% error rate got %q, want degraded", got)
	}
	// 6 failures + 4 successes = 60% -> unhealthy
	for range 5 {
		r.Observe("p", OutcomeFailed, 5)
	}
	if got := r.Health("p"); got != Unhealthy {
		t.Fatalf("at 60%% error rate got %q, want unhealthy", got)
	}
}

func TestUnhealthyByConsecutiveFailures(t *testing.T) {
	now := time.Unix(1000, 0)
	r := New(Thresholds{UnhealthyConsecutive: 3, UnhealthyErrorRate: 0.99, DegradedErrorRate: 0.99}, func() time.Time { return now })
	for range 100 {
		r.Observe("p", OutcomeSucceeded, 5)
	}
	for range 3 {
		r.Observe("p", OutcomeFailed, 5)
	}
	if got := r.Health("p"); got != Unhealthy {
		t.Fatalf("3 consecutive failures got %q, want unhealthy", got)
	}
	// A success resets the run.
	r.Observe("p", OutcomeSucceeded, 5)
	if got := r.Health("p"); got == Unhealthy {
		t.Fatalf("after recovery still %q", got)
	}
}

func TestRateLimitedState(t *testing.T) {
	now := time.Unix(1000, 0)
	r := New(Thresholds{RateLimitWindow: time.Minute}, func() time.Time { return now })
	r.Observe("p", OutcomeSucceeded, 5)
	r.Observe("p", OutcomeRateLimited, 5)
	if got := r.Health("p"); got != RateLimited {
		t.Fatalf("after 429 got %q, want rate_limited", got)
	}
	// Outside the window the 429 no longer dominates.
	now = now.Add(2 * time.Minute)
	if got := r.Health("p"); got == RateLimited {
		t.Fatalf("stale 429 still rate_limited")
	}
}

func TestStalenessDegrades(t *testing.T) {
	now := time.Unix(1000, 0)
	r := New(Thresholds{StaleAfter: time.Minute}, func() time.Time { return now })
	r.Observe("p", OutcomeSucceeded, 5)
	if got := r.Health("p"); got != Healthy {
		t.Fatalf("fresh = %q", got)
	}
	now = now.Add(2 * time.Minute)
	if got := r.Health("p"); got != Degraded {
		t.Fatalf("stale = %q, want degraded", got)
	}
}

func TestUnconfiguredAndDisabledOverride(t *testing.T) {
	r := New(Thresholds{}, nil)
	r.SetUnconfigured("nokey")
	if got := r.Health("nokey"); got != Unconfigured {
		t.Fatalf("unconfigured = %q", got)
	}
	r.SetDisabled("off")
	if got := r.Health("off"); got != Disabled {
		t.Fatalf("disabled = %q", got)
	}
	// Disabled beats unconfigured.
	r.SetUnconfigured("both")
	r.SetDisabled("both")
	if got := r.Health("both"); got != Disabled {
		t.Fatalf("both = %q, want disabled", got)
	}
}

func TestLatencyPercentiles(t *testing.T) {
	r := New(Thresholds{}, nil)
	for i := 1; i <= 100; i++ {
		r.Observe("p", OutcomeSucceeded, float64(i))
	}
	p50 := r.LatencyP50("p")
	if p50 == nil || *p50 < 45 || *p50 > 55 {
		t.Fatalf("p50 = %v, want ~50", p50)
	}
	p95 := r.LatencyP95("p")
	if p95 == nil || *p95 < 90 {
		t.Fatalf("p95 = %v, want >=90", p95)
	}
	if r.LatencyP50("unknown") != nil {
		t.Fatal("unknown provider has a percentile")
	}
	// A negative latency is unmeasured and must not enter the ring.
	r.Observe("p", OutcomeSucceeded, -1)
	if got := r.LatencyP50("p"); got == nil {
		t.Fatal("ring emptied by an unmeasured sample")
	}
}

func TestSnapshot(t *testing.T) {
	now := time.Unix(1000, 0)
	r := New(Thresholds{}, func() time.Time { return now })
	r.Observe("a", OutcomeSucceeded, 10)
	r.Observe("a", OutcomeFailed, 20)
	r.Observe("b", OutcomeSucceeded, 30)
	snaps := r.Snapshot()
	if len(snaps) != 2 {
		t.Fatalf("snapshot len = %d, want 2", len(snaps))
	}
	byName := map[string]Snapshot{}
	for _, s := range snaps {
		byName[s.Provider] = s
	}
	if byName["a"].Success != 1 || byName["a"].Failure != 1 {
		t.Fatalf("a counts = %+v", byName["a"])
	}
	if byName["b"].Success != 1 || byName["b"].Failure != 0 {
		t.Fatalf("b counts = %+v", byName["b"])
	}
	if !byName["a"].LastSuccess.Equal(now) {
		t.Fatal("a last success wrong")
	}
}

func TestConcurrentObserve(t *testing.T) {
	r := New(Thresholds{}, nil)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				if (i+j)%3 == 0 {
					r.Observe("p", OutcomeFailed, float64(j))
				} else {
					r.Observe("p", OutcomeSucceeded, float64(j))
				}
			}
		}(i)
	}
	wg.Wait()
	snap := r.Snapshot()
	if len(snap) != 1 || snap[0].Success+snap[0].Failure != 32*50 {
		t.Fatalf("concurrent observe lost events: %+v", snap)
	}
}
