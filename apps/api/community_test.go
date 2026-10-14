package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// fakeCommunity is an in-memory communityStore: it exercises the handlers
// (loopback gate, admin gate, validation, envelopes) with no database.
type fakeCommunity struct {
	welcomeRow  *welcomeConfig
	autoroles   []autoroleRule
	panels      []rolePanel
	assignments []roleAssignment
	nextID      int64
}

func (f *fakeCommunity) welcome(ctx context.Context, guildID string) (*welcomeConfig, error) {
	return f.welcomeRow, nil
}
func (f *fakeCommunity) saveWelcome(ctx context.Context, guildID string, in welcomeConfig) error {
	c := in
	f.welcomeRow = &c
	return nil
}
func (f *fakeCommunity) listAutoroles(ctx context.Context, guildID string) ([]autoroleRule, error) {
	return f.autoroles, nil
}
func (f *fakeCommunity) replaceAutoroles(ctx context.Context, guildID string, rules []autoroleRule) error {
	f.autoroles = rules
	return nil
}
func (f *fakeCommunity) listPanels(ctx context.Context, guildID string) ([]rolePanel, error) {
	return f.panels, nil
}
func (f *fakeCommunity) replacePanels(ctx context.Context, guildID string, panels []rolePanel) error {
	f.panels = panels
	return nil
}
func (f *fakeCommunity) recordAssignment(ctx context.Context, guildID string, in roleAssignmentInput) (roleAssignment, error) {
	f.nextID++
	a := roleAssignment{ID: f.nextID, UserID: in.UserID, RoleID: in.RoleID, Action: in.Action, Source: in.Source, Status: in.Status, Error: in.Error}
	f.assignments = append(f.assignments, a)
	return a, nil
}
func (f *fakeCommunity) listAssignments(ctx context.Context, guildID string, limit int) ([]roleAssignment, error) {
	return f.assignments, nil
}

func communityServer(t *testing.T, f *fakeCommunity) *server {
	t.Helper()
	s := newTestServer(t)
	s.community = f
	return s
}

// The fake must satisfy the interface, including the `welcome` method name.
var _ communityStore = (*fakeCommunity)(nil)

func TestCommunityConfigLoopbackOnly(t *testing.T) {
	s := communityServer(t, &fakeCommunity{})
	// A non-loopback peer sees a 404 (route is invisible), not a 403.
	rec := doFrom(t, s, "GET", "/api/internal/community/config", "", "203.0.113.9:1234")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-loopback status = %d, want 404", rec.Code)
	}
	rec = doFrom(t, s, "GET", "/api/internal/community/config", "", loopback)
	if rec.Code != http.StatusOK {
		t.Fatalf("loopback status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestCommunityConfigUnavailableWithoutStore(t *testing.T) {
	s := newTestServer(t) // community == nil
	rec := doFrom(t, s, "GET", "/api/internal/community/config", "", loopback)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestInternalRoleAssignmentValidation(t *testing.T) {
	s := communityServer(t, &fakeCommunity{})
	// A valid add records.
	rec := doFrom(t, s, "POST", "/api/internal/role-assignments", `{"userId":"100000000000000001","roleId":"200000000000000002","action":"add","source":"autorole","status":"ok"}`, loopback)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	// A non-snowflake role id is refused.
	rec = doFrom(t, s, "POST", "/api/internal/role-assignments", `{"userId":"100000000000000001","roleId":"abc","action":"add","source":"autorole","status":"ok"}`, loopback)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad roleId status = %d, want 400", rec.Code)
	}
	// An unknown source is refused.
	rec = doFrom(t, s, "POST", "/api/internal/role-assignments", `{"userId":"100000000000000001","roleId":"200000000000000002","action":"add","source":"hacker","status":"ok"}`, loopback)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad source status = %d, want 400", rec.Code)
	}
}

