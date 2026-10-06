package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"github.com/anvxxr-arch/fudcourt/backend/api/internal/access/identity"
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

// discordClient performs the calls with an injected HTTP client; apiBase and
// tokenURL are fields so tests can point them at a stub server.
type discordClient struct {
	env      discordEnv
	http     *http.Client
	apiBase  string
	tokenURL string
}

func newDiscordClient(env discordEnv) *discordClient {
	return &discordClient{
		env:      env,
		http:     &http.Client{Timeout: 15 * time.Second},
		apiBase:  discordAPI,
		tokenURL: discordTokenURL,
	}
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
	if d.env.GuildID == "" || d.env.BotToken == "" {
		return []string{}
	}
	req, err := http.NewRequestWithContext(ctx, "GET",
		d.apiBase+"/guilds/"+url.PathEscape(d.env.GuildID)+"/members/"+url.PathEscape(userID), nil)
	if err != nil {
		return []string{}
	}
	req.Header.Set("Authorization", "Bot "+d.env.BotToken)
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

// listGuildMembers lists the configured guild (listGuildMembers in the OpenAPI
// contract) or reports unavailable (false) when the guild/bot env is unset.
func (d *discordClient) listGuildMembers(ctx context.Context, limit int) ([]discordMember, bool) {
	if d.env.GuildID == "" || d.env.BotToken == "" {
		return nil, false
	}
	req, err := http.NewRequestWithContext(ctx, "GET",
		d.apiBase+"/guilds/"+url.PathEscape(d.env.GuildID)+fmt.Sprintf("/members?limit=%d", limit), nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("Authorization", "Bot "+d.env.BotToken)
	res, err := d.http.Do(req)
	if err != nil {
		return nil, false
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
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
	if d.env.GuildID == "" || d.env.BotToken == "" {
		return false, "Discord is not configured"
	}
	memberURL := d.apiBase + "/guilds/" + url.PathEscape(d.env.GuildID) + "/members/" + url.PathEscape(userID)
	req, err := http.NewRequestWithContext(ctx, "GET", memberURL, nil)
	if err != nil {
		return false, "Could not read that guild member"
	}
	req.Header.Set("Authorization", "Bot "+d.env.BotToken)
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
	req.Header.Set("Authorization", "Bot "+d.env.BotToken)
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

// roleEnv maps the configured single role ids into identity.RoleEnv the way
// tierFromRoles in guard.ts resolves them: with no guild/role env there is
// nothing to resolve against (empty sets -> public), otherwise the admin and
// team sets are the two configured ids. MemberRoleIDs stays empty — the
// guard.ts member floor ("any resolvable account is at least member") applies.
func (d *discordClient) roleEnv() identity.RoleEnv {
	if d.env.GuildID == "" || d.env.RoleAdmin == "" || d.env.RoleTeam == "" {
		return identity.RoleEnv{}
	}
	return identity.RoleEnv{AdminRoleIDs: []string{d.env.RoleAdmin}, TeamRoleIDs: []string{d.env.RoleTeam}}
}
