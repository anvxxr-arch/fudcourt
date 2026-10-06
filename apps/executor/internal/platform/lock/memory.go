package lock

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// MemoryConfig configures a MemoryLock. The zero value is ready to use: real
// time (SystemClock) and crypto-random token suffixes.
type MemoryConfig struct {
	// Clock drives TTL expiry. Tests inject a FixedClock so "advance the clock
	// past the TTL and the lease is gone" is instant and deterministic.
	// nil means SystemClock.
	Clock Clock

	// TokenSuffix mints the random half of each owner token (`owner:suffix`).
	// Tests inject a deterministic sequence so token behaviour is assertable;
	// nil means the crypto/rand default.
	TokenSuffix func() string
}

// memoryLease is one held lease: the token that owns the key and the instant
// (unix millis) at which the TTL runs out.
type memoryLease struct {
	token     string
	expiresAt int64
}

// MemoryLock is a deterministic, in-process ExecutionLock for tests. It
// reproduces the Valkey semantics of lock.ts exactly without any I/O:
// first-acquirer-wins per key (SET NX), TTL expiry driven by the injected
// Clock, and compare-and-act renew/release that only fire on the token this
// owner's successful Acquire minted. The (executionID, owner) → token map is
// in-process and lost if the lock is discarded — a restarted holder must
// re-acquire, exactly like the real client (PRD §114).
//
// The context parameter of the ExecutionLock methods is accepted but not
// consulted: operations here are synchronous and non-blocking, so there is no
// I/O to cancel. Callers that need deadlines get them from the context on
// ValkeyLock.
type MemoryLock struct {
	mu          sync.Mutex
	clock       Clock
	suffix      func() string
	unavailable error
	leases      map[string]memoryLease
	tokens      map[tokenKey]string
}

// NewMemoryLock builds a MemoryLock from cfg, defaulting the zero fields
// (Clock → SystemClock, TokenSuffix → crypto/rand hex).
func NewMemoryLock(cfg MemoryConfig) *MemoryLock {
	if cfg.Clock == nil {
		cfg.Clock = SystemClock{}
	}
	if cfg.TokenSuffix == nil {
		cfg.TokenSuffix = randomTokenSuffix
	}
	return &MemoryLock{
		clock:  cfg.Clock,
		suffix: cfg.TokenSuffix,
		leases: make(map[string]memoryLease),
		tokens: make(map[tokenKey]string),
	}
}

var _ ExecutionLock = (*MemoryLock)(nil)

// SetUnavailable arms the fail-closed failure knob: while armed, Acquire
// answers (false, an error matching ErrUnavailable wrapping err) and Renew
// answers false, exactly as a broken connection would — so tests can prove the
// fail-closed path of both implementations without a real outage. Release
// reports the error but still drops the local token (best-effort parity with
// lock.ts, whose release deletes its token in a finally block). Passing nil
// disarms the knob; err is the simulated connection failure and must be
// non-nil to arm.
func (m *MemoryLock) SetUnavailable(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.unavailable = err
}

// Acquire takes the lease if the key is free or its TTL has run out (SET NX PX
// parity). true records a freshly minted token for (executionID, owner); false
// with nil error means the key is held by someone else. While the knob is
// armed it is FAIL-CLOSED: (false, ErrUnavailable-wrapped error).
func (m *MemoryLock) Acquire(_ context.Context, executionID, owner string, ttl time.Duration) (bool, error) {
	if err := validateParams(executionID, owner); err != nil {
		return false, err
	}
	if ttl <= 0 {
		return false, fmt.Errorf("%w", ErrInvalidTTL)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.unavailable != nil {
		return false, unavailable("acquire", executionID, m.unavailable)
	}
	key := LockKey(executionID)
	now := m.clock.Now()
	if l, ok := m.leases[key]; ok && l.expiresAt > now {
		return false, nil // held (SET NX would answer null)
	}
	token := mintToken(owner, m.suffix)
	m.leases[key] = memoryLease{token: token, expiresAt: now + ttlMillis(ttl)}
	m.tokens[tokenKey{executionID, owner}] = token
	return true, nil
}

// Renew extends the lease only while this owner still holds it and its TTL has
// not run out. false means the lease is lost: expired, taken by another owner,
// never acquired here, or backend failure — with no token on record the answer
// is (false, nil) without touching the backend (lock.ts parity), and while the
// knob is armed it is (false, ErrUnavailable-wrapped error). The map entry is
// kept on loss, mirroring lock.ts, so a later re-Acquire is what re-establishes
// the mapping.
func (m *MemoryLock) Renew(_ context.Context, executionID, owner string, ttl time.Duration) (bool, error) {
	if err := validateParams(executionID, owner); err != nil {
		return false, err
	}
	if ttl <= 0 {
		return false, fmt.Errorf("%w", ErrInvalidTTL)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	token, ok := m.tokens[tokenKey{executionID, owner}]
	if !ok {
		return false, nil // never acquired (or already released) — lease lost
	}
	if m.unavailable != nil {
		return false, unavailable("renew", executionID, m.unavailable)
	}
	key := LockKey(executionID)
	now := m.clock.Now()
	l, ok := m.leases[key]
	if !ok || l.token != token || l.expiresAt <= now {
		return false, nil // expired or someone else's — compare-and-act parity
	}
	l.expiresAt = now + ttlMillis(ttl)
	m.leases[key] = l
	return true, nil
}

// Release drops this owner's lease. Releasing a lease you do not hold is a
// NO-OP (nil): without a held token nothing is sent and someone else's lease
// is never touched (lock.ts returns before calling the client). The local
// token is dropped first, so a duplicate release is also a no-op. While the
// knob is armed the failure is reported (best-effort — for logs only) but the
// token is still dropped.
func (m *MemoryLock) Release(_ context.Context, executionID, owner string) error {
	if err := validateParams(executionID, owner); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	k := tokenKey{executionID, owner}
	token, ok := m.tokens[k]
	if !ok {
		return nil // not our lease — NO-OP
	}
	delete(m.tokens, k) // drop the token first (lock.ts `finally`): duplicates no-op
	if m.unavailable != nil {
		return unavailable("release", executionID, m.unavailable)
	}
	key := LockKey(executionID)
	if l, held := m.leases[key]; held && l.token == token {
		delete(m.leases, key) // compare-and-act: only delete our own token's lease
	}
	return nil
}
