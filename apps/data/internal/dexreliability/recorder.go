// Package dexreliability is the DEX Data Platform's provider reliability
// recorder (plan §34, §19): it observes every fetch, derives per-provider
// availability / latency percentiles / error rate / staleness, and answers the
// capability registry's health query so fallback routing can skip an unhealthy
// provider (plan §35).
//
// It sits on ONE side of a seam. The engine (internal/ingest) already owns the
// rate limiter and the circuit breaker; it does NOT need to change for this
// package to work. An adapter calls Observe after each attempt, and the
// capability registry is handed Health(provider) as its HealthFunc. Nothing
// here imports the engine, and the engine does not import this.
//
// It is deliberately in-process and lock-guarded: provider health is
// observability + routing input, not durable state. The durability path is the
// Tailer's optional sink, which periodically writes the derived windows to
// data.dex_provider_health through the dexstore.Writer.
package dexreliability

import (
	"sort"
	"time"
)

// latencyRing is a fixed-capacity ring of recent latencies in milliseconds.
// A ring (not a growing slice) keeps Observe O(1) and memory bounded under a
// 5-rps provider; the percentile query sorts a copy of at most cap samples.
type latencyRing struct {
	buf  []float64
	next int
	size int
}

const latencyCapacity = 512

func (r *latencyRing) add(ms float64) {
	if r.buf == nil {
		r.buf = make([]float64, latencyCapacity)
	}
	r.buf[r.next] = ms
	r.next = (r.next + 1) % latencyCapacity
	if r.size < latencyCapacity {
		r.size++
	}
}

// percentile returns the p-th percentile (0..1) of the samples, or nil when no
// sample exists. p is clamped. Uses the nearest-rank method: deterministic and
// free of interpolation guesswork.
func (r *latencyRing) percentile(p float64) *float64 {
	if r.size == 0 {
		return nil
	}
	if p < 0 {
		p = 0
	}
	if p > 1 {
		p = 1
	}
	xs := make([]float64, r.size)
	copy(xs, r.buf[:r.size])
	sort.Float64s(xs)
	idx := int(p * float64(len(xs)-1+1))
	if idx >= len(xs) {
		idx = len(xs) - 1
	}
	v := xs[idx]
	return &v
}

// providerState is one provider's accumulated observations.
type providerState struct {
	success     int64
	failure     int64
	rateLimited int64
	latency     latencyRing
	// lastSuccess / lastFailure are the wall-clock instants of the last
	// outcome; the zero time means "never", which staleness treats as unknown.
	lastSuccess time.Time
	lastFailure time.Time
	// consecutive is the current run of failures; it mirrors the engine
	// breaker's own counter for the health view.
	consecutive int
	state       Health
	lastStateAt time.Time
}

// Health is a provider's derived liveness (the closed set the capability
// registry consumes).
type Health string

const (
	Healthy      Health = "healthy"
	Degraded     Health = "degraded"
	RateLimited  Health = "rate_limited"
	Unhealthy    Health = "unhealthy"
	Unconfigured Health = "unconfigured"
	Disabled     Health = "disabled"
)

// Thresholds tune the derived health. Zero values fall back to defaults.
type Thresholds struct {
	// DegradedErrorRate is the error-rate (0..1) at or above which a provider
	// is Degraded.
	DegradedErrorRate float64
	// UnhealthyErrorRate is the error-rate at or above which it is Unhealthy.
	UnhealthyErrorRate float64
	// UnhealthyConsecutive is the consecutive-failure count at or above which
	// it is Unhealthy regardless of the rolling rate.
	UnhealthyConsecutive int
	// StaleAfter marks a provider whose LastSuccess is older than this as
	// Degraded even without failures.
	StaleAfter time.Duration
	// RateLimitWindow is how recent a rate-limit event must be to keep the
	// RateLimited state.
	RateLimitWindow time.Duration
}

func (t Thresholds) withDefaults() Thresholds {
	if t.DegradedErrorRate == 0 {
		t.DegradedErrorRate = 0.10
	}
	if t.UnhealthyErrorRate == 0 {
		t.UnhealthyErrorRate = 0.50
	}
	if t.UnhealthyConsecutive == 0 {
		t.UnhealthyConsecutive = 5
	}
	if t.StaleAfter == 0 {
		t.StaleAfter = 15 * time.Minute
	}
	if t.RateLimitWindow == 0 {
		t.RateLimitWindow = 5 * time.Minute
	}
	return t
}
