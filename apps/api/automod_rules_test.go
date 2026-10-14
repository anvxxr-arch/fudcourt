package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// fakeAutomod is an in-memory automodStore: it exercises the handler (loopback
// gate, method guard, envelope, camelCase shape) without a database. The
// SQL-specific behaviour (enabled-only filter, priority ordering) is covered by
// the schema bootstrap gate + a live-database run, not here.
type fakeAutomod struct {
	rules []automodRule
	err   error
}

func (f *fakeAutomod) list(_ context.Context, guildID string) ([]automodRule, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make([]automodRule, 0, len(f.rules))
	for _, r := range f.rules {
		if r.GuildID == guildID {
			out = append(out, r)
		}
	}
	return out, nil
}

func automodServer(t *testing.T, rules ...automodRule) *server {
	t.Helper()
	s := newTestServer(t)
	s.automod = &fakeAutomod{rules: rules}
	return s
}

func sampleRule() automodRule {
	thr := 3.0
	timeout := 600
	return automodRule{
		ID: 1, GuildID: "100", Name: "mass-mention", Enabled: true, Priority: 10, Event: "message",
		Matchers:    []automodMatcher{{Type: "mentions", Threshold: &thr}},
		Actions:     []string{"delete", "timeout"},
		ExemptRoles: []string{"777"}, ExemptUsers: []string{}, ExemptChannels: []string{},
		CooldownSeconds: 30, TimeoutSeconds: &timeout,
		CreatedAt: "2026-01-01 00:00:00", UpdatedAt: "2026-01-01 00:00:00",
	}
}

func TestAutomodRulesServedToLoopback(t *testing.T) {
	s := automodServer(t, sampleRule())
	rec := doFrom(t, s, "GET", "/api/internal/automod/rules", "", loopback)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Rules []map[string]any `json:"rules"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rec.Body.String())
	}
	if len(body.Rules) != 1 {
		t.Fatalf("rules len = %d, want 1", len(body.Rules))
	}
	// The camelCase keys the bot's parseRule reads must be present.
	r := body.Rules[0]
	for _, key := range []string{"id", "name", "enabled", "priority", "event", "matchers", "actions",
		"exemptRoles", "exemptUsers", "exemptChannels", "cooldownSeconds", "timeoutSeconds"} {
		if _, ok := r[key]; !ok {
			t.Errorf("rule JSON is missing key %q (got %v)", key, r)
		}
	}
	if r["name"] != "mass-mention" || r["cooldownSeconds"].(float64) != 30 {
		t.Fatalf("rule = %v", r)
	}
}

func TestAutomodRulesFiltersToConfiguredGuild(t *testing.T) {
	other := sampleRule()
	other.ID = 2
	other.GuildID = "999"
	s := automodServer(t, sampleRule(), other)
	rec := doFrom(t, s, "GET", "/api/internal/automod/rules", "", loopback)
	var body struct {
		Rules []automodRule `json:"rules"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Rules) != 1 || body.Rules[0].GuildID != "100" {
		t.Fatalf("rules = %+v, want only the configured guild's rule", body.Rules)
	}
}

func TestAutomodRulesRefusedForNonLoopbackPeer(t *testing.T) {
	s := automodServer(t, sampleRule())
	rec := doFrom(t, s, "GET", "/api/internal/automod/rules", "", "203.0.113.7:4444")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (the route is invisible off-host)", rec.Code)
	}
}

func TestAutomodRulesMethodGuard(t *testing.T) {
	s := automodServer(t, sampleRule())
	rec := doFrom(t, s, "POST", "/api/internal/automod/rules", "{}", loopback)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow != "GET" {
		t.Fatalf("Allow = %q, want GET", allow)
	}
}

func TestAutomodRulesStoreDisabledAnswers503(t *testing.T) {
	s := newTestServer(t) // automod left nil
	rec := doFrom(t, s, "GET", "/api/internal/automod/rules", "", loopback)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"automod_unavailable"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestAutomodRulesStoreErrorAnswers500(t *testing.T) {
	s := newTestServer(t)
	s.automod = &fakeAutomod{err: context.DeadlineExceeded}
	rec := doFrom(t, s, "GET", "/api/internal/automod/rules", "", loopback)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

func TestAutomodRulesNilServerDoesNotPanic(t *testing.T) {
	s := newTestServer(t)
	if s.automod != nil {
		t.Fatal("precondition: automod should be nil")
	}
	_ = s.handler() // building the mux must not dereference the nil store
}
