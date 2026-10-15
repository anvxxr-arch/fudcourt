package main

// scheduler.go is the scheduler panel: the definitions the worker's tick materializes into
// ordinary `jobs`, shown with their health so an operator can see WHY a scheduled thing has
// not run, and edited under an ownership rule that keeps this panel out of another's rows.
//
// WHY OWNERSHIP IS THE WHOLE WRITE PATH. `scheduled_jobs` is a SHARED table, and ownership
// is not in it as a column — it is derived from `job_kind`. The feeds panel writes its
// `feed.poll` definitions inside the same transaction as the source row (a feed can never
// exist unpolled), which makes those rows the feeds panel's, not this one's. A wholesale
// replace from here that deleted every definition for the guild would take every feed's
// poll with it, and the symptom would NOT be an error: with the definition gone the feeds
// panel's LEFT JOIN falls back to its default cadence (`reconcileFeedSources` reads
// `schedule_expr` with a 900 fallback), so the operator sees "my feed stopped updating
// hours ago" long after the save that did it. So the upsert carries
// `WHERE scheduled_jobs.job_kind <> 'feed.poll'`, the delete carries the same exclusion,
// and a name a feed already owns is refused with a 409 naming it rather than reported as
// saved.
//
// WHY A CRON DEFINITION IS STORED WITHOUT A `next_run_at`. Anchoring a schedule means
// computing its first occurrence, and a cron expression needs a cron parser, a timezone
// database and a DST policy — none of which this binary has, and all of which the worker
// has. Rather than grow a second implementation of "next occurrence" that can disagree
// with the one that actually fires, the panel writes NULL for a cron and the first tick
// anchors it (`store::anchor`, apps/discord-worker). `once` and `interval` need no
// calendar, so the panel anchors those itself.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/capability"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/errs"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/httpx"
	"github.com/jackc/pgx/v5"
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

// scheduleStore is the Postgres half of the panel.
type scheduleStore interface {
	list(ctx context.Context, guildID string) ([]scheduleDefinition, error)
	// replace writes THIS panel's definitions for the guild in one transaction, keyed on
	// `name`, and refuses a name another panel owns with a *foreignScheduleError.
	replace(ctx context.Context, guildID string, definitions []scheduleDefinition) error
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

// replace writes THIS panel's definitions for the guild in one transaction, keyed on
// `name`, and never touches a row another panel owns.
func (s *pgScheduleStore) replace(ctx context.Context, guildID string, definitions []scheduleDefinition) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	// A rollback after a successful commit is a no-op, so this is safe on both paths.
	defer func() { _ = tx.Rollback(ctx) }()

	now := time.Now().UTC()
	keep := make([]string, 0, len(definitions))
	for _, d := range definitions {
		name := strings.TrimSpace(d.Name)
		var id int64
		// The `WHERE` on the DO UPDATE is the ownership rule: a row whose `job_kind` is
		// `feed.poll` is not this panel's to touch. When it applies, no row is updated, so
		// the RETURNING yields nothing and `pgx.ErrNoRows` is how we learn it — which is
		// exactly the difference between "saved" and "a feed owns this name", and the
		// handler turns it into a 409.
		//
		// The CASE on `next_run_at` is the rhythm rule: editing the SCHEDULE re-anchors the
		// definition (the stored occurrence was computed for the old expression), while
		// editing only the payload or the enabled flag leaves the next occurrence alone —
		// the same reason the feeds panel does not reset a poll cadence on a save.
		err := tx.QueryRow(ctx, `
			INSERT INTO scheduled_jobs (guild_id, name, job_kind, schedule_kind, schedule_expr,
			                            timezone, payload, enabled, next_run_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (guild_id, name) DO UPDATE SET
			  job_kind      = EXCLUDED.job_kind,
			  schedule_kind = EXCLUDED.schedule_kind,
			  schedule_expr = EXCLUDED.schedule_expr,
			  timezone      = EXCLUDED.timezone,
			  payload       = EXCLUDED.payload,
			  enabled       = EXCLUDED.enabled,
			  next_run_at   = CASE
			    WHEN scheduled_jobs.schedule_kind IS DISTINCT FROM EXCLUDED.schedule_kind
			      OR scheduled_jobs.schedule_expr IS DISTINCT FROM EXCLUDED.schedule_expr
			      OR scheduled_jobs.timezone      IS DISTINCT FROM EXCLUDED.timezone
			    THEN EXCLUDED.next_run_at
			    ELSE scheduled_jobs.next_run_at
			  END,
			  updated_at    = now()
			WHERE scheduled_jobs.job_kind <> 'feed.poll'
			RETURNING id`,
			guildID, name, d.JobKind, d.ScheduleKind, strings.TrimSpace(d.ScheduleExpr),
			strings.TrimSpace(d.Timezone), payloadJSON(d.Payload), d.Enabled,
			anchorFor(d.ScheduleKind, strings.TrimSpace(d.ScheduleExpr), now),
		).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return &foreignScheduleError{Name: name, Owner: ownerFeeds}
		}
		if err != nil {
			return err
		}
		keep = append(keep, name)
	}

	// Gone from the list means gone — but only OURS. A feed's poll is not in the request
	// because the feeds panel owns it, so `NOT (name = ANY($2))` alone would delete it as
	// though the operator had removed it.
	if _, err := tx.Exec(ctx, `
		DELETE FROM scheduled_jobs
		 WHERE guild_id = $1 AND job_kind <> 'feed.poll' AND NOT (name = ANY($2))`,
		guildID, keep); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// foreignScheduleError says a name is already another panel's row. Its own type so the
