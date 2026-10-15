package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/capability"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
)

// Logging & audit (db/schema/pg-schema.sql: `log_destinations`, `audit_logs`).
//
// Two distinct concerns share this file:
//
//   - Discord ACTIVITY logs — WHERE the bot mirrors Discord events (message
//     delete, join/leave, role change, moderation, AutoMod, …). One row per
//     (guild, category) → channel. The bot reads the map over the loopback hop
//     (it carries no Postgres driver), so an operator re-points a category at a
//     different channel from the dashboard without a restart.
//
//   - AUDIT logs — changes to the BOT ITSELF (settings/rules/feeds/permissions),
//     with a structured before/after. The dashboard writes these as it mutates
//     config; the bot may record its own via the loopback POST.
//
// Both are the same hop `settings`/`moderation_cases`/`automod_rules` already use.

// logCategoryList is the ONE authority for the closed set of activity classes
// the bot can route, in the order the dashboard renders them (the contract
// enumerates exactly this list, in this order). logCategories is the membership
// test derived from it, so the set the api CHECKS cannot drift from the set it
// SENDS. A category outside it is a validation error, never a silently-stored
// typo (the bot's router switches on exactly these names).
var logCategoryList = []string{"message", "member", "role", "voice", "channel", "moderation", "automod"}

var logCategories = func() map[string]bool {
	m := make(map[string]bool, len(logCategoryList))
	for _, c := range logCategoryList {
		m[c] = true
	}
	return m
}()

// auditSources is the closed set of origins an audit entry may carry. It mirrors
// the moderation-case sources where they overlap.
var auditSources = map[string]bool{
	"dashboard": true, "discord": true, "automod": true, "system": true,
}

// logDestination is one category → channel routing row. Snowflakes are strings
// (a JS client must never lose precision); updated_at matches `settings`.
type logDestination struct {
	Category  string `json:"category"`
	ChannelID string `json:"channelId"`
	Enabled   bool   `json:"enabled"`
	UpdatedAt string `json:"updatedAt"`
}

// auditEntry is one recorded change to the bot. before/after are the structured
// snapshots (jsonb); either may be absent (a create has no before, a delete has
// no after) and is then omitted from the wire.
type auditEntry struct {
	ID           int64           `json:"id"`
	GuildID      string          `json:"guildId"`
	ActorID      string          `json:"actorId"`
	ActorName    string          `json:"actorName"`
	Action       string          `json:"action"`
	ResourceType string          `json:"resourceType"`
	ResourceID   string          `json:"resourceId"`
	Before       json.RawMessage `json:"before,omitempty"`
	After        json.RawMessage `json:"after,omitempty"`
	Source       string          `json:"source"`
	CreatedAt    string          `json:"createdAt"`
}

// auditInput is the write shape. The guild is pinned server-side, never trusted
// from the body.
type auditInput struct {
	GuildID      string          `json:"guildId"`
	ActorID      string          `json:"actorId"`
	ActorName    string          `json:"actorName"`
	Action       string          `json:"action"`
	ResourceType string          `json:"resourceType"`
	ResourceID   string          `json:"resourceId"`
	Before       json.RawMessage `json:"before"`
	After        json.RawMessage `json:"after"`
	Source       string          `json:"source"`
}

// loggingStore is the persistence boundary; the interface keeps the handlers
// testable with an in-memory fake and no database.
type loggingStore interface {
	listDestinations(ctx context.Context, guildID string) ([]logDestination, error)
	upsertDestination(ctx context.Context, guildID, category, channelID string, enabled bool) error
	deleteDestination(ctx context.Context, guildID, category string) error
	recordAudit(ctx context.Context, in auditInput) (auditEntry, error)
	listAudit(ctx context.Context, guildID, resourceType string, limit int) ([]auditEntry, error)
}

type pgLoggingStore struct{ pool *pgxpool.Pool }

func newPGLoggingStore(pool *pgxpool.Pool) *pgLoggingStore { return &pgLoggingStore{pool: pool} }

