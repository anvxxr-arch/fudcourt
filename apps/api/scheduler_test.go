package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeSchedules is an in-memory scheduleStore: the handler (the admin gate, the store-nil
// refusal, the envelope, the ownership 409) with no database.
type fakeSchedules struct {
	rows  []scheduleDefinition
	calls int
	// replaced is what the handler handed the store, so a test can assert on what the
	// HANDLER owns (trimming, clearing worker-owned columns) rather than on SQL.
	replaced    []scheduleDefinition
	replaceCall int
	// replaceErr stands in for the one refusal only the database can produce: the ownership
	// predicate swallowing a name another panel owns.
	replaceErr error
}

func (f *fakeSchedules) list(ctx context.Context, guildID string) ([]scheduleDefinition, error) {
	f.calls++
	return f.rows, nil
}

func (f *fakeSchedules) replace(ctx context.Context, guildID string, definitions []scheduleDefinition) error {
	f.replaceCall++
	f.replaced = definitions
	return f.replaceErr
}

// validDefinition is the baseline every refusal test starts from, so a case that changes one
// field differs from the happy path in exactly one place.
func validDefinition() map[string]any {
	return map[string]any{
		"name":         "standup",
		"jobKind":      "discord.message",
		"scheduleKind": "cron",
		"scheduleExpr": "0 9 * * *",
		"timezone":     "Asia/Jakarta",
		"enabled":      true,
		"payload":      map[string]any{"channel_id": "1234567890123456789", "content": "standup"},
	}
}

// definitionBody wraps one definition in the request envelope.
func definitionBody(d map[string]any) string {
	body, err := json.Marshal(map[string]any{"definitions": []any{d}})
	if err != nil {
		panic(err)
	}
	return string(body)
}

func schedulesServer(t *testing.T, f *fakeSchedules) *server {
	t.Helper()
	s := newTestServer(t)
	s.schedules = f
	return s
}

// TestOwnershipIsDerivedFromTheJobKind is the whole ownership rule, with no
// database: the row that does not exist yet is exactly the one a panel would
// mis-handle, and `feed.poll` is a string two panels have to agree on.
func TestOwnershipIsDerivedFromTheJobKind(t *testing.T) {
	cases := []struct {
		jobKind  string
		owner    scheduleOwner
		readOnly bool
	}{
		{"feed.poll", ownerFeeds, true},
		{"discord.message", ownerScheduler, false},
		{"", ownerScheduler, false},
		{"feed.polls", ownerScheduler, false}, // a near-miss must NOT be treated as a feed
	}
	for _, tc := range cases {
		got := annotate(scheduleDefinition{JobKind: tc.jobKind})
		if got.Owner != tc.owner || got.ReadOnly != tc.readOnly {
			t.Errorf("job_kind %q: owner=%q readOnly=%v, want owner=%q readOnly=%v",
				tc.jobKind, got.Owner, got.ReadOnly, tc.owner, tc.readOnly)
		}
	}
}

func TestSchedulerPanelIsUnavailableWithoutAStore(t *testing.T) {
	s := newTestServer(t) // s.schedules is nil: no database, nothing to show
	rec := do(t, s, "GET", "/api/admin/scheduler", adminCookie(t), "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "scheduler_unavailable") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSchedulerPanelRefusesALowerTier(t *testing.T) {
	f := &fakeSchedules{}
	s := schedulesServer(t, f)
	rec := do(t, s, "GET", "/api/admin/scheduler", lowerTierCookie(t), "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", rec.Code, rec.Body.String())
	}
	if f.calls != 0 {
		t.Fatal("a refused request must never reach the store")
	}
}

// The write path exists now, so what must still be refused is a method the handler never
// implemented — and it is refused BEFORE the admin gate, so not even an admin can reach it.
func TestSchedulerPanelRefusesAMethodItDoesNotImplement(t *testing.T) {
	f := &fakeSchedules{}
	s := schedulesServer(t, f)
	rec := do(t, s, "DELETE", "/api/admin/scheduler", adminCookie(t), "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405: %s", rec.Code, rec.Body.String())
	}
	if f.calls != 0 || f.replaceCall != 0 {
		t.Fatal("a refused method must not reach the store")
	}
}

