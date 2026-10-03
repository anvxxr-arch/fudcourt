// Package health is the readiness registry (objective §34: every long-running
// service exposes liveness/readiness and never reports ready before required
// dependencies are usable).
//
// /healthz answers "is this process alive" and stays dependency-free.
// /readyz runs every registered dependency check under a deadline. Domains
// register checks here as they gain storage (Postgres, Valkey, the executor
// API), so readiness grows with real dependencies instead of a hardcoded list.
package health

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Check is one dependency probe. It must be cheap and must not mutate state.
type Check func(ctx context.Context) error

// Registry holds the named dependency checks of one process.
type Registry struct {
	mu     sync.RWMutex
	checks map[string]Check
}

// NewRegistry returns an empty registry (ready = nothing to wait for).
func NewRegistry() *Registry {
	return &Registry{checks: map[string]Check{}}
}

// Register adds or replaces a named dependency check.
func (r *Registry) Register(name string, check Check) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.checks[name] = check
}

// Result is one dependency's readiness verdict. Error is for the readiness
// endpoint (ops surface), never public routes.
type Result struct {
	Name  string `json:"name"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// Run probes every registered dependency concurrently under timeout and returns
// the verdicts. Ready is true only when every check passed.
func (r *Registry) Run(parent context.Context, timeout time.Duration) (results []Result, ready bool) {
	r.mu.RLock()
	names := make([]string, 0, len(r.checks))
	checks := make(map[string]Check, len(r.checks))
	for name, check := range r.checks {
		names = append(names, name)
		checks[name] = check
	}
	r.mu.RUnlock()

	if len(names) == 0 {
		return nil, true
	}
	results = make([]Result, len(names))
	var wg sync.WaitGroup
	for i, name := range names {
		wg.Add(1)
		go func(i int, name string) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(parent, timeout)
			defer cancel()
			res := Result{Name: name, OK: true}
			if err := checks[name](ctx); err != nil {
				res.OK = false
				res.Error = fmt.Sprintf("%v", err)
			}
			results[i] = res
		}(i, name)
	}
	wg.Wait()
	ready = true
	for _, res := range results {
		if !res.OK {
			ready = false
		}
	}
	return results, ready
}
