//go:build live

// Live smoke test: it dials the real publishers, so it is kept out of the
// default (deterministic, offline) test run behind the "live" build tag.
//
//	go test -tags live -run TestLiveFeeds -v ./apps/data/internal/ingest/providers/newsfeed/
//
// It makes exactly one request per active source, sequentially, at the source's
// declared cadence-independent politeness: no concurrency, no retries, no
// crawl. A source that refuses us is reported refused, never worked around.
package newsfeed

import (
	"context"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

func TestLiveFeeds(t *testing.T) {
	if testing.Short() {
		t.Skip("live")
	}
	m := NewModule(nil)
	f, ok := m.Fetchers()[datasetFeed].(*fetcher)
	if !ok {
		t.Fatal("no feed fetcher")
	}

	var reachable, refused, empty int
	total := 0
	for _, feed := range Feeds {
		if feed.Status != StatusActive {
			t.Logf("  -- %-14s SKIP (%s: %s)", feed.Slug, feed.Status, feed.StatusDetail)
			continue
		}
		rec := &recWriter{}
		job := ingest.Job{Provider: providerName, Dataset: datasetFeed, Subject: feed.Slug}
		started := time.Now()
		res, err := f.Fetch(context.Background(), job, rec)
		took := time.Since(started).Round(time.Millisecond)
		switch {
		case err != nil:
			refused++
			t.Logf("  !! %-14s FAILED in %s: %v", feed.Slug, took, err)
		case res.RowsIn == 0:
			empty++
			reachable++
			t.Logf("  .. %-14s 0 items in %s (feed answered, nothing published)", feed.Slug, took)
		default:
			reachable++
			total += res.RowsWritten
			first := rec.arts[0]
			t.Logf("  ok %-14s %2d items -> %2d articles in %s | %q | %s | tags=%v",
				feed.Slug, res.RowsIn, res.RowsWritten, took, clip(first.Headline, 58),
				first.URL, first.Topics)
		}
	}
	t.Logf("reachable=%d refused=%d empty=%d articles=%d", reachable, refused, empty, total)
	if reachable == 0 {
		t.Fatal("not one source answered: this is an environment failure, not a source failure")
	}
	slog.Debug("live", "articles", total)
}

func clip(s string, n int) string {
	if len([]rune(s)) <= n {
		return s
	}
	return fmt.Sprintf("%s...", string([]rune(s)[:n]))
}

var _ = canon.Article{}
