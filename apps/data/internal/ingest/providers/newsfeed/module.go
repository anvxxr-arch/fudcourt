package newsfeed

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// providerName is the data.job provider column value. The SOURCE is the job's
// Subject (a registry slug), so one provider row covers the whole registry and
// each source still owns an independent job, schedule, cursor and health.
const providerName = "newsfeed"

// datasetFeed is the single dataset: every source shares one fetch/parse path.
const datasetFeed = "feed"

// maxAdaptiveDelay caps the adaptive back-off a not-modified feed may ask for.
const maxAdaptiveDelay = 30 * time.Minute

// fetcher is the one dataset implementation: it resolves the job's Subject to
// a registry row and runs that feed.
type fetcher struct {
	dataset string
	client  *client
}

// Dataset reports the dataset name (the registry key the engine and the manual
// run surface resolve).
func (f *fetcher) Dataset() string { return f.dataset }

// Fetch runs ONE synchronous attempt (the engine owns retries, the limiter and
// the breaker). Errors are typed: a HardError is terminal for the attempt
// (shape/restriction), a transport failure is soft and the engine's exponential
// backoff applies.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	feed, ok := Lookup(job.Subject)
	if !ok {
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "unknown source " + job.Subject}
	}
	if feed.Status != StatusActive {
		// A job for a restricted / credential-pending source must fail loudly
		// with the measured reason, not silently collect nothing.
		return ingest.FetchResult{}, &HardError{
			Kind:   string(feed.Status),
			Detail: feed.Slug + " is " + string(feed.Status) + ": " + feed.StatusDetail,
		}
	}

	prev := validatorsFrom(job.Cursor)
	body, meta, err := f.client.fetch(ctx, feed, prev)
	if err != nil {
		return ingest.FetchResult{}, err
	}

	// The next cursor starts as the previous one (so keys like the last
	// published moment survive a 304) and is then overwritten with what this
	// exchange learned. It stays bounded by construction.
	next := ingest.Cursor{}
	for k, v := range job.Cursor {
		next[k] = v
	}
	if meta.ETag != "" {
		next["etag"] = meta.ETag
	}
	if meta.LastModified != "" {
		next["last_modified"] = meta.LastModified
	}

	if meta.NotModified {
		// Steady state: the publisher's copy has not moved. Nothing is parsed,
		// nothing is written, and the feed is polled less often until it moves
		// again (bounded adaptive back-off).
		hint := feed.Schedule * 2
		if hint > maxAdaptiveDelay {
			hint = maxAdaptiveDelay
		}
		if hint > 0 {
			return ingest.FetchResult{Next: next, NextRunHint: &hint}, nil
		}
		return ingest.FetchResult{Next: next}, nil
	}

	_, items, err := ParseFeed(body, feed.Format)
	if err != nil {
		return ingest.FetchResult{}, err
	}

	now := time.Now().UTC()
	articles := make([]canon.Article, 0, len(items))
	seenURL := make(map[string]bool, len(items))
	seenHash := make(map[string]bool, len(items))
	rejected := 0
	var newest time.Time
	var latestItem *Item
	for i := range items {
		it := items[i]
		article, units, ok := articleFromItem(feed, it, now)
		if !ok {
			rejected++
			continue
		}
		// In-batch dedup (Level 1 by URL, Level 3 by content hash): one fetch
		// may carry the same story twice, and a feed republishing its own
		// syndicated copy is exactly how that happens.
		if seenURL[units.URL] || seenHash[units.Hash] {
			rejected++
			continue
		}
		seenURL[units.URL] = true
		seenHash[units.Hash] = true
		articles = append(articles, article)
		if article.PublishedAt != nil && article.PublishedAt.After(newest) {
			newest = *article.PublishedAt
			latestItem = &items[i]
		}
	}

	written := 0
	if len(articles) > 0 {
		// writeRejected counts rows the store's own validation refused; they
		// are rejected, never dropped silently, and never counted as written.
		var writeRejected int
		var werr error
		written, writeRejected, werr = w.WriteArticles(ctx, articles)
		rejected += writeRejected
		if werr != nil {
			return ingest.FetchResult{RowsIn: len(items), RowsRejected: rejected}, werr
		}
	}

	next["fetched_at"] = now.Format(time.RFC3339)
	next["body_hash"] = bodyHash(body)
	next["items_in"] = len(items)
	if !newest.IsZero() {
		next["last_published_at"] = newest.Format(time.RFC3339)
	}
	if latestItem != nil {
		if id := latestItem.ID; id != "" {
			next["last_external_id"] = id
		}
	}

	return ingest.FetchResult{
		RowsIn:       len(items),
		RowsWritten:  written,
		RowsRejected: rejected,
		Next:         next,
	}, nil
}

// Module is the newsfeed adapter's registration.
type Module struct {
	client *client
}

// NewModule builds the newsfeed module with an optional injected Doer (tests).
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

// Provider is the data.job provider column value.
func (m *Module) Provider() string { return providerName }

// Fetchers returns the one dataset fetcher, keyed by dataset name.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	return map[string]ingest.Fetcher{datasetFeed: &fetcher{dataset: datasetFeed, client: m.client}}
}

// Jobs is the seed registry: exactly one job per ACTIVE feed, carrying the
// feed's own desired cadence and priority. A job whose subject is not in the
// registry (a stale row from an older build) is never seeded; the engine
// leaves it alone rather than collecting a source this build does not know.
func (m *Module) Jobs() []ingest.JobSpec {
	feeds := Enabled()
	specs := make([]ingest.JobSpec, 0, len(feeds))
	for _, f := range feeds {
		specs = append(specs, ingest.JobSpec{
			Provider: providerName,
			Dataset:  datasetFeed,
			Subject:  f.Slug,
			Mode:     "poll",
			Schedule: f.Schedule,
			Priority: f.Priority,
			Enabled:  true,
		})
	}
	return specs
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