func (s *pgLoggingStore) listDestinations(ctx context.Context, guildID string) ([]logDestination, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT category, channel_id, enabled, updated_at FROM log_destinations WHERE guild_id = $1 ORDER BY category`,
		guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []logDestination{}
	for rows.Next() {
		var d logDestination
		if err := rows.Scan(&d.Category, &d.ChannelID, &d.Enabled, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *pgLoggingStore) upsertDestination(ctx context.Context, guildID, category, channelID string, enabled bool) error {
	const stmt = `
		INSERT INTO log_destinations (guild_id, category, channel_id, enabled, updated_at)
		VALUES ($1,$2,$3,$4, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
		ON CONFLICT (guild_id, category) DO UPDATE
		  SET channel_id = EXCLUDED.channel_id,
		      enabled = EXCLUDED.enabled,
		      updated_at = EXCLUDED.updated_at`
	_, err := s.pool.Exec(ctx, stmt, guildID, category, channelID, enabled)
	return err
}

func (s *pgLoggingStore) deleteDestination(ctx context.Context, guildID, category string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM log_destinations WHERE guild_id = $1 AND category = $2`, guildID, category)
	return err
}

// nullableJSON maps an empty/nil raw message to SQL NULL, so a create's missing
// `before` is a real NULL, never an invalid empty jsonb.
func nullableJSON(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return []byte(raw)
}

func (s *pgLoggingStore) recordAudit(ctx context.Context, in auditInput) (auditEntry, error) {
	const stmt = `
		INSERT INTO audit_logs (guild_id, actor_id, actor_name, action, resource_type, resource_id, before, after, source)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id, created_at`
	var e auditEntry
	err := s.pool.QueryRow(ctx, stmt,
		in.GuildID, in.ActorID, in.ActorName, in.Action, in.ResourceType, in.ResourceID,
		nullableJSON(in.Before), nullableJSON(in.After), in.Source,
	).Scan(&e.ID, &e.CreatedAt)
	if err != nil {
		return auditEntry{}, err
	}
	e.GuildID, e.ActorID, e.ActorName = in.GuildID, in.ActorID, in.ActorName
	e.Action, e.ResourceType, e.ResourceID, e.Source = in.Action, in.ResourceType, in.ResourceID, in.Source
	e.Before, e.After = in.Before, in.After
	return e, nil
}