// handler can answer 409 with the reason instead of a generic 500: "saved" and "did not
// save" must never look the same to an operator who just pressed Save.
type foreignScheduleError struct {
	Name  string
	Owner scheduleOwner
}

func (e *foreignScheduleError) Error() string {
	return fmt.Sprintf("definition %q belongs to the %s panel; edit it there", e.Name, e.Owner)
}

// The bounds of a definition this panel writes. The interval bounds ARE the feed poll
// bounds on purpose: both answer "how often may this bot act", and a second set of numbers
// would drift from the first. The count bound is the tick's own `TICK_BATCH`, because a save
// that needs more than one tick to become visible would make the panel lie about what it
// just did.
const (
	maxScheduleDefinitions = 200
	maxScheduleName        = 64
	maxScheduleExpr        = 120
	maxScheduleContent     = 1900
)

// writableJobKinds is the allow-list this panel may create, with what each kind does.
//
// An unknown kind is refused BY NAME: a definition whose kind no handler claims is
// materialized, claimed, and failed as "no handler registered", which reads as a scheduler
// bug and is not one. `health.ping` is on the list because the worker registers it without
// any configuration, so it is the honest way to prove the whole chain — schedule, tick,
// claim, run, history — before Discord is reachable.
var writableJobKinds = map[string]string{
	"discord.message": "post a message to a channel",
	"health.ping":     "succeed without doing anything",
}

// anchorFor computes the first occurrence this panel is ABLE to compute, or nil for a
// schedule it cannot evaluate.
//
// `once` is its own instant and `interval` is arithmetic: neither needs a calendar, a
// timezone database or a DST policy, so the panel anchors them exactly, and an interval is
// anchored one interval AHEAD rather than now (the feeds panel wants an immediate first
// poll; "every 24h" created at noon should not fire at noon). A cron expression needs all
// three, and the worker's parser is the only thing that has them: the panel stores NULL and
// the first tick anchors it with the same parser it will use forever after. One definition
// of "next occurrence" is the point — the dashboard must show what the worker will do, not
// what a second implementation believes.
func anchorFor(scheduleKind, expr string, now time.Time) *time.Time {
	switch scheduleKind {
	case "once":
		at, err := time.Parse(time.RFC3339, expr)
		if err != nil {
			return nil
		}
		return &at
	case "interval":
		secs, err := strconv.Atoi(expr)
		if err != nil {
			return nil
		}
		at := now.Add(time.Duration(secs) * time.Second)
		return &at
	default:
		return nil
	}
}