func TestSchedulerPanelListsDefinitionsWithTheirHealth(t *testing.T) {
	f := &fakeSchedules{rows: []scheduleDefinition{
		annotate(scheduleDefinition{ID: 1, Name: "nightly", JobKind: "discord.message",
			ScheduleKind: "cron", ScheduleExpr: "0 3 * * *", Timezone: "Europe/Amsterdam", Enabled: true}),
		annotate(scheduleDefinition{ID: 2, Name: "news", JobKind: feedPollKind,
			ScheduleKind: "interval", ScheduleExpr: "900", Timezone: "UTC", Enabled: true}),
	}}
	s := schedulesServer(t, f)
	rec := do(t, s, "GET", "/api/admin/scheduler", adminCookie(t), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		`"definitions"`, `"name":"nightly"`, `"owner":"scheduler"`, `"readOnly":false`,
		`"name":"news"`, `"owner":"feeds"`, `"readOnly":true`, `"timezone":"Europe/Amsterdam"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("body is missing %s: %s", want, body)
		}
	}
}

// TestSchedulerWritesItsOwnDefinitions is the happy path, and it asserts what the HANDLER
// owns: names and expressions are stored trimmed (so "news " and "news" cannot become two
// rows under the `(guild_id, name)` unique constraint) and every worker-owned column is
// cleared, so a hand-made request cannot even appear to set the next occurrence or the
// health. The response is the STORE's list, not the request body: only the database knows
// what the worker has done to these rows.
func TestSchedulerWritesItsOwnDefinitions(t *testing.T) {
	f := &fakeSchedules{rows: []scheduleDefinition{
		annotate(scheduleDefinition{ID: 7, Name: "standup", JobKind: "discord.message",
			ScheduleKind: "cron", ScheduleExpr: "0 9 * * *", Timezone: "Asia/Jakarta", Enabled: true}),
	}}
	s := schedulesServer(t, f)
	d := validDefinition()
	d["name"] = "  standup  "
	d["scheduleExpr"] = " 0 9 * * * "
	// Every worker-owned field, as if a client made them up.
	d["id"] = float64(99)
	d["nextRunAt"] = "2020-01-01T00:00:00Z"
	d["lastRunAt"] = "2020-01-01T00:00:00Z"
	d["lastStatus"] = "ok"
	d["lastError"] = "none"
	d["attempts"] = float64(4)
	d["maxAttempts"] = float64(9)

	rec := do(t, s, "POST", "/api/admin/scheduler", adminCookie(t), definitionBody(d))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if f.replaceCall != 1 {
		t.Fatalf("replace calls = %d, want 1", f.replaceCall)
	}
	got := f.replaced[0]
	if got.Name != "standup" || got.ScheduleExpr != "0 9 * * *" {
		t.Fatalf("stored name/expr = %q/%q, want trimmed", got.Name, got.ScheduleExpr)
	}
	if got.ID != 0 || got.NextRunAt != nil || got.LastRunAt != nil ||
		got.LastStatus != nil || got.LastError != nil || got.Attempts != 0 || got.MaxAttempts != 0 {
		t.Fatalf("worker-owned fields reached the store: %+v", got)
	}
	if !strings.Contains(rec.Body.String(), `"id":7`) {
		t.Fatalf("the response must be the stored rows, got: %s", rec.Body.String())
	}
}

// TestSchedulerRefusesANameTheFeedsPanelOwns covers the refusal only SQL can produce: the
// ownership predicate swallows the row, the store reports it, and the WIRE has to say so. A
// save that quietly did nothing would be indistinguishable from a save.
func TestSchedulerRefusesANameTheFeedsPanelOwns(t *testing.T) {
	f := &fakeSchedules{replaceErr: &foreignScheduleError{Name: "news", Owner: ownerFeeds}}
	s := schedulesServer(t, f)
	rec := do(t, s, "POST", "/api/admin/scheduler", adminCookie(t), definitionBody(validDefinition()))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "news") || !strings.Contains(body, "feeds") {
		t.Fatalf("the refusal must name the definition and its owner: %s", body)
	}
}

// TestSchedulerValidatesBeforeWriting walks the refusals an operator can actually hit, and
// asserts the store is never reached: a refused body must not be half-written, and the
// message has to name the field, because that message is all the operator sees.
func TestSchedulerValidatesBeforeWriting(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(d map[string]any)
		want   string
	}{
		{"empty name", func(d map[string]any) { d["name"] = "   " }, "name must be 1..64"},
		{"control character in name", func(d map[string]any) { d["name"] = "a\nb" }, "control characters"},
		{"feed poll kind", func(d map[string]any) { d["jobKind"] = "feed.poll" }, "belongs to the feeds panel"},
		{"unknown kind", func(d map[string]any) { d["jobKind"] = "shell.exec" }, "jobKind must be one of"},
		{"unknown schedule kind", func(d map[string]any) { d["scheduleKind"] = "hourly" }, "scheduleKind must be one of"},
		{"once in the past", func(d map[string]any) {
			d["scheduleKind"] = "once"
			d["scheduleExpr"] = "2020-01-01T00:00:00Z"
		}, "is in the past"},
		{"once is not a timestamp", func(d map[string]any) {
			d["scheduleKind"] = "once"
			d["scheduleExpr"] = "tomorrow"
		}, "RFC 3339"},
		{"interval is not a number", func(d map[string]any) {
			d["scheduleKind"] = "interval"
			d["scheduleExpr"] = "hourly"
		}, "whole number of seconds"},
		{"interval is a denial of service", func(d map[string]any) {
			d["scheduleKind"] = "interval"
			d["scheduleExpr"] = "5"
		}, "must be 60..604800 seconds"},
		{"cron has four fields", func(d map[string]any) { d["scheduleExpr"] = "0 9 * *" }, "has 4 fields"},
		{"cron month by name", func(d map[string]any) { d["scheduleExpr"] = "0 9 * JAN *" }, "must be numbers"},
		{"cron is not an expression", func(d map[string]any) { d["scheduleExpr"] = "@daily" }, "has 1 fields"},
		{"unknown timezone", func(d map[string]any) { d["timezone"] = "Mars/Olympus" }, "unknown timezone"},
		{"empty timezone", func(d map[string]any) { d["timezone"] = " " }, "IANA zone name"},
		{"no channel", func(d map[string]any) { d["payload"] = map[string]any{"content": "hi"} }, "payload.channel_id"},
		{"channel is not an id", func(d map[string]any) {
			d["payload"] = map[string]any{"channel_id": "#general", "content": "hi"}
		}, "payload.channel_id"},
		{"no content", func(d map[string]any) {
			d["payload"] = map[string]any{"channel_id": "1234567890123456789", "content": "  "}
		}, "payload.content is required"},
		{"content is too long", func(d map[string]any) {
			d["payload"] = map[string]any{"channel_id": "1234567890123456789", "content": strings.Repeat("x", 1901)}
		}, "at most 1900 characters"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := validDefinition()
			tc.mutate(d)
			f := &fakeSchedules{}
			s := schedulesServer(t, f)
			rec := do(t, s, "POST", "/api/admin/scheduler", adminCookie(t), definitionBody(d))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Fatalf("body = %s, want it to contain %q", rec.Body.String(), tc.want)
			}
			if f.replaceCall != 0 {
				t.Fatal("a refused definition must not reach the store")
			}
		})
	}
}

// TestSchedulerRefusesATwoHeadedBody covers the two refusals that are about the LIST rather
// than a definition: the same name twice (which the database would reject as a conflict, so
// the operator would get a 500 for their own typo) and more definitions than a tick will
// materialize.
func TestSchedulerRefusesATwoHeadedBody(t *testing.T) {
	f := &fakeSchedules{}
	s := schedulesServer(t, f)
	dup := `{"definitions":[` +
		`{"name":"standup","jobKind":"health.ping","scheduleKind":"interval","scheduleExpr":"600","timezone":"UTC"},` +
		`{"name":"standup","jobKind":"health.ping","scheduleKind":"interval","scheduleExpr":"900","timezone":"UTC"}]}`
	rec := do(t, s, "POST", "/api/admin/scheduler", adminCookie(t), dup)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "duplicate name") {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	many := make([]map[string]any, 0, maxScheduleDefinitions+1)
	for i := 0; i <= maxScheduleDefinitions; i++ {
		d := validDefinition()
		d["name"] = "daily-" + strconv.Itoa(i)
		many = append(many, d)
	}
	body, err := json.Marshal(map[string]any{"definitions": many})
	if err != nil {
		t.Fatal(err)
	}
	rec = do(t, s, "POST", "/api/admin/scheduler", adminCookie(t), string(body))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "at most 200") {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if f.replaceCall != 0 {
		t.Fatal("a refused list must not reach the store")
	}
}

// TestAnchorForIsWhatThePanelCanCompute pins the boundary between what this panel anchors
// itself and what it deliberately leaves to the worker's parser. A cron MUST come back nil:
// the panel has no cron parser and no DST policy, and a guess here would show the operator a
// "next run" the worker disagrees with — the second source of truth this design refuses.
func TestAnchorForIsWhatThePanelCanCompute(t *testing.T) {
	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)

	once := anchorFor("once", "2026-06-01T14:00:00Z", now)
	if once == nil || !once.Equal(time.Date(2026, 6, 1, 14, 0, 0, 0, time.UTC)) {
		t.Fatalf("once anchor = %v", once)
	}
	iv := anchorFor("interval", "3600", now)
	if iv == nil || !iv.Equal(now.Add(time.Hour)) {
		t.Fatalf("interval anchor = %v, want one interval ahead, not now", iv)
	}
	if cron := anchorFor("cron", "0 9 * * *", now); cron != nil {
		t.Fatalf("a cron must be stored unanchored, got %v", cron)
	}
}
