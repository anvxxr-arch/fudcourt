package ingest

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

// fakePG records every statement the projection issues. It satisfies PGConn,
// which is exactly why that interface is narrow.
type fakePG struct {
	sqls   []string
	argLen []int
	err    error
}

func (f *fakePG) Exec(ctx context.Context, sql string, args ...any) (any, error) {
	f.sqls = append(f.sqls, sql)
	f.argLen = append(f.argLen, len(args))
	if f.err != nil {
		return nil, f.err
	}
	return nil, nil
}

func sampleRows() []SourceRow {
	return []SourceRow{
		{Slug: "cointelegraph", Label: "Cointelegraph RSS", Homepage: "https://cointelegraph.com",
			FeedURL: "https://cointelegraph.com/rss", FeedFormat: "rss", Category: "news",
			Country: "US", Language: "en", Reliability: 4, License: "feed-redistribution",
			Status: "active", Enabled: true, PollSeconds: 180},
		{Slug: "cryptoslate", Label: "CryptoSlate RSS", Homepage: "https://cryptoslate.com",
			FeedURL: "https://cryptoslate.com/feed/", FeedFormat: "rss", Category: "news",
			Country: "US", Language: "en", Reliability: 3, License: "feed-redistribution",
			Status: "restricted", StatusDetail: "HTTP 403 Cloudflare interstitial", PollSeconds: 0},
	}
}

func TestEnsureNewsSourcesProjectsEveryRow(t *testing.T) {
	pg := &fakePG{}
	if err := EnsureNewsSources(context.Background(), pg, sampleRows(), slog.Default()); err != nil {
		t.Fatalf("project: %v", err)
	}
	if len(pg.sqls) != 2 {
		t.Fatalf("statements = %d, want one per row", len(pg.sqls))
	}
	for i, sql := range pg.sqls {
		if !strings.Contains(sql, "INSERT INTO data.news_source") {
			t.Errorf("statement %d is not the projection: %s", i, sql)
		}
		// Idempotency lives in the statement: a re-apply updates, never dupes.
		if !strings.Contains(sql, "ON CONFLICT (source_slug) DO UPDATE") {
			t.Errorf("statement %d lacks the upsert clause", i)
		}
		if pg.argLen[i] != 14 {
			t.Errorf("statement %d bound %d args, want 14", i, pg.argLen[i])
		}
	}
}

func TestEnsureNewsSourcesEmptyIsANoOp(t *testing.T) {
	pg := &fakePG{}
	if err := EnsureNewsSources(context.Background(), pg, nil, nil); err != nil {
		t.Fatalf("empty projection: %v", err)
	}
	if len(pg.sqls) != 0 {
		t.Fatalf("an empty registry must issue no statements, got %d", len(pg.sqls))
	}
}

func TestEnsureNewsSourcesRefusesIncompleteRow(t *testing.T) {
	pg := &fakePG{}
	rows := []SourceRow{{Slug: "", FeedURL: "https://example.com/feed", Status: "active"}}
	err := EnsureNewsSources(context.Background(), pg, rows, nil)
	if err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("want an incomplete-row error, got %v", err)
	}
	if len(pg.sqls) != 0 {
		t.Fatal("a refused row must not reach the database")
	}
}

func TestEnsureNewsSourcesPropagatesAndNamesTheRow(t *testing.T) {
	pg := &fakePG{err: errors.New("connection reset")}
	err := EnsureNewsSources(context.Background(), pg, sampleRows(), nil)
	if err == nil {
		t.Fatal("a store failure must surface")
	}
	if !strings.Contains(err.Error(), "cointelegraph") {
		t.Fatalf("the failure must name the row it died on: %v", err)
	}
}

func TestNullableText(t *testing.T) {
	if nullableText("") != nil {
		t.Fatal("an absent value must be NULL, not an empty string")
	}
	if got := nullableText("US"); got != "US" {
		t.Fatalf("nullableText = %v", got)
	}
}
