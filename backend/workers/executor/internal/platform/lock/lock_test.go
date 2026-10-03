package lock

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestLockKey(t *testing.T) {
	tests := []struct {
		name        string
		executionID string
		want        string
	}{
		{"plain id", "e1", "execution:e1:lock"},
		{"uuid-like id", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "execution:7c9e6679-7425-40de-944b-e07fc1f90ae7:lock"},
		{"id with separator chars", "a:b", "execution:a:b:lock"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := LockKey(tt.executionID); got != tt.want {
				t.Errorf("LockKey(%q) = %q, want %q", tt.executionID, got, tt.want)
			}
		})
	}
}

// The Lua scripts must stay byte-identical to frontend/web/src/platform/executor/
// lock.ts (the parity oracle): they are the atomic compare-and-act that stops a
// delayed worker from unlocking a lease it lost. The literals below are copied
// from lock.ts and must never be regenerated from the Go constants.
func TestScriptsMatchTypeScriptOracle(t *testing.T) {
	tests := []struct {
		name   string
		got    string
		oracle string
	}{
		{
			name:   "RELEASE_LUA",
			got:    releaseLua,
			oracle: "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
		},
		{
			name:   "HEARTBEAT_LUA",
			got:    heartbeatLua,
			oracle: "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.got != tt.oracle {
				t.Errorf("script drifted from lock.ts:\ngot  %q\nwant %q", tt.got, tt.oracle)
			}
		})
	}
}

// Token suffixes must be fresh per mint, so two acquires by the same owner
// string never alias one lease (lock.ts comment above the token minting).
func TestMintTokenNeverAliases(t *testing.T) {
	suffixes := []string{"n1", "n2", "n3"}
	i := 0
	seq := func() string {
		s := suffixes[i]
		i++
		return s
	}
	tests := []struct {
		name  string
		owner string
		want  string
	}{
		{"first mint", "alice", "alice:n1"},
		{"second mint, same owner", "alice", "alice:n2"},
		{"third mint, same owner", "alice", "alice:n3"},
	}
	seen := map[string]bool{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mintToken(tt.owner, seq)
			if got != tt.want {
				t.Errorf("mintToken(%q) = %q, want %q", tt.owner, got, tt.want)
			}
			if seen[got] {
				t.Errorf("token %q minted twice — leases would alias", got)
			}
			seen[got] = true
		})
	}
}

// TTL wire parity with lock.ts: Math.round then Math.max(1, …). Sub-millisecond
// positive TTLs clamp to 1 ms (a 0 PX would be a protocol error); non-positive
// TTLs never reach this function (they are refused with ErrInvalidTTL).
func TestTTLMillisClampParity(t *testing.T) {
	tests := []struct {
		name string
		ttl  time.Duration
		want int64
	}{
		{"sub-millisecond clamps to 1", 500 * time.Microsecond, 1},
		{"tiny positive clamps to 1", time.Nanosecond, 1},
		{"exact millisecond", time.Millisecond, 1},
		{"half rounds up like Math.round", 1500 * time.Microsecond, 2},
		{"two-and-a-half rounds up like Math.round", 2500 * time.Microsecond, 3},
		{"just under half rounds down", 2499 * time.Microsecond, 2},
		{"seconds", 10 * time.Second, 10000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ttlMillis(tt.ttl); got != tt.want {
				t.Errorf("ttlMillis(%v) = %d, want %d", tt.ttl, got, tt.want)
			}
		})
	}
}

func TestFixedClock(t *testing.T) {
	tests := []struct {
		name    string
		start   int64
		advance []time.Duration
		want    int64
	}{
		{"no movement", 1000, nil, 1000},
		{"advance by seconds", 1000, []time.Duration{time.Second}, 2000},
		{"cumulative advances", 1000, []time.Duration{250 * time.Millisecond, 250 * time.Millisecond}, 1500},
		{"can step backwards", 1000, []time.Duration{-time.Second}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewFixedClock(tt.start)
			for _, d := range tt.advance {
				c.Advance(d)
			}
			if got := c.Now(); got != tt.want {
				t.Errorf("clock = %d, want %d", got, tt.want)
			}
		})
	}
}

// Both implementations refuse invalid input with the named errors — never
// clamp or substitute. Validation happens before any backend is touched.
func TestLockValidation(t *testing.T) {
	build := map[string]func(t *testing.T) ExecutionLock{
		"memory": func(*testing.T) ExecutionLock { return NewMemoryLock(MemoryConfig{}) },
		"valkey": func(t *testing.T) ExecutionLock {
			failingDialer := func(context.Context) (net.Conn, error) {
				t.Fatal("validation must not dial")
				return nil, errors.New("unreachable")
			}
			l, err := NewValkeyLock(ValkeyConfig{Dialer: failingDialer})
			if err != nil {
				t.Fatalf("NewValkeyLock: %v", err)
			}
			return l
		},
	}
	tests := []struct {
		name string
		run  func(l ExecutionLock) error
		want error
	}{
		{"Acquire empty executionID", func(l ExecutionLock) error {
			_, err := l.Acquire(context.Background(), "", "alice", time.Second)
			return err
		}, ErrInvalidExecutionID},
		{"Renew empty executionID", func(l ExecutionLock) error {
			_, err := l.Renew(context.Background(), "", "alice", time.Second)
			return err
		}, ErrInvalidExecutionID},
		{"Release empty executionID", func(l ExecutionLock) error {
			return l.Release(context.Background(), "", "alice")
		}, ErrInvalidExecutionID},
		{"Acquire empty owner", func(l ExecutionLock) error {
			_, err := l.Acquire(context.Background(), "e1", "", time.Second)
			return err
		}, ErrInvalidOwner},
		{"Renew empty owner", func(l ExecutionLock) error {
			_, err := l.Renew(context.Background(), "e1", "", time.Second)
			return err
		}, ErrInvalidOwner},
		{"Release empty owner", func(l ExecutionLock) error {
			return l.Release(context.Background(), "e1", "")
		}, ErrInvalidOwner},
		{"Acquire zero ttl", func(l ExecutionLock) error {
			_, err := l.Acquire(context.Background(), "e1", "alice", 0)
			return err
		}, ErrInvalidTTL},
		{"Acquire negative ttl", func(l ExecutionLock) error {
			_, err := l.Acquire(context.Background(), "e1", "alice", -time.Second)
			return err
		}, ErrInvalidTTL},
		{"Renew zero ttl", func(l ExecutionLock) error {
			_, err := l.Renew(context.Background(), "e1", "alice", 0)
			return err
		}, ErrInvalidTTL},
		{"Renew negative ttl", func(l ExecutionLock) error {
			_, err := l.Renew(context.Background(), "e1", "alice", -time.Second)
			return err
		}, ErrInvalidTTL},
	}
	for implName, buildLock := range build {
		for _, tt := range tests {
			t.Run(implName+"/"+tt.name, func(t *testing.T) {
				err := tt.run(buildLock(t))
				if !errors.Is(err, tt.want) {
					t.Errorf("error = %v, want %v", err, tt.want)
				}
			})
		}
	}
}

func TestValkeyConfigRequiresAddressOrDialer(t *testing.T) {
	if _, err := NewValkeyLock(ValkeyConfig{}); !errors.Is(err, ErrInvalidConfig) {
		t.Errorf("NewValkeyLock(ValkeyConfig{}) error = %v, want %v", err, ErrInvalidConfig)
	}
}