func TestAdminWelcomeRequiresAdmin(t *testing.T) {
	s := communityServer(t, &fakeCommunity{})
	rec := do(t, s, "GET", "/api/admin/welcome", "", "")
	if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
		t.Fatalf("unauthenticated status = %d, want 401/403", rec.Code)
	}
	rec = do(t, s, "GET", "/api/admin/welcome", adminCookie(t), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("admin GET status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestAdminWelcomeRoundTrip(t *testing.T) {
	f := &fakeCommunity{}
	s := communityServer(t, f)
	body := `{"joinEnabled":true,"joinChannelId":"555000000000000005","joinMessage":"hi {user}","leaveEnabled":false}`
	rec := do(t, s, "POST", "/api/admin/welcome", adminCookie(t), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if f.welcomeRow == nil || f.welcomeRow.JoinChannelID != "555000000000000005" || f.welcomeRow.JoinMessage != "hi {user}" {
		t.Fatalf("stored welcome = %+v", f.welcomeRow)
	}
}

func TestAdminWelcomeRejectsBadChannel(t *testing.T) {
	s := communityServer(t, &fakeCommunity{})
	rec := do(t, s, "POST", "/api/admin/welcome", adminCookie(t), `{"joinChannelId":"not-a-snowflake"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestAdminWelcomeRejectsBadEmbed(t *testing.T) {
	s := communityServer(t, &fakeCommunity{})
	rec := do(t, s, "POST", "/api/admin/welcome", adminCookie(t), `{"joinEmbed":"not-json"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestAdminAutorolesReplace(t *testing.T) {
	f := &fakeCommunity{}
	s := communityServer(t, f)
	body := `{"autoroles":[{"id":"1","roleId":"420000000000000042","kind":"on_join","delaySeconds":0,"appliesTo":"human","enabled":true,"priority":0}]}`
	rec := do(t, s, "POST", "/api/admin/autoroles", adminCookie(t), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if len(f.autoroles) != 1 || f.autoroles[0].RoleID != "420000000000000042" {
		t.Fatalf("stored autoroles = %+v", f.autoroles)
	}
}

func TestAdminAutorolesRejectsUnknownKind(t *testing.T) {
	s := communityServer(t, &fakeCommunity{})
	rec := do(t, s, "POST", "/api/admin/autoroles", adminCookie(t), `{"autoroles":[{"roleId":"420000000000000042","kind":"teleport","appliesTo":"all"}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestAdminAutorolesRejectsDuplicateRole(t *testing.T) {
	s := communityServer(t, &fakeCommunity{})
	rec := do(t, s, "POST", "/api/admin/autoroles", adminCookie(t), `{"autoroles":[{"roleId":"420000000000000042","kind":"on_join","appliesTo":"all"},{"roleId":"420000000000000042","kind":"on_join","appliesTo":"all"}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestAdminRolePanelsReplaceAndValidate(t *testing.T) {
	f := &fakeCommunity{}
	s := communityServer(t, f)
	body := `{"panels":[{"id":"p1","kind":"button","mode":"toggle","enabled":true,"options":[{"roleId":"100000000000000010","label":"A"},{"roleId":"100000000000000011","label":"B"}]}]}`
	rec := do(t, s, "POST", "/api/admin/role-panels", adminCookie(t), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if len(f.panels) != 1 || len(f.panels[0].Options) != 2 {
		t.Fatalf("stored panels = %+v", f.panels)
	}
	// A panel with no options is refused.
	rec = do(t, s, "POST", "/api/admin/role-panels", adminCookie(t), `{"panels":[{"id":"p2","kind":"button","mode":"toggle","options":[]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty options status = %d, want 400", rec.Code)
	}
	// A duplicate option role is refused.
	rec = do(t, s, "POST", "/api/admin/role-panels", adminCookie(t), `{"panels":[{"id":"p3","kind":"button","mode":"toggle","options":[{"roleId":"100000000000000010"},{"roleId":"100000000000000010"}]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("dup option status = %d, want 400", rec.Code)
	}
}

func TestAdminRolePanelsRejectsBadMode(t *testing.T) {
	s := communityServer(t, &fakeCommunity{})
	rec := do(t, s, "POST", "/api/admin/role-panels", adminCookie(t), `{"panels":[{"id":"p","kind":"button","mode":"vibes","options":[{"roleId":"100000000000000010"}]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestAdminRoleAssignmentsList(t *testing.T) {
	f := &fakeCommunity{assignments: []roleAssignment{{ID: 1, UserID: "100000000000000001", RoleID: "200000000000000002", Status: "ok"}}}
	s := communityServer(t, f)
	rec := do(t, s, "GET", "/api/admin/role-assignments", adminCookie(t), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out struct {
		Assignments []roleAssignment `json:"assignments"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Assignments) != 1 {
		t.Fatalf("assignments = %+v", out.Assignments)
	}
}

func TestValidateWelcomeForcesChannelWhenEnabled(t *testing.T) {
	w := &welcomeConfig{JoinEnabled: true, JoinChannelID: ""}
	if msg := validateWelcome(w); msg != "" {
		t.Fatalf("unexpected msg %q", msg)
	}
	if w.JoinEnabled {
		t.Fatalf("joinEnabled should be forced false with no channel")
	}
}

func TestValidateAssignmentTruncatesError(t *testing.T) {
	in := &roleAssignmentInput{UserID: "100000000000000001", RoleID: "200000000000000002", Action: "add", Source: "panel", Status: "failed", Error: strings.Repeat("x", 600)}
	if msg := validateAssignment(in); msg != "" {
		t.Fatalf("unexpected msg %q", msg)
	}
	if len(in.Error) != 512 {
		t.Fatalf("error len = %d, want 512", len(in.Error))
	}
}
