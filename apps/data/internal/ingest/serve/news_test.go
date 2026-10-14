package serve

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
)

// newsRows builds a fake article set with distinct published times so the
// keyset cursor has something to page over.
func newsRows(t *testing.T, n int) []canon.Article {
	t.Helper()
	base := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	out := make([]canon.Article, 0, n)
	for i := range n {
		ts := base.Add(-time.Duration(i) * time.Hour)
		summary := "summary"
		publisher := "The Defiant"
		lang := "en"
		out = append(out, canon.Article{
			ArticleID:   "article/newsfeed/" + string(rune('a'+i)),
			Headline:    "Headline " + string(rune('a'+i)),
			Summary:     &summary,
			URL:         "https://example.com/" + string(rune('a'+i)),
			Publisher:   &publisher,
			PublishedAt: &ts,
			Language:    &lang,
			Topics:      []string{"markets"},
			Assets:      []string{"BTC"},
			Source:      "newsfeed",
			RetrievedAt: base,
		})
	}
	return out
}

// TestNewsLinkHeaderIsAbsolutePath is the regression for the cursor bug: the
// handler used to copy r.URL, which ServeHTTP had already stripped to "/news",
// so the Link header advertised a bare "/news?…" that a client resolving it
// from the public surface followed to /api/news — the research relay, a
// different document. The path must be absolute and point at this endpoint.
func TestNewsLinkHeaderIsAbsolutePath(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.articles = newsRows(t, 3)

	rec, body := get(t, h, "/api/data/news?limit=2")
	if rec.Code != 200 {
		t.Fatalf("code = %d, body %s", rec.Code, rec.Body.String())
	}
	items, _ := body["data"].([]any)
	if len(items) != 2 {
		t.Fatalf("rows = %d, want 2", len(items))
	}
	link := rec.Header().Get("Link")
	if link == "" {
		t.Fatal("full page must advertise a next cursor")
	}
	if !strings.HasPrefix(link, "</api/data/news?") {
		t.Fatalf("Link must be absolute on this endpoint, got %q", link)
	}
	if strings.Contains(link, "<news?") || strings.Contains(link, "</news?") {
		t.Fatalf("Link must not be the stripped relative path, got %q", link)
	}
	if !strings.Contains(link, "before=") {
		t.Fatalf("Link must carry the cursor: %q", link)
	}
	if !strings.Contains(link, `rel="next"`) {
		t.Fatalf("Link must declare rel=next: %q", link)
	}
}

// TestNewsLinkPreservesFilters proves the cursor keeps narrowing: a paged
// request must not silently widen back to the unfiltered feed.
func TestNewsLinkPreservesFilters(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.articles = newsRows(t, 4)
	rec, _ := get(t, h, "/api/data/news?limit=2&asset=BTC&category=markets&source=The%20Defiant")
	link := rec.Header().Get("Link")
	for _, want := range []string{"asset=BTC", "category=markets", "source=The+Defiant"} {
		if !strings.Contains(link, want) {
			t.Fatalf("Link dropped %q: %q", want, link)
		}
	}
}

// TestNewsShortPageOmitsLink: fewer rows than the limit means there is no next
// page, so advertising one would be a lie.
func TestNewsShortPageOmitsLink(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.articles = newsRows(t, 2)
	rec, _ := get(t, h, "/api/data/news?limit=10")
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	if link := rec.Header().Get("Link"); link != "" {
		t.Fatalf("short page must not advertise a cursor, got %q", link)
	}
}

func TestNewsFilters(t *testing.T) {
	h, r, _ := newTestServer(t)
	rows := newsRows(t, 3)
	other := "Cointelegraph"
	rows[1].Publisher = &other
	rows[2].Assets = []string{"ETH"}
	r.articles = rows

	cases := []struct {
		name  string
		query string
		want  int
	}{
		{"no filter", "?limit=10", 3},
		{"by outlet", "?limit=10&source=Cointelegraph", 1},
		{"by family", "?limit=10&source=newsfeed", 3},
		{"by asset", "?limit=10&asset=ETH", 1},
		{"by category", "?limit=10&category=markets", 3},
		{"unknown outlet is empty, not 400", "?limit=10&source=Nope", 0},
		{"unknown asset is empty", "?limit=10&asset=DOGE", 0},
		{"search", "?limit=10&search=headline", 3},
		{"search miss", "?limit=10&search=zzz", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec, body := get(t, h, "/api/data/news"+c.query)
			if rec.Code != 200 {
				t.Fatalf("code = %d, body %s", rec.Code, rec.Body.String())
			}
			items, _ := body["data"].([]any)
			if len(items) != c.want {
				t.Fatalf("rows = %d, want %d", len(items), c.want)
			}
		})
	}
}

func TestNewsCursorPagesWithoutOverlap(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.articles = newsRows(t, 4)

	rec, body := get(t, h, "/api/data/news?limit=2")
	first, _ := body["data"].([]any)
	if len(first) != 2 {
		t.Fatalf("page 1 rows = %d", len(first))
	}
	link := rec.Header().Get("Link")
	// Extract the absolute path out of <...>.
	start := strings.Index(link, "<") + 1
	end := strings.Index(link, ">")
	next := link[start:end]

	rec2, body2 := get(t, h, next)
	if rec2.Code != 200 {
		t.Fatalf("page 2 code = %d, body %s", rec2.Code, rec2.Body.String())
	}
	second, _ := body2["data"].([]any)
	if len(second) != 2 {
		t.Fatalf("page 2 rows = %d, want 2", len(second))
	}
	seen := map[string]bool{}
	for _, it := range append(append([]any{}, first...), second...) {
		m := it.(map[string]any)
		id, _ := m["article_id"].(string)
		if seen[id] {
			t.Fatalf("row %s appeared on both pages", id)
		}
		seen[id] = true
	}
}

func TestNewsBadParams(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.articles = newsRows(t, 2)
	for _, bad := range []string{
		"?limit=0", "?limit=-1", "?limit=abc",
		"?before=not-a-date", "?before=2026-13-45",
	} {
		rec, _ := get(t, h, "/api/data/news"+bad)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: code = %d, want 400", bad, rec.Code)
		}
	}
}

func TestNewsLimitClamped(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.articles = newsRows(t, 3)
	rec, body := get(t, h, "/api/data/news?limit=100000")
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	items, _ := body["data"].([]any)
	if len(items) != 3 {
		t.Fatalf("rows = %d, want 3 (clamp is an upper bound, not a pad)", len(items))
	}
}

// TestNewsStoreOutageIs503: a store failure must fail loudly, never serve an
// empty list that reads like "no news".
func TestNewsStoreOutageIs503(t *testing.T) {
	h, r, _ := newTestServer(t)
	r.err = errors.New("store unavailable")
	rec, _ := get(t, h, "/api/data/news?limit=2")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", rec.Code)
	}
}

func TestNewsMethodNotAllowed(t *testing.T) {
	h, _, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/data/news", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("code = %d, want 405", rec.Code)
	}
}