// validateScheduleDefinition checks one definition and returns the operator-facing reason
// it is refused, or "". The rules are the worker's, restated: the same `Schedule` parser
// will evaluate this schedule forever after, and a value this panel accepted but the worker
// rejects would be a definition that looks saved and never runs. Where the two differ it is
// only by being STRICTER here, and the reason says which bound failed.
func validateScheduleDefinition(d scheduleDefinition, now time.Time) string {
	name := strings.TrimSpace(d.Name)
	if name == "" || len(name) > maxScheduleName {
		return fmt.Sprintf("name must be 1..%d characters", maxScheduleName)
	}
	if strings.ContainsAny(d.Name, "\n\r	") {
		return "name must not contain control characters"
	}
	if d.JobKind == feedPollKind {
		return "jobKind feed.poll belongs to the feeds panel: create the feed there and its poll is written with it"
	}
	if _, ok := writableJobKinds[d.JobKind]; !ok {
		return "jobKind must be one of discord.message, health.ping"
	}
	switch d.ScheduleKind {
	case "once", "interval", "cron":
	default:
		return "scheduleKind must be one of once, interval, cron"
	}
	expr := strings.TrimSpace(d.ScheduleExpr)
	if expr == "" || len(expr) > maxScheduleExpr {
		return fmt.Sprintf("scheduleExpr must be 1..%d characters", maxScheduleExpr)
	}
	switch d.ScheduleKind {
	case "once":
		at, err := time.Parse(time.RFC3339, expr)
		if err != nil {
			return "scheduleExpr must be an RFC 3339 timestamp for a once schedule"
		}
		if !at.After(now) {
			return "scheduleExpr is in the past; a once schedule fires once and is never fired late"
		}
	case "interval":
		secs, err := strconv.Atoi(expr)
		if err != nil {
			return "scheduleExpr must be a whole number of seconds for an interval schedule"
		}
		if secs < minPollInterval || secs > maxPollInterval {
			return fmt.Sprintf("scheduleExpr must be %d..%d seconds", minPollInterval, maxPollInterval)
		}
	case "cron":
		if msg := validateCronShape(expr); msg != "" {
			return msg
		}
	}
	tz := strings.TrimSpace(d.Timezone)
	if tz == "" || len(tz) > 64 {
		return "timezone must be an IANA zone name such as UTC or Asia/Jakarta"
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return fmt.Sprintf("unknown timezone %q", tz)
	}
	return validateSchedulePayload(d)
}

// cronFieldOK matches the characters a crontab field may contain. The class is a fixed set
// and the expression length is bounded, so it cannot backtrack: this is a shape check, not
// an evaluator.
var cronFieldOK = regexp.MustCompile(`^[0-9*,\-/]+$`)

// validateCronShape checks the SHAPE of a cron expression, never its meaning: the field
// count (5, or 6/7 with a leading seconds field) and the characters a field may contain.
//
// The meaning belongs to the worker's `cron` crate, and this panel deliberately does not
// grow a parser to second-guess it. So the accepted subset is NUMERIC (a zone name is not
// needed and a month NAME would only be accepted here while being refused there), and an
// expression that passes this check but fails the parser is recorded against the definition
// by the tick that evaluates it, where the panel shows it.
func validateCronShape(expr string) string {
	fields := strings.Fields(expr)
	if len(fields) != 5 && len(fields) != 6 && len(fields) != 7 {
		return fmt.Sprintf("scheduleExpr has %d fields; expected 5 (min hour dom mon dow) "+
			"or 6/7 with a leading seconds field", len(fields))
	}
	for _, f := range fields {
		if !cronFieldOK.MatchString(f) {
			return fmt.Sprintf("scheduleExpr field %q must be numbers, *, a range, a list or a step", f)
		}
	}
	return ""
}

