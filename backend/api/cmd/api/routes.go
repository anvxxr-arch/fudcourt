package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/api/internal/identity"
	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/backend/api/internal/platform/httpx"
)

// The tranche-1 route surface (migration-plan §20 "health/settings/identity
// first"): the identity family that actually exists in the web tree —
// /api/auth/login, /api/auth/callback, /api/auth/logout and the admin control
// plane /api/admin/members (the session/user-info plane). There is no
// standalone settings or health route in frontend/web: health is served by this
// service's own /healthz and /readyz, and the only settings route
// (/api/executor/settings) belongs to the executor slice. Every handler below
// is a behavior-faithful port of the named TS route file: same envelopes,
// same statuses, same redirects, same cookies.
const (
	// stateCookieName / stateTTL are STATE_COOKIE / STATE_TTL in login/route.ts:
	// the per-attempt OAuth nonce parked in a short-lived httpOnly cookie.
	stateCookieName = "fud_oauth_state"
	stateTTL        = 10 * 60
)

// sessionClaims is the one session gate: the signed cookie is the only
// identity input (never a header — a proxy-supplied identity is spoofable).
func (s *server) sessionClaims(r *http.Request) (*identity.SessionClaims, error) {
	return identity.SessionFromCookie(s.secret, readCookieValue(r, identity.SessionCookieName), time.Now())
}

// writeRedirect answers like NextResponse.redirect (307 Temporary Redirect).
func writeRedirect(w http.ResponseWriter, location string) {
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusTemporaryRedirect)
}

// handleAuthLogin ports GET /api/auth/login (login/route.ts): starts the
// Discord OAuth2 flow with a per-attempt nonce in the state cookie. The
// post-login `next` target is attacker-supplied and is filtered through
// identity.IsSafeNext on BOTH ends of the round-trip, exactly as the TS route
// pair does.
func (s *server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	env := s.discord.env
	if env.ClientID == "" || env.RedirectURI == "" {
		writeRefusal(w, r, http.StatusInternalServerError, "auth_unconfigured", errs.CategoryInternal,
			"FUDCOURT_CLIENT_ID and DISCORD_REDIRECT_URI must be set")
		return
	}
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal", errs.CategoryInternal, "internal error")
		return
	}
	nonce := hex.EncodeToString(entropy[:])
	next := "/"
	if raw := r.URL.Query().Get("next"); identity.IsSafeNext(raw) {
		next = raw
	}
	state := nonce + "." + next
	writeCookie(w, stateCookieName, state, time.Now(), cookieOptions{MaxAge: stateTTL})
	// URLSearchParams serializes in insertion order (measured), so the query is
	// built by hand in the TS order with the same codec.
	writeRedirect(w, discordAuthorize+
		"?client_id="+jsEncodeFormComponent(env.ClientID)+
		"&response_type=code"+
		"&redirect_uri="+jsEncodeFormComponent(env.RedirectURI)+
		"&scope="+jsEncodeFormComponent("identify guilds")+
		"&state="+jsEncodeFormComponent(state))
}

// handleAuthLogout ports GET|POST /api/auth/logout (logout/route.ts): drops
// the signed session cookie by overwriting it with maxAge 0 — the outgoing
// Set-Cookie is what retires it in the browser. GET and POST both work so a
// plain <a href> and a form button share one endpoint.
func (s *server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	writeCookie(w, identity.SessionCookieName, "", time.Now(), cookieOptions{MaxAge: 0})
	writeRedirect(w, requestOrigin(r)+"/")
}

// splitState parses the state cookie's `${nonce}.${next}` parking format
// (splitState in callback/route.ts). DIVERGENCE (deliberate, documented): the
// TS implementation returns only the nonce as `state` and then compares it to
// the full Discord-echoed `${nonce}.${next}` — measured 2026-10-01, that
// comparison can never pass, so the TS callback rejects every callback with
// bad_state and login never completes. The documented contract ("the callback
// only accepts a code whose state matches", login/route.ts) is that the echoed
// state equals the PARKED state, so `state` here is the whole parked value.
// The tail is decodeURIComponent-ed and re-validated exactly as the TS code
// does before it may become a redirect target.
func splitState(value string) (state, next string, undecodable bool) {
	if value == "" {
		return "", "/", false
	}
	dot := strings.Index(value, ".")
	if dot <= 0 {
		return "", "/", false
	}
	tail, err := url.PathUnescape(value[dot+1:])
	if err != nil {
		return "", "/", true
	}
	if !identity.IsSafeNext(tail) {
		tail = "/"
	}
	return value, tail, false
}

