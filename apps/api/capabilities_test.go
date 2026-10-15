package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/capability"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/identity"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/cache"
)

// fakeCapabilities is the in-memory capabilityStore. replaceRole overwrites ONE role and leaves the
// others alone, exactly as the SQL transaction does, so a handler that clobbers the rest of the
// mapping fails here rather than in production.
type fakeCapabilities struct {
	byRole map[string][]string
	err    error
}

func (f *fakeCapabilities) listGrants(_ context.Context, _ string) (map[string][]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make(map[string][]string, len(f.byRole))
	for role, grants := range f.byRole {
		out[role] = append([]string(nil), grants...)
	}
	return out, nil
}

func (f *fakeCapabilities) replaceRole(_ context.Context, _, roleID string, grants []string, _ string) error {
	if f.err != nil {
		return f.err
	}
	if f.byRole == nil {
		f.byRole = map[string][]string{}
	}
	if len(grants) == 0 {
		delete(f.byRole, roleID)
		return nil
	}
	f.byRole[roleID] = append([]string(nil), grants...)
	return nil
}

// capCookie mints a session for an arbitrary identity: the permission tests need the owner, an admin
// whose roles hold something, and an admin whose roles hold nothing.
func capCookie(t *testing.T, id string, tier identity.Tier, roles []string) string {
	t.Helper()
	token, err := identity.CreateSessionToken(routeTestSecret, identity.SessionClaims{
		ID: id, Username: "user-" + id, Tier: tier, Roles: roles,
	}, identity.SessionMaxAge, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return identity.SessionCookieName + "=" + token
}

// permissionsServer is a test server with both stores the permissions routes touch: the capability
// mapping and the audit trail.
func permissionsServer(t *testing.T, store *fakeCapabilities) (*server, *fakeLogging) {
	t.Helper()
	s := newTestServer(t)
	s.capabilities = store
	audit := &fakeLogging{}
	s.logging = audit
	return s, audit
}

func decodePermissions(t *testing.T, rec *httptest.ResponseRecorder) permissionsBody {
	t.Helper()
	var body permissionsBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not a permissions envelope: %v (%s)", err, rec.Body.String())
	}
	return body
}

// TestContractCarriesTheVocabularyWeCheck keeps the two copies of one vocabulary — this package's List
// and the contract's Capability enum — from drifting apart. A capability the code checks but the
// contract omits cannot be discovered by a client; one the contract offers but the code does not know
// is a grant the panel would let an operator make and nothing would honour.
func TestContractCarriesTheVocabularyWeCheck(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/openapi/fudcourt.yaml")
	if err != nil {
		t.Fatalf("read the contract: %v", err)
	}
	text := string(raw)
	at := strings.Index(text, "\n    Capability:")
	if at < 0 {
		t.Fatal("the contract has no Capability schema")
	}
	open := strings.Index(text[at:], "enum: [")
	if open < 0 {
		t.Fatal("the Capability schema has no enum")
	}
	open += at + len("enum: [")
	closeIdx := strings.Index(text[open:], "]")
	if closeIdx < 0 {
		t.Fatal("the Capability enum is unterminated")
	}
	enum := text[open : open+closeIdx]
	tokens := []string{}
	for _, part := range strings.Split(enum, ",") {
		if c := strings.TrimSpace(part); c != "" {
			tokens = append(tokens, c)
		}
	}
	if want := capability.List; !reflect.DeepEqual(tokens, want) {
		t.Fatalf("contract enum = %v\nwant the code's List = %v", tokens, want)
	}
}

