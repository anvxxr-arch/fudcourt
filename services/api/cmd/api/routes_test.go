package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/services/api/internal/identity"
	"github.com/anvxxr-arch/fudcourt/services/api/internal/platform/health"
)

const routeTestSecret = "test-secret-at-least-32-characters-long!!"

// fakeDiscord is a hermetic stand-in for discord.com: the handlers talk to it
// through the same discordClient code the production routes use (the client's
// base URLs are injected), so the tests cover the real HTTP/parse path.
func fakeDiscord(t *testing.T) (*discordClient, *httptest.Server) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.PostFormValue("grant_type") != "authorization_code" {
			w.WriteHeader(400)
			return
		}
		io.WriteString(w, `{"access_token":"oauth-token","token_type":"Bearer"}`)
	})
	mux.HandleFunc("/api/v10/users/@me", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"id":"42","username":"tester","global_name":"Tester","avatar":"hash"}`)
	})
	mux.HandleFunc("/api/v10/guilds/100/members/42", func(w http.ResponseWriter, r *http.Request) {
		// Real Discord member payload: roles are snowflake STRINGS.
		io.WriteString(w, `{"user":{"id":"42"},"roles":["900"]}`)
	})
	mux.HandleFunc("/api/v10/guilds/100/members", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[{"user":{"id":"42","username":"tester","global_name":"Tester","avatar":"hash"},"roles":["900"]}]`)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	dc := newDiscordClient(discordEnv{
		ClientID:     "cid",
		ClientSecret: "csecret",
		RedirectURI:  "https://fudcourt.example/auth/callback",
		GuildID:      "100",
		BotToken:     "bot",
		RoleTeam:     "800",
		RoleAdmin:    "900",
	})
	dc.apiBase = srv.URL + "/api/v10"
	dc.tokenURL = srv.URL + "/api/oauth2/token"
	return dc, srv
}

func newTestServer(t *testing.T) *server {
	t.Helper()
	dc, _ := fakeDiscord(t)
	return &server{health: health.NewRegistry(), discord: dc, secret: routeTestSecret}
}

func adminCookie(t *testing.T) string {
	t.Helper()
	token, err := identity.CreateSessionToken(routeTestSecret, identity.SessionClaims{
		ID: "1", Username: "admin", Tier: identity.TierAdmin, Roles: []string{},
	}, identity.SessionMaxAge, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return identity.SessionCookieName + "=" + token
}

func do(t *testing.T, srv *server, method, target string, cookie string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rdr)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "fudcourt.example")
	rec := httptest.NewRecorder()
	srv.handler().ServeHTTP(rec, req)
	return rec
}

