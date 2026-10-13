package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/identity"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/cache"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Discord REST client — the port of the retired frontend Discord client plus
// the OAuth helpers inside api/auth/callback/route.ts. The bot token never
// leaves this process: every helper returns normalised data or an empty/typed
// result, never a raw Discord payload, so no handler can accidentally
// serialize a token or an upstream error body onto the wire.

// discordAPI is the fixed Discord REST base (DISCORD_API / TOKEN_ENDPOINT in
// the TS oracles).
const (
	discordAPI       = "https://discord.com/api/v10"
	discordTokenURL  = "https://discord.com/api/oauth2/token"
	discordAuthorize = "https://discord.com/oauth2/authorize"
)

const (
	// membersTTL is how long a fetched guild-member list stays fresh. Roles
	// change rarely and the admin panel tolerates a minute of staleness in
	// exchange for never waiting on Discord.
	membersTTL = 60 * time.Second
	// membersFetchTimeout caps one upstream members fetch: inline on a cold
	// miss (a 503 instead of a hanging request) and inside the detached
	// background refresh (which has no request deadline of its own).
	membersFetchTimeout = 2 * time.Second
	// membersListLimit is the ONE limit the members plane fetches with: the
	// admin route and the startup prewarm must agree, because guild+limit is
	// the cache key — a prewarm at a different limit would warm a key no
	// request ever reads.
	membersListLimit = 100
)

// discordEnv is the Discord-side configuration the TS routes read from
// process.env at call time. Empty fields mean "not configured" and every
// helper fails soft exactly where its TS counterpart does.
type discordEnv struct {
	ClientID     string // FUDCOURT_CLIENT_ID
	ClientSecret string // FUDCOURT_CLIENT_SECRET
	RedirectURI  string // DISCORD_REDIRECT_URI
	GuildID      string // FUDCOURT_GUILD_ID
	BotToken     string // FUDCOURT_BOT_TOKEN
	RoleTeam     string // FUDCOURT_ROLE_TEAM
	RoleAdmin    string // FUDCOURT_ROLE_ADMIN
	RoleMagang   string // FUDCOURT_ROLE_MAGANG
}

// discordUser is the normalised OAuth profile (DiscordUser in callback/route.ts).
type discordUser struct {
	ID         string
	Username   string
	GlobalName *string
	Avatar     *string // raw CDN hash, resolved to a URL by the caller
}

// discordMember is the members-row wire shape (see listGuildMembers in the
// OpenAPI contract). Avatar is the raw CDN hash (or null) exactly as the
// listing reports it.
type discordMember struct {
	ID         string
	Username   string
	GlobalName *string
	Avatar     *string
	RoleIDs    []string
}

// discordRole is one guild role as the settings panel needs it: id + name,
// with position and managed so the UI can order them and flag bot-managed
// roles that cannot be assigned by hand.
type discordRole struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Color    int    `json:"color"`
	Position int    `json:"position"`
	Managed  bool   `json:"managed"`
}

// discordClient performs the calls with an injected HTTP client; apiBase and
// tokenURL are fields so tests can point them at a stub server.
type discordClient struct {
	env      discordEnv
	http     *http.Client
	apiBase  string
	tokenURL string
	// members caches the guild-member list (stale-while-revalidate, see
	// listGuildMembers), keyed by this client's own guild id + limit.
	members *cache.Cache[[]discordMember]
	// settings is the admin-editable config store (settings.go). nil means
	// "not configured": every resolution then uses env alone.
	settings settingsStore
}

// discordTransport is the one connection pool every discordClient shares:
// keep-alive on and idle provider connections retained, with the per-host
// idle cap raised above http.Transport's default of 2 so a cache refresh and
// an OAuth exchange in flight at the same time reuse one warm connection
// instead of paying a fresh TCP+TLS handshake (120-400ms to Discord) each.
var discordTransport = func() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConns = 64
	t.MaxIdleConnsPerHost = 16
	t.IdleConnTimeout = 90 * time.Second
	return t
}()

