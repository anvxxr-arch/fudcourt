package newsfeed

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
)

// fakeDoer returns a canned response (or error) and records the requests it
// saw, so tests can assert the conditional headers and the URL shape.
type fakeDoer struct {
	status  int
	headers http.Header
	body    string
	err     error
	seen    []*http.Request
}

func (f *fakeDoer) Do(r *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, r)
	if f.err != nil {
		return nil, f.err
	}
	h := f.headers
	if h == nil {
		h = http.Header{}
	}
	return &http.Response{
		StatusCode: f.status,
		Header:     h,
		Body:       io.NopCloser(strings.NewReader(f.body)),
		Request:    r,
	}, nil
}

// captureWriter records the articles written to it.
type captureWriter struct {
	articles []canon.Article
	fail     error
}

func (c *captureWriter) WriteArticles(_ context.Context, rows []canon.Article) (int, int, error) {
	if c.fail != nil {
		return 0, 0, c.fail
	}
	c.articles = append(c.articles, rows...)
	return len(rows), 0, nil
}

// The rest of canon.Writer is unused by this adapter's tests.
func (c *captureWriter) UpsertAssets(context.Context, []canon.Asset) (int, error) { return 0, nil }
func (c *captureWriter) UpsertChains(context.Context, []canon.Chain) (int, error) { return 0, nil }
func (c *captureWriter) UpsertVenues(context.Context, []canon.Venue) (int, error) { return 0, nil }
func (c *captureWriter) UpsertInstruments(context.Context, []canon.Instrument) (int, error) {
	return 0, nil
}
func (c *captureWriter) UpsertProtocols(context.Context, []canon.Protocol) (int, error) {
	return 0, nil
}
func (c *captureWriter) UpsertSeries(context.Context, []canon.SeriesMeta) (int, error) {
	return 0, nil
}
func (c *captureWriter) UpsertProviderSymbols(context.Context, []canon.ProviderSymbol) (int, error) {
	return 0, nil
}
func (c *captureWriter) WriteOhlcv(context.Context, []canon.Ohlcv) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteTrades(context.Context, []canon.Trade) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteQuotes(context.Context, []canon.Quote) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteOrderbook(context.Context, []canon.OrderbookSnap) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteLiquidations(context.Context, []canon.Liquidation) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteOptionQuotes(context.Context, []canon.OptionQuote) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteObservations(context.Context, []canon.Observation) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteFunding(context.Context, []canon.FundingRate) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteOpenInterest(context.Context, []canon.OpenInterest) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WritePools(context.Context, []canon.Pool) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WritePredictionMarkets(context.Context, []canon.PredictionMarket) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteChainTVL(context.Context, []canon.ChainTVL) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteProtocolTVL(context.Context, []canon.ProtocolTVL) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteSupply(context.Context, []canon.SupplySnapshot) (int, int, error) {
	return 0, 0, nil
}
func (c *captureWriter) WriteMetric(context.Context, string, []canon.MetricPoint) (int, error) {
	return 0, nil
}

var _ canon.Writer = (*captureWriter)(nil)

