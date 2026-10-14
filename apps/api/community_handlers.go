package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
)

var autoroleKinds = map[string]bool{"on_join": true, "after_duration": true, "after_verification": true}
var autoroleApplies = map[string]bool{"all": true, "human": true, "bot": true}
var panelKinds = map[string]bool{"reaction": true, "button": true, "select": true}
var panelModes = map[string]bool{"toggle": true, "single": true, "multiple": true, "exclusive": true}

// handleInternalCommunityConfig is the bot's single read of welcome/autorole/
// panel config. Loopback-only, like every other internal read: the bot has no
// Postgres driver, so this hop is how an operator change reaches it live.
func (s *server) handleInternalCommunityConfig(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) {
		httpx.WriteError(w, r, errNotFound)
		return
	}
	if s.community == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "community_unavailable", errs.CategoryInternal,
			"community store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	welcome, err := s.community.welcome(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "welcome query failed")
		return
	}
	autoroles, err := s.community.listAutoroles(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "autorole query failed")
		return
	}
	panels, err := s.community.listPanels(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "role panel query failed")
		return
	}
	out := map[string]any{"autoroles": autoroles, "panels": panels}
	if welcome != nil {
		out["welcome"] = welcome
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// handleInternalRoleAssignments records one grant/revoke the bot attempted,
// INCLUDING failures. Loopback-only; the guild is pinned server-side.
func (s *server) handleInternalRoleAssignments(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) {
		httpx.WriteError(w, r, errNotFound)
		return
	}
	if s.community == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "community_unavailable", errs.CategoryInternal,
			"community store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	var in roleAssignmentInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	if msg := validateAssignment(&in); msg != "" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, msg)
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	a, err := s.community.recordAssignment(r.Context(), guildID, in)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "assignment insert failed")
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, a)
}

func validateAssignment(in *roleAssignmentInput) string {
	in.UserID = strings.TrimSpace(in.UserID)
	in.RoleID = strings.TrimSpace(in.RoleID)
	if !isSnowflake(in.UserID) {
		return "userId must be a Discord id (digits only)"
	}
	if !isSnowflake(in.RoleID) {
		return "roleId must be a Discord id (digits only)"
	}
	if in.Action != "add" && in.Action != "remove" {
		return "action must be add or remove"
	}
	switch in.Source {
	case "autorole", "panel", "verification", "manual":
	default:
		return "source must be autorole, panel, verification or manual"
	}
	switch in.Status {
	case "ok", "failed":
	default:
		return "status must be ok or failed"
	}
	if len(in.Error) > 512 {
		in.Error = in.Error[:512]
	}
	return ""
}

// handleAdminWelcome is the dashboard's welcome/goodbye editor.
func (s *server) handleAdminWelcome(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if s.community == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "community_unavailable", errs.CategoryInternal,
			"community store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	if r.Method == http.MethodGet {
		cur, err := s.community.welcome(r.Context(), guildID)
		if err != nil {
			writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "welcome query failed")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"welcome": cur})
		return
	}
	var req welcomeConfig
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	if msg := validateWelcome(&req); msg != "" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, msg)
		return
	}
	before, _ := s.community.welcome(r.Context(), guildID)
	if err := s.community.saveWelcome(r.Context(), guildID, req); err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "welcome write failed")
		return
	}
	s.recordAudit(r.Context(), auditInput{
		ActorID: s.auditActor(r).ID, ActorName: s.auditActor(r).Name,
		Action: "welcome.set", ResourceType: "welcome", ResourceID: "welcome",
		Before: marshalOrNil(before), After: marshalOrNil(req), Source: "dashboard",
	})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "welcome": req})
}

func validateWelcome(w *welcomeConfig) string {
	w.JoinChannelID = strings.TrimSpace(w.JoinChannelID)
	w.LeaveChannelID = strings.TrimSpace(w.LeaveChannelID)
	if w.JoinEnabled && !isSnowflake(w.JoinChannelID) {
		w.JoinEnabled = false // a join message with no channel is a silent no-op; force the operator to pick one
	}
	if w.JoinChannelID != "" && !isSnowflake(w.JoinChannelID) {
		return "joinChannelId must be a Discord id (digits only)"
	}
	if w.LeaveChannelID != "" && !isSnowflake(w.LeaveChannelID) {
		return "leaveChannelId must be a Discord id (digits only)"
	}
	if len(w.JoinMessage) > 2000 || len(w.LeaveMessage) > 2000 || len(w.JoinDMMessage) > 2000 {
		return "welcome messages must be 2000 characters or fewer"
	}
	if len(w.JoinEmbed) > 0 {
		var probe map[string]any
		if err := json.Unmarshal(w.JoinEmbed, &probe); err != nil {
			return "joinEmbed must be a JSON object"
		}
	}
	if len(w.LeaveEmbed) > 0 {
		var probe map[string]any
		if err := json.Unmarshal(w.LeaveEmbed, &probe); err != nil {
			return "leaveEmbed must be a JSON object"
		}
	}
	return ""
}

