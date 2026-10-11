package newsfeed

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// recWriter implements canon.Writer by embedding the frozen interface: the
// methods this adapter never calls stay unimplemented, so a future call to one
// panics loudly instead of silently succeeding in a test.
type recWriter struct {
	canon.Writer
	arts []canon.Article
	err  error
}

func (r *recWriter) WriteArticles(ctx context.Context, rows []canon.Article) (int, int, error) {
	if r.err != nil {
		return 0, len(rows), r.err
	}
	r.arts = append(r.arts, rows...)
	return len(rows), 0, nil
}

// doer is a canned upstream: one status, one body, whatever validators to echo.
type doer struct {
	status   int
	body     string
	etag     string
	lastMod  string
	finalURL string
	err      error
}

func (d doer) Do(req *http.Request) (*http.Response, error) {
	if d.err != nil {
		return nil, d.err
	}
	h := http.Header{}
	if d.etag != "" {
		h.Set("ETag", d.etag)
	}
	if d.lastMod != "" {
		h.Set("Last-Modified", d.lastMod)
	}
	resp := &http.Response{
		StatusCode: d.status,
		Header:     h,
		Body:       io.NopCloser(strings.NewReader(d.body)),
		Request:    req,
	}
	if d.finalURL != "" {
		u, err := url.Parse(d.finalURL)
		if err != nil {
			return nil, err
		}
		resp.Request = &http.Request{URL: u}
	}
	return resp, nil
}

func testModule(d doer) *Module { return NewModule(d) }

func fetchOne(t *testing.T, m *Module, subject string, cursor ingest.Cursor, wtr canon.Writer) ingest.FetchResult {
	t.Helper()
	f, ok := m.Fetchers()[datasetFeed]
	if !ok {
		t.Fatal("dataset feed fetcher is not registered")
	}
	job := ingest.Job{Provider: providerName, Dataset: datasetFeed, Subject: subject, Mode: "poll", Cursor: cursor}
	res, err := f.Fetch(context.Background(), job, wtr)
	if err != nil {
		t.Fatalf("Fetch(%s): %v", subject, err)
	}
	return res
}

func TestModuleShape(t *testing.T) {
	m := testModule(doer{status: 200, body: rssFixture})
	if m.Provider() != providerName {
		t.Fatalf("provider = %q", m.Provider())
	}
	f, ok := m.Fetchers()[datasetFeed]
	if !ok {
		t.Fatalf("fetchers = %v", m.Fetchers())
	}
	// ingest.Fetcher is the frozen interface (Fetch only); Dataset is this
	// adapter's own accessor, so it is reached through the concrete type.
	if cf, isConcrete := f.(*fetcher); !isConcrete || cf.Dataset() != datasetFeed {
		t.Fatalf("fetcher is not the feed fetcher: %T", f)
	}
}

func TestFetchWritesArticlesWithDeterministicIds(t *testing.T) {
	wtr := &recWriter{}
	res := fetchOne(t, testModule(doer{status: 200, body: rssFixture, etag: `W/"v1"`, lastMod: "Sat, 11 Oct 2026 09:20:00 GMT"}),
		"cointelegraph", nil, wtr)

	if res.RowsIn != 2 || res.RowsWritten != 2 || res.RowsRejected != 0 {
		t.Fatalf("res = %+v", res)
	}
	if len(wtr.arts) != 2 {
		t.Fatalf("written = %d", len(wtr.arts))
	}
	// Level 2 dedup: the id is the mint of (source slug, publisher guid), so
	// the same story upserts on a later fetch instead of duplicating.
	wantID := canon.MintID(canon.KindArticle, canon.ArticleKey("cointelegraph", "example-1001"))
	if wtr.arts[0].ArticleID != wantID {
		t.Fatalf("article id = %q, want %q", wtr.arts[0].ArticleID, wantID)
	}
	if wtr.arts[0].Source != "cointelegraph" {
		t.Fatalf("source = %q", wtr.arts[0].Source)
	}
	if wtr.arts[0].PublishedAt == nil || wtr.arts[0].PublishedAt.Location() != time.UTC {
		t.Fatalf("published_at = %v", wtr.arts[0].PublishedAt)
	}
	if wtr.arts[0].RetrievedAt.IsZero() {
		t.Fatal("retrieved_at must be the ingestion moment")
	}
	// The tracking parameters of the upstream link are gone; the story's own
	// query parameter survives.
	if strings.Contains(wtr.arts[0].URL, "utm_") || !strings.Contains(wtr.arts[0].URL, "id=42") {
		t.Fatalf("url = %q", wtr.arts[0].URL)
	}
	if res.Next["etag"] != `W/"v1"` || res.Next["body_hash"] == nil || res.Next["last_published_at"] == nil {
		t.Fatalf("cursor = %+v", res.Next)
	}
	if res.NextRunHint != nil {
		t.Fatal("a moving feed must not back off")
	}
}

