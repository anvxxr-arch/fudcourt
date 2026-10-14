package newsfeed

import (
	"context"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fetcher serves ONE source (one dataset). It owns no scheduling: the engine
// gates dispatch through the per-provider rate limiter and circuit breaker,
// and owns retry/backoff. Fetch is one synchronous attempt.
type fetcher struct {
	src    Source
	client *client
}

func (f *fetcher) Dataset() string { return f.src.ID }

// Fetch performs one attempt for one dataset:
//
//	fetch (conditional) -> parse -> normalize -> WriteArticles
//
// A 304 short-circuits to zero rows (nothing changed). A recognised feed
// with zero items is a successful empty run, not an error. An unrecognised
// document root is a loud shape error: the endpoint stopped being a feed.
// RowsRejected comes from the writer's own count, never an invented number.
func (f *fetcher) Fetch(ctx context.Context, job ingest.Job, w canon.Writer) (ingest.FetchResult, error) {
	if w == nil {
		return ingest.FetchResult{}, &HardError{Kind: "shape", Detail: "no writer supplied to fetcher"}
	}
	if f.src.FeedURL == "" || f.src.Status != StatusWorking {
		return ingest.FetchResult{}, &HardError{
			Kind:   "no-credentials",
			URL:    f.src.FeedURL,
			Detail: "source " + f.src.ID + " is not dispatchable: " + f.src.BlockReason,
		}
	}
	cond := condHeaders{}
	if job.Cursor != nil {
		cond.ETag, _ = job.Cursor["etag"].(string)
		cond.LastModified, _ = job.Cursor["last_modified"].(string)
	}

	body, etag, lastMod, _, notModified, err := f.client.getBytes(ctx, f.src.FeedURL, cond)
	if err != nil {
		return ingest.FetchResult{}, err
	}
	if notModified {
		return ingest.FetchResult{Next: carryCursor(job.Cursor, etag, lastMod, time.Time{}, "")}, nil
	}

	items, kind, err := parseFeed(body)
	if err != nil {
		return ingest.FetchResult{}, &HardError{Kind: "shape", URL: f.src.FeedURL, Detail: err.Error()}
	}
	if kind == "" {
		return ingest.FetchResult{}, &HardError{
			Kind:   "shape",
			URL:    f.src.FeedURL,
			Detail: "document root is not rss or feed; body is not a recognized feed",
		}
	}
	if f.src.MaxItems > 0 && len(items) > f.src.MaxItems {
		items = items[:f.src.MaxItems]
	}

	now := time.Now().UTC()
	rows := make([]canon.Article, 0, len(items))
	var newest time.Time
	var newestID string
	for _, it := range items {
		a := toArticle(it, f.src, now)
		if a.PublishedAt != nil && a.PublishedAt.After(newest) {
			newest = *a.PublishedAt
			newestID = a.ArticleID
		}
		rows = append(rows, a)
	}

	written, rejected, err := w.WriteArticles(ctx, rows)
	if err != nil {
		return ingest.FetchResult{}, err
	}
	return ingest.FetchResult{
		RowsIn:       len(rows),
		RowsWritten:  written,
		RowsRejected: rejected,
		Next:         carryCursor(job.Cursor, etag, lastMod, newest, newestID),
	}, nil
}

// carryCursor builds the next cursor from the conditional-request state and
// the newest published row. A cursor that carries only etag/last-modified
// still lets the next attempt short-circuit on a 304.
func carryCursor(prev ingest.Cursor, etag, lastMod string, newest time.Time, newestID string) ingest.Cursor {
	next := ingest.Cursor{}
	if etag != "" {
		next["etag"] = etag
	} else if prev != nil {
		if v, ok := prev["etag"].(string); ok {
			next["etag"] = v
		}
	}
	if lastMod != "" {
		next["last_modified"] = lastMod
	} else if prev != nil {
		if v, ok := prev["last_modified"].(string); ok {
			next["last_modified"] = v
		}
	}
	if !newest.IsZero() {
		next["last_published_at"] = newest.UTC().Format(time.RFC3339)
		next["last_id"] = newestID
	} else if prev != nil {
		if v, ok := prev["last_published_at"].(string); ok {
			next["last_published_at"] = v
		}
		if v, ok := prev["last_id"].(string); ok {
			next["last_id"] = v
		}
	}
	return next
}

// Module is the newsfeed adapter's registration: one fetcher per working
// source, one poll job per dataset.
type Module struct {
	client *client
}

// NewModule builds the newsfeed module with an optional injected Doer
// (tests substitute canned responses; nil means the tuned default transport).
func NewModule(d canon.Doer) *Module {
	return &Module{client: newClient(d, 0)}
}

// Provider is the data.job provider column value.
func (m *Module) Provider() string { return providerName }

// Fetchers returns one fetcher per dispatchable source, keyed by dataset id.
func (m *Module) Fetchers() map[string]ingest.Fetcher {
	out := make(map[string]ingest.Fetcher)
	for _, s := range Sources {
		if s.Status != StatusWorking {
			continue
		}
		out[s.ID] = &fetcher{src: s, client: m.client}
	}
	return out
}

// Jobs is the seed registry: one poll job per working source. The schedule
// is the source's desired freshness; the engine's rate limiter and breaker
// gate the actual dispatch. Priority follows the house scale (3 = near-real
// time, 5 = daily); news publishers sit at 3, regulators and research at 4.
func (m *Module) Jobs() []ingest.JobSpec {
	specs := make([]ingest.JobSpec, 0, len(Sources))
	for _, s := range Sources {
		if s.Status != StatusWorking {
			continue
		}
		specs = append(specs, ingest.JobSpec{
			Provider: providerName,
			Dataset:  s.ID,
			Subject:  "",
			Mode:     "poll",
			Schedule: pollSchedule(s),
			Priority: pollPriority(s),
			Enabled:  true,
		})
	}
	return specs
}

// pollSchedule floors a source's interval at one minute: a sub-minute news
// poll is a rate-policy violation, not a freshness win.
func pollSchedule(s Source) time.Duration {
	const floor = time.Minute
	if d := s.pollInterval(); d > floor {
		return d
	}
	return floor
}

// pollPriority maps the source family onto the house priority scale.
func pollPriority(s Source) int {
	switch s.Category {
	case "regulator", "research":
		return 4
	case "security":
		return 3
	default:
		return 3
	}
}

// compile-time checks the adapter satisfies the frozen interfaces.
var (
	_ ingest.Module  = (*Module)(nil)
	_ ingest.Fetcher = (*fetcher)(nil)
)
