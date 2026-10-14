package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// fakeCustomCommands is an in-memory customCommandStore: it exercises the
// handlers (loopback gate, admin gate, validation, envelopes) with no database.
type fakeCustomCommands struct {
	rows []customCommand
}

func (f *fakeCustomCommands) list(ctx context.Context, guildID string) ([]customCommand, error) {
	if f.rows == nil {
		return []customCommand{}, nil
	}
	return f.rows, nil
}
func (f *fakeCustomCommands) replace(ctx context.Context, guildID string, cmds []customCommand) error {
	f.rows = cmds
	return nil
}

var _ customCommandStore = (*fakeCustomCommands)(nil)

func customCommandsServer(t *testing.T, f *fakeCustomCommands) *server {
	t.Helper()
	s := newTestServer(t)
	s.customCommands = f
	return s
}

func TestCustomCommandsLoopbackOnly(t *testing.T) {
	s := customCommandsServer(t, &fakeCustomCommands{})
	rec := doFrom(t, s, "GET", "/api/internal/custom-commands", "", "203.0.113.9:1234")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-loopback status = %d, want 404", rec.Code)
	}
	rec = doFrom(t, s, "GET", "/api/internal/custom-commands", "", loopback)
	if rec.Code != http.StatusOK {
		t.Fatalf("loopback status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestCustomCommandsUnavailableWithoutStore(t *testing.T) {
	s := newTestServer(t) // customCommands == nil
	rec := doFrom(t, s, "GET", "/api/internal/custom-commands", "", loopback)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	rec = do(t, s, "GET", "/api/admin/custom-commands", adminCookie(t), "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("admin status = %d, want 503", rec.Code)
	}
}

func TestInternalCustomCommandsRead(t *testing.T) {
	f := &fakeCustomCommands{rows: []customCommand{{Name: "rules", Enabled: true, Responses: []commandResponse{{Text: "be nice"}}}}}
	s := customCommandsServer(t, f)
	rec := doFrom(t, s, "GET", "/api/internal/custom-commands", "", loopback)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out struct {
		Commands []customCommand `json:"commands"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Commands) != 1 || out.Commands[0].Name != "rules" {
		t.Fatalf("commands = %+v", out.Commands)
	}
}

func TestAdminCustomCommandsRequiresAdmin(t *testing.T) {
	s := customCommandsServer(t, &fakeCustomCommands{})
	rec := do(t, s, "GET", "/api/admin/custom-commands", "", "")
	if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
		t.Fatalf("unauthenticated status = %d, want 401/403", rec.Code)
	}
	rec = do(t, s, "GET", "/api/admin/custom-commands", adminCookie(t), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("admin GET status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestAdminCustomCommandsReplaceRoundTrip(t *testing.T) {
	f := &fakeCustomCommands{}
	s := customCommandsServer(t, f)
	body := `{"commands":[{"name":"Rules","aliases":["rulebook"],"responses":[{"text":"hi {user}"}],"allowedRoles":["420000000000000042"],"allowedChannels":["555000000000000005"],"cooldownSeconds":30,"deleteTrigger":true,"reply":true,"enabled":true}]}`
	rec := do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if len(f.rows) != 1 {
		t.Fatalf("stored rows = %+v", f.rows)
	}
	got := f.rows[0]
	if got.Name != "rules" { // normalised to lowercase
		t.Fatalf("name = %q, want rules", got.Name)
	}
	if len(got.Aliases) != 1 || got.Aliases[0] != "rulebook" {
		t.Fatalf("aliases = %+v", got.Aliases)
	}
	if !got.DeleteTrigger || got.CooldownSeconds != 30 {
		t.Fatalf("flags = %+v", got)
	}
	if len(got.AllowedRoles) != 1 || len(got.AllowedChannels) != 1 {
		t.Fatalf("allow-lists = %+v", got)
	}
}

func TestAdminCustomCommandsRejectsBadName(t *testing.T) {
	s := customCommandsServer(t, &fakeCustomCommands{})
	for _, body := range []string{
		`{"commands":[{"name":"has space","responses":[{"text":"x"}]}]}`,
		`{"commands":[{"name":"","responses":[{"text":"x"}]}]}`,
		`{"commands":[{"name":"UPPER!","responses":[{"text":"x"}]}]}`,
	} {
		rec := do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t), body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, rec.Code)
		}
	}
}

func TestAdminCustomCommandsRejectsDuplicateTrigger(t *testing.T) {
	s := customCommandsServer(t, &fakeCustomCommands{})
	// Two commands sharing a name.
	rec := do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t),
		`{"commands":[{"name":"rules","responses":[{"text":"a"}]},{"name":"rules","responses":[{"text":"b"}]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("dup name status = %d, want 400", rec.Code)
	}
	// An alias colliding with another command's name is refused too — the
	// trigger namespace is shared.
	rec = do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t),
		`{"commands":[{"name":"rules","responses":[{"text":"a"}]},{"name":"info","aliases":["rules"],"responses":[{"text":"b"}]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("alias-collision status = %d, want 400", rec.Code)
	}
}

func TestAdminCustomCommandsRejectsResponseProblems(t *testing.T) {
	s := customCommandsServer(t, &fakeCustomCommands{})
	// No responses.
	rec := do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t), `{"commands":[{"name":"rules","responses":[]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty responses status = %d, want 400", rec.Code)
	}
	// A response with neither text nor embed.
	rec = do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t), `{"commands":[{"name":"rules","responses":[{}]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty response status = %d, want 400", rec.Code)
	}
	// An embed that is not a JSON object.
	rec = do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t), `{"commands":[{"name":"rules","responses":[{"embed":"nope"}]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad embed status = %d, want 400", rec.Code)
	}
}

func TestAdminCustomCommandsRejectsBadAllowLists(t *testing.T) {
	s := customCommandsServer(t, &fakeCustomCommands{})
	rec := do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t),
		`{"commands":[{"name":"rules","responses":[{"text":"x"}],"allowedRoles":["not-an-id"]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad role status = %d, want 400", rec.Code)
	}
	rec = do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t),
		`{"commands":[{"name":"rules","responses":[{"text":"x"}],"allowedChannels":["nope"]}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad channel status = %d, want 400", rec.Code)
	}
}

func TestAdminCustomCommandsRejectsBadCooldown(t *testing.T) {
	s := customCommandsServer(t, &fakeCustomCommands{})
	rec := do(t, s, "POST", "/api/admin/custom-commands", adminCookie(t),
		`{"commands":[{"name":"rules","responses":[{"text":"x"}],"cooldownSeconds":999999}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestAdminCustomCommandsMethodNotAllowed(t *testing.T) {
	s := customCommandsServer(t, &fakeCustomCommands{})
	rec := do(t, s, "PUT", "/api/admin/custom-commands", adminCookie(t), "{}")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestValidateCustomCommandsNormalisesAliases(t *testing.T) {
	cmds := []customCommand{{
		Name:      " rules ",
		Aliases:   []string{"Rulebook", "rulebook", "  "},
		Responses: []commandResponse{{Text: "x"}},
	}}
	if msg := validateCustomCommands(cmds); msg != "" {
		t.Fatalf("unexpected msg %q", msg)
	}
	if cmds[0].Name != "rules" {
		t.Fatalf("name = %q", cmds[0].Name)
	}
	// Duplicates and blanks are dropped, order preserved, case folded.
	if len(cmds[0].Aliases) != 1 || cmds[0].Aliases[0] != "rulebook" {
		t.Fatalf("aliases = %+v", cmds[0].Aliases)
	}
}

func TestValidateCustomCommandsRejectsTooMany(t *testing.T) {
	cmds := make([]customCommand, 0, maxCustomCommands+1)
	for i := 0; i <= maxCustomCommands; i++ {
		cmds = append(cmds, customCommand{Name: "c" + string(rune('a'+i%26)) + string(rune('a'+(i/26)%26)), Responses: []commandResponse{{Text: "x"}}})
	}
	if msg := validateCustomCommands(cmds); msg == "" {
		t.Fatal("expected a too-many message")
	}
}