// handleAdminAutoroles replaces the whole autorole set in one transaction (the
// dashboard edits the list as a unit; a partial apply would leave stale grants).
func (s *server) handleAdminAutoroles(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if s.community == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "community_unavailable", errs.CategoryInternal,
			"community store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	if r.Method == http.MethodGet {
		rules, err := s.community.listAutoroles(r.Context(), guildID)
		if err != nil {
			writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "autorole query failed")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"autoroles": rules})
		return
	}
	var req struct {
		Rules []autoroleRule `json:"autoroles"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	if msg := validateAutoroles(req.Rules); msg != "" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, msg)
		return
	}
	before, _ := s.community.listAutoroles(r.Context(), guildID)
	if err := s.community.replaceAutoroles(r.Context(), guildID, req.Rules); err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "autorole write failed")
		return
	}
	s.recordAudit(r.Context(), auditInput{
		ActorID: s.auditActor(r).ID, ActorName: s.auditActor(r).Name,
		Action: "autoroles.replace", ResourceType: "autorole", ResourceID: "autoroles",
		Before: marshalOrNil(before), After: marshalOrNil(req.Rules), Source: "dashboard",
	})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "autoroles": req.Rules})
}

func validateAutoroles(rules []autoroleRule) string {
	if len(rules) > 100 {
		return "at most 100 autorole rules"
	}
	seen := map[string]bool{}
	for i := range rules {
		r := &rules[i]
		if !isSnowflake(r.RoleID) {
			return fmt.Sprintf("rule %d: roleId must be a Discord id", i)
		}
		if seen[r.RoleID] {
			return fmt.Sprintf("rule %d: duplicate roleId %s", i, r.RoleID)
		}
		seen[r.RoleID] = true
		if !autoroleKinds[r.Kind] {
			return fmt.Sprintf("rule %d: kind must be on_join, after_duration or after_verification", i)
		}
		if !autoroleApplies[r.AppliesTo] {
			return fmt.Sprintf("rule %d: appliesTo must be all, human or bot", i)
		}
		if r.DelaySeconds < 0 || r.DelaySeconds > 30*24*3600 {
			return fmt.Sprintf("rule %d: delaySeconds must be between 0 and 2592000", i)
		}
	}
	return ""
}

// handleAdminRolePanels replaces the whole panel set (panels + options) in one
// transaction.
func (s *server) handleAdminRolePanels(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if s.community == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "community_unavailable", errs.CategoryInternal,
			"community store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	if r.Method == http.MethodGet {
		panels, err := s.community.listPanels(r.Context(), guildID)
		if err != nil {
			writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "role panel query failed")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"panels": panels})
		return
	}
	var req struct {
		Panels []rolePanel `json:"panels"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	if msg := validatePanels(req.Panels); msg != "" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, msg)
		return
	}
	before, _ := s.community.listPanels(r.Context(), guildID)
	if err := s.community.replacePanels(r.Context(), guildID, req.Panels); err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "role panel write failed")
		return
	}
	s.recordAudit(r.Context(), auditInput{
		ActorID: s.auditActor(r).ID, ActorName: s.auditActor(r).Name,
		Action: "role_panels.replace", ResourceType: "role_panel", ResourceID: "role_panels",
		Before: marshalOrNil(before), After: marshalOrNil(req.Panels), Source: "dashboard",
	})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "panels": req.Panels})
}

func validatePanels(panels []rolePanel) string {
	if len(panels) > 50 {
		return "at most 50 role panels"
	}
	seenID := map[string]bool{}
	for i := range panels {
		p := &panels[i]
		p.ID = strings.TrimSpace(p.ID)
		if p.ID == "" || len(p.ID) > 64 {
			return fmt.Sprintf("panel %d: id is required (<= 64 chars)", i)
		}
		if seenID[p.ID] {
			return fmt.Sprintf("panel %d: duplicate id %s", i, p.ID)
		}
		seenID[p.ID] = true
		if !panelKinds[p.Kind] {
			return fmt.Sprintf("panel %d: kind must be reaction, button or select", i)
		}
		if !panelModes[p.Mode] {
			return fmt.Sprintf("panel %d: mode must be toggle, single, multiple or exclusive", i)
		}
		if p.ChannelID != "" && !isSnowflake(p.ChannelID) {
			return fmt.Sprintf("panel %d: channelId must be a Discord id", i)
		}
		if len(p.Options) == 0 {
			return fmt.Sprintf("panel %d: at least one option is required", i)
		}
		if len(p.Options) > 25 {
			return fmt.Sprintf("panel %d: at most 25 options", i)
		}
		seenRole := map[string]bool{}
		for j := range p.Options {
			o := &p.Options[j]
			if !isSnowflake(o.RoleID) {
				return fmt.Sprintf("panel %d option %d: roleId must be a Discord id", i, j)
			}
			if seenRole[o.RoleID] {
				return fmt.Sprintf("panel %d option %d: duplicate roleId %s", i, j, o.RoleID)
			}
			seenRole[o.RoleID] = true
			if len(o.Label) > 100 || len(o.Emoji) > 64 {
				return fmt.Sprintf("panel %d option %d: label/emoji too long", i, j)
			}
		}
	}
	return ""
}

// handleAdminRoleAssignments lists the recent assignment attempts (incl. failed)
// so the dashboard can answer "why didn't this member get the role?".
func (s *server) handleAdminRoleAssignments(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if s.community == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "community_unavailable", errs.CategoryInternal,
			"community store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	guildID := s.discord.effective(r.Context()).GuildID
	rows, err := s.community.listAssignments(r.Context(), guildID, limit)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "assignment query failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"assignments": rows})
}
