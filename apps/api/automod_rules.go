package main

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
)

// AutoMod rules (db/schema/pg-schema.sql, `automod_rules`). A rule is DATA the
// operator authors; the bot evaluates it. This file owns the loopback read the
// bot makes at boot and per event — the same hop it reads the Discord config and
// writes cases through (internal_config.go, moderation_cases.go), because the
// bot carries no Postgres driver.
//
// The JSON shape emitted here is the contract the bot validates against
// (apps/discord-bot/src/automod/rules.ts, `parseRule`). camelCase, snowflakes and
// ids as strings, matchers/actions as structured arrays.

// automodMatcher is one matcher as the bot's engine expects it. Only the fields a
// matcher type actually uses are populated (threshold for counts, values for
// word/domain lists, pattern for regex); the bot re-validates per type.
type automodMatcher struct {
	Type      string   `json:"type"`
	Threshold *float64 `json:"threshold,omitempty"`
	Values    []string `json:"values,omitempty"`
	Pattern   string   `json:"pattern,omitempty"`
}

// automodRule is one rule row, projected to the bot's camelCase contract.
type automodRule struct {
	ID              int64            `json:"id"`
	GuildID         string           `json:"guildId"`
	Name            string           `json:"name"`
	Enabled         bool             `json:"enabled"`
	Priority        int              `json:"priority"`
	Event           string           `json:"event"`
	Matchers        []automodMatcher `json:"matchers"`
	Actions         []string         `json:"actions"`
	ExemptRoles     []string         `json:"exemptRoles"`
	ExemptUsers     []string         `json:"exemptUsers"`
	ExemptChannels  []string         `json:"exemptChannels"`
	CooldownSeconds int              `json:"cooldownSeconds"`
	TimeoutSeconds  *int             `json:"timeoutSeconds,omitempty"`
	RoleID          string           `json:"roleId,omitempty"`
	CreatedAt       string           `json:"createdAt"`
	UpdatedAt       string           `json:"updatedAt"`
}

// automodStore is the persistence boundary, so the handler is testable with a
// fake and no database.
type automodStore interface {
	list(ctx context.Context, guildID string) ([]automodRule, error)
}

type pgAutomodStore struct{ pool *pgxpool.Pool }

func newPGAutomodStore(pool *pgxpool.Pool) *pgAutomodStore { return &pgAutomodStore{pool: pool} }

// list returns every ENABLED rule for the guild, highest priority first, then by
// id (a stable tiebreak). Disabled rules are filtered in SQL: the bot's hot path
// never sees them.
func (s *pgAutomodStore) list(ctx context.Context, guildID string) ([]automodRule, error) {
	const stmt = `
		SELECT id, guild_id, name, enabled, priority, event,
		       matchers, actions,
		       exempt_roles, exempt_users, exempt_channels,
		       cooldown_seconds, timeout_seconds, role_id,
		       created_at, updated_at
		FROM automod_rules
		WHERE guild_id = $1 AND enabled = true
		ORDER BY priority DESC, id`
	rows, err := s.pool.Query(ctx, stmt, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]automodRule, 0, 16)
	for rows.Next() {
		var (
			r      automodRule
			roleID *string
		)
		if err := rows.Scan(&r.ID, &r.GuildID, &r.Name, &r.Enabled, &r.Priority, &r.Event,
			&r.Matchers, &r.Actions,
			&r.ExemptRoles, &r.ExemptUsers, &r.ExemptChannels,
			&r.CooldownSeconds, &r.TimeoutSeconds, &roleID,
			&r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		if roleID != nil {
			r.RoleID = *roleID
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// handleInternalAutomodRules serves the bot over the loopback hop:
//
//	GET /api/internal/automod/rules → {"rules":[...]}
//
// No session, by design: the api listener is loopback-only (DR-002) and the rule
// set carries no secret. A non-loopback peer is refused as if the route did not
// exist, so the rule set can never be read from off-host.
func (s *server) handleInternalAutomodRules(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	if !isLoopbackPeer(r.RemoteAddr) {
		httpx.WriteError(w, r, errNotFound)
		return
	}
	if s.automod == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "automod_unavailable", errs.CategoryInternal,
			"automod store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	rules, err := s.automod.list(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal, "automod query failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"rules": rules})
}
