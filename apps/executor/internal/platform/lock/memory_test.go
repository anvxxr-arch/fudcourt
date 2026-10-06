package lock

import (
	"context"
	"errors"
	"testing"
	"time"
)

const baseMillis = int64(1_700_000_000_000)

// memoryEnv builds a MemoryLock on a fixed clock with a scripted token suffix
// so every lease is deterministic.
type memoryEnv struct {
	lock  *MemoryLock
	clock *FixedClock
}

func newMemoryEnv(suffixes ...string) memoryEnv {
	i := 0
	suffix := func() string {
		if i >= len(suffixes) {
			return "stale"
		}
		s := suffixes[i]
		i++
		return s
	}
	clock := NewFixedClock(baseMillis)
	return memoryEnv{
		lock:  NewMemoryLock(MemoryConfig{Clock: clock, TokenSuffix: suffix}),
		clock: clock,
	}
}

// Mutual exclusion (PRD §65): while one owner holds the lease, no other owner
// can take it; once released the key is free again.
func TestMemoryLockMutualExclusion(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T, l *MemoryLock)
	}{
		{"second owner cannot acquire while held", func(t *testing.T, l *MemoryLock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			if ok, err := l.Acquire(context.Background(), "e1", "bob", time.Second); ok || err != nil {
				t.Fatalf("bob Acquire = %v, %v; want false, nil", ok, err)
			}
		}},
		{"released key can be acquired", func(t *testing.T, l *MemoryLock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			if err := l.Release(context.Background(), "e1", "alice"); err != nil {
				t.Fatalf("alice Release: %v", err)
			}
			if ok, err := l.Acquire(context.Background(), "e1", "bob", time.Second); !ok || err != nil {
				t.Fatalf("bob Acquire after release = %v, %v; want true, nil", ok, err)
			}
		}},
		{"keys are independent per execution", func(t *testing.T, l *MemoryLock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second); !ok || err != nil {
				t.Fatalf("alice Acquire e1 = %v, %v; want true, nil", ok, err)
			}
			if ok, err := l.Acquire(context.Background(), "e2", "bob", time.Second); !ok || err != nil {
				t.Fatalf("bob Acquire e2 = %v, %v; want true, nil", ok, err)
			}
		}},
		{"same owner cannot re-acquire its own live lease", func(t *testing.T, l *MemoryLock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			if ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second); ok || err != nil {
				t.Fatalf("alice re-Acquire = %v, %v; want false, nil (SET NX parity)", ok, err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newMemoryEnv("s1", "s2", "s3", "s4")
			tt.run(t, env.lock)
		})
	}
}

// Owner-only release: a non-owner Release is a NO-OP and the owner keeps the
// lease; a stale owner whose lease expired and was taken by a newer lease can
// never unlock it.
func TestMemoryLockOwnerOnlyRelease(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T, l *MemoryLock, c *FixedClock)
	}{
		{"non-owner release is a no-op", func(t *testing.T, l *MemoryLock, _ *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			if err := l.Release(context.Background(), "e1", "bob"); err != nil {
				t.Fatalf("bob Release = %v; want nil no-op", err)
			}
			if ok, err := l.Renew(context.Background(), "e1", "alice", time.Second); !ok || err != nil {
				t.Fatalf("alice Renew after bob's no-op = %v, %v; want true, nil", ok, err)
			}
			if ok, err := l.Acquire(context.Background(), "e1", "bob", time.Second); ok || err != nil {
				t.Fatalf("bob Acquire = %v, %v; want false, nil (alice still holds)", ok, err)
			}
		}},
		{"release without acquire is a no-op", func(t *testing.T, l *MemoryLock, _ *FixedClock) {
			if err := l.Release(context.Background(), "e1", "mallory"); err != nil {
				t.Fatalf("Release without lease = %v; want nil no-op", err)
			}
		}},
		{"stale owner cannot release a newer lease", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			// alice takes the lease, it expires, bob takes the newer lease —
			// alice's delayed release/renew must never touch bob's lease.
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			c.Advance(200 * time.Millisecond)
			if ok, err := l.Acquire(context.Background(), "e1", "bob", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("bob Acquire = %v, %v; want true, nil", ok, err)
			}
			if err := l.Release(context.Background(), "e1", "alice"); err != nil {
				t.Fatalf("alice stale Release = %v; want nil (no-op)", err)
			}
			if ok, err := l.Renew(context.Background(), "e1", "bob", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("bob Renew after alice's stale release = %v, %v; want true, nil", ok, err)
			}
			if ok, err := l.Renew(context.Background(), "e1", "alice", 100*time.Millisecond); ok || err != nil {
				t.Fatalf("alice stale Renew = %v, %v; want false, nil (lease lost)", ok, err)
			}
		}},
		{"double release is a no-op on someone else's newer lease", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			if err := l.Release(context.Background(), "e1", "alice"); err != nil {
				t.Fatalf("alice Release = %v; want nil", err)
			}
			if ok, err := l.Acquire(context.Background(), "e1", "bob", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("bob Acquire = %v, %v; want true, nil", ok, err)
			}
			if err := l.Release(context.Background(), "e1", "alice"); err != nil {
				t.Fatalf("alice duplicate Release = %v; want nil (token already dropped)", err)
			}
			if ok, err := l.Renew(context.Background(), "e1", "bob", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("bob Renew = %v, %v; want true, nil (lease untouched)", ok, err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newMemoryEnv("s1", "s2", "s3", "s4")
			tt.run(t, env.lock, env.clock)
		})
	}
}

