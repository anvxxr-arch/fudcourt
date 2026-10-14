package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// fakeLogging is an in-memory loggingStore: it exercises the handlers (loopback
// gate, admin gate, envelopes, camelCase shape, validation) without a database.
// The SQL-specific behaviour (upsert-on-conflict, jsonb NULL for a missing
// before/after, index-backed ordering) is covered by the schema bootstrap gate
// and a live-database run, not here.
type fakeLogging struct {
	destinations []logDestination
	audit        []auditEntry
	nextID       int64
	err          error
}

func (f *fakeLogging) listDestinations(_ context.Context, guildID string) ([]logDestination, error) {
	if f.err != nil {
		return nil, f.err
	}
	return append([]logDestination{}, f.destinations...), nil
}

func (f *fakeLogging) upsertDestination(_ context.Context, guildID, category, channelID string, enabled bool) error {
	if f.err != nil {
		return f.err
	}
	for i := range f.destinations {
		if f.destinations[i].Category == category {
			f.destinations[i] = logDestination{Category: category, ChannelID: channelID, Enabled: enabled}
			return nil
		}
	}
	f.destinations = append(f.destinations, logDestination{Category: category, ChannelID: channelID, Enabled: enabled})
	return nil
}

func (f *fakeLogging) deleteDestination(_ context.Context, guildID, category string) error {
	if f.err != nil {
		return f.err
	}
	kept := f.destinations[:0]
	for _, d := range f.destinations {
		if d.Category != category {
			kept = append(kept, d)
		}
	}
	f.destinations = kept
	return nil
}

func (f *fakeLogging) recordAudit(_ context.Context, in auditInput) (auditEntry, error) {
	if f.err != nil {
		return auditEntry{}, f.err
	}
	f.nextID++
	e := auditEntry{
		ID: f.nextID, GuildID: in.GuildID, ActorID: in.ActorID, ActorName: in.ActorName,
		Action: in.Action, ResourceType: in.ResourceType, ResourceID: in.ResourceID,
		Before: in.Before, After: in.After, Source: in.Source, CreatedAt: "2026-01-01 00:00:00",
	}
	f.audit = append(f.audit, e)
	return e, nil
}

func (f *fakeLogging) listAudit(_ context.Context, guildID, resourceType string, limit int) ([]auditEntry, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := []auditEntry{}
	for i := len(f.audit) - 1; i >= 0 && len(out) < limit; i-- {
		if resourceType == "" || f.audit[i].ResourceType == resourceType {
			out = append(out, f.audit[i])
		}
	}
	return out, nil
}

func loggingServer(t *testing.T, lg *fakeLogging) *server {
	t.Helper()
	s := newTestServer(t)
	s.logging = lg
	return s
}

func TestInternalLogConfigLoopbackOnly(t *testing.T) {
	s := loggingServer(t, &fakeLogging{destinations: []logDestination{
		{Category: "moderation", ChannelID: "111", Enabled: true},
		{Category: "message", ChannelID: "222", Enabled: false},
		{Category: "member", ChannelID: "333", Enabled: true},
	}})

	rec := doFrom(t, s, "GET", "/api/internal/log-config", "", "192.0.2.9:1234")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-loopback = %d, want 404 (route invisible)", rec.Code)
	}

	rec = doFrom(t, s, "GET", "/api/internal/log-config", "", loopback)
	if rec.Code != http.StatusOK {
		t.Fatalf("loopback = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Destinations map[string]string `json:"destinations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Destinations["moderation"] != "111" || body.Destinations["member"] != "333" {
		t.Fatalf("enabled destinations missing: %v", body.Destinations)
	}
	if _, ok := body.Destinations["message"]; ok {
		t.Fatalf("a disabled destination must not be served: %v", body.Destinations)
	}
}

func TestInternalLogConfigMethodGuardAndUnavailable(t *testing.T) {
	s := loggingServer(t, &fakeLogging{})
	rec := doFrom(t, s, "DELETE", "/api/internal/log-config", "", loopback)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE = %d, want 405", rec.Code)
	}

	s.logging = nil
	rec = doFrom(t, s, "GET", "/api/internal/log-config", "", loopback)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("no store = %d, want 503", rec.Code)
	}
}

func TestInternalAuditWrite(t *testing.T) {
	lg := &fakeLogging{}
	s := loggingServer(t, lg)
	rec := doFrom(t, s, "POST", "/api/internal/audit",
		`{"actorId":"999","action":"automod.rule.disable","resourceType":"automod_rule","resourceId":"7","source":"automod"}`, loopback)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	if len(lg.audit) != 1 {
		t.Fatalf("audit rows = %d, want 1", len(lg.audit))
	}
	e := lg.audit[0]
	if e.GuildID != "100" {
		t.Fatalf("guild must be pinned to the configured one: %q", e.GuildID)
	}
	if e.Action != "automod.rule.disable" || e.Source != "automod" {
		t.Fatalf("entry drifted: %+v", e)
	}
}

func TestInternalAuditValidation(t *testing.T) {
	s := loggingServer(t, &fakeLogging{})
	for _, tc := range []struct{ name, body string }{
		{"missing action", `{"resourceType":"settings"}`},
		{"missing resourceType", `{"action":"settings.update"}`},
		{"unknown source", `{"action":"a","resourceType":"b","source":"hacker"}`},
		{"not an object", `[]`},
	} {
		rec := doFrom(t, s, "POST", "/api/internal/audit", tc.body, loopback)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400 (body %s)", tc.name, rec.Code, rec.Body.String())
		}
	}

	// A directly-constructed input with a malformed snapshot must be refused
	// (the JSON decoder cannot deliver invalid JSON, so this guards the
	// validator itself against a caller that builds the input by hand).
	bad := auditInput{Action: "a", ResourceType: "b", Before: json.RawMessage(`{oops`)}
	if msg := validateAuditInput(&bad, "100"); msg == "" {
		t.Fatal("a malformed before snapshot must be refused")
	}
}

