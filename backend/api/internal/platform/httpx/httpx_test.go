package httpx

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
)

func TestValidRequestID(t *testing.T) {
	for _, ok := range []string{"abc", "req-1", "a.b_c-123", strings.Repeat("a", 128)} {
		if !validRequestID(ok) {
			t.Errorf("validRequestID(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"", strings.Repeat("a", 129), "has space", "line\nbreak", "semi;colon", "quote\"x"} {
		if validRequestID(bad) {
			t.Errorf("validRequestID(%q) = true, want false", bad)
		}
	}
}

func TestRequestIDAdoptsWellFormedAndRejectsForged(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(RequestIDFrom(r.Context())))
	})
	h := RequestID(inner)

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Request-Id", "client-supplied-1")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-Id"); got != "client-supplied-1" {
		t.Fatalf("well-formed inbound id must be adopted, got %q", got)
	}

	req = httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Request-Id", "forged\nlog-line")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	got := rec.Header().Get("X-Request-Id")
	if got == "" || strings.Contains(got, "\n") || got == "forged\nlog-line" {
		t.Fatalf("forged inbound id must be replaced, got %q", got)
	}
}

func TestWriteErrorWritesEnvelopeWithRequestID(t *testing.T) {
	h := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, r, errs.Wrap(errs.CategoryRiskLimit, "RISK_LIMIT_EXCEEDED",
			"Execution exceeds configured risk limit", errors.New("openRisk=42.5 budget=40 (internal figures)")))
	}))
	req := httptest.NewRequest("POST", "/api/v1/executions", nil)
	req.Header.Set("X-Request-Id", "req-42")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 409 {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	var env errs.Envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body is not the error envelope: %v (%s)", err, rec.Body.String())
	}
	if env.Error.Code != "RISK_LIMIT_EXCEEDED" || env.Error.RequestID != "req-42" {
		t.Fatalf("envelope = %+v", env.Error)
	}
	if strings.Contains(rec.Body.String(), "internal figures") {
		t.Fatal("wrapped cause text leaked into the envelope")
	}
}

func TestRecoverContainsPanics(t *testing.T) {
	h := Recover(RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("database exploded: dsn=postgres://ops:supersecret@db")
	})))
	req := httptest.NewRequest("GET", "/boom", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 500 {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, "supersecret") || strings.Contains(body, "database exploded") {
		t.Fatalf("panic text leaked to the wire: %s", body)
	}
	if !strings.Contains(body, `"request_id"`) {
		t.Fatalf("contained panic must still carry the correlation id: %s", body)
	}
}

func TestWriteJSONFraming(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteJSON(rec, 200, map[string]string{"q": "a<b&c"})
	if want := "{\"q\":\"a<b&c\"}\n"; rec.Body.String() != want {
		t.Fatalf("framing must match JSON.stringify + one newline:\n got %q\nwant %q", rec.Body.String(), want)
	}
}
