package api
// Panic-containment tests for the executor mux's recoverMiddleware (dd80ca3).
// The middleware is the executor's port of apps/api/internal/platform/httpx
// .Recover: a panicking handler answers the canonical internal envelope and the
// stack goes to the log, never the wire. These tests pin both halves of that
// contract at the handler boundary — the 500 envelope on panic and the
// untouched pass-through when nothing panics — plus the §43 rule that no
// internal detail (panic text, stack frames) reaches the caller.
//
// Nothing here needs the harness: recoverMiddleware wraps any http.Handler, so
// the tests drive it with bare httptest handlers and a real router-free mux.
import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// panicHandler panics with value after the middleware has already seen the
// request, exactly as a handler deep in a route would.
func panicHandler(value any) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(value)
	})
}

// TestRecoverMiddlewareContainsPanic pins the panic path: a handler that
// panics answers 500 with the canonical envelope
// `{"error":{"code":"internal","message":"internal error","request_id":""}}`.
// request_id is empty because the executor has no request-id middleware, and
// the middleware must not fabricate a correlation the operator cannot look up.
func TestRecoverMiddlewareContainsPanic(t *testing.T) {
	h := recoverMiddleware(panicHandler("boom"))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/executor/executions", nil))

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("panicking handler answered %d, want 500", w.Code)
	}
	body := decodeBody(t, w.Body.Bytes())
	errObj, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("body = %v, want an `error` object", body)
	}
	if errObj["code"] != "internal" {
		t.Fatalf("error.code = %v, want internal", errObj["code"])
	}
	if errObj["message"] != "internal error" {
		t.Fatalf("error.message = %v, want %q", errObj["message"], "internal error")
	}
	if got, present := errObj["request_id"]; !present || got != "" {
		t.Fatalf("error.request_id = %v (present=%v), want the empty string", got, present)
	}
}

// TestRecoverMiddlewarePassesThrough pins the non-panic path: the wrapper is
// transparent — status, headers and body reach the caller untouched.
func TestRecoverMiddlewarePassesThrough(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Executor-Pass", "yes")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	h := recoverMiddleware(next)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/executor/accounts", nil))

	if w.Code != http.StatusCreated {
		t.Fatalf("clean handler answered %d, want 201 (the wrapper must not rewrite the status)", w.Code)
	}
	if got := w.Header().Get("X-Executor-Pass"); got != "yes" {
		t.Fatalf("X-Executor-Pass = %q, want yes (the wrapper must not drop headers)", got)
	}
	if got := w.Body.String(); got != `{"ok":true}` {
		t.Fatalf("body = %q, want the handler's own body verbatim", got)
	}
}

// TestRecoverMiddlewareHidesPanicDetail pins §43: the panic value and the
// stack never reach the wire. The panic carries text a caller must never see
// (an internal address, a stack-shaped marker); the response may only carry the
// canned envelope.
func TestRecoverMiddlewareHidesPanicDetail(t *testing.T) {
	const secret = "10.0.0.1:5432 credentials unsealed"
	h := recoverMiddleware(panicHandler(secret))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/executor/settings", nil))

	raw := w.Body.String()
	for _, leak := range []string{secret, "goroutine", "runtime.", "debug.Stack", "panic:", "server.go"} {
		if strings.Contains(raw, leak) {
			t.Fatalf("response body leaks %q: %s", leak, raw)
		}
	}
	if len(raw) > 200 {
		t.Fatalf("response body is %d bytes, want the small canned envelope only", len(raw))
	}
}
