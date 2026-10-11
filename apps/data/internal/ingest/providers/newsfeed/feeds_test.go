package newsfeed

import (
	"net/url"
	"strings"
	"testing"
)

// The registry's own invariants. These run in CI with no network: they prove
// the registry is well-formed, not that the sources are reachable (that is what
// a live smoke test is for, and it is never a substitute for these).
func TestRegistryInvariants(t *testing.T) {
	seen := map[string]bool{}
	for _, f := range Feeds {
		if f.Slug == "" || seen[f.Slug] {
			t.Fatalf("duplicate or empty slug %q", f.Slug)
		}
		seen[f.Slug] = true
		if f.Slug != strings.ToLower(f.Slug) {
			t.Errorf("%s: slug must be lowercase", f.Slug)
		}
		if f.Label == "" || f.Homepage == "" || f.Language == "" || f.Category == "" {
			t.Errorf("%s: label/homepage/language/category are required", f.Slug)
		}
		u, err := url.Parse(f.URL)
		if err != nil {
			t.Errorf("%s: unparsable url %q", f.Slug, f.URL)
			continue
		}
		if u.Scheme != "https" {
			t.Errorf("%s: feed url must be https, got %q", f.Slug, f.URL)
		}
		switch f.Format {
		case FormatRSS, FormatAtom, FormatJSONFeed:
		default:
			t.Errorf("%s: unknown format %q", f.Slug, f.Format)
		}
		if f.Reliability < 1 || f.Reliability > 5 {
			t.Errorf("%s: reliability %d out of 1..5", f.Slug, f.Reliability)
		}
		if f.Status == StatusActive {
			if f.Schedule <= 0 {
				t.Errorf("%s: an active feed needs a positive schedule", f.Slug)
			}
			if f.Priority < 1 || f.Priority > 9 {
				t.Errorf("%s: priority %d out of 1..9", f.Slug, f.Priority)
			}
			if f.StatusDetail != "" {
				t.Errorf("%s: an active feed carries no status detail", f.Slug)
			}
			continue
		}
		// Every non-active row must say WHY, and must not claim a cadence.
		if strings.TrimSpace(f.StatusDetail) == "" {
			t.Errorf("%s: non-active row without a reason", f.Slug)
		}
		if f.Schedule != 0 {
			t.Errorf("%s: a non-active feed must not carry a schedule", f.Slug)
		}
	}
}

func TestLookupAndEnabled(t *testing.T) {
	f, ok := Lookup("cointelegraph")
	if !ok || f.Format != FormatRSS {
		t.Fatalf("lookup = %+v, %v", f, ok)
	}
	if _, ok := Lookup("nope"); ok {
		t.Fatal("lookup must not invent a source")
	}
	for _, f := range Enabled() {
		if f.Status != StatusActive {
			t.Fatalf("%s is not active but is enabled", f.Slug)
		}
	}
	// The restricted row is registered AND excluded - both matter.
	if _, ok := Lookup("cryptoslate"); !ok {
		t.Fatal("a restricted source must stay registered so the wall is visible")
	}
}

func TestSourceRowsProjectTheRegistry(t *testing.T) {
	rows := SourceRows()
	if len(rows) != len(Feeds) {
		t.Fatalf("rows = %d, registry = %d", len(rows), len(Feeds))
	}
	for _, r := range rows {
		if r.Slug == "" || r.FeedURL == "" || r.Status == "" || r.FeedFormat == "" {
			t.Fatalf("incomplete projection row: %+v", r)
		}
		if r.Enabled != (r.Status == string(StatusActive)) {
			t.Errorf("%s: enabled=%v status=%s", r.Slug, r.Enabled, r.Status)
		}
		if r.Enabled && r.PollSeconds <= 0 {
			t.Errorf("%s: an enabled source needs a poll cadence", r.Slug)
		}
	}
}

func TestCountsMatchRegistry(t *testing.T) {
	total := 0
	for _, n := range Counts() {
		total += n
	}
	if total != len(Feeds) {
		t.Fatalf("counts total %d != registry %d", total, len(Feeds))
	}
	if Counts()[StatusActive] == 0 {
		t.Fatal("no active feeds in the registry")
	}
}
