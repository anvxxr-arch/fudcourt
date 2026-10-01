package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/lock"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/repository"
)

// errInvalidProbeTimeout marks an unparseable FUDCOURT_EXECUTOR_READYZ_TIMEOUT_MS:
// a probe bound that cannot be parsed is refused at startup, never silently
// clamped to "infinity".
var errInvalidProbeTimeout = errors.New("FUDCOURT_EXECUTOR_READYZ_TIMEOUT_MS must be a positive integer (ms)")

// defaultProbeTimeout bounds each dependency check on /readyz individually, so
// a hung store cannot wedge the endpoint for its caller (systemd's own timeout
// is the backstop, not the signal).
const defaultProbeTimeout = 2 * time.Second

// healthProbeKey is the synthetic lease key the /readyz lock probe uses. It is
// namespaced away from the `execution:{id}:lock` space so a probe can never
// shadow or steal a real execution's lease.
const healthProbeKey = "health:probe"

// healthServer is the executor's operational surface (objective §34, §25).
// The worker is not a request server — nothing calls it but systemd and an
// operator — so this is deliberately the smallest useful thing:
//
//	/healthz  process liveness only (no dependencies; a slow dependency must
//	          not make a live process look dead to a restart policy)
//	/readyz   dependency readiness: the Postgres store answers one round trip
//	          and the lock backend is reachable. 503 while either is not
//	          usable — "not ready" is an honest answer, never a guess
//	          (objective §34: do not report ready before required
//	          dependencies are usable).
//
// Loopback only (DR-002: the only ingress is the Cloudflare tunnel to the web
// tier, which proxies to services/api, never to the executor).
type healthServer struct {
	store *repository.Store
	lock  lock.ExecutionLock
}

// readyState is the /readyz body: the owner token (which worker this is), each
// dependency's verdict, and the derived decision. No secrets, no plaintext —
// objective §35 forbids credentials in any log or response.
type readyState struct {
	Service     string `json:"service"`
	Owner       string `json:"owner"`
	TimestampMs int64  `json:"timestampMs"`
	Postgres    string `json:"postgres"`
	LockBackend string `json:"lockBackend"`
	Ready       bool   `json:"ready"`
}

// handler builds the mux for one owner token.
func (h *healthServer) handler(owner string, probeTimeout time.Duration) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"service": "executor", "owner": owner})
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		st := h.probe(r.Context(), owner, probeTimeout)
		code := http.StatusOK
		if !st.Ready {
			code = http.StatusServiceUnavailable
		}
		writeJSON(w, code, st)
	})
	return mux
}

// probe re-evaluates each dependency with its own bounded context. A backend
// that errors is reported "down: <reason>" with the reason kept for the log;
// ready is derived, never asserted by the caller.
func (h *healthServer) probe(ctx context.Context, owner string, probeTimeout time.Duration) readyState {
	st := readyState{Service: "executor", Owner: owner, TimestampMs: time.Now().UnixMilli()}
	pctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	// VERDICTS, NOT VERBATIM: a backend error string is free-form and may carry
	// the endpoint, the DSN or a token. Objective \u00a735 forbids exposing those in
	// a response body and \u00a743 forbids leaking internal detail, so the probe
	// CLASSIFIES the failure here and moves the concrete cause to the process log
	// (slog) -- which is where an operator needs it.
	if h.store != nil {
		if err := h.store.Ping(pctx); err != nil {
			st.Postgres = unusable
			slog.Warn("executor: readyz store probe failed", "error", err)
		} else {
			st.Postgres = ok
		}
	} else {
		st.Postgres = notConfigured
	}

	if h.lock != nil {
		// Fail-closed semantics: Acquire on an unusable backend answers
		// (false, err) -- the same answer that stops trading. A healthy backend
		// that answers (false, nil) is "someone else holds it", which is NOT a
		// readiness failure: the backend answered fine. Whatever the probe took
		// is released immediately.
		granted, err := h.lock.Acquire(pctx, healthProbeKey, owner, 5*time.Second)
		switch {
		case err != nil:
			st.LockBackend = unusable
			slog.Warn("executor: readyz lock probe failed", "error", err)
		case granted:
			_ = h.lock.Release(pctx, healthProbeKey, owner)
			st.LockBackend = ok
		default:
			st.LockBackend = ok
		}
	} else {
		st.LockBackend = notConfigured
	}

	st.Ready = st.Postgres == ok && isOK(st.LockBackend)
	return st
}

// The verdicts /readyz may report: whole words, never backend text. A label
// that echoed an error would leak the endpoint, the DSN or a token.
const (
	ok            = "ok"
	unusable      = "unusable"
	notConfigured = "not configured"
)

// isOK reports whether a dependency label means usable.
func isOK(label string) bool { return label == ok }

// writeJSON encodes v as the response body. Encoding cannot fail for these
// value types, and a health endpoint must not be able to hang on its writer.
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// parseProbeTimeout reads the /readyz bound from env. Absent selects the
// default; unparseable or non-positive values are a startup failure (never a
// silent infinity).
func parseProbeTimeout(raw string) (time.Duration, error) {
	if raw == "" {
		return defaultProbeTimeout, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, errInvalidProbeTimeout
	}
	return time.Duration(n) * time.Millisecond, nil
}
