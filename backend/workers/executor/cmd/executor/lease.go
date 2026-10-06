package main

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/lock"
)

// leaseAdapter bridges lock.ExecutionLock (the package's public,
// context-and-Duration surface) to worker.Lock (the worker's deliberately
// minimal local interface: ctx + TTL in milliseconds). The worker
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
func (a leaseAdapter) Acquire(ctx context.Context, executionID, owner string, ttlMs int64) (bool, error) {
	return a.lock.Acquire(ctx, executionID, owner, time.Duration(ttlMs)*time.Millisecond)
}

// Renew implements worker.Lock.
func (a leaseAdapter) Renew(ctx context.Context, executionID, owner string, ttlMs int64) (bool, error) {
	return a.lock.Renew(ctx, executionID, owner, time.Duration(ttlMs)*time.Millisecond)
}

// Release implements worker.Lock.
func (a leaseAdapter) Release(ctx context.Context, executionID, owner string) error {
	return a.lock.Release(ctx, executionID, owner)
}
