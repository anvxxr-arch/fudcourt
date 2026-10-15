package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/capability"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
)

// adminSettingsBody is the GET /api/admin/settings envelope: the effective
// Discord config (DB over env), the env defaults it falls back to, the guild's
// role list for the pickers, and whether the store is wired.
type adminSettingsBody struct {
	Config     discordConfig `json:"config"`
	Defaults   discordConfig `json:"defaults"`
	Roles      []discordRole `json:"roles"`
	Configured bool          `json:"configured"`
}

// handleAdminSettings serves the settings panel the admin asked for: the
// Discord wiring (guild + role mapping) is read from and written to the
// `settings` table, not the environment. GET returns the effective config and
// the guild's roles; POST validates and saves. Both re-check the admin tier
// server-side from the session cookie.
func (s *server) handleAdminSettings(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !s.allowCapability(w, r, capabilityForMethod(r, capability.SettingsRead, capability.SettingsManage)) {
		return
	}
	if r.Method == http.MethodGet {
		s.adminSettingsGet(w, r)
		return
	}
	s.adminSettingsPost(w, r)
}

func (s *server) adminSettingsGet(w http.ResponseWriter, r *http.Request) {
	defaults := discordConfig{
		GuildID:    s.discord.env.GuildID,
		RoleAdmin:  s.discord.env.RoleAdmin,
		RoleTeam:   s.discord.env.RoleTeam,
		RoleMagang: s.discord.env.RoleMagang,
	}
	eff := s.discord.effective(r.Context())
	config := discordConfig{
		GuildID:    eff.GuildID,
		RoleAdmin:  eff.RoleAdmin,
		RoleTeam:   eff.RoleTeam,
		RoleMagang: eff.RoleMagang,
	}
	roles, _ := s.discord.listGuildRoles(r.Context())
	if roles == nil {
		roles = []discordRole{}
	}
	httpx.WriteJSON(w, http.StatusOK, adminSettingsBody{
		Config:     config,
		Defaults:   defaults,
		Roles:      roles,
		Configured: s.discord.settings != nil,
	})
}

// adminSettingsRequest is the POST body: the four snowflake ids, each optional
// (an omitted key keeps the stored value). A provided key must be a digit-only
// snowflake so a typo can never be persisted as a live role id.
type adminSettingsRequest struct {
	GuildID    *string `json:"guildId"`
	RoleAdmin  *string `json:"roleAdmin"`
	RoleTeam   *string `json:"roleTeam"`
	RoleMagang *string `json:"roleMagang"`
}

func (s *server) adminSettingsPost(w http.ResponseWriter, r *http.Request) {
	if s.discord.settings == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "settings_unavailable", errs.CategoryInternal,
			"settings store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "JSON body required")
		return
	}
	var req adminSettingsRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "JSON body required")
		return
	}
	// Merge onto the current effective config so a partial body keeps the
	// untouched keys.
	cur := s.discord.effective(r.Context())
	next := discordConfig{
		GuildID:    cur.GuildID,
		RoleAdmin:  cur.RoleAdmin,
		RoleTeam:   cur.RoleTeam,
		RoleMagang: cur.RoleMagang,
	}
	// Validate only the fields the admin actually sent: an env default is
	// operator-trusted and must not be re-validated (a legacy short id in the
	// environment would otherwise block an unrelated edit).
	check := func(field string, raw *string, dst *string) bool {
		if raw == nil {
			return true
		}
		v := strings.TrimSpace(*raw)
		if v != "" && !isSnowflake(v) {
			writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
				field+" must be a Discord id (digits only)")
			return false
		}
		*dst = v
		return true
	}
	if !check("guildId", req.GuildID, &next.GuildID) ||
		!check("roleAdmin", req.RoleAdmin, &next.RoleAdmin) ||
		!check("roleTeam", req.RoleTeam, &next.RoleTeam) ||
		!check("roleMagang", req.RoleMagang, &next.RoleMagang) {
		return
	}
	if err := s.discord.settings.save(r.Context(), next); err != nil {
		writeRefusal(w, r, http.StatusBadGateway, "settings_write_failed", errs.CategoryNetwork, err.Error())
		return
	}
	// Audit the change with a structured before/after, best-effort: the save
	// stands even if the audit row cannot be written.
	s.recordAudit(r.Context(), auditInput{
		ActorID: s.auditActor(r).ID, ActorName: s.auditActor(r).Name,
		Action: "settings.update", ResourceType: "settings", ResourceID: "discord",
		Before: marshalOrNil(cur), After: marshalOrNil(next), Source: "dashboard",
	})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "config": next})
}

// isSnowflake reports whether v is a plausible Discord snowflake: 15-21 ASCII
// digits. Anything else is refused so a typo cannot be persisted as a role id.
func isSnowflake(v string) bool {
	if len(v) < 15 || len(v) > 21 {
		return false
	}
	for _, c := range v {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
