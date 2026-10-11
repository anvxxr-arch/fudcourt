package ingest

import (
	"context"
	"fmt"
	"log/slog"
)

// SourceRow is one news-source registry row as the projection writer stores it.
// It is a plain value type owned by this package on purpose: the registry
// lives in the newsfeed adapter, which imports ingest, so ingest must not
// import it back. main.go (the composition root, which imports both) converts
// and calls this.
type SourceRow struct {
	Slug         string
	Label        string
	Homepage     string
	FeedURL      string
	FeedFormat   string
	Category     string
	Country      string
	Language     string
	Reliability  int
	License      string
	Status       string
	StatusDetail string
	Enabled      bool
	PollSeconds  int
}

// ensureNewsSourceSQL upserts one registry row. The registry is version
// controlled, so a re-apply is the normal case: the statement updates every
// projected column and leaves created_at alone.
const ensureNewsSourceSQL = `INSERT INTO data.news_source
	(source_slug, label, homepage, feed_url, feed_format, category, country,
	 language, reliability, license, status, status_detail, enabled, poll_seconds)
	VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
	ON CONFLICT (source_slug) DO UPDATE SET
		label = EXCLUDED.label, homepage = EXCLUDED.homepage,
		feed_url = EXCLUDED.feed_url, feed_format = EXCLUDED.feed_format,
		category = EXCLUDED.category, country = EXCLUDED.country,
		language = EXCLUDED.language, reliability = EXCLUDED.reliability,
		license = EXCLUDED.license, status = EXCLUDED.status,
		status_detail = EXCLUDED.status_detail, enabled = EXCLUDED.enabled,
		poll_seconds = EXCLUDED.poll_seconds, updated_at = now()`

// EnsureNewsSources projects the news-source registry into data.news_source,
// one statement per row, after the schema has been applied.
//
// It is deliberately NOT a canon.Writer method: canon.Writer is the frozen
// provider-write surface (ADDENDUM C) and this projection is not a provider
// fact — it is the registry describing itself. Rows the registry no longer
// names are left in place (with their last state) rather than deleted, so a
// source cannot vanish from the record by being edited out of a build.
func EnsureNewsSources(ctx context.Context, pool PGConn, rows []SourceRow, logger *slog.Logger) error {
	if len(rows) == 0 {
		return nil
	}
	for _, r := range rows {
		if r.Slug == "" || r.FeedURL == "" || r.Status == "" {
			return fmt.Errorf("ingest: news source row is incomplete: slug=%q url=%q status=%q", r.Slug, r.FeedURL, r.Status)
		}
		args := []any{
			r.Slug, r.Label, nullableText(r.Homepage), r.FeedURL, r.FeedFormat,
			r.Category, nullableText(r.Country), nullableText(r.Language),
			r.Reliability, nullableText(r.License), r.Status,
			nullableText(r.StatusDetail), r.Enabled, r.PollSeconds,
		}
		if _, err := pool.Exec(ctx, ensureNewsSourceSQL, args...); err != nil {
			return fmt.Errorf("ingest: project news source %q: %w", r.Slug, err)
		}
	}
	if logger != nil {
		logger.InfoContext(ctx, "ingest: news source registry projected", "rows", len(rows))
	}
	return nil
}

// nullableText maps the empty string to NULL: an absent country or license is
// absence, never a blank that reads like a value.
func nullableText(s string) any {
	if s == "" {
		return nil
	}
	return s
}