func (s *pgLoggingStore) listAudit(ctx context.Context, guildID, resourceType string, limit int) ([]auditEntry, error) {
	base := `SELECT id, guild_id, actor_id, actor_name, action, resource_type, resource_id,
		before, after, source, created_at FROM audit_logs WHERE guild_id = $1`
	args := []any{guildID}
	if resourceType != "" {
		base += ` AND resource_type = $2`
		args = append(args, resourceType)
	}
	base += ` ORDER BY id DESC LIMIT $` + strconv.Itoa(len(args)+1)
	args = append(args, limit)

	rows, err := s.pool.Query(ctx, base, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []auditEntry{}
	for rows.Next() {
		var (
			e      auditEntry
			before []byte
			after  []byte
		)
		if err := rows.Scan(&e.ID, &e.GuildID, &e.ActorID, &e.ActorName, &e.Action,
			&e.ResourceType, &e.ResourceID, &before, &after, &e.Source, &e.CreatedAt); err != nil {
			return nil, err
		}
		if len(before) > 0 {
			e.Before = json.RawMessage(before)
		}
		if len(after) > 0 {
			e.After = json.RawMessage(after)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// recordAudit is the best-effort helper the dashboard handlers call after a
// mutation. A logging failure must never fail the mutation the operator asked
// for, so it only logs — the config change stands even if its audit row cannot
// be written (a durable gap the operator can see in the dashboard).
func (s *server) recordAudit(ctx context.Context, in auditInput) {
	if s.logging == nil {
		return
	}
	in.GuildID = s.discord.effective(ctx).GuildID
	if in.GuildID == "" {
		return
	}
	if in.Source == "" {
		in.Source = "dashboard"
	}
	if _, err := s.logging.recordAudit(ctx, in); err != nil {
		slog.Error("audit write failed", "service", "api", "action", in.Action, "error", err)
	}
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// handleInternalLogConfig serves the bot over the loopback hop: the enabled
// category → channel map, flat, for the router to switch on. No session, by
// design: the api listener is loopback-only (DR-002) and the map carries no
// secret. A non-loopback peer is refused as if the route did not exist.
func (s *server) handleInternalLogConfig(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) {
		httpx.WriteError(w, r, errNotFound)
		return
	}
	if s.logging == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "logging_unavailable", errs.CategoryInternal,
			"logging store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	rows, err := s.logging.listDestinations(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "log config query failed")
		return
	}
	destinations := map[string]string{}
	for _, d := range rows {
		if d.Enabled && d.ChannelID != "" {
			destinations[d.Category] = d.ChannelID
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"destinations": destinations})
}

// handleInternalAudit serves the bot's audit writes over the loopback hop. The
// bot records a change it originated (a prefix edit through a command, an
// AutoMod rule toggle) so the audit trail is complete regardless of origin.
func (s *server) handleInternalAudit(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) {
		httpx.WriteError(w, r, errNotFound)
		return
	}
	if s.logging == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "logging_unavailable", errs.CategoryInternal,
			"logging store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	var in auditInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	if msg := validateAuditInput(&in, s.discord.effective(r.Context()).GuildID); msg != "" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, msg)
		return
	}
	e, err := s.logging.recordAudit(r.Context(), in)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "audit insert failed")
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, e)
}

// handleAdminLogDestinations serves the dashboard's log-routing editor: GET the
// full map (including disabled rows), POST to upsert one category. An empty
// channelId clears the category (the bot then stops mirroring it).
func (s *server) handleAdminLogDestinations(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !s.allowCapability(w, r, capabilityForMethod(r, capability.LogsRead, capability.LogsWrite)) {
		return
	}
	if s.logging == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "logging_unavailable", errs.CategoryInternal,
			"logging store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	if r.Method == http.MethodGet {
		rows, err := s.logging.listDestinations(r.Context(), guildID)
		if err != nil {
			writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "log config query failed")
			return
		}
		// The closed set travels with the rows: a category the operator has never
		// routed has no row, and the dashboard still has to render it (as unrouted).
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"destinations": rows, "categories": logCategoryList})
		return
	}
	s.adminLogDestinationsPost(w, r, guildID)
}

// logDestinationRequest is the POST body: a category and its destination. An
// empty channelId clears the row.
type logDestinationRequest struct {
	Category  string `json:"category"`
	ChannelID string `json:"channelId"`
	Enabled   *bool  `json:"enabled"`
}

func (s *server) adminLogDestinationsPost(w http.ResponseWriter, r *http.Request, guildID string) {
	var req logDestinationRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	req.Category = strings.TrimSpace(req.Category)
	req.ChannelID = strings.TrimSpace(req.ChannelID)
	if !logCategories[req.Category] {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "category is not a known log category")
		return
	}
	before := s.logDestinationByCategory(r.Context(), guildID, req.Category)

	if req.ChannelID == "" {
		if err := s.logging.deleteDestination(r.Context(), guildID, req.Category); err != nil {
			writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "log config delete failed")
			return
		}
		s.recordAudit(r.Context(), auditInput{
			ActorID: s.auditActor(r).ID, ActorName: s.auditActor(r).Name,
			Action: "log_destination.clear", ResourceType: "log_destination", ResourceID: req.Category,
			Before: marshalOrNil(before), Source: "dashboard",
		})
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "cleared": req.Category})
		return
	}
	if !isSnowflake(req.ChannelID) {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "channelId must be a Discord id (digits only)")
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	if err := s.logging.upsertDestination(r.Context(), guildID, req.Category, req.ChannelID, enabled); err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "log config write failed")
		return
	}
	after := logDestination{Category: req.Category, ChannelID: req.ChannelID, Enabled: enabled}
	s.recordAudit(r.Context(), auditInput{
		ActorID: s.auditActor(r).ID, ActorName: s.auditActor(r).Name,
		Action: "log_destination.set", ResourceType: "log_destination", ResourceID: req.Category,
		Before: marshalOrNil(before), After: marshalOrNil(after), Source: "dashboard",
	})
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "destination": after})
}

