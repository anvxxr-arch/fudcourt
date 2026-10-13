// Package cache is a small in-process TTL cache with stale-while-revalidate —
// the L1 half of the philosophy apps/data/platform/cache documents (DR-019),
// kept dependency-free and local to this service: a hit costs no syscall, a
// miss means the caller fetches, and a cache failure can never become an
// outage because every read degrades to "not cached", never to an error.
//
// It exists to keep hot paths off the network: the guild-member list is the
// one provider-backed read this API serves, and a Discord round-trip costs
// 120-400 ms where a memory read costs microseconds.
//
// Keys must be a bounded, server-derived set (guild ids, limits) — never raw
// request input — so the entry map cannot be grown by an unbounded caller.
package cache

import (
	"sync"
	"time"
)

// Cache stores values by key. An entry younger than fresh is fresh: served
// with no upstream call. An entry older than fresh is stale: still served,
// while exactly one background refresh runs (stale-while-revalidate), so a
// stale hit never blocks on the fetch. A key with no entry is a cold miss:
// the caller fetches inline and stores with Set.
type Cache[T any] struct {
	mu      sync.RWMutex
	entries map[string]*entry[T]
	fresh   time.Duration
	now     func() time.Time
}

// entry is one stored value. refreshing is the single-flight guard: at most
// one Revalidate goroutine per key exists at a time.
type entry[T any] struct {
	value      T
	fetchedAt  time.Time
	refreshing bool
}

// New returns a cache whose entries stay fresh for fresh. fresh <= 0 makes
// every present entry immediately stale — every read serves the stored value
// and revalidates in the background (still never blocking).
func New[T any](fresh time.Duration) *Cache[T] {
	return &Cache[T]{
		entries: map[string]*entry[T]{},
		fresh:   fresh,
		now:     time.Now,
	}
}

// Get returns the stored value. stale reports the entry outlived the fresh
// window (serve it and kick a Revalidate). ok is false only when the key was
// never successfully fetched — there is no such thing as a cached error.
func (c *Cache[T]) Get(key string) (value T, stale, ok bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	if !ok {
		return value, false, false
	}
	return e.value, c.now().Sub(e.fetchedAt) >= c.fresh, true
}

// Set stores value as freshly fetched now. It mutates the existing entry when
// there is one, so an entry's identity — and any in-flight refresh holding it
// — survives a re-Set.
func (c *Cache[T]) Set(key string, value T) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.entries[key]; ok {
		e.value = value
		e.fetchedAt = c.now()
		e.refreshing = false
		return
	}
	c.entries[key] = &entry[T]{value: value, fetchedAt: c.now()}
}

// Revalidate runs fetch in one background goroutine — at most one in flight
// per key — and stores a successful result. A failed fetch keeps the previous
// value and age untouched, so readers keep getting the stale value and the
// next stale read retries. A key with no entry is ignored: a cold miss has no
// value to serve while fetch runs, so it must fetch inline.
//
// fetch runs detached from the request that noticed the staleness (that
// request's context dies with its response); it must carry its own timeout
// and must not touch request-scoped state.
func (c *Cache[T]) Revalidate(key string, fetch func() (T, bool)) {
	c.mu.Lock()
	e, ok := c.entries[key]
	if !ok || e.refreshing {
		c.mu.Unlock()
		return
	}
	e.refreshing = true
	c.mu.Unlock()

	go func() {
		value, stored := fetch()
		c.mu.Lock()
		defer c.mu.Unlock()
		if stored {
			e.value = value
			e.fetchedAt = c.now()
		}
		e.refreshing = false
	}()
}
