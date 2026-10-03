// Wire-contract tests for the news family (PLAN G12 SG-12.3).
//
// OFFLINE and deterministic: a fake Doer serves a canned feed, so the handler
// -- the strict param 400s, the X-Cache header, the served envelope and every
// error status -- is provable without touching cointelegraph.com. The live
// oracle run belongs to scripts/verify-news.py.
package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/chainrank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinank"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinglass"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/coinmarketcap"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/khala"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/llama"
	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research/news"
)

type newsDoer struct {
	body  string
	code  int
	count int
}

func (d *newsDoer) Do(req *http.Request) (*http.Response, error) {
	d.count++
	code := d.code
	if code == 0 {
		code = 200
	}
	return &http.Response{
		StatusCode: code,
		Body:       io.NopCloser(strings.NewReader(d.body)),
		Header:     http.Header{"Content-Type": []string{"application/xml"}},
		Request:    req,
	}, nil
}

// newsFeed builds a feed with n items.
func newsFeed(n int) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0"?><rss version="2.0"><channel><title>Cointelegraph</title>`)
	for i := 0; i < n; i++ {
		b.WriteString(`<item><title><![CDATA[Headline `)
		b.WriteString(string(rune('a' + i%26)))
		b.WriteString(`]]></title><link>https://n.test/`)
		b.WriteString(string(rune('a' + i%26)))
		b.WriteString(`</link><description><![CDATA[<p>Body</p>]]></description>`)
		b.WriteString(`<pubDate>Mon, 29 Sep 2026 15:53:54 +0000</pubDate>`)
		b.WriteString(`<media:content url="https://img.test/x.jpg"/></item>`)
	}
	b.WriteString(`</channel></rss>`)
	return b.String()
}

func newsGet(t *testing.T, d *newsDoer, url string) *httptest.ResponseRecorder {
	t.Helper()
	if d.body == "" {
		d.body = newsFeed(3)
	}
	f, err := news.New(news.Options{Client: d, TTL: 15})
	if err != nil {
		t.Fatalf("news.New: %v", err)
	}
	rec := httptest.NewRecorder()
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{F: f}, chainrank.Service{}, coinglass.Service{}, coinank.Service{}, coinmarketcap.Service{})
	srv.mux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

func TestNewsHealthzReportsFourFamilies(t *testing.T) {
	rec := newsGet(t, &newsDoer{}, "/healthz")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	body := decode(t, rec)
	for k, want := range map[string]string{
		"build": "28 modes", "khala": "3 modes", "llama": "3 modes", "news": "1 feeds",
	} {
		if got := body[k]; got != want {
			t.Errorf("healthz[%q] = %v, want %q", k, got, want)
		}
	}
}

func TestNewsDefaultSourceAndLimit(t *testing.T) {
	d := &newsDoer{body: newsFeed(40)}
	rec := newsGet(t, d, "/api/news")
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	items, _ := body["items"].([]interface{})
	if len(items) != 30 {
		t.Fatalf("items = %d, want the default limit 30", len(items))
	}
	if total, _ := body["total"].(float64); total != 40 {
		t.Fatalf("total = %v, want 40 (the FULL parsed count, not the head)", body["total"])
	}
	if up, _ := body["upstream"].(string); !strings.Contains(up, "cointelegraph.com/rss") {
		t.Fatalf("upstream = %q", up)
	}
	if _, ok := body["timestamp"].(float64); !ok {
		t.Fatalf("timestamp missing: %v", body)
	}
	if got := rec.Header().Get("X-Cache"); got != "MISS" {
		t.Fatalf("X-Cache = %q, want MISS on a cold fetch", got)
	}
	row := items[0].(map[string]interface{})
	if row["source"] != "Cointelegraph" {
		t.Fatalf("row source = %v, want the display label", row["source"])
	}
	for _, k := range []string{"title", "link", "description", "pubDate", "image", "source"} {
		if _, ok := row[k]; !ok {
			t.Errorf("row key %q missing: %v", k, row)
		}
	}
}

