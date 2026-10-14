package dexreliability

import "time"

// Snapshot is one provider's derived reliability at one instant — the shape the
// admin dashboard (plan §58) and the durable sink render.
type Snapshot struct {
	Provider        string
	State           Health
	Success         int64
	Failure         int64
	RateLimited     int64
	ErrorRate       *float64
	LatencyP50Ms    *float64
	LatencyP95Ms    *float64
	LatencyP99Ms    *float64
	LastSuccess     time.Time
	LastFailure     time.Time
	StalenessSecond *float64
	ObservedAt      time.Time
}

// Snapshot returns every observed provider's derived reliability, sorted by
// provider name. It reads under one lock acquisition so a dashboard read is a
// consistent view.
func (r *Recorder) Snapshot() []Snapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()
	now := r.now()
	out := make([]Snapshot, 0, len(r.states))
	for name, st := range r.states {
		out = append(out, r.snapshotFor(name, st, now))
	}
	sortSnapshots(out)
	return out
}

// SnapshotOne returns one provider's snapshot and whether it has been observed.
func (r *Recorder) SnapshotOne(provider string) (Snapshot, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	st, ok := r.states[provider]
	if !ok {
		return Snapshot{}, false
	}
	return r.snapshotFor(provider, st, r.now()), true
}

// snapshotFor builds one provider's snapshot. Caller holds at least the read
// lock (LatencyP* and derive read only immutable-under-lock fields for this
// reader's purposes).
func (r *Recorder) snapshotFor(name string, st *providerState, now time.Time) Snapshot {
	s := Snapshot{
		Provider:     name,
		State:        r.derive(st, now),
		Success:      st.success,
		Failure:      st.failure,
		RateLimited:  st.rateLimited,
		LastSuccess:  st.lastSuccess,
		LastFailure:  st.lastFailure,
		LatencyP50Ms: st.latency.percentile(0.50),
		LatencyP95Ms: st.latency.percentile(0.95),
		LatencyP99Ms: st.latency.percentile(0.99),
		ObservedAt:   now,
	}
	if total := st.success + st.failure; total > 0 {
		rate := float64(st.failure) / float64(total)
		s.ErrorRate = &rate
	}
	if !st.lastSuccess.IsZero() {
		secs := now.Sub(st.lastSuccess).Seconds()
		s.StalenessSecond = &secs
	}
	return s
}

// LatencyP50 returns the 50th-percentile latency in ms, or nil if unmeasured.
func (r *Recorder) LatencyP50(provider string) *float64 { return r.percentileOf(provider, 0.50) }

// LatencyP95 returns the 95th-percentile latency in ms, or nil.
func (r *Recorder) LatencyP95(provider string) *float64 { return r.percentileOf(provider, 0.95) }

// LatencyP99 returns the 99th-percentile latency in ms, or nil.
func (r *Recorder) LatencyP99(provider string) *float64 { return r.percentileOf(provider, 0.99) }

func (r *Recorder) percentileOf(provider string, p float64) *float64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	st, ok := r.states[provider]
	if !ok {
		return nil
	}
	return st.latency.percentile(p)
}

// sortSnapshots orders by provider name (small insertion sort: the provider set
// is small and usually already ordered).
func sortSnapshots(s []Snapshot) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1].Provider > s[j].Provider; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}
