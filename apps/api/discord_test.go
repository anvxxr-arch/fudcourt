package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/cache"
	"github.com/anvxxr-arch/fudcourt/apps/api/internal/platform/health"
)

// membersPayload is one guild-member list body whose global_name carries
// name: the marker tests read out of the served response to tell WHICH fetch
// produced the answer (v1 = first fetch, v2 = a later one).
func membersPayload(name string) string {
	return `[{"user":{"id":"42","username":"tester","global_name":"` + name + `","avatar":"hash"},"roles":["900"]}]`
}

// membersFake is a hermetic Discord stand-in for the members cache: it counts
// every list attempt (refusals included), serves a mutable payload, and can
// be made to fail. The production discordClient talks to it over HTTP through
// the same code path as discord.com (base URL injection, as fakeDiscord does).
type membersFake struct {
	srv      *httptest.Server
	mu       sync.Mutex
	attempts int
	payload  string
	failing  bool
}

func newMembersFake(t *testing.T) *membersFake {
	t.Helper()
	f := &membersFake{payload: membersPayload("v1")}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v10/guilds/100/members", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.attempts++
		if f.failing {
			f.mu.Unlock()
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		io.WriteString(w, f.payload)
		f.mu.Unlock()
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

// configure swaps what the fake answers: the payload for success, failing
// for a 502 refusal.
func (f *membersFake) configure(payload string, failing bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.payload = payload
	f.failing = failing
}

// tries is the number of upstream attempts seen so far.
func (f *membersFake) tries() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attempts
}

// membersServer wires the real handler stack to the fake. fresh shrinks the
// production membersTTL instead of sleeping it.
func membersServer(t *testing.T, fresh time.Duration) (*server, *membersFake) {
	t.Helper()
	fake := newMembersFake(t)
	dc := newDiscordClient(discordEnv{
		GuildID:   "100",
		BotToken:  "bot",
		RoleTeam:  "800",
		RoleAdmin: "900",
	})
	dc.apiBase = fake.srv.URL + "/api/v10"
	dc.members = cache.New[[]discordMember](fresh)
	return &server{health: health.NewRegistry(), discord: dc, secret: routeTestSecret}, fake
}

// fetchMembers runs one authenticated GET /api/admin/members and returns the
// status and raw body.
func fetchMembers(t *testing.T, srv *server) (int, string) {
	t.Helper()
	rec := do(t, srv, "GET", "/api/admin/members", adminCookie(t), "")
	return rec.Code, rec.Body.String()
}

// waitForTries polls until the fake has seen want upstream attempts — a
// background refresh is asynchronous, so tests observe it rather than assume
// an instant.
func waitForTries(t *testing.T, fake *membersFake, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fake.tries() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("upstream attempts = %d, want >= %d within 2s", fake.tries(), want)
}

// TestAdminMembersListCaching pins the cache contract of the members plane:
// a cold miss fetches upstream exactly once, fresh hits never touch upstream,
// a stale answer is served while one background refresh runs, and an upstream
// failure after a successful fetch degrades to the stale value instead of an
// error. A cold failure must refuse (503) without being cached.
func TestAdminMembersListCaching(t *testing.T) {
	for _, tc := range []struct {
		name  string
		fresh time.Duration
		run   func(t *testing.T, srv *server, fake *membersFake)
	}{
		{
			name:  "cold miss fetches upstream exactly once",
			fresh: time.Minute,
			run: func(t *testing.T, srv *server, fake *membersFake) {
				status, body := fetchMembers(t, srv)
				if status != 200 || !strings.Contains(body, `"globalName":"v1"`) {
					t.Fatalf("cold fetch: status = %d, body = %s", status, body)
				}
				if got := fake.tries(); got != 1 {
					t.Fatalf("upstream attempts after cold fetch = %d, want 1", got)
				}
				status, body = fetchMembers(t, srv)
				if status != 200 || !strings.Contains(body, `"globalName":"v1"`) {
					t.Fatalf("second fetch: status = %d, body = %s", status, body)
				}
				if got := fake.tries(); got != 1 {
					t.Fatalf("upstream attempts after second fetch = %d, want 1 (served from cache)", got)
				}
			},
		},
		{
			name:  "hot hit serves cached without any upstream call",
			fresh: time.Minute,
			run: func(t *testing.T, srv *server, fake *membersFake) {
				if status, _ := fetchMembers(t, srv); status != 200 {
					t.Fatalf("cold fetch status = %d, want 200", status)
				}
				// Upstream now refuses AND carries a different payload: a
				// fresh hit must answer from memory without dialing it.
				fake.configure(membersPayload("v2"), true)
				status, body := fetchMembers(t, srv)
				if status != 200 || !strings.Contains(body, `"globalName":"v1"`) {
					t.Fatalf("hot hit after upstream went dark: status = %d, body = %s", status, body)
				}
				if got := fake.tries(); got != 1 {
					t.Fatalf("upstream attempts = %d, want 1 (a fresh hit must not call upstream)", got)
				}
			},
		},
		{
			name:  "stale serves the old list while one background refresh runs",
			fresh: 50 * time.Millisecond,
			run: func(t *testing.T, srv *server, fake *membersFake) {
				if status, _ := fetchMembers(t, srv); status != 200 {
					t.Fatalf("cold fetch status = %d, want 200", status)
				}
				time.Sleep(4 * 50 * time.Millisecond)
				fake.configure(membersPayload("v2"), false)
				// The stale answer must be v1 — deterministic: the response
				// is built from the value Get returned, which the in-flight
				// refresh cannot change.
				status, body := fetchMembers(t, srv)
				if status != 200 || !strings.Contains(body, `"globalName":"v1"`) {
					t.Fatalf("stale serve: status = %d, body = %s (want stale v1)", status, body)
				}
				waitForTries(t, fake, 2) // the background refresh did hit upstream
				status, body = fetchMembers(t, srv)
				if status != 200 || !strings.Contains(body, `"globalName":"v2"`) {
					t.Fatalf("after refresh: status = %d, body = %s (want refreshed v2)", status, body)
				}
			},
		},
		{
			name:  "upstream failure after a successful fetch serves stale, not an error",
			fresh: 50 * time.Millisecond,
			run: func(t *testing.T, srv *server, fake *membersFake) {
				if status, _ := fetchMembers(t, srv); status != 200 {
					t.Fatalf("cold fetch status = %d, want 200", status)
				}
				time.Sleep(4 * 50 * time.Millisecond)
				fake.configure(membersPayload("v2"), true) // every refresh will fail
				status, body := fetchMembers(t, srv)
				if status != 200 || !strings.Contains(body, `"globalName":"v1"`) {
					t.Fatalf("stale serve during outage: status = %d, body = %s (want stale v1, never 503)", status, body)
				}
				waitForTries(t, fake, 2) // the refresh was attempted and failed
				status, body = fetchMembers(t, srv)
				if status != 200 || !strings.Contains(body, `"globalName":"v1"`) {
					t.Fatalf("after failed refresh: status = %d, body = %s (want stale v1)", status, body)
				}
			},
		},
		{
			name:  "a cold fetch failure is refused and never cached",
			fresh: time.Minute,
			run: func(t *testing.T, srv *server, fake *membersFake) {
				fake.configure(membersPayload("v1"), true)
				status, body := fetchMembers(t, srv)
				if status != 503 || !strings.Contains(body, "discord_unavailable") {
					t.Fatalf("cold failure: status = %d, body = %s (want 503 discord_unavailable)", status, body)
				}
				fake.configure(membersPayload("v1"), false)
				status, body = fetchMembers(t, srv)
				if status != 200 || !strings.Contains(body, `"globalName":"v1"`) {
					t.Fatalf("after healing: status = %d, body = %s (a failed fetch must not be cached)", status, body)
				}
				if got := fake.tries(); got != 2 {
					t.Fatalf("upstream attempts = %d, want 2", got)
				}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, fake := membersServer(t, tc.fresh)
			tc.run(t, srv, fake)
		})
	}
}
