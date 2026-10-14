package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/api/internal/access/identity"
)

// fakeFeeds is an in-memory feedStore: it exercises the handler (the admin gate,
// the store-nil refusal, validation, the envelope, and the worker-column strip)
// with no database.
type fakeFeeds struct {
	rows    []feedSource
	written int
}

func (f *fakeFeeds) list(ctx context.Context, guildID string) ([]feedSource, error) {
	return f.rows, nil
}

func (f *fakeFeeds) replace(ctx context.Context, guildID string, sources []feedSource) error {
	f.written++
	f.rows = sources
	return nil
}

func feedsServer(t *testing.T, f *fakeFeeds) *server {
	t.Helper()
	s := newTestServer(t)
	s.feeds = f
	return s
}

// A feed that passes every rule, for the tests that are not about validation.
const goodFeed = `{"feeds":[{"name":"news","url":"https://example.com/feed.xml",` +
	`"channelId":"100000000000000010","message":"{title}","adapter":"auto",` +
	`"pollIntervalSecs":900,"enabled":true}]}`

// lowerTierCookie is a valid session that simply is not an admin.
func lowerTierCookie(t *testing.T) string {
	t.Helper()
	token, err := identity.CreateSessionToken(routeTestSecret, identity.SessionClaims{
		ID: "2", Username: "member", Tier: identity.TierMember, Roles: []string{},
	}, identity.SessionMaxAge, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return identity.SessionCookieName + "=" + token
}

func TestFeedsPanelIsUnavailableWithoutAStore(t *testing.T) {
	s := newTestServer(t) // s.feeds is nil: no database, nothing to show
	rec := do(t, s, "GET", "/api/admin/feeds", adminCookie(t), "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "feeds_unavailable") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestFeedsPanelRefusesALowerTier(t *testing.T) {
	f := &fakeFeeds{}
	s := feedsServer(t, f)
	for _, method := range []string{"GET", "POST"} {
		rec := do(t, s, method, "/api/admin/feeds", lowerTierCookie(t), goodFeed)
		// 401, not 403: this API answers an insufficient tier as unauthorized
		// (see requireAdmin), and the panel follows the house rule.
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want 401: %s", method, rec.Code, rec.Body.String())
		}
	}
	if f.written != 0 {
		t.Fatal("a refused request must never reach the store")
	}
}

func TestFeedsPanelRoundTrip(t *testing.T) {
	f := &fakeFeeds{}
	s := feedsServer(t, f)

	rec := do(t, s, "GET", "/api/admin/feeds", adminCookie(t), "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"feeds"`) {
		t.Fatalf("GET = %d %s", rec.Code, rec.Body.String())
	}

	rec = do(t, s, "POST", "/api/admin/feeds", adminCookie(t), goodFeed)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST = %d %s", rec.Code, rec.Body.String())
	}
	if f.written != 1 || len(f.rows) != 1 || f.rows[0].Name != "news" {
		t.Fatalf("store saw %d writes with rows %+v", f.written, f.rows)
	}
	if !strings.Contains(rec.Body.String(), `"name":"news"`) {
		t.Fatalf("the answer must be the stored row: %s", rec.Body.String())
	}
}

func TestFeedsPanelRefusesBadInput(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"loopback literal", `{"feeds":[{"name":"a","url":"http://127.0.0.1/feed","channelId":"100000000000000010","pollIntervalSecs":900}]}`, "private address"},
		{"single label", `{"feeds":[{"name":"a","url":"http://intranet/feed","channelId":"100000000000000010","pollIntervalSecs":900}]}`, "fully-qualified"},
		{"credentials", `{"feeds":[{"name":"a","url":"https://u:p@example.com/feed","channelId":"100000000000000010","pollIntervalSecs":900}]}`, "credentials"},
		{"odd port", `{"feeds":[{"name":"a","url":"http://example.com:9200/feed","channelId":"100000000000000010","pollIntervalSecs":900}]}`, "default port"},
		{"scheme", `{"feeds":[{"name":"a","url":"file:///etc/passwd","channelId":"100000000000000010","pollIntervalSecs":900}]}`, "http or https"},
		{"adapter", `{"feeds":[{"name":"a","url":"https://example.com/f","adapter":"lua","channelId":"100000000000000010","pollIntervalSecs":900}]}`, "adapter"},
		{"channel", `{"feeds":[{"name":"a","url":"https://example.com/f","channelId":"#general","pollIntervalSecs":900}]}`, "channelId"},
		{"cadence too fast", `{"feeds":[{"name":"a","url":"https://example.com/f","channelId":"100000000000000010","pollIntervalSecs":30}]}`, "pollIntervalSecs"},
		{"duplicate names", `{"feeds":[{"name":"a","url":"https://example.com/f","channelId":"100000000000000010","pollIntervalSecs":900},{"name":"a","url":"https://example.com/g","channelId":"100000000000000010","pollIntervalSecs":900}]}`, "duplicate"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeFeeds{}
			s := feedsServer(t, f)
			rec := do(t, s, "POST", "/api/admin/feeds", adminCookie(t), tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Fatalf("body = %s, want it to mention %q", rec.Body.String(), tc.want)
			}
			if f.written != 0 {
				t.Fatal("a refused feed must never reach the store")
			}
		})
	}
}

func TestFeedsPanelStripsTheWorkerColumns(t *testing.T) {
	f := &fakeFeeds{}
	s := feedsServer(t, f)
	body := `{"feeds":[{"id":99,"name":"news","url":"https://example.com/feed.xml",` +
		`"channelId":"100000000000000010","pollIntervalSecs":900,"primed":true,` +
		`"owed":123,"consecutiveFailures":7,"lastError":"forged","lastStatus":"ok"}]}`
	rec := do(t, s, "POST", "/api/admin/feeds", adminCookie(t), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST = %d %s", rec.Code, rec.Body.String())
	}
	got := f.rows[0]
	if got.ID != 0 || got.Primed || got.Owed != 0 || got.ConsecutiveFailures != 0 ||
		got.LastError != nil || got.LastStatus != nil {
		t.Fatalf("the worker's columns were accepted from the body: %+v", got)
	}
}
