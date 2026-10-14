package newsfeed

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// benchRSS is a synthetic feed with the shape and size of a real publisher
// feed (50 items, escaped HTML summaries), so the parser benchmark measures
// the same work the live path does.
func benchRSS(n int) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>`)
	for i := range n {
		b.WriteString(`<item><title>Bitcoin and Ethereum market update `)
		b.WriteString(itoa(i))
		b.WriteString(`</title><pubDate>Sun, 11 Oct 2026 17:03:00 +0000</pubDate><guid>https://example.com/a/`)
		b.WriteString(itoa(i))
		b.WriteString(`</guid><link>https://example.com/a/`)
		b.WriteString(itoa(i))
		b.WriteString(`?utm_source=rss</link><dc:creator>Jane Doe</dc:creator><category>Markets</category>`)
		b.WriteString(`<description><![CDATA[<p>Spot <b>Bitcoin</b> funds pulled in $1.2B as <b>Ethereum</b> rallied.</p>]]></description></item>`)
	}
	b.WriteString(`</channel></rss>`)
	return b.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func BenchmarkParseRSS50(b *testing.B) {
	body := []byte(benchRSS(50))
	b.ReportAllocs()
	b.SetBytes(int64(len(body)))
	for b.Loop() {
		items, kind, err := parseFeed(body)
		if err != nil || kind != "rss" || len(items) != 50 {
			b.Fatalf("parse: kind=%q n=%d err=%v", kind, len(items), err)
		}
	}
}

func BenchmarkNormalizeArticle(b *testing.B) {
	src := Source{ID: "bench", Label: "Bench", Language: "en", Topics: []string{"markets"}}
	it := rawItem{
		ExtID: "https://example.com/a/1?utm_source=rss",
		URL:   "https://example.com/a/1?utm_source=rss&utm_medium=feed",
		Title: "Bitcoin and Ethereum market update", Summary: "Spot Bitcoin funds pulled in $1.2B.",
		PublishedAt: "Sun, 11 Oct 2026 17:03:00 +0000",
	}
	now := time.Now().UTC()
	b.ReportAllocs()
	for b.Loop() {
		_ = toArticle(it, src, now)
	}
}

func BenchmarkCanonicalURL(b *testing.B) {
	u := "HTTPS://Example.COM/news/post/?utm_source=rss&utm_medium=rss&b=2&a=1#frag"
	b.ReportAllocs()
	for b.Loop() {
		_ = canonicalURL(u)
	}
}

// BenchmarkFetchEndToEnd measures one full fetcher run (fetch hooks + parse +
// normalize + write) against a canned body, with no network and no database.
func BenchmarkFetchEndToEnd(b *testing.B) {
	body := benchRSS(50)
	do := &fakeDoer{status: 200, body: body, headers: http.Header{"Etag": {`"v1"`}}}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	b.ReportAllocs()
	b.SetBytes(int64(len(body)))
	for b.Loop() {
		w := &captureWriter{}
		if _, err := f.Fetch(context.Background(), ingest.Job{}, w); err != nil {
			b.Fatalf("fetch: %v", err)
		}
	}
}
