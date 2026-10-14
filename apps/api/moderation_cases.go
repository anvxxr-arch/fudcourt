package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
)

// Moderation cases (db/schema/pg-schema.sql, `moderation_cases`). The Discord
// bot is a zero-dependency Bun program: it carries no Postgres driver, so it
// records every action through this loopback api — the same hop it reads the
// Discord config through (internal_config.go). The dashboard reads the same
// rows through the admin-tier route, so Discord and the panel show ONE case log.

// moderationCase is one recorded moderation action. Discord snowflakes are
// strings (a JS client must never lose precision), and timestamps are
// 'YYYY-MM-DD HH:MM:SS' UTC strings, matching the `settings` convention.
type moderationCase struct {
	ID              int64  `json:"id"`
	CaseNumber      int64  `json:"caseNumber"`
	GuildID         string `json:"guildId"`
	Action          string `json:"action"`
	TargetUserID    string `json:"targetUserId"`
	ModeratorUserID string `json:"moderatorUserId"`
	Reason          string `json:"reason"`
	DurationSeconds *int   `json:"durationSeconds,omitempty"`
	Source          string `json:"source"`
	Status          string `json:"status"`
	CreatedAt       string `json:"createdAt"`
	ExpiresAt       string `json:"expiresAt,omitempty"`
	UpdatedAt       string `json:"updatedAt"`
}

// caseCreateInput is the POST body. It is deliberately closed: only the fields
// the bot owns. `status`/`caseNumber`/timestamps are server-derived, never
// client-supplied.
type caseCreateInput struct {
	GuildID         string `json:"guildId"`
	Action          string `json:"action"`
	TargetUserID    string `json:"targetUserId"`
	ModeratorUserID string `json:"moderatorUserId"`
	Reason          string `json:"reason"`
	DurationSeconds *int   `json:"durationSeconds"`
	Source          string `json:"source"`
}

// caseActions is the closed set of actions that may be recorded. Anything else
// is a validation error rather than a silently-stored typo.
var caseActions = map[string]bool{
	"warn": true, "unwarn": true, "timeout": true, "untimeout": true,
	"kick": true, "ban": true, "unban": true, "purge": true,
	"nickname": true, "lock": true, "unlock": true, "slowmode": true,
}

// caseSources is the closed set of origins. It mirrors the moderation sources
// in the product spec (slash | prefix | context_menu | dashboard | automod |
// system).
var caseSources = map[string]bool{
	"slash": true, "prefix": true, "context_menu": true,
	"dashboard": true, "automod": true, "system": true,
}

// activeActions open a case that stays open until it is lifted or expires
// (a timeout, a ban). Every other action is a point-in-time record, closed on
// creation.
var activeActions = map[string]bool{"timeout": true, "ban": true}

// errCaseNotFound maps to 404 for a case-number lookup that misses.
var errCaseNotFound = errs.New(errs.CategoryNotFound, "NOT_FOUND", "no such case")

// casesStore is the persistence boundary. The interface keeps the handlers
// testable with an in-memory fake and no database.
type casesStore interface {
	create(ctx context.Context, in caseCreateInput) (moderationCase, error)
	recent(ctx context.Context, guildID string, limit int) ([]moderationCase, error)
	byTarget(ctx context.Context, guildID, targetID string, limit int) ([]moderationCase, error)
	byNumber(ctx context.Context, guildID string, number int64) (moderationCase, error)
}

type pgCasesStore struct{ pool *pgxpool.Pool }

func newPGCasesStore(pool *pgxpool.Pool) *pgCasesStore { return &pgCasesStore{pool: pool} }

// caseColumns is the projection every read shares, so the scanner stays one
// shape. COALESCE keeps a NULL expires_at an empty string, never "null".
const caseColumns = `id, case_number, guild_id, action, target_user_id, moderator_user_id,
	reason, duration_seconds, source, status, created_at, COALESCE(expires_at,''), updated_at`

func scanCase(row pgx.Row) (moderationCase, error) {
	var c moderationCase
	err := row.Scan(&c.ID, &c.CaseNumber, &c.GuildID, &c.Action, &c.TargetUserID,
		&c.ModeratorUserID, &c.Reason, &c.DurationSeconds, &c.Source, &c.Status,
		&c.CreatedAt, &c.ExpiresAt, &c.UpdatedAt)
	return c, err
}

func (s *pgCasesStore) create(ctx context.Context, in caseCreateInput) (moderationCase, error) {
	// expires_at is derived from now() + duration in SQL, so the clock is the
	// database's (one source of truth) and a timeout's deadline is atomic with
	// its insert. make_interval(secs => NULL) is NULL, so a non-timeout case
	// stores NULL.
	const stmt = `
		INSERT INTO moderation_cases
		  (guild_id, action, target_user_id, moderator_user_id, reason,
		   duration_seconds, source, status, expires_at)
		VALUES
		  ($1, $2, $3, $4, $5, $6, $7, $8,
		   CASE WHEN $6::int IS NOT NULL
		        THEN to_char((now() AT TIME ZONE 'UTC') + make_interval(secs => $6::int),
		                     'YYYY-MM-DD HH24:MI:SS')
		        ELSE NULL END)
		RETURNING ` + caseColumns
	row := s.pool.QueryRow(ctx, stmt, in.GuildID, in.Action, in.TargetUserID,
		in.ModeratorUserID, in.Reason, in.DurationSeconds, in.Source, statusFor(in.Action))
	c, err := scanCase(row)
	if err != nil {
		return moderationCase{}, err
	}
	return c, nil
}

