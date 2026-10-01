package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/lock"
)

// The shared fakeLock (main_test.go) already answers the lock.ExecutionLock
// shape and records its calls, so these tests reuse it rather than a second
// stub: a duplicate fake is how two "truths" about the same backend diverge.

// The probe's lock label must never leak an endpoint, a token or a password
// (objective §8.4/§35): only a backend verdict belongs in a response body.
func TestProbeLockLabelCarriesNoSecret(t *testing.T) {
	for _, tc := range []struct {
		name string
		ok   bool
		err  error
	}{
		{"healthy", true, nil},
		{"busy", false, nil},
		{"down", false, errors.New("dial tcp 127.0.0.1:6379 refused")},
	} {
		h := &healthServer{lock: &fakeLock{ok: tc.ok, err: tc.err}}
		st := h.probe(context.Background(), "w1-1", defaultProbeTimeout)
		for _, bad := range []string{"6379", "password", "token", "ValkeyLock"} {
			if strings.Contains(st.LockBackend, bad) {
				t.Fatalf("%s: lock label %q contains %q", tc.name, st.LockBackend, bad)
			}
		}
	}
}

// A healthy backend answers "ok" even when it declines the probe grant (the key
// is held): refusal of a synthetic key is NOT a readiness failure.
func TestProbeHealthyBusyLockIsReady(t *testing.T) {
	h := &healthServer{lock: &fakeLock{ok: false}} // held by a real worker
	st := h.probe(context.Background(), "w1-1", defaultProbeTimeout)
	if !isOK(st.LockBackend) {
		t.Fatalf("busy lock must read ok, got %q", st.LockBackend)
	}
}

// An unusable backend makes the executor NOT ready: the fail-closed signal
// reaches an operator, not just the trading path.
func TestProbeDownLockIsNotReady(t *testing.T) {
	h := &healthServer{lock: &fakeLock{err: errors.New("i/o timeout")}}
	st := h.probe(context.Background(), "w1-1", defaultProbeTimeout)
	if isOK(st.LockBackend) {
		t.Fatalf("unusable lock must not read ok: %q", st.LockBackend)
	}
	if st.Ready {
		t.Fatal("an unusable lock backend must not make the executor ready")
	}
}

// Whatever the probe grants is released immediately: a readiness check must
// never leave a lease behind for a dead probe process.
func TestProbeReleasesItsGrant(t *testing.T) {
	l := &fakeLock{ok: true}
	h := &healthServer{lock: l}
	if st := h.probe(context.Background(), "w1-1", defaultProbeTimeout); !isOK(st.LockBackend) {
		t.Fatalf("healthy lock: %q", st.LockBackend)
	}
	if len(l.calls) != 2 {
		t.Fatalf("lock calls = %v, want exactly Acquire+Release", l.calls)
	}
	if !strings.HasPrefix(l.calls[0], "acquire:"+healthProbeKey) {
		t.Fatalf("first call = %q, want acquire on the probe key", l.calls[0])
	}
	if !strings.HasPrefix(l.calls[1], "release:"+healthProbeKey) {
		t.Fatalf("second call = %q, want release of the probe lease", l.calls[1])
	}
}

// The probe key is namespaced away from the execution lease space so a
// readiness check can never shadow a real execution's lock.
func TestProbeUsesNamespacedKey(t *testing.T) {
	if strings.HasPrefix(healthProbeKey, "execution:") {
		t.Fatalf("probe key %q collides with the execution lease namespace", healthProbeKey)
	}
}

// Method discipline: /healthz and /readyz are GET-only, like every other
// FUDCourt read endpoint.
func TestHealthMethodsAreGetOnly(t *testing.T) {
	h := newTestHandler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/healthz", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /healthz = %d, want 405", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/readyz", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /readyz = %d, want 405", rec.Code)
	}
}

// With no store configured the executor is NOT ready: an unconfigured
// dependency must read 503, never a confident 200.
func TestReadyzUnconfiguredStoreIsNotReady(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler().ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured store = %d, want 503", rec.Code)
	}
	var st readyState
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("body: %v", err)
	}
	if st.Service != "executor" || st.Owner == "" {
		t.Fatalf("body = %+v", st)
	}
	if st.Ready {
		t.Fatal("unconfigured store must not report ready")
	}
}

func newTestHandler() http.Handler {
	h := &healthServer{lock: &fakeLock{ok: false}}
	return h.handler("w-test", defaultProbeTimeout)
}

// parseProbeTimeout: absent selects the default; junk refuses (never a silent
// infinity, which would let a hung store wedge /readyz forever).
func TestParseProbeTimeout(t *testing.T) {
	if d, err := parseProbeTimeout(""); err != nil || d != defaultProbeTimeout {
		t.Fatalf("absent: %v, %v", d, err)
	}
	if d, err := parseProbeTimeout("2500"); err != nil || d != 2500*time.Millisecond {
		t.Fatalf("valid: %v, %v", d, err)
	}
	for _, bad := range []string{"0", "-5", "soon", "1.5"} {
		if _, err := parseProbeTimeout(bad); !errors.Is(err, errInvalidProbeTimeout) {
			t.Fatalf("%q must refuse, got %v", bad, err)
		}
	}
}

// Compile-time proof the handler's dependencies are the published interfaces
// (a widening here would be a silent coupling the worker does not declare).
var _ lock.ExecutionLock = (*fakeLock)(nil)
