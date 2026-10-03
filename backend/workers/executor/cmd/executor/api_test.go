package main

// The executor API surface's wiring contract: fail-visible config (§34) and the
// documented env surface. These tests never open a listener, so they stay
// hermetic.

import (
	"context"
	"testing"
)

// envMap is a getenv stub over a literal map.
func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

// TestAPISurfaceRefusesWithoutSessionSecret pins the fail-visible rule: a
// missing/short FUDCOURT_SESSION_SECRET refuses construction instead of serving
// a surface whose every request would 500.
func TestAPISurfaceRefusesWithoutSessionSecret(t *testing.T) {
	srv, err := startAPISurface(context.Background(), nil, "master-key",
		envMap(map[string]string{"FUDCOURT_EXECUTOR_API_ADDR": "127.0.0.1:0"}))
	if err == nil {
		t.Fatalf("startAPISurface succeeded without FUDCOURT_SESSION_SECRET (srv=%v)", srv)
	}
}

// TestAPISurfaceRefusesShortSessionSecret pins the length floor (a 32-character
// minimum) from the session package.
func TestAPISurfaceRefusesShortSessionSecret(t *testing.T) {
	_, err := startAPISurface(context.Background(), nil, "master-key",
		envMap(map[string]string{"FUDCOURT_SESSION_SECRET": "too-short"}))
	if err == nil {
		t.Fatalf("startAPISurface accepted a short session secret")
	}
}

// TestAPIAddrDefaults pins the loopback default (DR-002).
func TestAPIAddrDefaults(t *testing.T) {
	if got := apiAddr(envMap(nil)); got != defaultAPIAddr {
		t.Fatalf("apiAddr default = %q, want %q", got, defaultAPIAddr)
	}
	if got := apiAddr(envMap(map[string]string{"FUDCOURT_EXECUTOR_API_ADDR": " 127.0.0.1:9999 "})); got != "127.0.0.1:9999" {
		t.Fatalf("apiAddr = %q, want the trimmed override", got)
	}
}

// TestLiveEnabledIsExactOne pins the kill-switch comparison (`== "1"`, exactly
// as runtime.ts reads FUDCOURT_EXECUTOR_LIVE).
func TestLiveEnabledIsExactOne(t *testing.T) {
	cases := map[string]bool{"1": true, "true": false, "yes": false, "": false, " 1": false}
	for value, want := range cases {
		if got := liveEnabled(envMap(map[string]string{"FUDCOURT_EXECUTOR_LIVE": value})); got != want {
			t.Fatalf("liveEnabled(%q) = %v, want %v", value, got, want)
		}
	}
}