// validateSchedulePayload checks the payload the WORKER reads. It restates the worker's own
// rules rather than replacing them — the worker must still defend itself, because SQL is not
// the only way a row is written — but an operator should hear about a bad channel while
// typing, not from `last_error` one tick later.
func validateSchedulePayload(d scheduleDefinition) string {
	switch d.JobKind {
	case "discord.message":
		if !isSnowflake(payloadString(d.Payload, "channel_id")) {
			return "payload.channel_id must be a Discord channel id"
		}
		content := payloadString(d.Payload, "content")
		if strings.TrimSpace(content) == "" {
			return "payload.content is required"
		}
		if len(content) > maxScheduleContent {
			return fmt.Sprintf("payload.content must be at most %d characters", maxScheduleContent)
		}
	}
	return ""
}

// payloadString reads a payload field as a string without trusting its type: a client can
// send a number where a string belongs, and that must be a refusal rather than a panic.
func payloadString(payload map[string]any, key string) string {
	s, _ := payload[key].(string)
	return s
}

// payloadJSON encodes a payload for the `jsonb` column. The column is NOT NULL and an
// absent payload means "no arguments", which is the common case for a kind that takes none.
func payloadJSON(payload map[string]any) json.RawMessage {
	raw := marshalOrNil(payload)
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	return raw
}

// handleAdminScheduler is GET|POST /api/admin/scheduler: every definition with its
// schedule, its next occurrence and its last outcome, and the editor that writes this
// panel's rows.
func (s *server) handleAdminScheduler(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	if !s.allowCapability(w, r, capabilityForMethod(r, capability.SchedulerRead, capability.SchedulerManage)) {
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
	if r.Method == http.MethodGet {
		s.writeScheduleList(w, r, guildID)
		return
	}
	var req struct {
		Definitions []scheduleDefinition `json:"definitions"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&req); err != nil {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
			"body must be a JSON object")
		return
	}
	if len(req.Definitions) > maxScheduleDefinitions {
		writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
			fmt.Sprintf("at most %d definitions are allowed", maxScheduleDefinitions))
		return
	}
	now := time.Now().UTC()
	seen := make(map[string]bool, len(req.Definitions))
	for i, d := range req.Definitions {
		// Trimming here rather than in SQL means the duplicate check, the stored name and
		// the conflict key are the same string: "news " and "news" must not be two rows.
		d.Name = strings.TrimSpace(d.Name)
		d.ScheduleExpr = strings.TrimSpace(d.ScheduleExpr)
		d.Timezone = strings.TrimSpace(d.Timezone)
		if msg := validateScheduleDefinition(d, now); msg != "" {
			writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
				fmt.Sprintf("definitions[%d]: %s", i, msg))
			return
		}
		if seen[d.Name] {
			writeRefusal(w, r, http.StatusBadRequest, "bad_request", errs.CategoryValidation,
				fmt.Sprintf("definitions[%d]: duplicate name %q", i, d.Name))
			return
		}
		seen[d.Name] = true

		// The worker owns these columns. The SQL never writes them, but clearing them here
		// means the store sees exactly the operator's fields whether it is a fake or
		// Postgres — and a hand-made request cannot even LOOK like it set the next
		// occurrence or the health.
		d.ID = 0
		d.NextRunAt, d.LastRunAt = nil, nil
		d.LastStatus, d.LastError = nil, nil
		d.Attempts, d.MaxAttempts = 0, 0
		req.Definitions[i] = d
	}
	if err := s.schedules.replace(r.Context(), guildID, req.Definitions); err != nil {
		var foreign *foreignScheduleError
		if errors.As(err, &foreign) {
			writeRefusal(w, r, http.StatusConflict, "conflict", errs.CategoryConflict, foreign.Error())
			return
		}
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal,
			"scheduler write failed")
		return
	}
	s.writeScheduleList(w, r, guildID)
}

// writeScheduleList answers with the CURRENT rows, not the request body: the worker-owned
// fields (health, the next occurrence) are only knowable from the store.
func (s *server) writeScheduleList(w http.ResponseWriter, r *http.Request, guildID string) {
	definitions, err := s.schedules.list(r.Context(), guildID)
	if err != nil {
		writeRefusal(w, r, http.StatusInternalServerError, "internal_error", errs.CategoryInternal,
			"scheduler query failed")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"definitions": definitions})
}
