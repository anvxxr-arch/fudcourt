// Package lock implements the execution lease (PRD §65): one worker owns one
// execution at a time, so a worker race can never double-submit orders.
//
// The semantics mirror frontend/web/src/platform/executor/lock.ts exactly (the
// parity oracle): the key is `execution:{executionId}:lock`, the value is an
// owner token `owner:random` minted fresh per Acquire so a delayed worker can
// never act on a lease it already lost, acquisition is `SET key token PX ttl
// NX`, and release/renew are compare-and-act Lua scripts that only fire when
// the stored token still matches.
//
// FAIL-CLOSED: an unavailable lock means no trading. Any backend error or an
// unusable client makes Acquire answer (false, err) — the caller must not
// trade — and Renew answer false — the caller has lost its lease. Only Release
// is best-effort: there is nothing to lose. The (executionID, owner) → token
// map lives in each implementation, in-process only: a restarted holder has no
// token and must re-acquire (PRD §114).
package lock

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	// ErrUnavailable marks a lock backend that could not be reached or that
	// answered with an unexpected reply. It is FAIL-CLOSED: the bool returned
	// alongside it is always false (Acquire: do not trade; Renew: lease lost),
	// because a lock that fails open means duplicate orders. errors.Is matches
	// it while the wrapped cause keeps the concrete failure for logs.
	ErrUnavailable = errors.New("lock: backend unavailable")

	// ErrInvalidExecutionID marks an empty executionID. It is refused outright
	// (never substituted or defaulted) because a lock on the wrong key is
	// worse than no lock: it would let two executions trade as one.
	ErrInvalidExecutionID = errors.New("lock: empty executionID")

	// ErrInvalidOwner marks an empty owner. The owner half of the token is what
	// ties a lease to one worker; an empty owner would make every worker's
	// token collide on the `:` prefix and could never be renewed or released.
	ErrInvalidOwner = errors.New("lock: empty owner")

	// ErrInvalidTTL marks a non-positive TTL. Unlike the TypeScript oracle
	// (which clamps every bad TTL to 1 ms via Math.max) a Go caller passing
	// ttl <= 0 has a bug worth failing on, and the house rule is never clamp
	// silently. Positive sub-millisecond TTLs ARE clamped to 1 ms (see
	// ttlMillis) to keep wire parity with the oracle.
	ErrInvalidTTL = errors.New("lock: non-positive ttl")

	// ErrInvalidConfig marks a config that cannot build a working lock (e.g. a
	// ValkeyLock with neither an address nor a dialer). Refused at construction
	// so misconfiguration fails once, loudly, instead of fail-closed forever.
	ErrInvalidConfig = errors.New("lock: invalid config")
)

// ExecutionLock is the execution lease (PRD §65): one worker owns one execution
// at a time, so a worker race can never double-submit orders. FAIL-CLOSED: an
// unavailable lock means no trading.
//
// Every method validates its inputs (named errors: ErrInvalidExecutionID,
// ErrInvalidOwner, ErrInvalidTTL) before touching any backend.
type ExecutionLock interface {
	// Acquire tries to take the lease for ttl. true means this caller now owns
	// the execution; false means someone else holds it OR the backend failed
	// (check the error) — never trade on false.
	Acquire(ctx context.Context, executionID, owner string, ttl time.Duration) (bool, error)
	// Renew extends the lease of the token this owner's successful Acquire
	// minted. false means the lease is lost (expired, taken, or never held, or
	// backend failure) — the caller must stop trading and re-Acquire.
	Renew(ctx context.Context, executionID, owner string, ttl time.Duration) (bool, error)
	// Release drops the lease this owner's successful Acquire minted.
	// Releasing a lease you do not hold is a NO-OP (nil), never someone else's
	// unlock. Release is best-effort: errors are for logs only.
	Release(ctx context.Context, executionID, owner string) error
}

// LockKey returns the lock key for an execution, `execution:{id}:lock` — the
// exact format of lockKey in lock.ts (PRD §65). Callers must go through this
// function so the store key can never drift from the oracle.
func LockKey(executionID string) string {
	return "execution:" + executionID + ":lock"
}