func TestNewsSecondRequestIsACacheHit(t *testing.T) {
	d := &newsDoer{body: newsFeed(5)}
	f, err := news.New(news.Options{Client: d, TTL: 15})
	if err != nil {
		t.Fatalf("news.New: %v", err)
	}
	// ONE server for both requests: the cache lives on the fetcher, so a second
	// helper call would build a second cache and prove nothing.
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{F: f}, chainrank.Service{}, coinglass.Service{}, coinank.Service{}, coinmarketcap.Service{}).mux()
	do := func(url string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
		return rec
	}
	first := do("/api/news?limit=2")
	if got := first.Header().Get("X-Cache"); got != "MISS" {
		t.Fatalf("first X-Cache = %q, want MISS", got)
	}
	rec := do("/api/news?limit=5")
	if got := rec.Header().Get("X-Cache"); got != "HIT" {
		t.Fatalf("X-Cache = %q, want HIT", got)
	}
	if d.count != 1 {
		t.Fatalf("upstream calls = %d, want 1: the feed URL is the cache key, not the query", d.count)
	}
	// The second request asks for MORE items than the first and must still get
	// them: the cache holds the whole document, not the first response's head.
	body := decode(t, rec)
	if items, _ := body["items"].([]interface{}); len(items) != 5 {
		t.Fatalf("second response items = %d, want 5", len(items))
	}
}

func TestNewsLimitIsStrict(t *testing.T) {
	cases := []struct {
		query string
		want  string
	}{
		{"?limit=", "limit must be an integer, got ''"},
		{"?limit=abc", "limit must be an integer, got 'abc'"},
		{"?limit=0", "limit must be between 1 and 100, got 0"},
		{"?limit=101", "limit must be between 1 and 100, got 101"},
	}
	for _, c := range cases {
		rec := newsGet(t, &newsDoer{}, "/api/news"+c.query)
		if rec.Code != 400 {
			t.Errorf("%s: status %d, want 400", c.query, rec.Code)
			continue
		}
		if got := decode(t, rec)["error"]; got != c.want {
			t.Errorf("%s: error %q, want %q", c.query, got, c.want)
		}
	}
	// A refused param must never reach upstream, and must never be clamped into
	// a silent success.
	d := &newsDoer{}
	newsGet(t, d, "/api/news?limit=101")
	if d.count != 0 {
		t.Fatalf("upstream calls = %d: a refused limit must be answered without a fetch", d.count)
	}
}

func TestNewsSourceIsStrict(t *testing.T) {
	rec := newsGet(t, &newsDoer{}, "/api/news?source=cnn")
	if rec.Code != 400 {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	body := decode(t, rec)
	if body["error"] != "unknown source 'cnn'" {
		t.Fatalf("error = %v", body["error"])
	}
	if body["detail"] != "expected one of cointelegraph" {
		t.Fatalf("detail = %v", body["detail"])
	}
	// The wired source resolves.
	if rec := newsGet(t, &newsDoer{}, "/api/news?source=cointelegraph"); rec.Code != 200 {
		t.Fatalf("the wired source must answer 200, got %d", rec.Code)
	}
}

func TestNewsErrorsKeepTheRealStatus(t *testing.T) {
	for _, code := range []int{403, 429, 500, 503} {
		d := &newsDoer{body: "<html>wall</html>", code: code}
		rec := newsGet(t, d, "/api/news")
		if rec.Code != code {
			t.Errorf("upstream %d -> status %d, want the real status", code, rec.Code)
		}
		body := decode(t, rec)
		if code == 429 {
			if body["error"] != "upstream 429 from the RSS feed" {
				t.Errorf("429 error = %v", body["error"])
			}
		} else if want := "upstream " + itoa(code) + " from the RSS feed"; body["error"] != want {
			t.Errorf("upstream %d error = %v, want %q", code, body["error"], want)
		}
		if body["detail"] == nil {
			t.Errorf("upstream %d must quote the real body", code)
		}
	}
}

func TestNewsEmptyFeedIs502(t *testing.T) {
	d := &newsDoer{body: "<rss><channel><title>none</title></channel></rss>"}
	rec := newsGet(t, d, "/api/news")
	if rec.Code != 502 {
		t.Fatalf("status %d, want 502: an empty feed is breakage, not an empty list", rec.Code)
	}
	body := decode(t, rec)
	if body["error"] != "upstream returned an empty feed" {
		t.Fatalf("error = %v", body["error"])
	}
	if _, ok := body["items"]; ok {
		t.Fatal("no payload may be substituted for a failure")
	}
}

func TestNewsRejectsNonGet(t *testing.T) {
	rec := httptest.NewRecorder()
	srv := newServer(&fakeFetcher{}, 60, khala.Service{}, llama.Service{}, news.Service{}, chainrank.Service{}, coinglass.Service{}, coinank.Service{}, coinmarketcap.Service{})
	srv.mux().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/news", nil))
	if rec.Code != 405 {
		t.Fatalf("status %d, want 405", rec.Code)
	}
}

// itoa avoids pulling strconv into a test file that already reads better
// without it.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