func (s *server) logDestinationByCategory(ctx context.Context, guildID, category string) *logDestination {
	rows, err := s.logging.listDestinations(ctx, guildID)
	if err != nil {
		return nil
	}
	for i := range rows {
		if rows[i].Category == category {
			return &rows[i]
		}
	}
	return nil
}

// handleAdminAuditLogs serves the dashboard audit viewer: newest first, optional
// ?resourceType= filter, bounded by ?limit=.
func (s *server) handleAdminAuditLogs(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	if !s.allowCapability(w, r, capability.LogsRead) {
		return
	}
	if s.logging == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "logging_unavailable", errs.CategoryInternal,
			"logging store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	rows, err := s.logging.listAudit(r.Context(), guildID, strings.TrimSpace(r.URL.Query().Get("resourceType")), auditLimit(r))
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "audit query failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"entries": rows})
}

// auditLimit bounds a list read: default 25, hard ceiling 100.
func auditLimit(r *http.Request) int {
	n := 25
	if v := r.URL.Query().Get("limit"); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 {
			n = p
		}
	}
	if n > 100 {
		n = 100
	}
	return n
}

// validateAuditInput returns an empty string when acceptable, else the refusal
// detail. It normalizes in place and pins the guild to the configured one.
func validateAuditInput(in *auditInput, configuredGuild string) string {
	in.Action = strings.TrimSpace(in.Action)
	in.ResourceType = strings.TrimSpace(in.ResourceType)
	if in.Action == "" {
		return "action is required"
	}
	if len(in.Action) > 128 {
		return "action is too long"
	}
	if in.ResourceType == "" {
		return "resourceType is required"
	}
	if len(in.ResourceType) > 64 {
		return "resourceType is too long"
	}
	if configuredGuild == "" {
		return "guild is not configured"
	}
	in.GuildID = configuredGuild
	if in.Source == "" {
		in.Source = "system"
	}
	if !auditSources[in.Source] {
		return "source is not a known audit source"
	}
	if in.ActorName == "" {
		in.ActorName = in.ActorID
	}
	if len(in.ActorName) > 128 {
		in.ActorName = in.ActorName[:128]
	}
	if len(in.ResourceID) > 128 {
		in.ResourceID = in.ResourceID[:128]
	}
	// Reject a body whose before/after is not valid JSON: a malformed snapshot
	// must never reach the jsonb column (Postgres would refuse it anyway, but a
	// 400 is a clearer contract than a 500).
	if len(in.Before) > 0 && !json.Valid(in.Before) {
		return "before must be valid JSON"
	}
	if len(in.After) > 0 && !json.Valid(in.After) {
		return "after must be valid JSON"
	}
	return ""
}

// auditActor is the dashboard identity for an audit entry, from the verified
// session cookie — never a client-supplied claim.
type auditActor struct {
	ID   string
	Name string
}

func (s *server) auditActor(r *http.Request) auditActor {
	claims, err := s.sessionClaims(r)
	if err != nil {
		return auditActor{}
	}
	name := claims.Username
	if claims.GlobalName != nil && *claims.GlobalName != "" {
		name = *claims.GlobalName
	}
	return auditActor{ID: claims.ID, Name: name}
}

// marshalOrNil returns the JSON encoding of v, or nil when v is nil (so a
// missing before/after is stored as SQL NULL).
func marshalOrNil(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}