func newDiscordClient(env discordEnv) *discordClient {
	return &discordClient{
		env:      env,
		http:     &http.Client{Timeout: 15 * time.Second, Transport: discordTransport},
		apiBase:  discordAPI,
		tokenURL: discordTokenURL,
		members:  cache.New[[]discordMember](membersTTL),
	}
}

// effective resolves the Discord wiring for one call: the env defaults overlaid
// with whatever an admin saved in the settings table (settings.go). The DB wins
// when a key is set; a missing key or an unreachable store keeps the env value,
// so the site tiers correctly before the panel is ever used and through a DB
// outage. The bot token and OAuth credentials stay env-only (they are secrets).
func (d *discordClient) effective(ctx context.Context) discordEnv {
	e := d.env
	if d.settings == nil {
		return e
	}
	cfg, err := d.settings.load(ctx)
	if err != nil {
		return e
	}
	if cfg.GuildID != "" {
		e.GuildID = cfg.GuildID
	}
	if cfg.RoleAdmin != "" {
		e.RoleAdmin = cfg.RoleAdmin
	}
	if cfg.RoleTeam != "" {
		e.RoleTeam = cfg.RoleTeam
	}
	if cfg.RoleMagang != "" {
		e.RoleMagang = cfg.RoleMagang
	}
	return e
}

// readJSON mirrors readJson in the TS oracles: parse failures are null, never
// a crash and never a leaked upstream body.
func readJSON(r io.Reader) any {
	raw, err := io.ReadAll(io.LimitReader(r, 4<<20))
	if err != nil {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

// exchangeCode trades the OAuth code for a bearer token (exchangeCode in
// callback/route.ts): Basic client auth, form body, access_token-or-fail.
func (d *discordClient) exchangeCode(ctx context.Context, code string) (string, error) {
	form := url.Values{
		"grant_type":   {"authorization_code"},
		"code":         {code},
		"redirect_uri": {d.env.RedirectURI},
	}
	req, err := http.NewRequestWithContext(ctx, "POST", d.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(d.env.ClientID+":"+d.env.ClientSecret)))
	res, err := d.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", fmt.Errorf("token exchange returned %d", res.StatusCode)
	}
	body := readJSON(res.Body)
	obj, ok := body.(map[string]any)
	if !ok {
		return "", fmt.Errorf("token response is not an object")
	}
	token, ok := obj["access_token"].(string)
	if !ok || token == "" {
		return "", fmt.Errorf("token response carried no access_token")
	}
	return token, nil
}

// fetchCurrentUser reads the OAuth profile (fetchCurrentUser in
// callback/route.ts). Discord payloads are untrusted input: every field the
// session depends on is type-checked before use.
func (d *discordClient) fetchCurrentUser(ctx context.Context, token string) (*discordUser, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", d.apiBase+"/users/@me", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := d.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("/users/@me returned %d", res.StatusCode)
	}
	obj, ok := readJSON(res.Body).(map[string]any)
	if !ok {
		return nil, fmt.Errorf("/users/@me returned a non-object body")
	}
	id, okID := obj["id"].(string)
	username, okName := obj["username"].(string)
	if !okID || id == "" || !okName || username == "" {
		return nil, fmt.Errorf("/users/@me returned no id/username")
	}
	u := &discordUser{ID: id, Username: username}
	if s, ok := obj["global_name"].(string); ok {
		u.GlobalName = &s
	}
	if s, ok := obj["avatar"].(string); ok {
		u.Avatar = &s
	}
	return u, nil
}

