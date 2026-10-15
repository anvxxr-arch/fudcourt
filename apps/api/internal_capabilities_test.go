package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/identity"
)

// --- the bot's half of §9: a member's capabilities, resolved by the SAME engine -----------------

// internalDo is `do` for the internal routes: it forges a loopback peer, because the route is
// deliberately invisible to everything else (a non-loopback request is answered as if it does not
// exist, which is asserted below).
func internalDo(t *testing.T, srv *server, method, target, body string, loopback bool) *httptest.ResponseRecorder {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rdr)
	if loopback {
		req.RemoteAddr = "127.0.0.1:54321"
	} else {
		req.RemoteAddr = "203.0.113.7:1234"
	}
	rec := httptest.NewRecorder()
	srv.handler().ServeHTTP(rec, req)
	return rec
}

type internalCapsBody struct {
	Capabilities []string `json:"capabilities"`
	Source       string   `json:"source"`
	MappingEmpty bool     `json:"mappingEmpty"`
	Unknown      []string `json:"unknown"`
}

func decodeInternalCaps(t *testing.T, rec *httptest.ResponseRecorder) internalCapsBody {
	t.Helper()
	var got internalCapsBody
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not the documented shape: %v (%s)", err, rec.Body.String())
	}
	return got
}

// The route must not exist for anyone but the co-located bot: the refusal is a 404, not a 401, so a
// scanner cannot even learn that the path is real.
func TestInternalCapabilitiesRefusesNonLoopback(t *testing.T) {
	srv, _ := permissionsServer(t, &fakeCapabilities{})
	rec := internalDo(t, srv, "POST", "/api/internal/capabilities", `{"userId":"1","roles":[]}`, false)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-loopback = %d, want 404 (route invisible)", rec.Code)
	}
}

func TestInternalCapabilitiesRejectsGetAndBadBody(t *testing.T) {
	srv, _ := permissionsServer(t, &fakeCapabilities{})

	if rec := internalDo(t, srv, "GET", "/api/internal/capabilities", "", true); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET = %d, want 405", rec.Code)
	}
	for _, body := range []string{`{`, `{"userId":"","roles":[]}`, `{"userId":"not-an-id","roles":[]}`, `{"userId":"800","roles":[]}`} {
		rec := internalDo(t, srv, "POST", "/api/internal/capabilities", body, true)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s = %d, want 400 (a snowflake is a requirement, not a hint)", body, rec.Code)
		}
	}
}

// The happy path the bot depends on: the member holds a mapped role, so the command may proceed.
func TestInternalCapabilitiesServesGrantedRole(t *testing.T) {
	const roleID = "800000000000000001"
	srv, _ := permissionsServer(t, &fakeCapabilities{byRole: map[string][]string{
		roleID: {"moderation.kick", "moderation.warn"},
	}})
	rec := internalDo(t, srv, "POST", "/api/internal/capabilities",
		`{"userId":"900000000000000002","roles":["`+roleID+`"]}`, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	got := decodeInternalCaps(t, rec)
	if got.Source != "roles" || got.MappingEmpty {
		t.Fatalf("source = %q mappingEmpty = %v, want roles/false", got.Source, got.MappingEmpty)
	}
	for _, want := range []string{"moderation.kick", "moderation.warn"} {
		if !contains(got.Capabilities, want) {
			t.Fatalf("capabilities %v must carry %s", got.Capabilities, want)
		}
	}
}

// The compatibility contract: while no role holds ANY grant, the bot keeps its pre-existing gate
// (admin role / Discord permission) instead of refusing every command an operator has not mapped yet.
// `mappingEmpty` is what makes that possible, so it must be reported truthfully.
func TestInternalCapabilitiesKeepsTheBotGateWhileMappingIsEmpty(t *testing.T) {
	srv, _ := permissionsServer(t, &fakeCapabilities{})
	env := srv.discord.effective(context.Background())
	if env.RoleAdmin == "" {
		t.Fatal("the test server has no admin role id; this test cannot state its claim")
	}
	rec := internalDo(t, srv, "POST", "/api/internal/capabilities",
		`{"userId":"900000000000000002","roles":["`+env.RoleAdmin+`"]}`, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	got := decodeInternalCaps(t, rec)
	if !got.MappingEmpty {
		t.Fatal("mappingEmpty = false with no grants stored; the bot would refuse an unmapped guild")
	}
	if got.Source != "admin_baseline" {
		t.Fatalf("source = %q, want admin_baseline for the admin role with an empty mapping", got.Source)
	}
}

// §9 in one assertion: the dashboard and the bot must not disagree about what an identity may do.
// Both paths are exercised with the SAME roles, and the resolved sets must be identical — if the bot
// re-invented tier logic on its side, this is the test that would catch it.
func TestInternalCapabilitiesAgreesWithTheDashboard(t *testing.T) {
	const (
		roleID = "800000000000000001"
		userID = "900000000000000002"
	)
	srv, _ := permissionsServer(t, &fakeCapabilities{byRole: map[string][]string{
		roleID: {"moderation.kick", "cases.read", "logging.view"},
	}})

	panel := do(t, srv, "GET", "/api/admin/permissions", capCookie(t, userID, identity.TierAdmin, []string{roleID}), "")
	if panel.Code != http.StatusOK {
		t.Fatalf("dashboard = %d, want 200 (%s)", panel.Code, panel.Body.String())
	}
	var body struct {
		Actor struct {
			Capabilities []string `json:"capabilities"`
		} `json:"actor"`
	}
	if err := json.Unmarshal(panel.Body.Bytes(), &body); err != nil {
		t.Fatalf("dashboard body: %v", err)
	}

	bot := internalDo(t, srv, "POST", "/api/internal/capabilities",
		`{"userId":"`+userID+`","roles":["`+roleID+`"]}`, true)
	if bot.Code != http.StatusOK {
		t.Fatalf("bot = %d, want 200 (%s)", bot.Code, bot.Body.String())
	}
	fromBot := decodeInternalCaps(t, bot)

	if strings.Join(fromBot.Capabilities, ",") != strings.Join(body.Actor.Capabilities, ",") {
		t.Fatalf("§9 violated: dashboard says %v, the bot says %v", body.Actor.Capabilities, fromBot.Capabilities)
	}
	if len(fromBot.Capabilities) == 0 {
		t.Fatal("both paths agree on an EMPTY set; the test proves nothing about what it claims")
	}
}

// The contract is what the BOT is written against: its client parses this exact shape, so a field
// renamed here but not there would only fail at runtime, inside a Discord command. Cheap guard, real
// failure mode.
func TestInternalCapabilitiesIsDocumented(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/openapi/fudcourt.yaml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, want := range []string{
		"/api/internal/capabilities:",
		"InternalCapabilitiesResponse:",
		"mappingEmpty",
		"admin_baseline",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("the contract no longer documents %q; the bot is coded against it", want)
		}
	}
}

func contains(list []string, want string) bool {
	for _, got := range list {
		if got == want {
			return true
		}
	}
	return false
}
