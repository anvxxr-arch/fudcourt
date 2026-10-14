package dexreliability

import (
	"sync"
	"time"
)

// Recorder accumulates per-provider reliability and derives health. It is safe
// for concurrent use: Observe is called from worker goroutines, Health from the
// dispatch gate and the read surface.
type Recorder struct {
	mu       sync.RWMutex
	states   map[string]*providerState
	unconfig map[string]bool
	disabled map[string]bool
	th       Thresholds
	now      func() time.Time
}

// New builds a recorder. th zero values take the documented defaults; now is
// injectable for tests (nil = time.Now).
func New(th Thresholds, now func() time.Time) *Recorder {
	if now == nil {
		now = time.Now
	}
	return &Recorder{
		states:   map[string]*providerState{},
		unconfig: map[string]bool{},
		disabled: map[string]bool{},
		th:       th.withDefaults(),
		now:      now,
	}
}

// Outcome classifies one observed attempt.
type Outcome int

const (
	// OutcomeSucceeded is a fetch that produced usable data.
	OutcomeSucceeded Outcome = iota
	// OutcomeFailed is a fetch that errored (transport, status, shape).
	OutcomeFailed
	// OutcomeRateLimited is a fetch refused by the provider's own limiter
	// (HTTP 429). It is counted separately: a 429 is not a provider defect.
	OutcomeRateLimited
)

// Observe records one attempt's outcome and latency (ms). latencyMs < 0 is
// treated as unmeasured and does not enter the percentile ring.
func (r *Recorder) Observe(provider string, outcome Outcome, latencyMs float64) {
	if provider == "" {
		return
	}
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.stateFor(provider)
	if latencyMs >= 0 {
		st.latency.add(latencyMs)
	}
	switch outcome {
	case OutcomeSucceeded:
		st.success++
		st.consecutive = 0
		st.lastSuccess = now
	case OutcomeFailed:
		st.failure++
		st.consecutive++
		st.lastFailure = now
	case OutcomeRateLimited:
		st.rateLimited++
		st.failure++
		st.lastFailure = now
	}
	st.state, st.lastStateAt = r.derive(st, now), now
}

// stateFor returns (creating) a provider's state. Caller holds the write lock.
func (r *Recorder) stateFor(provider string) *providerState {
	st, ok := r.states[provider]
	if !ok {
		st = &providerState{state: Healthy}
		r.states[provider] = st
	}
	return st
}

// SetUnconfigured marks a provider as missing credentials. It is not a health
// state the recorder can infer from outcomes (a provider that never ran has no
// outcomes), so the wiring declares it.
func (r *Recorder) SetUnconfigured(provider string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.unconfig[provider] = true
	r.stateFor(provider).state = Unconfigured
}

// SetDisabled marks a provider administratively off.
func (r *Recorder) SetDisabled(provider string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.disabled[provider] = true
	r.stateFor(provider).state = Disabled
}

// Health reports the derived state for one provider. An unknown provider is
// Healthy with no observations (the registry's "" default is "preferred").
func (r *Recorder) Health(provider string) Health {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.disabled[provider] {
		return Disabled
	}
	if r.unconfig[provider] {
		return Unconfigured
	}
	st, ok := r.states[provider]
	if !ok {
		return Healthy
	}
	// Re-derive against the CURRENT clock so staleness is live even without a
	// new observation.
	return r.derive(st, r.now())
}

// derive computes the state from an accumulated providerState at time now.
func (r *Recorder) derive(st *providerState, now time.Time) Health {
	total := st.success + st.failure
	if total == 0 {
		return Healthy
	}
	if st.rateLimited > 0 && !st.lastFailure.IsZero() &&
		now.Sub(st.lastFailure) <= r.th.RateLimitWindow {
		return RateLimited
	}
	errRate := float64(st.failure) / float64(total)
	if st.consecutive >= r.th.UnhealthyConsecutive || errRate >= r.th.UnhealthyErrorRate {
		return Unhealthy
	}
	if errRate >= r.th.DegradedErrorRate {
		return Degraded
	}
	if !st.lastSuccess.IsZero() && now.Sub(st.lastSuccess) > r.th.StaleAfter {
		return Degraded
	}
	return Healthy
}