// handleAuthCallback ports GET /api/auth/callback (callback/route.ts):
// code -> token -> /users/@me -> guild member roles -> tier -> signed session
// cookie. Every failure path ends at /login?error=... with a coarse code; no
// token, secret or Discord payload is ever echoed into a response body, a URL
// or a log line.
func (s *server) handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	now := time.Now()
	origin := requestOrigin(r)
	expectedState, expectedNext, undecodable := splitState(readCookieValue(r, stateCookieName))
	if undecodable {
		// callback/route.ts throws URIError on an undecodable tail and Next
		// answers 500; the JSON envelope is that 500 (documented divergence:
		// there is no Next error page behind this proxy).
		writeRefusal(w, r, http.StatusInternalServerError, "internal", errs.CategoryInternal, "internal error")
		return
	}
	clearState := cookieOptions{MaxAge: 0}
	reject := func(errorToken string) {
		location := origin + "/login?error=" + jsEncodeFormComponent(errorToken)
		if expectedNext != "/" {
			location += "&next=" + jsEncodeFormComponent(expectedNext)
		}
		writeCookie(w, stateCookieName, "", now, clearState)
		writeRedirect(w, location)
	}
	if r.URL.Query().Get("error") != "" {
		reject("discord_denied")
		return
	}
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" || state != expectedState {
		reject("bad_state")
		return
	}
	env := s.discord.env
	if env.ClientID == "" || env.ClientSecret == "" || env.RedirectURI == "" {
		reject("auth_unconfigured")
		return
	}
	token, err := s.discord.exchangeCode(r.Context(), code)
	if err != nil {
		reject("token_exchange_failed")
		return
	}
	profile, err := s.discord.fetchCurrentUser(r.Context(), token)
	if err != nil {
		reject("discord_api_failed")
		return
	}
	roles := s.discord.fetchGuildRoleIDs(r.Context(), profile.ID)
	// tierFromRoles verbatim (guard.ts): the tier, error ignored — the Go port
	// additionally reports role-env misconfiguration loudly, and guard.ts's
	// silent answer is what the route's behavior must mirror.
	resolved, _ := identity.TierFromRoleIDs(roles, s.discord.roleEnv())
	tier := resolved
	if tier == identity.TierPublic {
		// "`public` from tierFromRoles means the guild/role env is unset — a
		// successful OAuth identity is at least a member, never anonymous."
		tier = identity.TierMember
	}
	claims := identity.SessionClaims{
		ID:         profile.ID,
		Username:   profile.Username,
		GlobalName: profile.GlobalName,
		Tier:       tier,
		Roles:      roles,
	}
	if profile.Avatar != nil {
		avatar := "https://cdn.discordapp.com/avatars/" + profile.ID + "/" + *profile.Avatar + ".png"
		claims.Avatar = &avatar
	}
	signed, err := identity.CreateSessionToken(s.secret, claims, identity.SessionMaxAge, now)
	if err != nil {
		reject("session_secret_missing")
		return
	}
	writeCookie(w, stateCookieName, "", now, clearState)
	writeCookie(w, identity.SessionCookieName, signed, now, cookieOptions{MaxAge: identity.SessionMaxAge})
	writeRedirect(w, origin+jsEncodeURLPath(expectedNext))
}

// requireAdmin ports isAdmin() in admin/members/route.ts: the session must
// verify AND hold the admin tier. Missing session and insufficient tier are
// the SAME refusal there (`hasTier(null, 'admin')` is false -> 401
// `{error: 'unauthorized', detail: 'requires admin tier'}`), so they stay
// indistinguishable here too.
func (s *server) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if claims, err := s.sessionClaims(r); err == nil && claims.Tier.AtLeast(identity.TierAdmin) {
		return true
	}
	writeRefusal(w, r, http.StatusUnauthorized, "unauthorized", errs.CategoryUnauthenticated,
		identity.ErrTierRequired(identity.TierAdmin).Message)
	return false
}

// handleAdminMembers ports GET|POST /api/admin/members (admin/members/route.ts):
// list guild members with their resolved tier, and grant/revoke the team and
// admin roles. Every path re-checks the admin tier server-side from the
// session cookie — no client-supplied identity is trusted.
func (s *server) handleAdminMembers(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if r.Method == http.MethodGet {
		s.adminMembersList(w, r)
		return
	}
	s.adminMembersMutate(w, r)
}