func TestAdminLogDestinationsRequiresAdmin(t *testing.T) {
	rec := do(t, loggingServer(t, &fakeLogging{}), "GET", "/api/admin/logs/destinations", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no session = %d, want 401", rec.Code)
	}
}

func TestAdminLogDestinationsRoundTrip(t *testing.T) {
	lg := &fakeLogging{}
	s := loggingServer(t, lg)

	// Set a destination.
	rec := do(t, s, "POST", "/api/admin/logs/destinations", adminCookie(t),
		`{"category":"moderation","channelId":"555555555555555555"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("set = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if len(lg.destinations) != 1 || lg.destinations[0].ChannelID != "555555555555555555" || !lg.destinations[0].Enabled {
		t.Fatalf("destination not persisted: %+v", lg.destinations)
	}
	if len(lg.audit) != 1 || lg.audit[0].Action != "log_destination.set" || lg.audit[0].After == nil {
		t.Fatalf("set must be audited with an after snapshot: %+v", lg.audit)
	}

	// GET shows it.
	rec = do(t, s, "GET", "/api/admin/logs/destinations", adminCookie(t), "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"moderation"`) {
		t.Fatalf("GET = %d %s", rec.Code, rec.Body.String())
	}

	// Clearing (empty channelId) deletes it.
	rec = do(t, s, "POST", "/api/admin/logs/destinations", adminCookie(t), `{"category":"moderation","channelId":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("clear = %d, want 200", rec.Code)
	}
	if len(lg.destinations) != 0 {
		t.Fatalf("clear must delete the row: %+v", lg.destinations)
	}
	if lg.audit[len(lg.audit)-1].Action != "log_destination.clear" {
		t.Fatalf("clear must be audited: %+v", lg.audit)
	}
}

func TestAdminLogDestinationsValidation(t *testing.T) {
	s := loggingServer(t, &fakeLogging{})
	for _, tc := range []struct{ name, body string }{
		{"unknown category", `{"category":"nope","channelId":"555555555555555555"}`},
		{"bad channel", `{"category":"message","channelId":"not-an-id"}`},
		{"not an object", `"x"`},
	} {
		rec := do(t, s, "POST", "/api/admin/logs/destinations", adminCookie(t), tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400 (body %s)", tc.name, rec.Code, rec.Body.String())
		}
	}
}

func TestAdminAuditLogsList(t *testing.T) {
	lg := &fakeLogging{}
	s := loggingServer(t, lg)
	for _, a := range []string{"settings.update", "automod.rule.create", "log_destination.set"} {
		if _, err := lg.recordAudit(context.Background(), auditInput{GuildID: "100", Action: a, ResourceType: "settings"}); err != nil {
			t.Fatal(err)
		}
	}
	rec := do(t, s, "GET", "/api/admin/logs/audit?limit=2", adminCookie(t), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Entries []map[string]any `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Entries) != 2 {
		t.Fatalf("limit not honored: %d entries", len(body.Entries))
	}
	// Newest first.
	if body.Entries[0]["action"] != "log_destination.set" {
		t.Fatalf("audit must be newest-first: %v", body.Entries)
	}

	rec = do(t, s, "GET", "/api/admin/logs/audit", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no session = %d, want 401", rec.Code)
	}
}

// TestSettingsPostRecordsAudit proves the dashboard mutation path is audited
// with a structured before/after — the one config write that exists today.
func TestSettingsPostRecordsAudit(t *testing.T) {
	lg := &fakeLogging{}
	s := loggingServer(t, lg)
	s.discord.settings = &fakeSettings{}

	const newTeam = "801000000000000000"
	rec := do(t, s, "POST", "/api/admin/settings", adminCookie(t), `{"roleTeam":"`+newTeam+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if len(lg.audit) != 1 {
		t.Fatalf("settings write must produce one audit row: %+v", lg.audit)
	}
	e := lg.audit[0]
	if e.Action != "settings.update" || e.ResourceType != "settings" || e.Source != "dashboard" {
		t.Fatalf("audit entry drifted: %+v", e)
	}
	if e.ActorID != "1" {
		t.Fatalf("actor must come from the session: %+v", e)
	}
	var before, after discordConfig
	if err := json.Unmarshal(e.Before, &before); err != nil {
		t.Fatalf("before snapshot not JSON: %v", err)
	}
	if err := json.Unmarshal(e.After, &after); err != nil {
		t.Fatalf("after snapshot not JSON: %v", err)
	}
	if before.RoleTeam != "800" || after.RoleTeam != newTeam {
		t.Fatalf("before/after must bracket the change: before=%+v after=%+v", before, after)
	}
}

// TestRecordAuditSkipsWithoutStoreOrGuild pins the fail-safe: no store, or no
// configured guild, is a silent no-op — never a panic, never a bogus row.
func TestRecordAuditSkipsWithoutStoreOrGuild(t *testing.T) {
	s := newTestServer(t)
	s.recordAudit(context.Background(), auditInput{Action: "x", ResourceType: "y"}) // nil store: no panic

	lg := &fakeLogging{}
	s.logging = lg
	s.discord.env.GuildID = ""
	s.recordAudit(context.Background(), auditInput{Action: "x", ResourceType: "y"})
	if len(lg.audit) != 0 {
		t.Fatalf("an unconfigured guild must not record: %+v", lg.audit)
	}
}