func TestPermissionsRequireASession(t *testing.T) {
	s, _ := permissionsServer(t, &fakeCapabilities{})
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		rec := do(t, s, method, "/api/admin/permissions", "", `{"roleId":"800000000000000001","capabilities":[]}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s without a session = %d, want 401 (%s)", method, rec.Code, rec.Body.String())
		}
	}
}

func TestPermissionsPutRequiresTheAdminTier(t *testing.T) {
	// The capability engine answers "what may this identity do", but it is not the outer wall: a team
	// session is refused by the tier gate before the engine is consulted, which is the order the whole
	// admin plane already uses.
	s, audit := permissionsServer(t, &fakeCapabilities{byRole: map[string][]string{"800000000000000001": {"permissions.manage"}}})
	rec := do(t, s, http.MethodPut, "/api/admin/permissions",
		capCookie(t, "3", identity.TierTeam, []string{"800000000000000001"}), `{"roleId":"800000000000000001","capabilities":["logs.read"]}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("team session = %d, want 401 (%s)", rec.Code, rec.Body.String())
	}
	if len(audit.audit) != 0 {
		t.Fatalf("a refused write must not be audited as a change: %+v", audit.audit)
	}
}

func TestPermissionsGetSeedsAnAdminWhileTheMappingIsEmpty(t *testing.T) {
	s, _ := permissionsServer(t, &fakeCapabilities{})
	rec := do(t, s, http.MethodGet, "/api/admin/permissions", adminCookie(t), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d (%s)", rec.Code, rec.Body.String())
	}
	body := decodePermissions(t, rec)
	if body.Actor.Source != "admin_baseline" {
		t.Fatalf("actor.source = %q, want admin_baseline", body.Actor.Source)
	}
	if len(body.Actor.Capabilities) != len(capability.List) {
		t.Fatalf("baseline holds %d capabilities, want all %d", len(body.Actor.Capabilities), len(capability.List))
	}
	if len(body.Roles) != 0 {
		t.Fatalf("roles = %v, want none: the mapping is empty", body.Roles)
	}
	if len(body.Capabilities) != len(capability.List) || len(body.Namespaces) == 0 {
		t.Fatalf("the vocabulary must travel with the mapping: %d capabilities, %d namespaces",
			len(body.Capabilities), len(body.Namespaces))
	}
}

func TestPermissionsPutGrantsAWildcardAndResolvesIt(t *testing.T) {
	store := &fakeCapabilities{}
	s, audit := permissionsServer(t, store)
	rec := do(t, s, http.MethodPut, "/api/admin/permissions", adminCookie(t),
		`{"roleId":"800000000000000001","capabilities":["moderation.*","logs.read"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d (%s)", rec.Code, rec.Body.String())
	}
	var echo struct {
		OK           bool     `json:"ok"`
		RoleID       string   `json:"roleId"`
		Capabilities []string `json:"capabilities"`
		Resolved     []string `json:"resolved"`
		Unknown      []string `json:"unknown"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &echo); err != nil {
		t.Fatal(err)
	}
	if !echo.OK || echo.RoleID != "800000000000000001" {
		t.Fatalf("echo = %+v", echo)
	}
	if len(echo.Unknown) != 0 {
		t.Fatalf("unknown = %v, want none", echo.Unknown)
	}
	// The stored form is what was sent (a wildcard is stored as a wildcard); the effect is expanded.
	if len(store.byRole["800000000000000001"]) != 2 || store.byRole["800000000000000001"][0] != "moderation.*" {
		t.Fatalf("stored = %v, want the grants as written", store.byRole["800000000000000001"])
	}
	want := []string{"moderation.read", "moderation.warn", "moderation.timeout", "moderation.kick", "moderation.ban", "logs.read"}
	if len(echo.Resolved) != len(want) {
		t.Fatalf("resolved = %v, want %v (in render order)", echo.Resolved, want)
	}
	for i, c := range want {
		if echo.Resolved[i] != c {
			t.Fatalf("resolved[%d] = %q, want %q", i, echo.Resolved[i], c)
		}
	}
	// The change is accountable: one audit row, with the before (nothing) and the after.
	if len(audit.audit) != 1 {
		t.Fatalf("audit rows = %d, want 1", len(audit.audit))
	}
	if got := audit.audit[0]; got.Action != "permissions.changed" || got.ResourceType != "role_capabilities" || got.ResourceID != "800000000000000001" {
		t.Fatalf("audit = %+v", got)
	}
	if len(audit.audit[0].After) == 0 {
		t.Fatal("the audit row must carry the new grants")
	}
}