func TestAuthLoginStartsFlow(t *testing.T) {
	rec := do(t, newTestServer(t), "GET", "/api/auth/login?next=/dashboard", "", "")
	if rec.Code != 307 {
		t.Fatalf("status = %d, want 307 (NextResponse.redirect)", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, discordAuthorize+"?") {
		t.Fatalf("authorize location = %q", loc)
	}
	q, err := url.ParseQuery(strings.TrimPrefix(loc, discordAuthorize+"?"))
	if err != nil {
		t.Fatal(err)
	}
	if q.Get("client_id") != "cid" || q.Get("response_type") != "code" ||
		q.Get("scope") != "identify guilds" ||
		q.Get("redirect_uri") != "https://fudcourt.example/auth/callback" {
		t.Fatalf("authorize params drifted: %v", q)
	}
	state := q.Get("state")
	if !strings.HasSuffix(state, "./dashboard") {
		t.Fatalf("state must park the next target: %q", state)
	}
	sc := rec.Header().Get("Set-Cookie")
	if !strings.HasPrefix(sc, stateCookieName+"=") || !strings.Contains(sc, "Max-Age=600") ||
		!strings.Contains(sc, "Secure; HttpOnly; SameSite=lax") {
		t.Fatalf("state cookie drifted: %q", sc)
	}
}

func TestAuthLoginRejectsOpenRedirect(t *testing.T) {
	rec := do(t, newTestServer(t), "GET", "/api/auth/login?next="+url.QueryEscape("//evil.example/x"), "", "")
	q, _ := url.ParseQuery(strings.TrimPrefix(rec.Header().Get("Location"), discordAuthorize+"?"))
	state := q.Get("state")
	if !strings.HasSuffix(state, "./") || strings.Contains(state, "evil") {
		t.Fatalf("an unsafe next must degrade to /: %q", state)
	}
}

func TestAuthLoginUnconfigured(t *testing.T) {
	srv := newTestServer(t)
	srv.discord.env.ClientID = ""
	rec := do(t, srv, "GET", "/api/auth/login", "", "")
	if rec.Code != 500 || !strings.Contains(rec.Body.String(), `"error":"auth_unconfigured"`) {
		t.Fatalf("unconfigured login = %d %s", rec.Code, rec.Body.String())
	}
}

func TestAuthCallbackMintsSession(t *testing.T) {
	srv := newTestServer(t)
	state := "nonce123./dashboard"
	cookie := stateCookieName + "=" + jsEncodeURIComponent(state)
	rec := do(t, srv, "GET", "/api/auth/callback?code=good&state="+url.QueryEscape(state), cookie, "")
	if rec.Code != 307 {
		t.Fatalf("status = %d, want 307: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Location"); got != "https://fudcourt.example/dashboard" {
		t.Fatalf("post-login redirect = %q", got)
	}
	sc := rec.Header().Values("Set-Cookie")
	var retired, session string
	for _, c := range sc {
		if strings.HasPrefix(c, stateCookieName+"=;") {
			retired = c
		}
		if strings.HasPrefix(c, identity.SessionCookieName+"=") {
			session = c
		}
	}
	if !strings.Contains(retired, "Max-Age=0") {
		t.Fatalf("state cookie must be retired: %q", retired)
	}
	if !strings.Contains(session, "Max-Age=604800") {
		t.Fatalf("session cookie must carry SESSION_MAX_AGE: %q", session)
	}
	value := strings.TrimPrefix(strings.SplitN(session, ";", 2)[0], identity.SessionCookieName+"=")
	claims, err := identity.ReadSession(routeTestSecret, jsDecode(t, value), time.Now())
	if err != nil || claims == nil {
		t.Fatalf("minted session must verify: %v %v", claims, err)
	}
	if claims.ID != "42" || claims.Username != "tester" || claims.Avatar == nil ||
		*claims.Avatar != "https://cdn.discordapp.com/avatars/42/hash.png" {
		t.Fatalf("session claims drifted: %+v", claims)
	}
	// Guild/role env is configured and the real Discord role payload is a
	// string list; the {id}-object parser yields no roles, so the resolved tier
	// floors at member ("a successful OAuth identity is at least a member") —
	// never admin, from any role set. Pinned because it is fail-closed (a bug
	// cannot escalate) — see the divergence report for the escalation side.
	if claims.Tier != identity.TierMember {
		t.Fatalf("tier = %q, want member (role ids never resolve from string roles)", claims.Tier)
	}
}

func TestAuthCallbackRefusals(t *testing.T) {
	cases := []struct {
		name, query, cookie, errorToken string
	}{
		{"discord error echoes", "error=access_denied", stateCookieName + "=nonce./dashboard", "discord_denied"},
		{"missing code", "state=nonce", stateCookieName + "=nonce./dashboard", "bad_state"},
		{"state mismatch", "code=x&state=other", stateCookieName + "=nonce./dashboard", "bad_state"},
		{"no state cookie", "code=x&state=nonce", "", "bad_state"},
	}
	for _, tc := range cases {
		rec := do(t, newTestServer(t), "GET", "/api/auth/callback?"+tc.query, tc.cookie, "")
		if rec.Code != 307 {
			t.Fatalf("%s: status = %d, want 307", tc.name, rec.Code)
		}
		loc := rec.Header().Get("Location")
		want := "https://fudcourt.example/login?error=" + jsEncodeFormComponent(tc.errorToken) + "&next=" + jsEncodeFormComponent("/dashboard")
		if tc.cookie == "" {
			want = "https://fudcourt.example/login?error=" + jsEncodeFormComponent(tc.errorToken)
		}
		if loc != want {
			t.Fatalf("%s: redirect = %q, want %q", tc.name, loc, want)
		}
		sc := rec.Header().Get("Set-Cookie")
		if !strings.HasPrefix(sc, stateCookieName+"=;") {
			t.Fatalf("%s: state cookie must be retired: %q", tc.name, sc)
		}
	}
}

func TestAuthLogoutRetiresSession(t *testing.T) {
	for _, method := range []string{"GET", "POST"} {
		rec := do(t, newTestServer(t), method, "/api/auth/logout", "", "")
		if rec.Code != 307 || rec.Header().Get("Location") != "https://fudcourt.example/" {
			t.Fatalf("%s logout = %d %q", method, rec.Code, rec.Header().Get("Location"))
		}
		want := identity.SessionCookieName + "=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax"
		if got := rec.Header().Get("Set-Cookie"); got != want {
			t.Fatalf("%s retire Set-Cookie = %q, want %q", method, got, want)
		}
	}
}

func TestAdminMembersRefusesWithoutAdminSession(t *testing.T) {
	srv := newTestServer(t)
	member, err := identity.CreateSessionToken(routeTestSecret, identity.SessionClaims{
		ID: "2", Username: "m", Tier: identity.TierMember, Roles: []string{},
	}, identity.SessionMaxAge, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, cookie string }{
		{"no session", ""},
		{"member session", identity.SessionCookieName + "=" + member},
	} {
		rec := do(t, srv, "GET", "/api/admin/members", tc.cookie, "")
		if rec.Code != 401 {
			t.Fatalf("%s: status = %d, want 401", tc.name, rec.Code)
		}
		var body routeRefusal
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Error != "unauthorized" || body.Detail != "requires admin tier" {
			t.Fatalf("%s: refusal drifted: %+v", tc.name, body)
		}
		if body.RequestID == "" || body.RequestID != rec.Header().Get("X-Request-Id") {
			t.Fatalf("%s: request_id must correlate the refusal: %+v", tc.name, body)
		}
	}
}

func TestAdminMembersList(t *testing.T) {
	rec := do(t, newTestServer(t), "GET", "/api/admin/members", adminCookie(t), "")
	if rec.Code != 200 {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var body adminMembersBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Members) != 1 || body.Members[0].ID != "42" {
		t.Fatalf("members drifted: %+v", body)
	}
	if body.RoleIDs.Team != "800" || body.RoleIDs.Admin != "900" {
		t.Fatalf("roleIds drifted: %+v", body.RoleIDs)
	}
	// Key order is part of the shape contract (members, then roleIds).
	raw := rec.Body.String()
	if strings.Index(raw, `"members"`) > strings.Index(raw, `"roleIds"`) {
		t.Fatalf("key order drifted: %s", raw)
	}
}

func TestAdminMembersMutateValidation(t *testing.T) {
	srv := newTestServer(t)
	for _, tc := range []struct{ name, body, detail string }{
		{"not json", "nope", "JSON body required"},
		{"scalar json", "7", "JSON body required"},
		{"missing userId", `{"role":"team","action":"add"}`, "userId is required"},
		{"bad role", `{"userId":"42","role":"root","action":"add"}`, "role must be team or admin"},
		{"bad action", `{"userId":"42","role":"team","action":"wipe"}`, "action must be add or remove"},
	} {
		rec := do(t, srv, "POST", "/api/admin/members", adminCookie(t), tc.body)
		if rec.Code != 400 {
			t.Fatalf("%s: status = %d, want 400", tc.name, rec.Code)
		}
		var body routeRefusal
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Error != "bad_request" || body.Detail != tc.detail {
			t.Fatalf("%s: refusal drifted: %+v", tc.name, body)
		}
	}
}

func TestAdminMembersMutateAppliesRole(t *testing.T) {
	rec := do(t, newTestServer(t), "POST", "/api/admin/members", adminCookie(t),
		`{"userId":"42","role":"team","action":"add"}`)
	if rec.Code != 200 {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var body roleMutationBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.UserID != "42" || body.Role != "team" || body.Action != "add" {
		t.Fatalf("mutation envelope drifted: %+v", body)
	}
}

func TestMethodGuardMatchesTSExports(t *testing.T) {
	rec := do(t, newTestServer(t), "POST", "/api/auth/login", "", "")
	if rec.Code != 405 {
		t.Fatalf("login POST = %d, want 405 (Next 405s unexported methods)", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != "GET" {
		t.Fatalf("Allow header = %q", got)
	}
}

// jsDecode is readCookieValue's decode step (JS decodeURIComponent) applied to
// a bare value, for test inputs.
func jsDecode(t *testing.T, value string) string {
	t.Helper()
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Cookie", "v="+value)
	return readCookieValue(req, "v")
}