// TTL expiry via the injected clock: advance past the TTL and the lease is
// gone — another owner can acquire, and Renew on the expired lease answers
// false (lease lost).
func TestMemoryLockTTLExpiry(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T, l *MemoryLock, c *FixedClock)
	}{
		{"expired lease can be re-acquired by another owner", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			c.Advance(100 * time.Millisecond) // TTL boundary: the lease is gone
			if ok, err := l.Acquire(context.Background(), "e1", "bob", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("bob Acquire after expiry = %v, %v; want true, nil", ok, err)
			}
		}},
		{"renew after expiry returns false", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			c.Advance(100 * time.Millisecond)
			if ok, err := l.Renew(context.Background(), "e1", "alice", 100*time.Millisecond); ok || err != nil {
				t.Fatalf("alice Renew after expiry = %v, %v; want false, nil", ok, err)
			}
		}},
		{"lease held right up to the TTL boundary", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			c.Advance(99 * time.Millisecond)
			if ok, err := l.Acquire(context.Background(), "e1", "bob", 100*time.Millisecond); ok || err != nil {
				t.Fatalf("bob Acquire at t+99ms = %v, %v; want false, nil", ok, err)
			}
			if ok, err := l.Renew(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Renew at t+99ms = %v, %v; want true, nil", ok, err)
			}
		}},
		{"expired lease released by its owner is a no-op", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			c.Advance(200 * time.Millisecond)
			if err := l.Release(context.Background(), "e1", "alice"); err != nil {
				t.Fatalf("alice Release of expired lease = %v; want nil", err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newMemoryEnv("s1", "s2", "s3", "s4")
			tt.run(t, env.lock, env.clock)
		})
	}
}

// Renew extends the TTL from now: the lease survives past its original expiry
// and is gone only after the renewed TTL passes.
func TestMemoryLockRenewExtendsTTL(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T, l *MemoryLock, c *FixedClock)
	}{
		{"lease survives past original expiry after Renew", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			c.Advance(50 * time.Millisecond)
			if ok, err := l.Renew(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Renew at t+50ms = %v, %v; want true, nil", ok, err)
			}
			// t+120ms: past the original t+100ms expiry, inside the renewed
			// t+150ms window — only renewal keeps the lease alive here.
			c.Advance(70 * time.Millisecond)
			if ok, err := l.Acquire(context.Background(), "e1", "bob", 100*time.Millisecond); ok || err != nil {
				t.Fatalf("bob Acquire at t+120ms = %v, %v; want false, nil", ok, err)
			}
			// t+160ms: past the renewed expiry — the lease is gone.
			c.Advance(40 * time.Millisecond)
			if ok, err := l.Acquire(context.Background(), "e1", "bob", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("bob Acquire at t+160ms = %v, %v; want true, nil", ok, err)
			}
		}},
		{"without Renew the lease dies at the original TTL", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			c.Advance(50 * time.Millisecond)
			c.Advance(50 * time.Millisecond) // t+100ms, no Renew
			if ok, err := l.Acquire(context.Background(), "e1", "bob", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("bob Acquire at t+100ms = %v, %v; want true, nil", ok, err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newMemoryEnv("s1", "s2", "s3", "s4")
			tt.run(t, env.lock, env.clock)
		})
	}
}

