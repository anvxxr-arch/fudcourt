package news

// Turn-3 QA hostile-HTTP suite: the behaviours this family's fetch path had
// never proven — a slow upstream bounded by the caller's context, a body past
// the 4 MiB cap, and a 429 whose Retry-After header is deliberately unheeded.
// Status/gzip/single-flight/TTL are already proven in news_test.go. Fetch
// allowlists its table feeds (fetch.go:235), so hostile upstreams are injected
// as Doers behind the REAL feed URL. Deterministic, no network.

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const feedURL = "https://cointelegraph.com/rss"

// ctxBlockDoer blocks until the request context ends, then returns its error.
type ctxBlockDoer struct {
	calls int
}

func (d *ctxBlockDoer) Do(req *http.Request) (*http.Response, error) {
	d.calls++
	<-req.Context().Done()
	return nil, req.Context().Err()
}

// A slow feed is bounded by the caller's context: the fetch ends when the
// deadline ends, with exactly one attempt.
func TestHostileSlowFeedIsBoundedByContext(t *testing.T) {
	d := &ctxBlockDoer{}
	f, err := New(Options{Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, _, ferr := f.Fetch(ctx, feedURL)
	elapsed := time.Since(start)
	if ferr == nil {
		t.Fatal("slow feed: expected error")
	}
	if d.calls != 1 {
		t.Errorf("slow feed: %d attempts, want 1", d.calls)
	}
	if elapsed > time.Second {
		t.Errorf("slow feed: fetch took %v, want bounded by the 100ms context", elapsed)
	}
}

// A body streamed past the 4 MiB cap is cut, not buffered: the read ends in
// bounded time and the truncated XML must not ship a half-feed as success.
func TestHostileHugeFeedIsBounded(t *testing.T) {
	item := "<item><title>" + strings.Repeat("x", 1024) + "</title><link>http://x</link><description>d</description><pubDate>Fri, 09 Oct 2026 13:49:22 +0000</pubDate></item>"
	huge := `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>` + strings.Repeat(item, 20000) // ~20 MB
	d := &staticBodyDoer{body: huge}
	f, err := New(Options{Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	start := time.Now()
	_, items, _, ferr := f.Fetch(context.Background(), feedURL)
	if elapsed := time.Since(start); elapsed > 8*time.Second {
		t.Errorf("huge feed: fetch took %v, want bounded", elapsed)
	}
	he, ok := IsHardError(ferr)
	if !ok {
		t.Fatalf("huge feed: err = nil (parsed %d items); truncated XML must fail loudly", len(items))
	}
	if he.Kind != "too-large" {
		t.Errorf("huge feed: kind = %q, want too-large", he.Kind)
	}
}

// A 429 is exactly one upstream attempt; Retry-After is unheeded by design
// (backing off is the caller's job).
func TestHostile429WithRetryAfterIsSingleAttempt(t *testing.T) {
	d := &staticDoer{do: func(req *http.Request) (*http.Response, error) {
		h := make(http.Header)
		h.Set("Retry-After", "120")
		return &http.Response{
			StatusCode: 429,
			Body:       io.NopCloser(strings.NewReader("slow down")),
			Header:     h,
			Request:    req,
		}, nil
	}}
	f, err := New(Options{Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	start := time.Now()
	_, _, _, ferr := f.Fetch(context.Background(), feedURL)
	if ferr == nil {
		t.Fatal("429: expected error")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("429: fetch slept %v — Retry-After must not be honoured in-process", elapsed)
	}
}

// staticBodyDoer serves one canned body for any request.
type staticBodyDoer struct {
	body string
}

func (d *staticBodyDoer) Do(req *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(d.body)),
		Header:     http.Header{"Content-Type": []string{"application/rss+xml"}},
		Request:    req,
	}, nil
}

// staticDoer delegates to a canned function.
type staticDoer struct {
	do func(*http.Request) (*http.Response, error)
}

func (d *staticDoer) Do(req *http.Request) (*http.Response, error) { return d.do(req) }