func TestPermissionsPutRefusesAnUnknownCapabilityAndWritesNothing(t *testing.T) {
	store := &fakeCapabilities{}
	s, _ := permissionsServer(t, store)
	rec := do(t, s, http.MethodPut, "/api/admin/permissions", adminCookie(t),
		`{"roleId":"800000000000000001","capabilities":["logs.read","ghost.read"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("PUT = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ghost.read") {
		t.Fatalf("the refusal must name the offending grant: %s", rec.Body.String())
	}
	if len(store.byRole) != 0 {
		t.Fatalf("a refused write stored %v — validation must come before any write", store.byRole)
	}
}

func TestPermissionsPutRefusesAnUnstorableRoleID(t *testing.T) {
	store := &fakeCapabilities{}
	s, _ := permissionsServer(t, store)
	for _, roleID := range []string{"", "admin", "800 ", "-1"} {
		body, _ := json.Marshal(permissionsWrite{RoleID: roleID, Capabilities: []string{"logs.read"}})
		rec := do(t, s, http.MethodPut, "/api/admin/permissions", adminCookie(t), string(body))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("roleId %q = %d, want 400 (%s)", roleID, rec.Code, rec.Body.String())
		}
	}
	if len(store.byRole) != 0 {
		t.Fatalf("nothing may be stored: %v", store.byRole)
	}
}

func TestPermissionsPutRefusesAnAdminWhoseRolesHoldNothing(t *testing.T) {
	// The mapping is no longer empty, so the seeding rule is over: this admin holds no grant, and the
	// engine — not the tier — decides. This is the test that would fail if the admin tier were a
	// permanent bypass, which would make §22's mapping decoration for the identities it exists to
	// constrain.
	store := &fakeCapabilities{byRole: map[string][]string{"900000000000000002": {"logs.read"}}}
	s, audit := permissionsServer(t, store)
	rec := do(t, s, http.MethodPut, "/api/admin/permissions", capCookie(t, "1", identity.TierAdmin, []string{"700000000000000003"}),
		`{"roleId":"800000000000000001","capabilities":["feeds.read"]}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("PUT = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "permissions.manage") || !strings.Contains(rec.Body.String(), "access comes from roles") {
		t.Fatalf("the refusal must name the missing capability and where access comes from: %s", rec.Body.String())
	}
	if _, wrote := store.byRole["800000000000000001"]; wrote {
		t.Fatal("a refused write must not reach the store")
	}
	if len(audit.audit) != 0 {
		t.Fatalf("audit rows = %d, want 0", len(audit.audit))
	}
}

func TestPermissionsPutAllowsAnAdminWhoseRoleHoldsTheCapability(t *testing.T) {
	store := &fakeCapabilities{byRole: map[string][]string{"900000000000000002": {"permissions.manage"}}}
	s, _ := permissionsServer(t, store)
	rec := do(t, s, http.MethodPut, "/api/admin/permissions", capCookie(t, "1", identity.TierAdmin, []string{"900000000000000002"}),
		`{"roleId":"800000000000000001","capabilities":["logs.read"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if len(store.byRole["800000000000000001"]) != 1 || store.byRole["800000000000000001"][0] != "logs.read" {
		t.Fatalf("stored = %v", store.byRole["800000000000000001"])
	}
	if len(store.byRole["900000000000000002"]) != 1 {
		t.Fatalf("the writing role's own grants must survive: %v", store.byRole["900000000000000002"])
	}
}

func TestPermissionsPutRevokesByDeclaration(t *testing.T) {
	store := &fakeCapabilities{byRole: map[string][]string{"800000000000000001": {"logs.read"}, "900000000000000002": {"permissions.manage"}}}
	s, _ := permissionsServer(t, store)
	rec := do(t, s, http.MethodPut, "/api/admin/permissions", capCookie(t, "1", identity.TierAdmin, []string{"900000000000000002"}),
		`{"roleId":"800000000000000001","capabilities":[]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d (%s)", rec.Code, rec.Body.String())
	}
	if grants, ok := store.byRole["800000000000000001"]; ok {
		t.Fatalf("role 800 still holds %v — an empty declaration is a revoke", grants)
	}
	if len(store.byRole["900000000000000002"]) != 1 {
		t.Fatal("a revoke must not touch another role")
	}
}

func TestPermissionsGetReportsDriftPerRole(t *testing.T) {
	store := &fakeCapabilities{byRole: map[string][]string{"800000000000000001": {"logs.read", "ghost.read"}}}
	s, _ := permissionsServer(t, store)
	rec := do(t, s, http.MethodGet, "/api/admin/permissions", adminCookie(t), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d (%s)", rec.Code, rec.Body.String())
	}
	body := decodePermissions(t, rec)
	if len(body.Roles) != 1 {
		t.Fatalf("roles = %+v, want the one granted role", body.Roles)
	}
	if got := body.Roles[0].Unknown; len(got) != 1 || got[0] != "ghost.read" {
		t.Fatalf("unknown = %v, want [ghost.read] — drift must be visible, not silently dropped", got)
	}
	if len(body.Roles[0].Capabilities) != 2 {
		t.Fatalf("grants = %v, want both as stored", body.Roles[0].Capabilities)
	}
}

func TestPermissionsPutAllowsTheGuildOwnerWithoutAnyMapping(t *testing.T) {
	// The mapping is NOT empty and holds nothing for the owner's roles, so the seeding rule is over and
	// the role path grants nothing: only §22's owner override can let this write through.
	store := &fakeCapabilities{byRole: map[string][]string{"700000000000000003": {"logs.read"}}}
	s, _ := permissionsServer(t, store)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v10/guilds/100", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bot bot" {
			t.Errorf("guild fetch Authorization = %q, want the bot token", got)
		}
		_, _ = io.WriteString(w, `{"id":"100","name":"guild","owner_id":"1"}`)
	})
	stub := httptest.NewServer(mux)
	t.Cleanup(stub.Close)
	s.discord.apiBase = stub.URL + "/api/v10"
	s.discord.owner = cache.New[string](time.Hour)

	// TierAdmin as well as the owner: on THIS route the tier gate is the outer wall (the whole admin
	// plane uses it), so what is being tested is the INNER decision — an admin-tier session whose roles
	// hold nothing, against a non-empty mapping, passes only because it is the owner.
	owner := capCookie(t, "1", identity.TierAdmin, []string{"700000000000000003"})
	rec := do(t, s, http.MethodPut, "/api/admin/permissions", owner,
		`{"roleId":"800000000000000001","capabilities":["logs.read"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner PUT = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	get := do(t, s, http.MethodGet, "/api/admin/permissions", owner, "")
	if get.Code != http.StatusOK {
		t.Fatalf("owner GET = %d (%s)", get.Code, get.Body.String())
	}
	if body := decodePermissions(t, get); body.Actor.Source != "owner" {
		t.Fatalf("actor.source = %q, want owner", body.Actor.Source)
	}
	// And a non-owner member is still refused, so the override is about the owner and not about who
	// happened to authenticate.
	// A different admin, same roles, same empty grants: 403 from the engine, not 401 from the tier.
	rec = do(t, s, http.MethodPut, "/api/admin/permissions", capCookie(t, "2", identity.TierAdmin, []string{"700000000000000003"}),
		`{"roleId":"800000000000000001","capabilities":["logs.read"]}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-owner admin PUT = %d, want 403 from the engine", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// The admin plane is capability-gated
//
// The point of the engine is not that its own editor works; it is that every OTHER admin route is
// subject to the mapping too. Each route below is driven twice with the SAME admin session: once with
// a role that holds something else, once with a role that holds what the route needs. Only the first
// may be refused — and the refusal must NAME the capability, because the operator's next move is to
// grant it.
//
// `automod.read` is the "something else" on purpose: no admin route checks it (the AutoMod rules are
// reached by the bot, not the panel), so it can never accidentally satisfy a case below.

const gatedRole = "900000000000000001"
const unrelatedRole = "900000000000000009"

func TestAdminPlaneIsCapabilityGated(t *testing.T) {
	// A NON-empty mapping is what switches the engine on. While no role holds anything, the admin tier
	// keeps the full set (the seeding rule), which is why upgrading cannot lock an operator out.
	denyStore := &fakeCapabilities{byRole: map[string][]string{
		unrelatedRole: {"automod.read"},
		gatedRole:     {},
	}}

	cases := []struct {
		method, path, capability string
	}{
		{"POST", "/api/admin/settings", "settings.manage"},
		{"GET", "/api/admin/settings", "settings.read"},
		{"GET", "/api/admin/moderation/cases", "moderation.read"},
		{"POST", "/api/admin/logs/destinations", "logs.write"},
		{"GET", "/api/admin/logs/destinations", "logs.read"},
		{"GET", "/api/admin/logs/audit", "logs.read"},
		{"POST", "/api/admin/welcome", "welcome.write"},
		{"GET", "/api/admin/welcome", "welcome.read"},
		{"POST", "/api/admin/autoroles", "roles.manage"},
		{"GET", "/api/admin/autoroles", "roles.read"},
		{"POST", "/api/admin/role-panels", "roles.manage"},
		{"GET", "/api/admin/role-assignments", "roles.read"},
		{"POST", "/api/admin/custom-commands", "custom_commands.manage"},
		{"POST", "/api/admin/feeds", "feeds.manage"},
		{"GET", "/api/admin/feeds", "feeds.read"},
		{"POST", "/api/admin/scheduler", "scheduler.manage"},
		{"GET", "/api/admin/scheduler", "scheduler.read"},
		{"POST", "/api/admin/members", "roles.manage"},
	}

	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			denied, _ := permissionsServer(t, denyStore)
			rec := do(t, denied, tc.method, tc.path, capCookie(t, "1", identity.TierAdmin, []string{unrelatedRole}), "{}")
			if rec.Code != http.StatusForbidden {
				t.Fatalf("an admin whose roles hold something else got %d, want 403 for %s (%s)",
					rec.Code, tc.capability, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.capability) {
				t.Fatalf("the refusal must name %q so the operator knows what to grant: %s", tc.capability, rec.Body.String())
			}

			// Same session shape, one grant different: the route must get PAST the capability gate. What
			// it answers afterwards (400 on an empty body, 500 with no store wired) is not this test's
			// business — only that the gate is not what stopped it.
			allowed, _ := permissionsServer(t, &fakeCapabilities{byRole: map[string][]string{
				gatedRole: {tc.capability},
			}})
			ok := do(t, allowed, tc.method, tc.path, capCookie(t, "1", identity.TierAdmin, []string{gatedRole}), "{}")
			if ok.Code == http.StatusForbidden && strings.Contains(ok.Body.String(), "capability") {
				t.Fatalf("an admin holding %s was refused by the capability gate: %d %s",
					tc.capability, ok.Code, ok.Body.String())
			}
		})
	}
}

