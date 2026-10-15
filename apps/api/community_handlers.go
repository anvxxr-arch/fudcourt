package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

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

// panelPostedInput is what the bot reports once a panel message exists.
type panelPostedInput struct {
	PanelID   string `json:"panelId"`
	ChannelID string `json:"channelId"`
	MessageID string `json:"messageId"`
}

// panelPostedResponse echoes what was stored, so the bot's log line and the
// dashboard read the same three values.
type panelPostedResponse struct {
	OK        bool   `json:"ok"`
	PanelID   string `json:"panelId"`
	ChannelID string `json:"channelId"`
	MessageID string `json:"messageId"`
}

// validatePanelPosted mirrors the editor's own loose ends: the panel id is
// trimmed and bounded like the admin plane trims it, and the two ids are
// snowflakes — a typo must not be persisted as a message id that can never match.
func validatePanelPosted(in *panelPostedInput) string {
	in.PanelID = strings.TrimSpace(in.PanelID)
	if in.PanelID == "" || len(in.PanelID) > 64 {
		return "panelId must be 1-64 characters"
	}
	if !isSnowflake(in.ChannelID) {
		return "channelId must be a Discord id"
	}
	if !isSnowflake(in.MessageID) {
		return "messageId must be a Discord id"
	}
	return ""
}

// handleInternalPanelPosted records the message a panel was posted as — the same
// loopback hop, for the same reason: the bot posts it (it has no Postgres
// driver), and without this a reaction panel can never be matched, because the
// handler finds a panel by the message its reaction landed on.
func (s *server) handleInternalPanelPosted(w http.ResponseWriter, r *http.Request) {
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
	var in panelPostedInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	if msg := validatePanelPosted(&in); msg != "" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, msg)
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	ok, err := s.community.recordPanelMessage(r.Context(), guildID, in.PanelID, in.ChannelID, in.MessageID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "panel message update failed")
		return
	}
	if !ok {
		writeRefusal(w, r, http.StatusNotFound, "panel_not_found", errs.CategoryValidation,
			fmt.Sprintf("no panel %q in this guild", in.PanelID))
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, panelPostedResponse{
		OK: true, PanelID: in.PanelID, ChannelID: in.ChannelID, MessageID: in.MessageID,
	})
}

// assignmentSources is the closed set of origins for a role grant/revoke record.
//
// It MUST cover every source the bot passes to RoleService.grant/revoke/apply:
// the api refuses anything else, and the bot records best-effort, so a missing
// source means those attempts are silently ABSENT from the audit trail rather
// than an error anyone sees. That is exactly how reaction-role grants went
// unrecorded — the bot sent "panel-reaction", this set did not have it, and the
// 400 was swallowed by a record path that never inspected the response.
var assignmentSources = []string{"autorole", "panel", "panel-reaction", "verification", "manual"}

// assignmentSourceSet is assignmentSources as a membership test.
var assignmentSourceSet = func() map[string]bool {
	m := make(map[string]bool, len(assignmentSources))
	for _, s := range assignmentSources {
		m[s] = true
	}
	return m
}()

// assignmentSourceSentence is the refusal text for an unknown source, built from
// assignmentSources so the list an operator reads cannot drift from the set the
// handler enforces.
func assignmentSourceSentence() string {
	if len(assignmentSources) < 2 {
		return "source must be " + strings.Join(assignmentSources, "")
	}
	return "source must be " + strings.Join(assignmentSources[:len(assignmentSources)-1], ", ") +
		" or " + assignmentSources[len(assignmentSources)-1]
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
	if !assignmentSourceSet[in.Source] {
		return assignmentSourceSentence()
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
	// Runes, not bytes: the contract declares `maxLength: 2000` (code points) and Discord counts
	// characters, so a 2000-character message of emoji must not be refused for being 8000 bytes
	// long. Counting runes costs nothing in boundedness — the body is already capped at 32 KiB.
	if utf8.RuneCountInString(w.JoinMessage) > 2000 || utf8.RuneCountInString(w.LeaveMessage) > 2000 || utf8.RuneCountInString(w.JoinDMMessage) > 2000 {
		return "welcome messages must be 2000 characters or fewer"
	}
	if msg := validateEmbed("joinEmbed", w.JoinEmbed); msg != "" {
		return msg
	}
	if msg := validateEmbed("leaveEmbed", w.LeaveEmbed); msg != "" {
		return msg
	}
	return ""
}

// validateEmbed checks an embed's shape against the fields the bot's renderer actually reads.
//
// The column is jsonb and jsonb accepts anything, but `renderEmbed`
// (apps/discord-bot/src/community/templates.ts) calls `renderTemplate` on every string field and
// that calls `.replace` on its argument — so an embed stored as `{"title": 5}` makes the welcome
// path THROW at join time instead of failing at save time, which is the wrong end of an
// operator's day to find a typo. The dashboard is the only writer, so the shape is settled here.
//
// Unknown fields are deliberately NOT refused: the renderer ignores anything outside its field
// set ("rather than forwarded blindly"), so an extra key is harmless. Only the fields it touches
// are constrained, and only to the types it assumes. `null` is accepted wherever a string is
// expected — the renderer's falsy guard turns it into an empty string, a deliberate no-op.
func validateEmbed(name string, raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return name + " must be a JSON object"
	}
	for _, key := range []string{"title", "description"} {
		if msg := embedString(name, key, obj[key]); msg != "" {
			return msg
		}
	}
	if color, ok := obj["color"]; ok {
		var n float64
		if err := json.Unmarshal(color, &n); err != nil {
			return name + ".color must be a number"
		}
		if n < 0 || n > 0xFFFFFF || n != float64(int64(n)) {
			return name + ".color must be an integer between 0 and 16777215"
		}
	}
	for _, key := range []string{"footer", "author"} {
		sub, msg := embedObject(name, key, obj[key])
		if msg != "" {
			return msg
		}
		field := "text"
		if key == "author" {
			field = "name"
		}
		if sub != nil {
			if msg := embedString(name+"."+key, field, sub[field]); msg != "" {
				return msg
			}
		}
	}
	for _, key := range []string{"thumbnail", "image"} {
		sub, msg := embedObject(name, key, obj[key])
		if msg != "" {
			return msg
		}
		if sub != nil {
			if msg := embedString(name+"."+key, "url", sub["url"]); msg != "" {
				return msg
			}
		}
	}
	if fields, ok := obj["fields"]; ok {
		var list []map[string]json.RawMessage
		if err := json.Unmarshal(fields, &list); err != nil {
			return name + ".fields must be an array of objects"
		}
		if len(list) > 25 {
			return name + ".fields: at most 25 fields"
		}
		for i, f := range list {
			where := fmt.Sprintf("%s.fields[%d]", name, i)
			if msg := embedString(where, "name", f["name"]); msg != "" {
				return msg
			}
			if msg := embedString(where, "value", f["value"]); msg != "" {
				return msg
			}
		}
	}
	return ""
}

// embedObject decodes a nested embed object (footer, author, thumbnail, image); a nil map with an
// empty message means the key was absent, which is not an error.
func embedObject(name, key string, raw json.RawMessage) (map[string]json.RawMessage, string) {
	if len(raw) == 0 {
		return nil, ""
	}
	var sub map[string]json.RawMessage
	if err := json.Unmarshal(raw, &sub); err != nil {
		return nil, name + "." + key + " must be a JSON object"
	}
	return sub, ""
}

// embedString refuses a value that is present and neither a string nor null, naming the path the
// operator has to fix rather than the field's parent.
func embedString(where, key string, raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return where + "." + key + " must be a string"
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
