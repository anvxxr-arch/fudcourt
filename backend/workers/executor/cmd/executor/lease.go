package main

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/lock"
)

// leaseAdapter bridges lock.ExecutionLock (the package's public,
// context-and-Duration surface) to worker.Lock (the worker's deliberately
// minimal local interface: no context, TTL in milliseconds). The worker
// documents this exact seam: it must not couple to a specific lease backend
// shape, so the composition root supplies the adapter.
//
// FAIL-CLOSED is preserved verbatim: the underlying lock returns
// (false, err) on ANY failure and the adapter forwards both, so a Valkey
// outage or a lost lease can never look like "trade".
type leaseAdapter struct {
	lock lock.ExecutionLock
}

// Acquire implements worker.Lock.
func (a leaseAdapter) Acquire(executionID, owner string, ttlMs int64) (bool, error) {
	return a.lock.Acquire(context.Background(), executionID, owner, time.Duration(ttlMs)*time.Millisecond)
}

// Renew implements worker.Lock.
func (a leaseAdapter) Renew(executionID, owner string, ttlMs int64) (bool, error) {
	return a.lock.Renew(context.Background(), executionID, owner, time.Duration(ttlMs)*time.Millisecond)
}

// Release implements worker.Lock.
func (a leaseAdapter) Release(executionID, owner string) error {
	return a.lock.Release(context.Background(), executionID, owner)
}