// The member LIST is deliberately tier-only: reading who is in the guild has no capability of its own
// in the vocabulary, and inventing one would be a name with no check behind it (§22's rule is that
// every capability is a line of code that checks it). Its WRITES are gated — that is where the damage
// would be — and this test pins the distinction so nobody "fixes" it by accident.
func TestAdminMembersListStaysTierOnly(t *testing.T) {
	srv, _ := permissionsServer(t, &fakeCapabilities{byRole: map[string][]string{unrelatedRole: {"automod.read"}}})
	rec := do(t, srv, "GET", "/api/admin/members", capCookie(t, "1", identity.TierAdmin, []string{unrelatedRole}), "")
	if rec.Code == http.StatusForbidden {
		t.Fatalf("the member list is tier-gated by design, but the capability gate refused it: %s", rec.Body.String())
	}
}

// A member with no session still cannot reach an admin route at all: the tier gate comes FIRST, so the
// capability layer never has to be the thing standing between the public internet and the panel.
func TestCapabilityGateStillRequiresTheAdminTier(t *testing.T) {
	srv, _ := permissionsServer(t, &fakeCapabilities{byRole: map[string][]string{gatedRole: {"settings.manage"}}})
	rec := do(t, srv, "POST", "/api/admin/settings", capCookie(t, "1", identity.TierMember, []string{gatedRole}), "{}")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a non-admin holding the capability got %d, want 401 (the dashboard is an admin surface)", rec.Code)
	}
}