func (s *pgCasesStore) recent(ctx context.Context, guildID string, limit int) ([]moderationCase, error) {
	const stmt = `SELECT ` + caseColumns + `
		FROM moderation_cases WHERE guild_id = $1 ORDER BY id DESC LIMIT $2`
	return s.query(ctx, stmt, guildID, limit)
}

func (s *pgCasesStore) byTarget(ctx context.Context, guildID, targetID string, limit int) ([]moderationCase, error) {
	const stmt = `SELECT ` + caseColumns + `
		FROM moderation_cases WHERE guild_id = $1 AND target_user_id = $2
		ORDER BY id DESC LIMIT $3`
	return s.query(ctx, stmt, guildID, targetID, limit)
}

func (s *pgCasesStore) byNumber(ctx context.Context, guildID string, number int64) (moderationCase, error) {
	const stmt = `SELECT ` + caseColumns + `
		FROM moderation_cases WHERE guild_id = $1 AND case_number = $2`
	c, err := scanCase(s.pool.QueryRow(ctx, stmt, guildID, number))
	if errors.Is(err, pgx.ErrNoRows) {
		return moderationCase{}, errCaseNotFound
	}
	return c, err
}

func (s *pgCasesStore) query(ctx context.Context, stmt string, args ...any) ([]moderationCase, error) {
	rows, err := s.pool.Query(ctx, stmt, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]moderationCase, 0, 16)
	for rows.Next() {
		c, err := scanCase(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// statusFor is the case's opening status: an action that stays in force opens
// `active` (so a later lift can flip it to `reversed`/`closed`); a
// point-in-time action is recorded `closed`.
func statusFor(action string) string {
	if activeActions[action] {
		return "active"
	}
	return "closed"
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// caseLimit bounds a list read: default 25, hard ceiling 100, so a client can
// never ask for the whole table.
func caseLimit(r *http.Request) int {
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

// handleInternalModerationCases serves the bot over the loopback hop:
//
//	GET  ?target=<id>&limit=<n>   → {"cases":[...]}  (or ?number=<n> → one case)
//	POST {guildId,action,targetUserId,moderatorUserId,reason,durationSeconds,source}
//
// No session, by design: the api listener is loopback-only (DR-002) and a case
// carries no secret. A non-loopback peer is refused as if the route did not
// exist, so a case write can never be driven from off-host.
func (s *server) handleInternalModerationCases(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) {
		httpx.WriteError(w, r, errNotFound)
		return
	}
	if s.cases == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "cases_unavailable", errs.CategoryInternal,
			"case store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	if r.Method == http.MethodPost {
		s.createModerationCase(w, r)
		return
	}
	s.readModerationCases(w, r)
}

// handleAdminModerationCases serves the dashboard: the same case log the bot
// writes, behind the admin tier. GET only; the tier is re-checked from the
// signed session cookie server-side (never a client-supplied claim).
func (s *server) handleAdminModerationCases(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if s.cases == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "cases_unavailable", errs.CategoryInternal,
			"case store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	s.readModerationCases(w, r)
}

func (s *server) readModerationCases(w http.ResponseWriter, r *http.Request) {
	guildID := s.discord.effective(r.Context()).GuildID
	if n := r.URL.Query().Get("number"); n != "" {
		num, err := strconv.ParseInt(n, 10, 64)
		if err != nil || num <= 0 {
			writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "number must be a positive integer")
			return
		}
		c, err := s.cases.byNumber(r.Context(), guildID, num)
		if err != nil {
			writeRefusal(w, r, http.StatusNotFound, "not_found", errs.CategoryNotFound, "no such case")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, c)
		return
	}
	target := strings.TrimSpace(r.URL.Query().Get("target"))
	var (
		cases []moderationCase
		err   error
	)
	if target != "" {
		if !isSnowflake(target) {
			writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "target must be a snowflake id")
			return
		}
		cases, err = s.cases.byTarget(r.Context(), guildID, target, caseLimit(r))
	} else {
		cases, err = s.cases.recent(r.Context(), guildID, caseLimit(r))
	}
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "case query failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"cases": cases})
}

func (s *server) createModerationCase(w http.ResponseWriter, r *http.Request) {
	var in caseCreateInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, "body must be a JSON object")
		return
	}
	if msg := validateCaseInput(&in, s.discord.effective(r.Context()).GuildID); msg != "" {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation, msg)
		return
	}
	c, err := s.cases.create(r.Context(), in)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "case insert failed")
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, c)
}

// validateCaseInput returns an empty string when the input is acceptable, else
// the refusal detail. It normalizes in place (trims the reason, defaults the
// source, pins the guild to the configured one).
func validateCaseInput(in *caseCreateInput, configuredGuild string) string {
	if !caseActions[in.Action] {
		return "action is not a known moderation action"
	}
	if !isSnowflake(in.TargetUserID) {
		return "targetUserId must be a snowflake id"
	}
	if !isSnowflake(in.ModeratorUserID) {
		return "moderatorUserId must be a snowflake id"
	}
	// The guild is authoritative from config: a caller cannot log a case into
	// a different guild than the one this deployment is wired to.
	if configuredGuild == "" {
		return "guild is not configured"
	}
	in.GuildID = configuredGuild
	if in.Source == "" {
		in.Source = "slash"
	}
	if !caseSources[in.Source] {
		return "source is not a known moderation source"
	}
	if in.DurationSeconds != nil && (*in.DurationSeconds < 0 || *in.DurationSeconds > 60*60*24*365) {
		return "durationSeconds is out of range"
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if len(in.Reason) > 512 {
		in.Reason = in.Reason[:512]
	}
	return ""
}
