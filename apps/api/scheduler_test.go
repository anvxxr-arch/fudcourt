package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// fakeSchedules is an in-memory scheduleStore: the handler (the admin gate, the
// store-nil refusal, the envelope) with no database.
type fakeSchedules struct {
	rows  []scheduleDefinition
	calls int
}

func (f *fakeSchedules) list(ctx context.Context, guildID string) ([]scheduleDefinition, error) {
	f.calls++
	return f.rows, nil
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

func TestSchedulerPanelIsReadOnly(t *testing.T) {
	f := &fakeSchedules{}
	s := schedulesServer(t, f)
	// The write path does not exist yet, and must not be reachable by accident:
	// a method the handler does not implement is refused BEFORE the admin gate,
	// so even an admin cannot write here today.
	rec := do(t, s, "POST", "/api/admin/scheduler", adminCookie(t), `{"definitions":[]}`)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405: %s", rec.Code, rec.Body.String())
	}
	if f.calls != 0 {
		t.Fatal("a write must not reach the store")
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