func TestFetchNotModifiedWritesNothingAndBacksOff(t *testing.T) {
	wtr := &recWriter{}
	prev := ingest.Cursor{"etag": `W/"v1"`, "last_published_at": "2026-10-11T09:15:00Z", "items_in": 2}
	res := fetchOne(t, testModule(doer{status: 304}), "cointelegraph", prev, wtr)

	if len(wtr.arts) != 0 {
		t.Fatalf("a 304 must write nothing, wrote %d", len(wtr.arts))
	}
	if res.RowsIn != 0 {
		t.Fatalf("res = %+v", res)
	}
	// The bookkeeping survives the unchanged fetch...
	if res.Next["last_published_at"] != "2026-10-11T09:15:00Z" || res.Next["etag"] != `W/"v1"` {
		t.Fatalf("cursor dropped state: %+v", res.Next)
	}
	// ...and the feed is polled less often until it moves.
	feed, _ := Lookup("cointelegraph")
	if res.NextRunHint == nil || *res.NextRunHint != feed.Schedule*2 {
		t.Fatalf("hint = %v, want %v", res.NextRunHint, feed.Schedule*2)
	}
}

func TestFetchRejectsSourceWithNonActiveStatus(t *testing.T) {
	_, err := testModule(doer{status: 200, body: rssFixture}).Fetchers()[datasetFeed].
		Fetch(context.Background(), ingest.Job{Provider: providerName, Dataset: datasetFeed, Subject: "cryptoslate"}, &recWriter{})
	he, ok := IsHardError(err)
	if !ok || he.Kind != string(StatusRestricted) {
		t.Fatalf("want restricted HardError, got %v", err)
	}
	if !strings.Contains(he.Detail, "403") {
		t.Fatalf("the measured reason must travel with the failure: %q", he.Detail)
	}
}

