package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/health"
)

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	newServer(health.NewRegistry()).handler().ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != true || body["service"] != "api" {
		t.Fatalf("healthz body = %v", body)
	}
}

func TestReadyzReportsEachDependency(t *testing.T) {
	reg := health.NewRegistry()
	reg.Register("postgres", func(ctx context.Context) error { return nil })
	rec := httptest.NewRecorder()
	newServer(reg).handler().ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (all deps healthy)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"name":"postgres"`) {
		t.Fatalf("readyz must enumerate dependencies: %s", rec.Body.String())
	}

	reg.Register("valkey", func(ctx context.Context) error { return errors.New("down") })
	rec = httptest.NewRecorder()
	newServer(reg).handler().ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != 503 {
		t.Fatalf("status = %d, want 503 (a down dependency blocks readiness)", rec.Code)
	}
}

func TestUnknownPathIsTheErrorEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()
	newServer(health.NewRegistry()).handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/nope", nil))
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"error"`) || !strings.Contains(rec.Body.String(), `"request_id"`) {
		t.Fatalf("404 must be the normalized envelope: %s", rec.Body.String())
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("every response must carry a correlation id")
	}
}