// fetchGuildRoleIDs reads the member's role ids with the bot token
// (fetchGuildRoles in callback/route.ts). Missing guild/bot env, a non-member
// user, or an API error all yield an empty list — the caller tiers down rather
// than escalating. Role entries are accepted as either the snowflake strings
// Discord actually sends ({"roles":["123"]}) or legacy {"id":"123"} objects;
// anything else is skipped so the tier resolution stays fail-closed.
func (d *discordClient) fetchGuildRoleIDs(ctx context.Context, userID string) []string {
	e := d.effective(ctx)
	if e.GuildID == "" || e.BotToken == "" {
		return []string{}
	}
	req, err := http.NewRequestWithContext(ctx, "GET",
		d.apiBase+"/guilds/"+url.PathEscape(e.GuildID)+"/members/"+url.PathEscape(userID), nil)
	if err != nil {
		return []string{}
	}
	req.Header.Set("Authorization", "Bot "+e.BotToken)
	res, err := d.http.Do(req)
	if err != nil {
		return []string{}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return []string{}
	}
	obj, ok := readJSON(res.Body).(map[string]any)
	if !ok {
		return []string{}
	}
	list, ok := obj["roles"].([]any)
	if !ok {
		return []string{}
	}
	roles := []string{}
	for _, entry := range list {
		switch e := entry.(type) {
		case string:
			if e != "" {
				roles = append(roles, e)
			}
		case map[string]any:
			if id, ok := e["id"].(string); ok && id != "" {
				roles = append(roles, id)
			}
		}
	}
	return roles
}