// memberRow is one row of the TS response map (id, username, globalName,
// avatar, tier — that key order). globalName/avatar are nullable, never
// omitted: listGuildMembers normalizes them to string|null exactly as discord.ts
// does, and the TS response writes the nulls through.
type memberRow struct {
	ID         string        `json:"id"`
	Username   string        `json:"username"`
	GlobalName *string       `json:"globalName"`
	Avatar     *string       `json:"avatar"`
	Tier       identity.Tier `json:"tier"`
}

// roleIDsBody is the ROLES map of admin/members/route.ts ({team, admin} key
// order). JSON.stringify drops an `undefined` entry — an unset FUDCOURT_ROLE_*
// key is ABSENT from the wire, never null — so the Go wire mirrors that with
// omitempty (documented divergence from the honest-null rule: it is the TS
// shape consumers already parse).
type roleIDsBody struct {
	Team  string `json:"team,omitempty"`
	Admin string `json:"admin,omitempty"`
}

// adminMembersBody is the GET success envelope (members first, then roleIds —
// the TS literal's order).
type adminMembersBody struct {
	Members []memberRow `json:"members"`
	RoleIDs roleIDsBody `json:"roleIds"`
}

func (s *server) adminMembersList(w http.ResponseWriter, r *http.Request) {
	members, ok := s.discord.listGuildMembers(r.Context(), 100)
	if !ok {
		writeRefusal(w, r, http.StatusServiceUnavailable, "discord_unavailable", errs.CategoryNetwork,
			"FUDCOURT_BOT_TOKEN / FUDCOURT_GUILD_ID are not set, or Discord refused the request")
		return
	}
	env := s.discord.roleEnv()
	rows := make([]memberRow, 0, len(members))
	for _, m := range members {
		// tierFromRoles verbatim: the tier, error ignored (see handleAuthCallback).
		tier, _ := identity.TierFromRoleIDs(m.RoleIDs, env)
		rows = append(rows, memberRow{
			ID:         m.ID,
			Username:   m.Username,
			GlobalName: m.GlobalName,
			Avatar:     m.Avatar,
			Tier:       tier,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, adminMembersBody{
		Members: rows,
		RoleIDs: roleIDsBody{Team: s.discord.env.RoleTeam, Admin: s.discord.env.RoleAdmin},
	})
}

// roleMutationBody is the POST success envelope (`{ ok: true, userId, role,
// action }` — the TS literal's key order).
type roleMutationBody struct {
	OK     bool   `json:"ok"`
	UserID string `json:"userId"`
	Role   string `json:"role"`
	Action string `json:"action"`
}

func (s *server) adminMembersMutate(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "JSON body required")
		return
	}
	// TS: `req.json().catch(() => null)` then `typeof body !== 'object' ||
	// body === null` -> "JSON body required". In JS `typeof [] === 'object'`,
	// so an array body passes that check and fails later on the userId lookup —
	// mirrored exactly below.
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "JSON body required")
		return
	}
	obj, isObject := parsed.(map[string]any)
	if !isObject {
		if _, isArray := parsed.([]any); !isArray || parsed == nil {
			writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "JSON body required")
			return
		}
		// An array is a keyless object: fall through with no keys (JS parity).
		obj = nil
	}
	userID, _ := obj["userId"].(string)
	if userID == "" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "userId is required")
		return
	}
	role, _ := obj["role"].(string)
	if role != "team" && role != "admin" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "role must be team or admin")
		return
	}
	action, _ := obj["action"].(string)
	if action != "add" && action != "remove" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "action must be add or remove")
		return
	}
	roleID := s.discord.env.RoleTeam
	if role == "admin" {
		roleID = s.discord.env.RoleAdmin
	}
	if roleID == "" {
		writeRefusal(w, r, http.StatusServiceUnavailable, "discord_unconfigured", errs.CategoryInternal,
			"FUDCOURT_ROLE_"+strings.ToUpper(role)+" is not set")
		return
	}
	ok, problem := s.discord.setMemberRole(r.Context(), userID, roleID, action)
	if ok {
		httpx.WriteJSON(w, http.StatusOK, roleMutationBody{OK: true, UserID: userID, Role: role, Action: action})
		return
	}
	if problem == "" {
		problem = "Discord rejected the role change"
	}
	writeRefusal(w, r, http.StatusBadGateway, "discord_error", errs.CategoryNetwork, problem)
}
