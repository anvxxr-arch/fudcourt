package main

// scheduler.go is the scheduler panel: the definitions the worker's tick
// materializes into ordinary `jobs`, shown with their health so an operator can
// see WHY a scheduled thing has not run.
//
// WHY THIS IS READ-ONLY FOR NOW. `scheduled_jobs` is a SHARED table, and the
// ownership is not in it as a column — it is derived from `job_kind`. The feeds
// panel writes its `feed.poll` definitions inside the same transaction as the
// source row (a feed can never exist unpolled), which makes those rows the
// feeds panel's, not this one's. A wholesale replace from here would delete
// every feed's poll on a save, and the symptom would NOT be an error: with the
// definition gone the feeds panel's LEFT JOIN falls back to its default cadence
// (`reconcileFeedSources` reads `schedule_expr` with a 900 fallback), so the
// operator sees "my feed stopped updating hours ago" long after the save that
// did it. The next change adds the write path; it MUST carry
// `ON CONFLICT (guild_id, name) DO UPDATE ... WHERE scheduled_jobs.job_kind <>
// 'feed.poll'` so a name collision with another panel's row cannot hijack it.

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
	"github.com/jackc/pgx/v5/pgxpool"
)

// feedPollKind is the job_kind the feeds panel writes. Spelled once, here, for
// the same reason the worker spells it in its own crate: a shared string is a
// contract, so a typo should be a compile error rather than a definition nobody
// polls.
const feedPollKind = "feed.poll"

// scheduleOwner names the panel that WRITES a definition.
type scheduleOwner string

const (
	// ownerScheduler is this panel: definitions an operator creates by hand.
	ownerScheduler scheduleOwner = "scheduler"
	// ownerFeeds is the feeds panel, which owns its poll definitions.
	ownerFeeds scheduleOwner = "feeds"
)

// ownedBy derives ownership from the row's own `job_kind`, so it cannot drift
// from the data. An unrecognised kind belongs to this panel: it is the only one
// that creates definitions from scratch, so anything else is either one of
// ours or a new kind whose owner has not been taught yet — and showing it as
// editable here is the safer of the two mistakes, because a definition this
// panel silently hid would be one nobody could reach.
func ownedBy(jobKind string) scheduleOwner {
	if jobKind == feedPollKind {
		return ownerFeeds
	}
	return ownerScheduler
}

// annotate fills the ownership fields from the row's own `job_kind`. It is a
// pure function so the rule — including the `feed.poll` string itself — is
// unit-testable without a database, which is the only way a row that does not
// exist yet can be checked.
func annotate(d scheduleDefinition) scheduleDefinition {
	d.Owner = ownedBy(d.JobKind)
	d.ReadOnly = d.Owner != ownerScheduler
	return d
}

// scheduleDefinition is one `scheduled_jobs` row as the panel sees it. The
// worker-owned fields are in the same struct on purpose: the panel has to report
// them, and the write path (not yet built) has to know which columns it may not
// touch.
type scheduleDefinition struct {
	ID           int64          `json:"id"`
	Name         string         `json:"name"`
	JobKind      string         `json:"jobKind"`
	ScheduleKind string         `json:"scheduleKind"`
	ScheduleExpr string         `json:"scheduleExpr"`
	Timezone     string         `json:"timezone"`
	Payload      map[string]any `json:"payload"`
	Enabled      bool           `json:"enabled"`
	// Worker-owned, reported only. `nextRunAt` is the next occurrence the tick
	// will materialize; it is NULL on a spent `once` definition.
	NextRunAt   *time.Time `json:"nextRunAt,omitempty"`
	LastRunAt   *time.Time `json:"lastRunAt,omitempty"`
	LastStatus  *string    `json:"lastStatus,omitempty"`
	LastError   *string    `json:"lastError,omitempty"`
	Attempts    int32      `json:"attempts"`
	MaxAttempts int32      `json:"maxAttempts"`
	// Owner says which panel writes this row, and ReadOnly is that same fact in
	// the form a client needs — a UI should never have to know the ownership
	// table to decide whether to render an edit control.
	Owner    scheduleOwner `json:"owner"`
	ReadOnly bool          `json:"readOnly"`
}

// scheduleStore is the Postgres half of the panel. `list` is the whole surface
// until the write path lands with its ownership rule.
type scheduleStore interface {
	list(ctx context.Context, guildID string) ([]scheduleDefinition, error)
}

type pgScheduleStore struct{ pool *pgxpool.Pool }

func newPGScheduleStore(pool *pgxpool.Pool) *pgScheduleStore {
	return &pgScheduleStore{pool: pool}
}

// scheduleSelect reads every definition for the guild, this panel's rows first.
// `ORDER BY (job_kind = 'feed.poll')` sorts false before true, so the operator's
// own definitions are not buried under the feeds' polls.
const scheduleSelect = `
SELECT id, name, job_kind, schedule_kind, schedule_expr, timezone, payload, enabled,
       next_run_at, last_run_at, last_status, last_error, attempts, max_attempts
  FROM scheduled_jobs
 WHERE guild_id = $1
 ORDER BY (job_kind = 'feed.poll'), name`

func (s *pgScheduleStore) list(ctx context.Context, guildID string) ([]scheduleDefinition, error) {
	rows, err := s.pool.Query(ctx, scheduleSelect, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]scheduleDefinition, 0, 16)
	for rows.Next() {
		var (
			d   scheduleDefinition
			raw []byte
		)
		if err := rows.Scan(
			&d.ID, &d.Name, &d.JobKind, &d.ScheduleKind, &d.ScheduleExpr, &d.Timezone,
			&raw, &d.Enabled, &d.NextRunAt, &d.LastRunAt, &d.LastStatus, &d.LastError,
			&d.Attempts, &d.MaxAttempts,
		); err != nil {
			return nil, err
		}
		// A payload that will not parse is not worth failing the whole panel
		// over: show the definition with an empty payload. Every other column is
		// still worth seeing, and a malformed payload makes the row itself the
		// interesting thing.
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &d.Payload)
		}
		out = append(out, annotate(d))
	}
	return out, rows.Err()
}

// handleAdminScheduler is GET /api/admin/scheduler: every definition with its
// schedule, its next occurrence and its last outcome.
func (s *server) handleAdminScheduler(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet) {
		return
	}
	if !s.requireAdmin(w, r) {
		return
	}
	if s.schedules == nil {
		writeRefusal(w, r, http.StatusServiceUnavailable, "scheduler_unavailable", errs.CategoryInternal,
			"scheduler store is not configured (FUDCOURT_PG_URL unset)")
		return
	}
	guildID := s.discord.effective(r.Context()).GuildID
	if guildID == "" {
		writeRefusal(w, r, http.StatusServiceUnavailable, "scheduler_unavailable", errs.CategoryInternal,
			"no guild configured (FUDCOURT_GUILD_ID unset)")
		return
	}
	definitions, err := s.schedules.list(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal,
			"scheduler query failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"definitions": definitions})
}