// addGuildMember adds the freshly-authenticated OAuth user to the guild (Add
// Guild Member, PUT /guilds/{id}/members/{id}) using their own guilds.join
// bearer token; the bot must hold CREATE_INSTANT_INVITE. It reports created=true
// only for a 201 (a genuinely new join) — Discord answers 204 when the user is
// already a member, which is not a signup and must not re-grant the entry role.
// Every failure is a non-empty problem string; the caller treats it as
// best-effort and never blocks the login on it.
func (d *discordClient) addGuildMember(ctx context.Context, userID, accessToken string) (bool, string) {
	e := d.effective(ctx)
	if e.GuildID == "" || e.BotToken == "" {
		return false, "Discord is not configured"
	}
	if accessToken == "" {
		return false, "no OAuth access token"
	}
	payload, err := json.Marshal(map[string]string{"access_token": accessToken})
	if err != nil {
		return false, "could not build the join payload"
	}
	endpoint := d.apiBase + "/guilds/" + url.PathEscape(e.GuildID) + "/members/" + url.PathEscape(userID)
	req, err := http.NewRequestWithContext(ctx, "PUT", endpoint, strings.NewReader(string(payload)))
	if err != nil {
		return false, "could not build the join request"
	}
	req.Header.Set("Authorization", "Bot "+e.BotToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := d.http.Do(req)
	if err != nil {
		return false, "Discord returned no response"
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		message := ""
		if body, ok := readJSON(res.Body).(map[string]any); ok {
			if m, ok := body["message"].(string); ok {
				message = m
			}
		}
		if message == "" {
			message = fmt.Sprintf("Discord returned %d", res.StatusCode)
		}
		return false, message
	}
	return res.StatusCode == http.StatusCreated, ""
}

// listGuildMembers answers the members plane (listGuildMembers in the OpenAPI
// contract) from the process-local cache; fetchGuildMembers is the uncached
// Discord call underneath. The contract with the handler:
//
//   - fresh entry (< membersTTL): served from memory, no upstream call;
//   - stale entry: served immediately while ONE background refresh runs
//     (stale-while-revalidate) — after the first successful fetch this never
//     blocks on Discord;
//   - cold miss: fetches inline under membersFetchTimeout and reports
//     unavailable on failure (the 503 the route already answers); a failed
//     fetch is never cached;
//   - unset guild/bot env: unavailable, before any cache lookup.
//
// The cache key is guild id + limit — server configuration, never request
// input — so the keyspace cannot be grown by a caller.
func (d *discordClient) listGuildMembers(ctx context.Context, limit int) ([]discordMember, bool) {
	e := d.effective(ctx)
	if e.GuildID == "" || e.BotToken == "" {
		return nil, false
	}
	key := fmt.Sprintf("%s/%d", e.GuildID, limit)
	if value, stale, ok := d.members.Get(key); ok {
		if stale {
			d.members.Revalidate(key, func() ([]discordMember, bool) {
				// Detached from the request that noticed the staleness: its
				// context dies with the response, so this refresh carries its
				// own deadline.
				refreshCtx, cancel := context.WithTimeout(context.Background(), membersFetchTimeout)
				defer cancel()
				return d.fetchGuildMembers(refreshCtx, limit)
			})
		}
		return value, true
	}
	fetchCtx, cancel := context.WithTimeout(ctx, membersFetchTimeout)
	defer cancel()
	members, ok := d.fetchGuildMembers(fetchCtx, limit)
	if !ok {
		return nil, false
	}
	d.members.Set(key, members)
	return members, true
}

// fetchGuildMembers is one uncached Discord members call (listGuildMembers in
// the OpenAPI contract) or reports unavailable (false) when the guild/bot env
// is unset or Discord refuses.
func (d *discordClient) fetchGuildMembers(ctx context.Context, limit int) ([]discordMember, bool) {
	e := d.effective(ctx)
	if e.GuildID == "" || e.BotToken == "" {
		return nil, false
	}
	req, err := http.NewRequestWithContext(ctx, "GET",
		d.apiBase+"/guilds/"+url.PathEscape(e.GuildID)+fmt.Sprintf("/members?limit=%d", limit), nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("Authorization", "Bot "+e.BotToken)
	res, err := d.http.Do(req)
	if err != nil {
		return nil, false
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		// Drain the error body (bounded) so the keep-alive connection returns
		// to the pool instead of being torn down unread — a failing provider
		// is exactly when paying a fresh TCP+TLS handshake hurts most.
		io.Copy(io.Discard, io.LimitReader(res.Body, 4<<20))
		return nil, false
	}
	list, ok := readJSON(res.Body).([]any)
	if !ok {
		return nil, false
	}
	members := []discordMember{}
	for _, entry := range list {
		obj, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		user, ok := obj["user"].(map[string]any)
		if !ok {
			continue
		}
		id, ok := user["id"].(string)
		if !ok {
			continue
		}
		m := discordMember{ID: id, Username: id}
		if s, ok := user["username"].(string); ok {
			m.Username = s
		}
		if s, ok := user["global_name"].(string); ok {
			m.GlobalName = &s
		}
		if s, ok := user["avatar"].(string); ok {
			m.Avatar = &s
		}
		m.RoleIDs = []string{}
		if roles, ok := obj["roles"].([]any); ok {
			for _, r := range roles {
				if s, ok := r.(string); ok {
					m.RoleIDs = append(m.RoleIDs, s)
				}
			}
		}
		members = append(members, m)
	}
	return members, true
}

// setMemberRole adds or removes one role on a member (setMemberRole in the
// OpenAPI contract). Discord failures are reported as an error string rather
// than an exception, so the panel can render the reason.
func (d *discordClient) setMemberRole(ctx context.Context, userID, roleID, action string) (bool, string) {
	e := d.effective(ctx)
	if e.GuildID == "" || e.BotToken == "" {
		return false, "Discord is not configured"
	}
	memberURL := d.apiBase + "/guilds/" + url.PathEscape(e.GuildID) + "/members/" + url.PathEscape(userID)
	req, err := http.NewRequestWithContext(ctx, "GET", memberURL, nil)
	if err != nil {
		return false, "Could not read that guild member"
	}
	req.Header.Set("Authorization", "Bot "+e.BotToken)
	member, err := d.http.Do(req)
	if err != nil {
		return false, "Could not read that guild member"
	}
	defer member.Body.Close()
	if member.StatusCode < 200 || member.StatusCode > 299 {
		return false, "Could not read that guild member"
	}
	obj, ok := readJSON(member.Body).(map[string]any)
	if !ok {
		return false, "Could not read that guild member"
	}
	current := []string{}
	if roles, ok := obj["roles"].([]any); ok {
		for _, r := range roles {
			if s, ok := r.(string); ok {
				current = append(current, s)
			}
		}
	}
	alreadySet := false
	for _, id := range current {
		if id == roleID {
			alreadySet = true
			break
		}
	}
	if action == "add" && alreadySet {
		return true, ""
	}
	if action == "remove" && !alreadySet {
		return true, ""
	}
	next := make([]string, 0, len(current)+1)
	for _, id := range current {
		if action == "remove" && id == roleID {
			continue
		}
		next = append(next, id)
	}
	if action == "add" {
		next = append(next, roleID)
	}
	payload, err := json.Marshal(map[string][]string{"roles": next})
	if err != nil {
		return false, "Discord rejected the role change"
	}
	req, err = http.NewRequestWithContext(ctx, "PATCH", memberURL, strings.NewReader(string(payload)))
	if err != nil {
		return false, "Discord rejected the role change"
	}
	req.Header.Set("Authorization", "Bot "+e.BotToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := d.http.Do(req)
	if err != nil {
		return false, "Discord returned no response"
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		message := ""
		if body, ok := readJSON(res.Body).(map[string]any); ok {
			if m, ok := body["message"].(string); ok {
				message = m
			}
		}
		if message == "" {
			message = fmt.Sprintf("Discord returned %d", res.StatusCode)
		}
		return false, message
	}
	return true, ""
}

// roleEnv maps the resolved single role ids into identity.RoleEnv the way
// tierFromRoles in guard.ts resolves them: with no guild/role config there is
// nothing to resolve against (empty sets -> public), otherwise the admin and
// team sets are the two configured ids. MemberRoleIDs stays empty — the
// guard.ts member floor ("any resolvable account is at least member") applies.
func roleEnv(e discordEnv) identity.RoleEnv {
	if e.GuildID == "" || e.RoleAdmin == "" || e.RoleTeam == "" {
		return identity.RoleEnv{}
	}
	return identity.RoleEnv{AdminRoleIDs: []string{e.RoleAdmin}, TeamRoleIDs: []string{e.RoleTeam}}
}

// listGuildRoles reads the guild's roles (GET /guilds/{id}/roles) so the admin
// panel can offer a picker instead of hand-typed ids. ok=false when the guild
// or bot is unset or Discord refuses; the panel then falls back to free text.
func (d *discordClient) listGuildRoles(ctx context.Context) ([]discordRole, bool) {
	e := d.effective(ctx)
	if e.GuildID == "" || e.BotToken == "" {
		return nil, false
	}
	req, err := http.NewRequestWithContext(ctx, "GET", d.apiBase+"/guilds/"+url.PathEscape(e.GuildID)+"/roles", nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("Authorization", "Bot "+e.BotToken)
	res, err := d.http.Do(req)
	if err != nil {
		return nil, false
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		io.Copy(io.Discard, io.LimitReader(res.Body, 4<<20))
		return nil, false
	}
	raw, ok := readJSON(res.Body).([]any)
	if !ok {
		return nil, false
	}
	roles := make([]discordRole, 0, len(raw))
	for _, entry := range raw {
		obj, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		id, _ := obj["id"].(string)
		name, _ := obj["name"].(string)
		if id == "" {
			continue
		}
		r := discordRole{ID: id, Name: name}
		if c, ok := obj["color"].(float64); ok {
			r.Color = int(c)
		}
		if p, ok := obj["position"].(float64); ok {
			r.Position = int(p)
		}
		if m, ok := obj["managed"].(bool); ok {
			r.Managed = m
		}
		roles = append(roles, r)
	}
	return roles, true
}
