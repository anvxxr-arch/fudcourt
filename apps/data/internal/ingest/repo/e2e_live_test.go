//go:build live

// Live end-to-end test: writes the newsfeed adapter's real canonical rows
// through the real repo into data.news_article and reads them back with the
// filtered query /api/data/news serves.
//
// SAFETY: the entire test runs inside one transaction that is ALWAYS rolled
// back, so nothing it writes can persist — no scratch database is required,
// and a crash cannot strand rows. It still refuses to run unless the caller
// opts in explicitly:
//
//	FUDCOURT_NEWS_E2E_PG_URL=<dsn> FUDCOURT_NEWS_E2E_ALLOW=1 \
//	  go test -tags live ./apps/data/internal/ingest/repo/ -run TestLiveE2E -v
//
// The DSN must point at a database that already carries the data-schema
// (data.news_article). The test never runs DDL.
package repo_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest/repo"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// sourceTag namespaces this test's rows so the filtered reads target only
// rows this test created, even inside the rollback transaction.
const sourceTag = "newsfeed-e2e"

// txExec narrows pgx.Tx to repo.Executor (the repo takes the interface).
// pgx.Tx's Exec returns a CommandTag, so the adapter normalizes it to any,
// exactly as main.go's poolExecutor does for *pgxpool.Pool.
type txExec struct{ tx pgx.Tx }

func (e txExec) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return e.tx.Query(ctx, sql, args...)
}
func (e txExec) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return e.tx.QueryRow(ctx, sql, args...)
}
func (e txExec) Exec(ctx context.Context, sql string, args ...any) (any, error) {
	return e.tx.Exec(ctx, sql, args...)
}
func (e txExec) SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults {
	return e.tx.SendBatch(ctx, b)
}
func (e txExec) CopyFrom(ctx context.Context, table pgx.Identifier, cols []string, src pgx.CopyFromSource) (int64, error) {
	return e.tx.CopyFrom(ctx, table, cols, src)
}

var _ repo.Executor = txExec{}

func TestLiveE2ENewsIngest(t *testing.T) {
	dsn := os.Getenv("FUDCOURT_NEWS_E2E_PG_URL")
	if dsn == "" {
		t.Skip("FUDCOURT_NEWS_E2E_PG_URL unset")
	}
	if os.Getenv("FUDCOURT_NEWS_E2E_ALLOW") != "1" {
		t.Skip("FUDCOURT_NEWS_E2E_ALLOW != 1: refusing to touch a live database without explicit opt-in")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	// ALWAYS roll back: nothing this test writes may persist.
	defer func() {
		if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
			t.Logf("rollback: %v", err)
		}
	}()

	r := repo.New(txExec{tx: tx})

	id1 := "article/" + sourceTag + "/tx-1"
	id2 := "article/" + sourceTag + "/tx-2"
	now := time.Now().UTC()
	older := now.Add(-2 * time.Hour)
	newer := now.Add(-1 * time.Hour)
	s := "BTC funds rallied"
	rows := []canon.Article{
		{ArticleID: id1, Headline: "Bitcoin ETF inflow record",
			URL: "https://example.invalid/" + sourceTag + "/1", Summary: &s,
			Source: sourceTag, Topics: []string{"markets"}, Assets: []string{"BTC"},
			PublishedAt: &older, RetrievedAt: now},
		{ArticleID: id2, Headline: "Ethereum upgrade ships",
			URL:    "https://example.invalid/" + sourceTag + "/2",
			Source: sourceTag, Topics: []string{"infra"}, Assets: []string{"ETH"},
			PublishedAt: &newer, RetrievedAt: now},
	}

	written, rejected, err := r.WriteArticles(ctx, rows)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if written != 2 || rejected != 0 {
		t.Fatalf("write: written=%d rejected=%d, want 2/0", written, rejected)
	}

	// Idempotent re-write: same ArticleID upserts, never duplicates.
	written2, _, err := r.WriteArticles(ctx, rows)
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if written2 != 2 {
		t.Fatalf("rewrite written=%d, want 2", written2)
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM data.news_article WHERE article_id = ANY($1)`,
		[]string{id1, id2}).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 2 {
		t.Fatalf("row count = %d after rewrite, want 2 (upsert, not duplicate)", count)
	}

	// Validation rejects: a future retrieved_at must count as rejected, never
	// written.
	bad := canon.Article{ArticleID: "article/" + sourceTag + "/future", Headline: "future",
		URL: "https://example.invalid/" + sourceTag + "/f", Source: sourceTag,
		RetrievedAt: now.Add(1 * time.Hour)}
	if w, rej, err := r.WriteArticles(ctx, []canon.Article{bad}); err != nil || w != 0 || rej != 1 {
		t.Fatalf("future row: written=%d rejected=%d err=%v, want 0/1/nil", w, rej, err)
	}

	got, err := r.ListArticlesFiltered(ctx, canon.ArticleQuery{Source: sourceTag, Asset: "BTC", Limit: 10})
	if err != nil {
		t.Fatalf("asset filter: %v", err)
	}
	if len(got) != 1 || got[0].ArticleID != id1 {
		t.Fatalf("asset filter got %+v", got)
	}

	got, err = r.ListArticlesFiltered(ctx, canon.ArticleQuery{Source: sourceTag, Category: "infra", Limit: 10})
	if err != nil {
		t.Fatalf("category filter: %v", err)
	}
	if len(got) != 1 || got[0].ArticleID != id2 {
		t.Fatalf("category filter got %+v", got)
	}

	got, err = r.ListArticlesFiltered(ctx, canon.ArticleQuery{Source: sourceTag, Search: "ethereum", Limit: 10})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(got) != 1 || got[0].ArticleID != id2 {
		t.Fatalf("search got %+v", got)
	}

	// Keyset cursor: rows strictly older than the newer article's timestamp.
	got, err = r.ListArticlesFiltered(ctx, canon.ArticleQuery{
		Source: sourceTag, Before: now.Add(-90 * time.Minute), Limit: 10})
	if err != nil {
		t.Fatalf("cursor: %v", err)
	}
	if len(got) != 1 || got[0].ArticleID != id1 {
		t.Fatalf("cursor got %+v", got)
	}

	// The unfiltered read path still works.
	all, err := r.ListArticles(ctx, 10)
	if err != nil {
		t.Fatalf("ListArticles: %v", err)
	}
	t.Logf("E2E OK (rolled back): wrote=%d rewrote=%d count=%d filtered reads OK list_page=%d",
		written, written2, count, len(all))
}
