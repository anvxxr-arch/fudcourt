package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeCases is an in-memory casesStore: it exercises the handlers (validation,
// loopback gate, admin gate, envelopes) without a database. The SQL-specific
// behaviour (sequence-backed case_number, SQL-derived expires_at) is covered by
// the schema bootstrap gate + a live-database integration run, not here.
type fakeCases struct {
	mu    sync.Mutex
	cases []moderationCase
}

func (f *fakeCases) create(_ context.Context, in caseCreateInput) (moderationCase, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := int64(len(f.cases) + 1)
	c := moderationCase{
		ID: n, CaseNumber: n, GuildID: in.GuildID, Action: in.Action,
		TargetUserID: in.TargetUserID, ModeratorUserID: in.ModeratorUserID,
		Reason: in.Reason, DurationSeconds: in.DurationSeconds, Source: in.Source,
		Status: statusFor(in.Action), CreatedAt: "2026-01-01 00:00:00", UpdatedAt: "2026-01-01 00:00:00",
	}
	if in.DurationSeconds != nil {
		c.ExpiresAt = "2026-01-01 00:10:00"
	}
	f.cases = append(f.cases, c)
	return c, nil
}

func (f *fakeCases) recent(_ context.Context, guildID string, limit int) ([]moderationCase, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]moderationCase, 0, limit)
	for i := len(f.cases) - 1; i >= 0 && len(out) < limit; i-- {
		if f.cases[i].GuildID == guildID {
			out = append(out, f.cases[i])
		}
	}
	return out, nil
}

func (f *fakeCases) byTarget(_ context.Context, guildID, targetID string, limit int) ([]moderationCase, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]moderationCase, 0, limit)
	for i := len(f.cases) - 1; i >= 0 && len(out) < limit; i-- {
		if f.cases[i].GuildID == guildID && f.cases[i].TargetUserID == targetID {
			out = append(out, f.cases[i])
		}
	}
	return out, nil
}

func (f *fakeCases) byNumber(_ context.Context, guildID string, number int64) (moderationCase, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.cases {
		if c.GuildID == guildID && c.CaseNumber == number {
			return c, nil
		}
	}
	return moderationCase{}, errCaseNotFound
}

// casesServer builds a test server with the case store wired. The Discord fake
// carries guild id "100" (routes_test.go), so every case lands there.
func casesServer(t *testing.T) *server {
	t.Helper()
	s := newTestServer(t)
	s.cases = &fakeCases{}
	return s
}

// doFrom is `do` with a caller-chosen RemoteAddr, so the loopback gate is
// exercised (httptest's default peer, 192.0.2.1, is not loopback).
func doFrom(t *testing.T, srv *server, method, target, body, remote string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rdr)
	req.RemoteAddr = remote
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "fudcourt.example")
	rec := httptest.NewRecorder()
	srv.handler().ServeHTTP(rec, req)
	return rec
}

const loopback = "127.0.0.1:54321"

// validCaseBody is a well-formed POST body. Target/moderator are 18-digit
// snowflakes, matching what Discord actually sends.
const validCaseBody = `{"action":"warn","targetUserId":"111111111111111111","moderatorUserId":"222222222222222222","reason":"spam","source":"slash"}`

func decodeCase(t *testing.T, rec *httptest.ResponseRecorder) moderationCase {
	t.Helper()
	var c moderationCase
	if err := json.Unmarshal(rec.Body.Bytes(), &c); err != nil {
		t.Fatalf("decode case: %v (body %s)", err, rec.Body.String())
	}
	return c
}

func TestCaseCreateRecordsAction(t *testing.T) {
	s := casesServer(t)
	rec := doFrom(t, s, "POST", "/api/internal/moderation/cases", validCaseBody, loopback)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body.String())
	}
	c := decodeCase(t, rec)
	if c.CaseNumber != 1 || c.Action != "warn" || c.Status != "closed" {
		t.Fatalf("case = %+v", c)
	}
	if c.GuildID != "100" {
		t.Fatalf("guild = %q, want the configured 100", c.GuildID)
	}
	if c.TargetUserID != "111111111111111111" {
		t.Fatalf("target = %q", c.TargetUserID)
	}
}

func TestCaseCreatePinsGuildFromConfigNotBody(t *testing.T) {
	s := casesServer(t)
	// A body claiming another guild must not move the record: config wins.
	body := `{"guildId":"999","action":"kick","targetUserId":"111111111111111111","moderatorUserId":"222222222222222222"}`
	rec := doFrom(t, s, "POST", "/api/internal/moderation/cases", body, loopback)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	if c := decodeCase(t, rec); c.GuildID != "100" {
		t.Fatalf("guild = %q, want 100 (config authoritative)", c.GuildID)
	}
}

func TestCaseCreateDefaultsSourceToSlash(t *testing.T) {
	s := casesServer(t)
	body := `{"action":"ban","targetUserId":"111111111111111111","moderatorUserId":"222222222222222222"}`
	rec := doFrom(t, s, "POST", "/api/internal/moderation/cases", body, loopback)
	if c := decodeCase(t, rec); c.Source != "slash" {
		t.Fatalf("source = %q, want slash", c.Source)
	}
}

func TestCaseCreateRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"unknown action", `{"action":"nuke","targetUserId":"111111111111111111","moderatorUserId":"222222222222222222"}`},
		{"target not a snowflake", `{"action":"warn","targetUserId":"victim","moderatorUserId":"222222222222222222"}`},
		{"moderator not a snowflake", `{"action":"warn","targetUserId":"111111111111111111","moderatorUserId":"mod"}`},
		{"unknown source", `{"action":"warn","targetUserId":"111111111111111111","moderatorUserId":"222222222222222222","source":"telepathy"}`},
		{"negative duration", `{"action":"timeout","targetUserId":"111111111111111111","moderatorUserId":"222222222222222222","durationSeconds":-5}`},
		{"not an object", `[1,2,3]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := casesServer(t)
			rec := doFrom(t, s, "POST", "/api/internal/moderation/cases", tc.body, loopback)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"bad_request"`) {
				t.Fatalf("body = %s, want a bad_request refusal", rec.Body.String())
			}
		})
	}
}

func TestCaseCreateRefusedForNonLoopbackPeer(t *testing.T) {
	s := casesServer(t)
	rec := doFrom(t, s, "POST", "/api/internal/moderation/cases", validCaseBody, "203.0.113.7:4444")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (the route is invisible off-host)", rec.Code)
	}
}

func TestCaseListAndTargetFilter(t *testing.T) {
	s := casesServer(t)
	for _, b := range []string{validCaseBody, validCaseBody} {
		doFrom(t, s, "POST", "/api/internal/moderation/cases", b, loopback)
	}
	// A different target.
	doFrom(t, s, "POST", "/api/internal/moderation/cases",
		`{"action":"ban","targetUserId":"333333333333333333","moderatorUserId":"222222222222222222"}`, loopback)

	rec := doFrom(t, s, "GET", "/api/internal/moderation/cases", "", loopback)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d", rec.Code)
	}
	var list struct {
		Cases []moderationCase `json:"cases"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Cases) != 3 {
		t.Fatalf("list len = %d, want 3", len(list.Cases))
	}
	if list.Cases[0].CaseNumber != 3 {
		t.Fatalf("newest first expected, got case %d first", list.Cases[0].CaseNumber)
	}

	rec = doFrom(t, s, "GET", "/api/internal/moderation/cases?target=333333333333333333", "", loopback)
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Cases) != 1 || list.Cases[0].TargetUserID != "333333333333333333" {
		t.Fatalf("target filter = %+v", list.Cases)
	}
}

func TestCaseByNumberAndMissing(t *testing.T) {
	s := casesServer(t)
	doFrom(t, s, "POST", "/api/internal/moderation/cases", validCaseBody, loopback)

	rec := doFrom(t, s, "GET", "/api/internal/moderation/cases?number=1", "", loopback)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if c := decodeCase(t, rec); c.CaseNumber != 1 {
		t.Fatalf("case = %+v", c)
	}

	rec = doFrom(t, s, "GET", "/api/internal/moderation/cases?number=999", "", loopback)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}

	rec = doFrom(t, s, "GET", "/api/internal/moderation/cases?number=abc", "", loopback)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestCaseMethodGuard(t *testing.T) {
	s := casesServer(t)
	rec := doFrom(t, s, "DELETE", "/api/internal/moderation/cases", "", loopback)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow != "GET, POST" {
		t.Fatalf("Allow = %q", allow)
	}
}

func TestCaseStoreDisabledAnswers503(t *testing.T) {
	s := newTestServer(t) // cases left nil
	rec := doFrom(t, s, "GET", "/api/internal/moderation/cases", "", loopback)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"cases_unavailable"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestAdminCasesRequiresAdminTier(t *testing.T) {
	s := casesServer(t)
	rec := do(t, s, "GET", "/api/admin/moderation/cases", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 without a session", rec.Code)
	}
	rec = do(t, s, "GET", "/api/admin/moderation/cases", adminCookie(t), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with an admin session (body %s)", rec.Code, rec.Body.String())
	}
}

func TestStatusFor(t *testing.T) {
	active := []string{"timeout", "ban"}
	for _, a := range active {
		if got := statusFor(a); got != "active" {
			t.Errorf("statusFor(%q) = %q, want active", a, got)
		}
	}
	for _, a := range []string{"warn", "kick", "purge", "nickname", "lock", "unlock", "slowmode"} {
		if got := statusFor(a); got != "closed" {
			t.Errorf("statusFor(%q) = %q, want closed", a, got)
		}
	}
}

func TestCaseLimitClamp(t *testing.T) {
	cases := map[string]int{
		"/api/internal/moderation/cases":           25,
		"/api/internal/moderation/cases?limit=10":  10,
		"/api/internal/moderation/cases?limit=500": 100,
		"/api/internal/moderation/cases?limit=0":   25,
		"/api/internal/moderation/cases?limit=x":   25,
	}
	for target, want := range cases {
		req := httptest.NewRequest("GET", target, nil)
		if got := caseLimit(req); got != want {
			t.Errorf("caseLimit(%s) = %d, want %d", target, got, want)
		}
	}
}

// TestCaseStoreNilServerDoesNotPanic guards the nil-store path on a server that
// never attached stores (the default for a bare newTestServer).
func TestCaseStoreNilServerDoesNotPanic(t *testing.T) {
	s := newTestServer(t)
	if s.cases != nil {
		t.Fatal("precondition: cases should be nil")
	}
	_ = s.handler() // building the mux must not dereference the nil store
}

func TestCasesServerUsesConfiguredGuild(t *testing.T) {
	s := casesServer(t)
	if got := s.discord.effective(context.Background()).GuildID; got != "100" {
		t.Fatalf("effective guild = %q, want 100", got)
	}
}