// tokenKey is the in-process map key for the (executionID, owner) → held-token
// map (lock.ts keys it on a newline-joined string; a struct key cannot collide
// the way any separator-joined string can).
type tokenKey struct {
	executionID string
	owner       string
}

// Clock supplies the current time in unix milliseconds. It exists so lease TTL
// expiry is deterministic under test: advancing a FixedClock past a TTL makes
// the lease vanish without sleeping. It has the same shape as the clock in
// internal/exchanges on purpose, but is defined here (not imported) to keep the
// packages decoupled.
type Clock interface {
	// Now returns the current instant in unix milliseconds.
	Now() int64
}

// SystemClock is the real-time Clock: now is the wall clock.
type SystemClock struct{}

// Now returns the current wall-clock time in unix milliseconds.
func (SystemClock) Now() int64 {
	return time.Now().UnixMilli()
}

// FixedClock is a Clock whose time moves only when the test moves it, so TTL
// tests are instant and deterministic instead of sleeping. Safe for concurrent
// use.
type FixedClock struct {
	mu sync.Mutex
	ms int64
}

// NewFixedClock returns a FixedClock pinned at the given unix-millisecond
// instant.
func NewFixedClock(ms int64) *FixedClock {
	return &FixedClock{ms: ms}
}

// Now returns the clock's current instant in unix milliseconds.
func (c *FixedClock) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ms
}

// Advance moves the clock by d (negative d steps backwards; nothing in this
// package requires monotonicity, and refusing it would be a panic on input).
func (c *FixedClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ms += d.Milliseconds()
}

// mintToken builds the owner token `owner:suffix` — lock.ts's value
// `${workerId}:${random}`. The suffix must be fresh per Acquire attempt so two
// acquires by the same owner string never alias one lease: a stale holder of
// an old token can never release or renew a newer lease (the Lua compares the
// stored token byte-for-byte).
func mintToken(owner string, suffix func() string) string {
	return owner + ":" + suffix()
}

// randomTokenSuffix is the default TokenSuffix: 8 bytes from crypto/rand as
// hex. WHY crypto/rand and not a cheap PRNG: the suffix is the only thing
// stopping a delayed worker from acting on a lease it already lost, so it must
// be unpredictable as well as fresh. crypto/rand.Read is documented never to
// fail since Go 1.24 (it panics internally), so there is no error path here to
// lie about.
func randomTokenSuffix() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// validateParams rejects empty executionID/owner with their named errors.
// Refused outright — never defaulted or substituted.
func validateParams(executionID, owner string) error {
	if executionID == "" {
		return fmt.Errorf("%w", ErrInvalidExecutionID)
	}
	if owner == "" {
		return fmt.Errorf("%w", ErrInvalidOwner)
	}
	return nil
}

// ttlMillis converts a TTL to the integer milliseconds sent over the wire,
// rounding to nearest like JS Math.round and clamping to >= 1 like the
// Math.max(1, …) clamp in lock.ts. WHY the clamp is mirrored (parity): a 0 PX
// value is a Redis protocol error, and a positive sub-millisecond TTL must not
// become one. Non-positive TTLs never reach this function — they are refused
// with ErrInvalidTTL instead of being silently turned into a 1 ms lease.
func ttlMillis(ttl time.Duration) int64 {
	ms := int64(ttl / time.Millisecond)
	if ttl%time.Millisecond >= 500*time.Microsecond {
		ms++
	}
	if ms < 1 {
		ms = 1
	}
	return ms
}

// unavailable wraps cause so errors.Is(err, ErrUnavailable) is true while the
// concrete failure survives for logs. WHY both: ErrUnavailable is the
// fail-closed contract every caller must handle; the cause explains why.
func unavailable(op, executionID string, cause error) error {
	return fmt.Errorf("lock: %s %s: %w (%w)", op, executionID, ErrUnavailable, cause)
}