// Per-Acquire token minting: two acquires by the same owner string never alias
// one lease, so a stale owner cannot release or renew a newer lease.
func TestMemoryLockTokenPerAcquire(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T, l *MemoryLock, c *FixedClock)
	}{
		{"same owner re-acquires after expiry as a fresh lease", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice first Acquire = %v, %v; want true, nil", ok, err)
			}
			c.Advance(100 * time.Millisecond) // first lease expires
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice second Acquire = %v, %v; want true, nil", ok, err)
			}
			// The fresh lease is the current one: alice's release drops exactly
			// it, and the key is then free (the first lease is never revived).
			if err := l.Release(context.Background(), "e1", "alice"); err != nil {
				t.Fatalf("alice Release = %v; want nil", err)
			}
			if ok, err := l.Acquire(context.Background(), "e1", "bob", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("bob Acquire = %v, %v; want true, nil", ok, err)
			}
		}},
		{"stale same-owner renew after re-acquire extends the new lease only", func(t *testing.T, l *MemoryLock, c *FixedClock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice first Acquire = %v, %v; want true, nil", ok, err)
			}
			c.Advance(100 * time.Millisecond)
			if ok, err := l.Acquire(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice second Acquire = %v, %v; want true, nil", ok, err)
			}
			// Renew acts on the token the latest successful Acquire minted; the
			// first lease's token is gone and can never match again.
			c.Advance(50 * time.Millisecond)
			if ok, err := l.Renew(context.Background(), "e1", "alice", 100*time.Millisecond); !ok || err != nil {
				t.Fatalf("alice Renew = %v, %v; want true, nil", ok, err)
			}
			c.Advance(70 * time.Millisecond) // t+220ms total: inside renewed window of lease 2
			if ok, err := l.Acquire(context.Background(), "e1", "bob", 100*time.Millisecond); ok || err != nil {
				t.Fatalf("bob Acquire inside renewed window = %v, %v; want false, nil", ok, err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newMemoryEnv("n1", "n2", "n3", "n4")
			tt.run(t, env.lock, env.clock)
		})
	}
}

// Fail-closed: an unusable lock is a trading stop, never an open gate. Both
// Acquire and Renew must refuse; Release reports but is best-effort.
func TestMemoryLockFailClosed(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T, l *MemoryLock)
	}{
		{"acquire fails closed on connection error", func(t *testing.T, l *MemoryLock) {
			connErr := errors.New("connection reset by peer")
			l.SetUnavailable(connErr)
			ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second)
			if ok {
				t.Error("Acquire = true during outage; want false (must not trade)")
			}
			if !errors.Is(err, ErrUnavailable) || !errors.Is(err, connErr) {
				t.Errorf("Acquire error = %v; want ErrUnavailable wrapping %v", err, connErr)
			}
		}},
		{"renew fails closed on connection error while holding a lease", func(t *testing.T, l *MemoryLock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			connErr := errors.New("connection reset by peer")
			l.SetUnavailable(connErr)
			ok, err := l.Renew(context.Background(), "e1", "alice", time.Second)
			if ok {
				t.Error("Renew = true during outage; want false (lease lost)")
			}
			if !errors.Is(err, ErrUnavailable) || !errors.Is(err, connErr) {
				t.Errorf("Renew error = %v; want ErrUnavailable wrapping %v", err, connErr)
			}
		}},
		{"renew without a lease answers lost even during an outage", func(t *testing.T, l *MemoryLock) {
			// lock.ts parity: with no held token heartbeat answers false
			// without touching the backend, so no error is attached.
			l.SetUnavailable(errors.New("connection reset by peer"))
			if ok, err := l.Renew(context.Background(), "e1", "alice", time.Second); ok || err != nil {
				t.Fatalf("Renew without lease during outage = %v, %v; want false, nil", ok, err)
			}
		}},
		{"release reports the failure but drops the local token", func(t *testing.T, l *MemoryLock) {
			if ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second); !ok || err != nil {
				t.Fatalf("alice Acquire = %v, %v; want true, nil", ok, err)
			}
			connErr := errors.New("connection reset by peer")
			l.SetUnavailable(connErr)
			if err := l.Release(context.Background(), "e1", "alice"); !errors.Is(err, ErrUnavailable) {
				t.Fatalf("Release error = %v; want ErrUnavailable", err)
			}
			// The local token is gone (lock.ts `finally`): a duplicate release
			// is a no-op and answers nil even while still unavailable.
			if err := l.Release(context.Background(), "e1", "alice"); err != nil {
				t.Fatalf("duplicate Release = %v; want nil no-op", err)
			}
		}},
		{"recovery after the outage clears", func(t *testing.T, l *MemoryLock) {
			l.SetUnavailable(errors.New("connection reset by peer"))
			l.SetUnavailable(nil)
			if ok, err := l.Acquire(context.Background(), "e1", "alice", time.Second); !ok || err != nil {
				t.Fatalf("Acquire after recovery = %v, %v; want true, nil", ok, err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newMemoryEnv("s1", "s2", "s3", "s4")
			tt.run(t, env.lock)
		})
	}
}