func TestFetchUnknownSourceFails(t *testing.T) {
	_, err := testModule(doer{status: 200, body: rssFixture}).Fetchers()[datasetFeed].
		Fetch(context.Background(), ingest.Job{Provider: providerName, Dataset: datasetFeed, Subject: "does-not-exist"}, &recWriter{})
	if he, ok := IsHardError(err); !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestFetchForbiddenIsHardError(t *testing.T) {
	wtr := &recWriter{}
	_, err := testModule(doer{status: 403, body: "<html>Just a moment...</html>"}).Fetchers()[datasetFeed].
		Fetch(context.Background(), ingest.Job{Provider: providerName, Dataset: datasetFeed, Subject: "cointelegraph"}, wtr)
	he, ok := IsHardError(err)
	if !ok || he.Kind != "restricted" {
		t.Fatalf("want restricted HardError, got %v", err)
	}
	if len(wtr.arts) != 0 {
		t.Fatal("a refused fetch must not write")
	}
}

func TestFetchRefusesOffHostRedirect(t *testing.T) {
	wtr := &recWriter{}
	_, err := testModule(doer{status: 200, body: rssFixture, finalURL: "https://evil.example/feed"}).Fetchers()[datasetFeed].
		Fetch(context.Background(), ingest.Job{Provider: providerName, Dataset: datasetFeed, Subject: "cointelegraph"}, wtr)
	if he, ok := IsHardError(err); !ok || he.Kind != "shape" || !strings.Contains(he.Detail, "off-host") {
		t.Fatalf("want off-host shape HardError, got %v", err)
	}
	if len(wtr.arts) != 0 {
		t.Fatal("a redirected response must not be stored")
	}
}

func TestFetchRefusesOversizedBody(t *testing.T) {
	c := newClient(doer{status: 200, body: strings.Repeat("a", 4096)}, 0)
	c.maxBytes = 128
	_, _, err := c.fetch(context.Background(), Feed{Slug: "x", URL: "https://example.com/feed"}, validators{})
	if he, ok := IsHardError(err); !ok || he.Kind != "shape" {
		t.Fatalf("want shape HardError, got %v", err)
	}
}

func TestGuardURL(t *testing.T) {
	bad := []string{
		"http://example.com/feed",
		"ftp://example.com/feed",
		"https://localhost/feed",
		"https://127.0.0.1/feed",
		"https://10.1.2.3/feed",
		"https://192.168.1.5/feed",
		"https://172.16.0.1/feed",
		"https://172.31.255.254/feed",
		"https://169.254.169.254/latest/meta-data/",
		"https://0.0.0.0/feed",
		"https://user:pass@example.com/feed",
		"https://thing.internal/feed",
	}
	for _, raw := range bad {
		if err := guardURL(raw); err == nil {
			t.Errorf("guardURL(%q) allowed a URL it must refuse", raw)
		}
	}
	good := []string{"https://example.com/feed", "https://cointelegraph.com/rss", "https://172.32.0.1/feed"}
	for _, raw := range good {
		if err := guardURL(raw); err != nil {
			t.Errorf("guardURL(%q) refused a public URL: %v", raw, err)
		}
	}
}

func TestFetchInBatchDedup(t *testing.T) {
	// The same story twice in one document (a syndication artefact): one row.
	dup := `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Same story</title><link>https://example.com/a?utm_source=rss</link><guid>g1</guid></item>
<item><title>Same   story</title><link>https://example.com/a</link><guid>g2</guid></item>
</channel></rss>`
	wtr := &recWriter{}
	res := fetchOne(t, testModule(doer{status: 200, body: dup}), "cointelegraph", nil, wtr)
	if res.RowsIn != 2 {
		t.Fatalf("rows in = %d", res.RowsIn)
	}
	if len(wtr.arts) != 1 || res.RowsRejected != 1 {
		t.Fatalf("dedup failed: written=%d rejected=%d", len(wtr.arts), res.RowsRejected)
	}
}

func TestFetchRejectsItemsWithoutHeadlineOrLink(t *testing.T) {
	partial := `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Good</title><link>https://example.com/ok</link><guid>g1</guid></item>
<item><title></title><link>https://example.com/no-headline</link></item>
<item><title>No link</title><link></link></item>
</channel></rss>`
	wtr := &recWriter{}
	res := fetchOne(t, testModule(doer{status: 200, body: partial}), "cointelegraph", nil, wtr)
	if len(wtr.arts) != 1 || res.RowsRejected != 2 {
		t.Fatalf("written=%d rejected=%d, want 1/2", len(wtr.arts), res.RowsRejected)
	}
}

func TestWriteFailureIsReported(t *testing.T) {
	wtr := &recWriter{err: context.DeadlineExceeded}
	f := testModule(doer{status: 200, body: rssFixture}).Fetchers()[datasetFeed]
	_, err := f.Fetch(context.Background(), ingest.Job{Provider: providerName, Dataset: datasetFeed, Subject: "cointelegraph"}, wtr)
	if err == nil {
		t.Fatal("a store failure must surface, never be counted as written")
	}
}

func TestJobsCoverExactlyTheActiveFeeds(t *testing.T) {
	m := testModule(doer{status: 200, body: rssFixture})
	jobs := m.Jobs()
	if len(jobs) != len(Enabled()) {
		t.Fatalf("jobs = %d, active feeds = %d", len(jobs), len(Enabled()))
	}
	for _, j := range jobs {
		if j.Provider != providerName || j.Dataset != datasetFeed || j.Mode != "poll" || !j.Enabled {
			t.Fatalf("job shape = %+v", j)
		}
		if j.Schedule <= 0 {
			t.Fatalf("job %s has no schedule", j.Subject)
		}
		if j.Subject == "cryptoslate" {
			t.Fatal("a restricted source must not be seeded as a job")
		}
	}
}