const rssSample = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Sample</title>
  <item>
    <title>Bitcoin ETF sees record inflows</title>
    <pubDate>Sun, 11 Oct 2026 17:03:00 +0000</pubDate>
    <guid isPermaLink="true">https://example.com/news/btc-etf?utm_source=rss_feed&amp;utm_medium=rss</guid>
    <link><![CDATA[https://example.com/news/btc-etf?utm_source=rss_feed&utm_medium=rss]]></link>
    <dc:creator>Jane Doe</dc:creator>
    <category>Markets</category>
    <description><![CDATA[<p>Spot <b>Bitcoin</b> funds pulled in $1.2B.</p>]]></description>
  </item>
  <item>
    <title>Ethereum upgrade ships</title>
    <pubDate>Sun, 11 Oct 2026 16:00:00 +0000</pubDate>
    <guid>https://example.com/news/eth-upgrade</guid>
    <link>https://example.com/news/eth-upgrade</link>
    <description>Ethereum devs shipped a fork.</description>
  </item>
</channel>
</rss>`

const atomSample = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Sample Atom</title>
  <entry>
    <title>Solana outage resolved</title>
    <link rel="self" href="https://example.org/feed"/>
    <link rel="alternate" href="https://example.org/posts/solana-outage?utm_campaign=x"/>
    <id>tag:example.org,2026:1</id>
    <published>2026-10-11T14:00:00Z</published>
    <updated>2026-10-11T14:30:00Z</updated>
    <author><name>Alice</name></author>
    <category term="Infra"/>
    <summary>Solana validators restored block production.</summary>
  </entry>
</feed>`

func testSource() Source {
	return Source{
		ID: "example", Name: "Example", Label: "Example", Domain: "example.com",
		Category: "publisher", Language: "en",
		FeedURL: "https://example.com/rss", Method: MethodRSS,
		Topics: []string{"markets"}, Status: StatusWorking,
		Evidence: "test fixture",
	}
}

func TestParseRSS(t *testing.T) {
	items, kind, err := parseFeed([]byte(rssSample))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if kind != "rss" {
		t.Fatalf("kind = %q, want rss", kind)
	}
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2", len(items))
	}
	first := items[0]
	if first.Title != "Bitcoin ETF sees record inflows" {
		t.Fatalf("title = %q", first.Title)
	}
	if !strings.Contains(first.Summary, "Bitcoin") || strings.Contains(first.Summary, "<") {
		t.Fatalf("summary not de-marked: %q", first.Summary)
	}
	if first.Author != "Jane Doe" {
		t.Fatalf("author = %q", first.Author)
	}
	if len(first.Topics) != 1 || first.Topics[0] != "Markets" {
		t.Fatalf("topics = %v", first.Topics)
	}
}

func TestParseAtom(t *testing.T) {
	items, kind, err := parseFeed([]byte(atomSample))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if kind != "atom" {
		t.Fatalf("kind = %q, want atom", kind)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	it := items[0]
	if it.URL != "https://example.org/posts/solana-outage?utm_campaign=x" {
		t.Fatalf("url = %q (rel=self link must not win)", it.URL)
	}
	if it.Author != "Alice" {
		t.Fatalf("author = %q", it.Author)
	}
}

func TestParseUnrecognizedRootIsEmptyNotError(t *testing.T) {
	items, kind, err := parseFeed([]byte(`{"json":true}`))
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if kind != "" || items != nil {
		t.Fatalf("kind=%q items=%v, want empty", kind, items)
	}
}

func TestParseMalformedIsError(t *testing.T) {
	if _, _, err := parseFeed([]byte(`<rss><channel><item><title>x</title>`)); err == nil {
		t.Fatal("want error for truncated rss")
	}
}

func TestCanonicalURLStripsTracking(t *testing.T) {
	got := canonicalURL("HTTPS://Example.COM/news/post/?utm_source=rss&utm_medium=rss&b=2&a=1#frag")
	want := "https://example.com/news/post/?a=1&b=2"
	if got != want {
		t.Fatalf("canonicalURL = %q, want %q", got, want)
	}
}

func TestParseTimeFlex(t *testing.T) {
	cases := []struct {
		in   string
		want time.Time
		ok   bool
	}{
		{"Sun, 11 Oct 2026 17:03:00 +0000", time.Date(2026, 10, 11, 17, 3, 0, 0, time.UTC), true},
		{"Sun, 11 Oct 2026 10:59:00 -0400", time.Date(2026, 10, 11, 14, 59, 0, 0, time.UTC), true},
		{"2026-10-11T14:00:00Z", time.Date(2026, 10, 11, 14, 0, 0, 0, time.UTC), true},
		{"", time.Time{}, false},
		{"not a date", time.Time{}, false},
	}
	for _, c := range cases {
		got, ok := parseTimeFlex(c.in)
		if ok != c.ok || (ok && !got.Equal(c.want)) {
			t.Fatalf("parseTimeFlex(%q) = %v,%v want %v,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestToArticleSetsRetrievedAtNowNotPubDate(t *testing.T) {
	src := testSource()
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	a := toArticle(rawItem{
		ExtID: "https://example.com/news/btc-etf", URL: "https://example.com/news/btc-etf?utm_source=x",
		Title: "Bitcoin hits new high", Summary: "BTC rallied.",
		PublishedAt: "Sun, 11 Oct 2026 17:03:00 +0000",
	}, src, now)

	if !a.RetrievedAt.Equal(now) {
		t.Fatalf("RetrievedAt = %v, want %v", a.RetrievedAt, now)
	}
	if a.PublishedAt == nil || !a.PublishedAt.Equal(time.Date(2026, 10, 11, 17, 3, 0, 0, time.UTC)) {
		t.Fatalf("PublishedAt = %v", a.PublishedAt)
	}
	if a.ArticleID != canon.ArticleKey(providerName, "https://example.com/news/btc-etf") {
		t.Fatalf("ArticleID = %q", a.ArticleID)
	}
	if a.URL != "https://example.com/news/btc-etf" {
		t.Fatalf("URL not canonicalized: %q", a.URL)
	}
	if a.Source != providerName || a.Language == nil || *a.Language != "en" {
		t.Fatalf("source/language wrong: %q %v", a.Source, a.Language)
	}
	if !contains(a.Assets, "BTC") {
		t.Fatalf("assets = %v, want BTC", a.Assets)
	}
}

func TestToArticleNoPubDateLeavesPublishedAtNil(t *testing.T) {
	a := toArticle(rawItem{Title: "t", URL: "https://example.com/x"}, testSource(), time.Now().UTC())
	if a.PublishedAt != nil {
		t.Fatalf("PublishedAt = %v, want nil (never fabricated)", a.PublishedAt)
	}
}

func TestToArticleFallsBackToContentHashWhenNoID(t *testing.T) {
	a := toArticle(rawItem{Title: "Headline", URL: "https://example.com/x"}, testSource(), time.Now().UTC())
	if !strings.HasPrefix(a.ArticleID, "article/newsfeed/") {
		t.Fatalf("ArticleID = %q", a.ArticleID)
	}
	if a.ArticleID == canon.ArticleKey(providerName, "") {
		t.Fatal("empty provider id leaked into the key")
	}
}

func TestFetchWritesRowsOnce(t *testing.T) {
	do := &fakeDoer{status: 200, body: rssSample, headers: http.Header{"Etag": {"\"v1\""}}}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	w := &captureWriter{}

	res, err := f.Fetch(context.Background(), ingest.Job{Dataset: "example"}, w)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsIn != 2 || res.RowsWritten != 2 || res.RowsRejected != 0 {
		t.Fatalf("result = %+v", res)
	}
	if len(w.articles) != 2 {
		t.Fatalf("written = %d, want 2", len(w.articles))
	}
	if res.Next["etag"] != "\"v1\"" {
		t.Fatalf("cursor etag = %v", res.Next["etag"])
	}
	if res.Next["last_published_at"] != "2026-10-11T17:03:00Z" {
		t.Fatalf("cursor last_published_at = %v", res.Next["last_published_at"])
	}
}

func TestFetchSendsConditionalHeaders(t *testing.T) {
	do := &fakeDoer{status: 200, body: rssSample}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	_, err := f.Fetch(context.Background(), ingest.Job{Cursor: ingest.Cursor{
		"etag": "\"abc\"", "last_modified": "Sun, 11 Oct 2026 17:00:00 GMT",
	}}, &captureWriter{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	req := do.seen[0]
	if req.Header.Get("If-None-Match") != "\"abc\"" {
		t.Fatalf("If-None-Match = %q", req.Header.Get("If-None-Match"))
	}
	if req.Header.Get("If-Modified-Since") != "Sun, 11 Oct 2026 17:00:00 GMT" {
		t.Fatalf("If-Modified-Since = %q", req.Header.Get("If-Modified-Since"))
	}
}

func TestFetch304WritesNothing(t *testing.T) {
	do := &fakeDoer{status: 304}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	w := &captureWriter{}
	res, err := f.Fetch(context.Background(), ingest.Job{Cursor: ingest.Cursor{"etag": "\"v1\""}}, w)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if res.RowsIn != 0 || res.RowsWritten != 0 || len(w.articles) != 0 {
		t.Fatalf("304 must write nothing: %+v %d", res, len(w.articles))
	}
	if res.Next["etag"] != "\"v1\"" {
		t.Fatalf("cursor must carry previous etag: %v", res.Next["etag"])
	}
}

func TestFetch429IsStatusHardError(t *testing.T) {
	do := &fakeDoer{status: 429, body: "slow down", headers: http.Header{"Retry-After": {"120"}}}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	_, err := f.Fetch(context.Background(), ingest.Job{}, &captureWriter{})
	var he *HardError
	if !errors.As(err, &he) {
		t.Fatalf("err = %v, want *HardError", err)
	}
	if he.Kind != "status" || he.Status != 429 {
		t.Fatalf("hard error = %+v", he)
	}
	if !strings.Contains(he.Detail, "retry-after:120") {
		t.Fatalf("detail = %q", he.Detail)
	}
}

func TestFetchNonFeedBodyIsShapeError(t *testing.T) {
	do := &fakeDoer{status: 200, body: "<html><body>login</body></html>"}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	_, err := f.Fetch(context.Background(), ingest.Job{}, &captureWriter{})
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "shape" {
		t.Fatalf("err = %v, want shape HardError", err)
	}
}

func TestFetchEmptyFeedIsZeroRowsNotError(t *testing.T) {
	do := &fakeDoer{status: 200, body: `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	res, err := f.Fetch(context.Background(), ingest.Job{}, &captureWriter{})
	if err != nil {
		t.Fatalf("empty feed must not error: %v", err)
	}
	if res.RowsIn != 0 {
		t.Fatalf("rows = %d", res.RowsIn)
	}
}

func TestFetchOversizedBodyIsShapeError(t *testing.T) {
	big := strings.Repeat("a", maxBodyBytes+1)
	do := &fakeDoer{status: 200, body: big}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	_, err := f.Fetch(context.Background(), ingest.Job{}, &captureWriter{})
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "shape" || !strings.Contains(he.Detail, "cap") {
		t.Fatalf("err = %v, want cap shape HardError", err)
	}
}

func TestFetchNonWorkingSourceIsNoCredentials(t *testing.T) {
	src := testSource()
	src.Status = StatusPendingCreds
	src.BlockReason = "needs a key"
	f := &fetcher{src: src, client: newClient(&fakeDoer{status: 200}, 0)}
	_, err := f.Fetch(context.Background(), ingest.Job{}, &captureWriter{})
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "no-credentials" {
		t.Fatalf("err = %v, want no-credentials", err)
	}
}

func TestFetchWriterErrorPropagates(t *testing.T) {
	do := &fakeDoer{status: 200, body: rssSample}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	sentinel := errors.New("db down")
	_, err := f.Fetch(context.Background(), ingest.Job{}, &captureWriter{fail: sentinel})
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want sentinel", err)
	}
}

func TestSSRFGuard(t *testing.T) {
	blocked := []string{
		"http://127.0.0.1/x", "http://localhost/x", "http://10.0.0.5/x",
		"http://192.168.1.1/x", "http://172.16.0.1/x", "http://169.254.169.254/latest/meta-data",
		"file:///etc/passwd", "ftp://example.com/x", "http://user:pass@example.com/x",
	}
	for _, u := range blocked {
		if ssrfBlocked(u) == "" {
			t.Errorf("ssrfBlocked(%q) = allowed, want blocked", u)
		}
	}
	allowed := []string{"https://cointelegraph.com/rss", "https://example.com/feed", "http://example.org/a"}
	for _, u := range allowed {
		if r := ssrfBlocked(u); r != "" {
			t.Errorf("ssrfBlocked(%q) = %q, want allowed", u, r)
		}
	}
}

func TestTransportErrorIsHardError(t *testing.T) {
	do := &fakeDoer{err: errors.New("dial tcp: timeout")}
	f := &fetcher{src: testSource(), client: newClient(do, 0)}
	_, err := f.Fetch(context.Background(), ingest.Job{}, &captureWriter{})
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "transport" {
		t.Fatalf("err = %v, want transport HardError", err)
	}
}

func TestModuleContract(t *testing.T) {
	m := NewModule(&fakeDoer{status: 200, body: rssSample})
	if m.Provider() != providerName {
		t.Fatalf("provider = %q", m.Provider())
	}
	fetchers := m.Fetchers()
	if len(fetchers) == 0 {
		t.Fatal("no fetchers registered")
	}
	for _, s := range Sources {
		if s.Status != StatusWorking {
			if _, ok := fetchers[s.ID]; ok {
				t.Errorf("non-working source %s has a fetcher", s.ID)
			}
			continue
		}
		if _, ok := fetchers[s.ID]; !ok {
			t.Errorf("working source %s has no fetcher", s.ID)
		}
	}
	jobs := m.Jobs()
	if len(jobs) != len(fetchers) {
		t.Fatalf("jobs=%d fetchers=%d", len(jobs), len(fetchers))
	}
	for _, j := range jobs {
		if j.Provider != providerName || j.Mode != "poll" || !j.Enabled {
			t.Fatalf("bad job spec: %+v", j)
		}
		if j.Schedule < time.Minute {
			t.Fatalf("sub-minute schedule: %+v", j)
		}
	}
}

func TestValidateSourcesRejectsBadRows(t *testing.T) {
	base := testSource()
	cases := map[string][]Source{
		"empty id":     {{ID: "", Method: MethodRSS, FeedURL: "https://a.com/f"}},
		"dup id":       {base, base},
		"dup domain":   {base, {ID: "other", Domain: "example.com", Method: MethodRSS, FeedURL: "https://b.com/f"}},
		"no feed url":  {{ID: "x", Method: MethodRSS}},
		"blocked url":  {{ID: "x", Method: MethodRSS, FeedURL: "http://127.0.0.1/f"}},
		"working noev": {{ID: "x", Method: MethodRSS, FeedURL: "https://a.com/f", Status: StatusWorking}},
		"block noreason": {{ID: "x", Method: MethodRSS, FeedURL: "https://a.com/f",
			Status: StatusRestricted}},
	}
	for name, srcs := range cases {
		if err := ValidateSources(srcs); err == nil {
			t.Errorf("%s: ValidateSources = nil, want error", name)
		}
	}
	if err := ValidateSources(Sources); err != nil {
		t.Fatalf("built-in Sources must validate: %v", err)
	}
}

func TestLoadManifest(t *testing.T) {
	b := []byte(`{"version":1,"sources":[{"id":"m1","name":"M","label":"M","domain":"m.com","feed_url":"https://m.com/rss","method":"rss","status":"working","evidence":"probe"}]}`)
	srcs, err := LoadManifest(b)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(srcs) != 1 || srcs[0].ID != "m1" {
		t.Fatalf("sources = %+v", srcs)
	}
	if _, err := LoadManifest([]byte("not json")); err == nil {
		t.Fatal("want error on bad json")
	}
}

func TestEnabledSourcesOnlyWorking(t *testing.T) {
	for _, s := range EnabledSources() {
		if s.Status != StatusWorking || s.FeedURL == "" {
			t.Fatalf("enabled source %+v is not dispatchable", s)
		}
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

var _ = bytes.MinRead
