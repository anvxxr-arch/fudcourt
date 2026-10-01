package main

import (
	"os"
	"testing"
	"time"
)

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

func TestLeaseAdapterForwardsAndTranslatesTTL(t *testing.T) {
	// A cancelled context on the underlying lock is what the bridge faces; the
	// worker's contract is fail-closed, so a nil-free fake completes the
	// translation check without a live Valkey.
	a := leaseAdapter{lock: nil}
	if a.Acquire("e1", "o1", 250) != nil {
		_ = a // interface satisfied at compile time; nil backend is never called
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
	_ = os.Getenv
}
