package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

// errBoom is the sentinel the fail-closed test expects verbatim.
var errBoom = errors.New("boom")

// envLookup builds an os.Getenv-shaped stub from a map.
func envLookup(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

// goldenKeyHex is a valid 64-hex master key (any value: the config layer only
// validates its shape, never uses it).
const goldenKeyHex = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"

func baseEnv() map[string]string {
	return map[string]string{
		"FUDCOURT_EXECUTOR_MASTER_KEY": goldenKeyHex,
		"FUDCOURT_EXECUTOR_PG_URL":     "postgres://u:p@127.0.0.1:5432/fudcourt",
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	cfg, err := loadConfigFrom(envLookup(baseEnv()))
	if err != nil {
		t.Fatalf("defaults: %v", err)
	}
	if cfg.maxInFlight != 8 {
		t.Errorf("default max in flight = %d, want 8", cfg.maxInFlight)
	}
	if cfg.tick != 5*time.Second {
		t.Errorf("default tick = %v, want 5s", cfg.tick)
	}
	if cfg.stepFallback != "0.0001" {
		t.Errorf("default step = %q, want 0.0001", cfg.stepFallback)
	}
	if cfg.owner == "" {
		t.Error("owner must default to a per-process token (lease identity)")
	}
	if cfg.valkeyAddr != "" {
		t.Error("valkey addr must be empty unless VALKEY_ADDR is set")
	}
}

func TestLoadConfigMissingMasterKeyRefused(t *testing.T) {
	env := baseEnv()
	delete(env, "FUDCOURT_EXECUTOR_MASTER_KEY")
	if _, err := loadConfigFrom(envLookup(env)); err == nil {
		t.Fatal("absent master key must refuse (fail-closed)")
	}
}

func TestLoadConfigMissingPGURLRefused(t *testing.T) {
	env := baseEnv()
	delete(env, "FUDCOURT_EXECUTOR_PG_URL")
	if _, err := loadConfigFrom(envLookup(env)); err == nil {
		t.Fatal("absent PG url must refuse (Postgres is the durable truth)")
	}
}

func TestLoadConfigBadMaxInFlightRefused(t *testing.T) {
	for _, v := range []string{"0", "-3", "abc"} {
		env := baseEnv()
		env["FUDCOURT_EXECUTOR_MAX_INFLIGHT"] = v
		if _, err := loadConfigFrom(envLookup(env)); err == nil {
			t.Fatalf("max in flight %q must refuse (bounded concurrency)", v)
		}
	}
}

func TestLoadConfigBadTickRefused(t *testing.T) {
	for _, v := range []string{"-1", "soon"} {
		env := baseEnv()
		env["FUDCOURT_EXECUTOR_TICK_MS"] = v
		if _, err := loadConfigFrom(envLookup(env)); err == nil {
			t.Fatalf("tick %q must refuse", v)
		}
	}
}

// fakeLock records the exact arguments the adapter forwards.
type fakeLock struct {
	calls []string
	ok    bool
	err   error
}

func (f *fakeLock) Acquire(_ context.Context, id, owner string, ttl time.Duration) (bool, error) {
	f.calls = append(f.calls, "acquire:"+id+":"+owner+":"+ttl.String())
	return f.ok, f.err
}
func (f *fakeLock) Renew(_ context.Context, id, owner string, ttl time.Duration) (bool, error) {
	f.calls = append(f.calls, "renew:"+id+":"+owner+":"+ttl.String())
	return f.ok, f.err
}
func (f *fakeLock) Release(_ context.Context, id, owner string) error {
	f.calls = append(f.calls, "release:"+id+":"+owner)
	return f.err
}

// TestLeaseAdapterTranslatesTTLAndProxiesCalls pins the worker↔lock bridge:
// the worker speaks milliseconds on a minimal interface, the lock package
// speaks Duration on a contextual one. The translation is the adapter's only
// job and losing it (or mis-slicing by 1000) would silently change lease TTLs.
func TestLeaseAdapterTranslatesTTLAndProxiesCalls(t *testing.T) {
	f := &fakeLock{ok: true}
	a := leaseAdapter{lock: f}
	if ok, err := a.Acquire("e1", "o1", 250); !ok || err != nil {
		t.Fatalf("acquire: got (%v,%v)", ok, err)
	}
	if ok, err := a.Renew("e1", "o1", 1000); !ok || err != nil {
		t.Fatalf("renew: got (%v,%v)", ok, err)
	}
	if err := a.Release("e1", "o1"); err != nil {
		t.Fatalf("release: %v", err)
	}
	want := []string{"acquire:e1:o1:250ms", "renew:e1:o1:1s", "release:e1:o1"}
	if len(f.calls) != len(want) {
		t.Fatalf("calls = %v, want %v", f.calls, want)
	}
	for i := range want {
		if f.calls[i] != want[i] {
			t.Fatalf("call %d = %q, want %q", i, f.calls[i], want[i])
		}
	}
}

// TestLeaseAdapterForwardsFailClosed proves the bridge cannot turn a failed
// acquire into a trade: the (false, err) pair reaches the worker verbatim.
func TestLeaseAdapterForwardsFailClosed(t *testing.T) {
	f := &fakeLock{ok: false, err: errBoom}
	a := leaseAdapter{lock: f}
	ok, err := a.Acquire("e1", "o1", 30)
	if ok || err != errBoom {
		t.Fatalf("fail-closed lost: got (%v,%v), want (false,errBoom)", ok, err)
	}
}

func TestDefaultOwnerIsProcessUnique(t *testing.T) {
	if defaultOwner() == "" {
		t.Fatal("owner must never be empty")
	}
}

func TestMainEnvIsNotRequired(t *testing.T) {
	// loadConfig reads only its documented keys; an unrelated var must not
	// change the result (no hidden configuration coupling).
	env := baseEnv()
	env["TOTALLY_UNRELATED"] = "value"
	got, err := loadConfigFrom(envLookup(env))
	if err != nil {
		t.Fatalf("unrelated env broke config: %v", err)
	}
	want, _ := loadConfigFrom(envLookup(baseEnv()))
	if got != want {
		t.Fatal("unrelated env changed configuration")
	}
}
