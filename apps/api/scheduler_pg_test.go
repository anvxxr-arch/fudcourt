package main

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestPGSchedulerWritePath exercises the REAL SQL in scheduler.go's replace against a live
// Postgres carrying db/schema/pg-schema.sql. A fake store cannot check the properties that
// matter here, because they are properties of the SQL: `scheduled_jobs` is SHARED with the
// feeds panel, and the ownership rule is a WHERE clause inside an upsert. Whether a name
// collision really leaves the other panel's row alone, whether the delete really spares it,
// and whether a refused save really writes nothing at all are decided in the database, not in
// the Go. It is skipped unless FUDCOURT_TEST_PG_URL is set.
func TestPGSchedulerWritePath(t *testing.T) {
	url := os.Getenv("FUDCOURT_TEST_PG_URL")
	if url == "" {
		t.Skip("set FUDCOURT_TEST_PG_URL to run the live Postgres round-trip")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	store := newPGScheduleStore(pool)

	// A guild id that is not any real guild, so the test cannot touch live rows. The cleanup
	// is a direct delete on purpose: `replace` must NOT remove the feeds' poll, which is one
	// of the things under test.
	const guild = "999000000000000009"
	cleanup := func() { _, _ = pool.Exec(ctx, `DELETE FROM scheduled_jobs WHERE guild_id = $1`, guild) }
	cleanup()
	defer cleanup()

	// The feeds panel's row, written the way its own transaction writes it.
	var pollAt time.Time
	if err := pool.QueryRow(ctx, `
		INSERT INTO scheduled_jobs (guild_id, name, job_kind, schedule_kind, schedule_expr, timezone, payload, next_run_at)
		VALUES ($1, 'news', 'feed.poll', 'interval', '900', 'UTC', jsonb_build_object('source_id', 1), now())
		RETURNING next_run_at`, guild).Scan(&pollAt); err != nil {
		t.Fatalf("insert the feeds' poll: %v", err)
	}
	// 1. Saving a definition under the feed's NAME is refused — the hijack the ownership
	//    predicate exists to prevent — and the feed's row is untouched.
	err = store.replace(ctx, guild, []scheduleDefinition{{
		Name: "news", JobKind: "discord.message", ScheduleKind: "cron",
		ScheduleExpr: "0 9 * * *", Timezone: "Asia/Jakarta", Enabled: true,
	}})
	var foreign *foreignScheduleError
	if !errors.As(err, &foreign) {
		t.Fatalf("replace over a feed's name: err = %v, want *foreignScheduleError", err)
	}
	if foreign.Owner != ownerFeeds || foreign.Name != "news" {
		t.Fatalf("refusal = %+v", foreign)
	}
	rows, err := store.list(ctx, guild)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("the feed's row alone should remain, got %+v", rows)
	}
	if rows[0].JobKind != feedPollKind || rows[0].Owner != ownerFeeds || rows[0].ScheduleExpr != "900" {
		t.Fatalf("the feed's poll was rewritten: %+v", rows[0])
	}
	if rows[0].NextRunAt == nil || !rows[0].NextRunAt.Equal(pollAt) {
		t.Fatalf("the feed's next run moved: %v → %v", pollAt, rows[0].NextRunAt)
	}

	// 1b. A refused save writes NOTHING. The collision is on the SECOND definition, after a
	//     valid one has already been upserted inside the same transaction, so this is a real
	//     test of the rollback rather than of an empty transaction.
	err = store.replace(ctx, guild, []scheduleDefinition{
		{Name: "standup", JobKind: "health.ping",
			ScheduleKind: "interval", ScheduleExpr: "600", Timezone: "UTC", Enabled: true},
		{Name: "news", JobKind: "discord.message",
			ScheduleKind: "cron", ScheduleExpr: "0 9 * * *", Timezone: "UTC", Enabled: true},
	})
	if !errors.As(err, &foreign) {
		t.Fatalf("collision on the second definition: err = %v, want *foreignScheduleError", err)
	}
	rows, err = store.list(ctx, guild)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 || rows[0].Name != "news" {
		t.Fatalf("a refused save must be atomic, got %+v", rows)
	}

	// 2. This panel's own definitions, one per anchor the panel computes.
	once := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Second)
	before := time.Now().UTC()
	defs := []scheduleDefinition{
		{
			Name: "standup", JobKind: "discord.message", ScheduleKind: "cron",
			ScheduleExpr: "0 9 * * *", Timezone: "Asia/Jakarta", Enabled: true,
			Payload: map[string]any{"channel_id": "1234567890123456789", "content": "standup"},
		},
		{
			Name: "heartbeat", JobKind: "health.ping", ScheduleKind: "interval",
			ScheduleExpr: "600", Timezone: "UTC", Enabled: true,
		},
		{
			Name: "reminder", JobKind: "discord.message", ScheduleKind: "once",
			ScheduleExpr: once.Format(time.RFC3339), Timezone: "UTC", Enabled: true,
			Payload: map[string]any{"channel_id": "1234567890123456789", "content": "reminder"},
		},
	}
	if err := store.replace(ctx, guild, defs); err != nil {
		t.Fatalf("replace: %v", err)
	}
	byName := func() map[string]scheduleDefinition {
		got, err := store.list(ctx, guild)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		out := make(map[string]scheduleDefinition, len(got))
		for _, d := range got {
			out[d.Name] = d
		}
		return out
	}
	rows, err = store.list(ctx, guild)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("want 3 of ours + the feed's poll, got %d: %+v", len(rows), rows)
	}
	if rows[0].Owner != ownerScheduler {
		t.Fatalf("this panel's own rows must sort first, got %+v", rows[0])
	}
	// A cron is stored UNANCHORED: this server has no cron parser, and the tick anchors it
	// with the parser it will use forever after.
	m := byName()
	if got := m["standup"].NextRunAt; got != nil {
		t.Fatalf("a cron must be stored with no anchor, got %v", got)
	}
	// An interval is anchored one interval AHEAD — deliberately not immediately, which is
	// what the feeds path writes because a feed wants its first poll now.
	if got := m["heartbeat"].NextRunAt; got == nil ||
		got.Before(before.Add(9*time.Minute)) || got.After(before.Add(11*time.Minute)) {
		t.Fatalf("interval anchor = %v, want ~10 minutes after %v", got, before)
	}
	// A once is anchored at its own instant.
	if got := m["reminder"].NextRunAt; got == nil || !got.Equal(once) {
		t.Fatalf("once anchor = %v, want %v", got, once)
	}
	// The payload round-trips through jsonb, and an absent payload is `{}` rather than NULL
	// (the column is NOT NULL, and the worker reads the field as an object).
	if got := m["standup"].Payload["content"]; got != "standup" {
		t.Fatalf("payload did not round-trip: %+v", m["standup"].Payload)
	}
	if got := m["heartbeat"].Payload; len(got) != 0 {
		t.Fatalf("an absent payload must be {}, got %+v", got)
	}

	// 3. Editing only the payload leaves the rhythm alone — the stored anchor was computed for
	//    this schedule, and re-anchoring on every save would reset the cadence — while editing
	//    the SCHEDULE re-anchors it.
	heartbeatAt := *byName()["heartbeat"].NextRunAt
	defs[0].Payload = map[string]any{"channel_id": "1234567890123456789", "content": "standup!"}
	defs[1].Payload = map[string]any{"note": "edited"}
	defs[2].ScheduleExpr = time.Now().UTC().Add(3 * time.Hour).Truncate(time.Second).Format(time.RFC3339)
	wantReminder, err := time.Parse(time.RFC3339, defs[2].ScheduleExpr)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.replace(ctx, guild, defs); err != nil {
		t.Fatalf("replace (edit): %v", err)
	}
	if got := byName()["heartbeat"].NextRunAt; got == nil || !got.Equal(heartbeatAt) {
		t.Fatalf("an unchanged schedule must keep its anchor: %v → %v", heartbeatAt, got)
	}
	if got := byName()["reminder"].NextRunAt; got == nil || !got.Equal(wantReminder) {
		t.Fatalf("a changed schedule must re-anchor: %v, want %v", got, wantReminder)
	}
	if got := byName()["standup"].Payload["content"]; got != "standup!" {
		t.Fatalf("the edit did not land: %+v", byName()["standup"].Payload)
	}

	// 4. A save that drops a definition deletes OURS and leaves the feed's poll standing.
	if err := store.replace(ctx, guild, defs[:1]); err != nil {
		t.Fatalf("replace (shrink): %v", err)
	}
	rows, err = store.list(ctx, guild)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 || rows[0].Name != "standup" || rows[1].Name != "news" {
		t.Fatalf("want standup + the feed's poll, got %+v", rows)
	}

	// 5. An empty list clears this panel's rows and only those.
	if err := store.replace(ctx, guild, nil); err != nil {
		t.Fatalf("replace (clear): %v", err)
	}
	rows, err = store.list(ctx, guild)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 || rows[0].Owner != ownerFeeds {
		t.Fatalf("an empty save must clear only this panel's rows, got %+v", rows)
	}
}
