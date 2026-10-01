package news

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeDoer serves canned bodies per URL, counts requests and can block a
// response, so the cache, the single-flight and every error arm are proven by
// an observable rather than by trust.
type fakeDoer struct {
	mu      sync.Mutex
	calls   map[string]int
	body    map[string]string
	code    map[string]int
	err     map[string]error
	gzip    map[string]bool
	barrier chan struct{}
}

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	u := req.URL.String()
	f.mu.Lock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[u]++
	b, ok := f.body[u]
	code := f.code[u]
	e := f.err[u]
	bar := f.barrier
	gz := f.gzip[u]
	f.mu.Unlock()
	if bar != nil {
		<-bar
	}
	if e != nil {
		return nil, e
	}
	if !ok {
		b = feedXML(item("Headline one", "https://example.test/1", "Body one"))
	}
	if code == 0 {
		code = 200
	}
	h := http.Header{"Content-Type": []string{"application/xml"}}
	if gz {
		h.Set("Content-Encoding", "gzip")
	}
	return &http.Response{
		StatusCode: code,
		Body:       io.NopCloser(strings.NewReader(b)),
		Header:     h,
		Request:    req,
	}, nil
}

func (f *fakeDoer) count(u string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[u]
}

func newTestFetcher(t *testing.T, d Doer, ttl int) *Fetcher {
	t.Helper()
	f, err := New(Options{Client: d, TTL: ttl})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f
}

// item builds one <item> block; the CDATA spelling is used for the title so the
// CDATA arm of textRe is exercised by every test that uses this helper.
func item(title, link, desc string) string {
	return "<item><title><![CDATA[" + title + "]]></title>" +
		"<link>" + link + "</link>" +
		"<description><![CDATA[<p>" + desc + "</p>]]></description>" +
		"<pubDate>Mon, 29 Sep 2026 15:53:54 +0000</pubDate>" +
		"<media:content url=\"https://img.test/a.jpg\"/></item>"
}

func feedXML(items ...string) string {
	return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
		"<title>Cointelegraph</title>" + strings.Join(items, "") + "</channel></rss>"
}

func mustItems(t *testing.T, xml string) []Item {
	t.Helper()
	items := ParseItems(xml, "Cointelegraph")
	if len(items) == 0 {
		t.Fatalf("ParseItems found no items in %q", xml)
	}
	return items
}

// --- parser -----------------------------------------------------------------

func TestParseItemsProjectsSixKeys(t *testing.T) {
	items := mustItems(t, feedXML(item("Hello <b>world</b>", "https://n.test/x", "A summary")))
	got := items[0]
	if got.Title != "Hello <b>world</b>" {
		t.Errorf("title: %q (the CDATA body must survive verbatim; the feed owns its markup)", got.Title)
	}
	if got.Link != "https://n.test/x" {
		t.Errorf("link: %q", got.Link)
	}
	if got.Description != "A summary" {
		t.Errorf("description: %q (HTML must be stripped)", got.Description)
	}
	if got.PubDate != "Mon, 29 Sep 2026 15:53:54 +0000" {
		t.Errorf("pubDate: %q", got.PubDate)
	}
	if got.Image != "https://img.test/a.jpg" {
		t.Errorf("image: %q", got.Image)
	}
	if got.Source != "Cointelegraph" {
		t.Errorf("source: %q (the feed table's label, not the param name)", got.Source)
	}
	// Every key must be PRESENT on the wire even when upstream omitted the tag:
	// the TS route initialised each to '' and a missing key would be a wire
	// change no verifier could see coming.
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"title", "link", "description", "pubDate", "image", "source"} {
		if !strings.Contains(string(raw), `"`+k+`":`) {
			t.Errorf("key %q missing from %s", k, raw)
		}
	}
}

func TestParseItemsAbsentTagsBecomeEmptyStringsNotNulls(t *testing.T) {
	items := mustItems(t, feedXML("<item><title>Only a title</title></item>"))
	raw, err := json.Marshal(items[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "null") {
		t.Fatalf("absent tags must serialise as empty strings, got %s", raw)
	}
	if items[0].Image != "" || items[0].PubDate != "" || items[0].Description != "" {
		t.Fatalf("absent tags must be empty strings: %+v", items[0])
	}
}

func TestParseItemsBareAndCdataSpellingsAgree(t *testing.T) {
	cdata := mustItems(t, feedXML("<item><title><![CDATA[Same]]></title><link><![CDATA[https://n.test/x]]></link></item>"))[0]
	bare := mustItems(t, feedXML("<item><title>Same</title><link>https://n.test/x</link></item>"))[0]
	if cdata.Title != bare.Title || cdata.Link != bare.Link {
		t.Fatalf("CDATA and bare spellings disagree: %+v vs %+v", cdata, bare)
	}
}

func TestParseItemsDescriptionClipsTo200Runes(t *testing.T) {
	long := strings.Repeat("x", 250)
	items := mustItems(t, feedXML(item("t", "l", long)))
	if n := len([]rune(items[0].Description)); n != 200 {
		t.Fatalf("description runes = %d, want 200", n)
	}
	// A multi-byte character at the clip boundary must not be cut in half (the
	// TS UTF-16 slice could split a surrogate pair; runes cannot).
	wide := strings.Repeat("é", 250)
	items = mustItems(t, feedXML(item("t", "l", wide)))
	if n := len([]rune(items[0].Description)); n != 200 {
		t.Fatalf("wide description runes = %d, want 200", n)
	}
	if strings.ContainsRune(items[0].Description, '\uFFFD') {
		t.Fatal("clipping produced a replacement character")
	}
}

func TestParseItemsNoItemsIsNil(t *testing.T) {
	if got := ParseItems("<rss><channel><title>empty</title></channel></rss>", "Cointelegraph"); got != nil {
		t.Fatalf("a feed with no <item> must return nil (the loud-empty arm), got %v", got)
	}
}

// --- params -----------------------------------------------------------------

func TestParseLimitStrictMatrix(t *testing.T) {
	cases := []struct {
		query   string
		want    int
		wantErr string
	}{
		{"", 30, ""},
		{"?limit=5", 5, ""},
		{"?limit=1", 1, ""},
		{"?limit=100", 100, ""},
		{"?limit=", 0, "limit must be an integer, got ''"},
		{"?limit=abc", 0, "limit must be an integer, got 'abc'"},
		{"?limit=-1", 0, "limit must be an integer, got '-1'"},
		{"?limit=1.5", 0, "limit must be an integer, got '1.5'"},
		{"?limit=0", 0, "limit must be between 1 and 100, got 0"},
		{"?limit=101", 0, "limit must be between 1 and 100, got 101"},
		{"?limit=99999999999999999999", 0, "limit must be between 1 and 100, got 99999999999999999999"},
	}
	for _, c := range cases {
		q := parseQuery(t, c.query)
		got, err := ParseLimit(q)
		if c.wantErr == "" {
			if err != nil {
				t.Errorf("%q: unexpected error %v", c.query, err)
				continue
			}
			if got != c.want {
				t.Errorf("%q: got %d, want %d", c.query, got, c.want)
			}
			continue
		}
		if err == nil {
			t.Errorf("%q: expected the 400 %q, got %d", c.query, c.wantErr, got)
			continue
		}
		if err.Error() != c.wantErr {
			t.Errorf("%q: message %q, want %q", c.query, err.Error(), c.wantErr)
		}
	}
}

func TestParseSourceStrict(t *testing.T) {
	src, err := ParseSource(parseQuery(t, ""))
	if err != nil || src.Name != DefaultSource {
		t.Fatalf("absent source must default to %q: %+v %v", DefaultSource, src, err)
	}
	if _, err := ParseSource(parseQuery(t, "?source=cointelegraph")); err != nil {
		t.Fatalf("the one wired source must resolve: %v", err)
	}
	_, err = ParseSource(parseQuery(t, "?source=cnn"))
	var ue *UnknownSourceError
	if !errors.As(err, &ue) {
		t.Fatalf("an unknown source must be an UnknownSourceError, got %v", err)
	}
	if err.Error() != "unknown source 'cnn'" {
		t.Fatalf("message %q", err.Error())
	}
	if want := "expected one of cointelegraph"; UnknownSourceDetail() != want {
		t.Fatalf("detail %q, want %q", UnknownSourceDetail(), want)
	}
	// An unknown source must never be coerced into an empty feed.
	if _, err := ParseSource(parseQuery(t, "?source=")); err == nil {
		t.Fatal("an empty source must be a 400, not the default")
	}
}

// --- fetch / cache ----------------------------------------------------------

func TestFetchCachesAndReportsMissThenHit(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 15)
	url := Sources[0].URL

	_, items, info, err := f.Fetch(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	if info.Cache != "MISS" {
		t.Fatalf("first fetch cache mark = %q, want MISS", info.Cache)
	}
	if len(items) != 1 || info.ItemCount != 1 {
		t.Fatalf("items=%d info.ItemCount=%d, want 1", len(items), info.ItemCount)
	}
	_, _, info2, err := f.Fetch(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	if info2.Cache != "HIT" {
		t.Fatalf("second fetch cache mark = %q, want HIT", info2.Cache)
	}
	if n := d.count(url); n != 1 {
		t.Fatalf("upstream calls = %d, want 1 (the cache must absorb the second read)", n)
	}
}

func TestFetchTTLExpiryRefetches(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 1)
	url := Sources[0].URL
	if _, _, _, err := f.Fetch(context.Background(), url); err != nil {
		t.Fatal(err)
	}
	// Age the entry rather than sleeping a second: the clock the cache consults
	// is fetchedAt, so the rule under test is the TTL comparison itself.
	f.mu.Lock()
	for _, e := range f.entries {
		e.fetchedAt = time.Now().Add(-2 * time.Second).Unix()
	}
	f.mu.Unlock()
	_, _, info, err := f.Fetch(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	if info.Cache != "MISS" {
		t.Fatalf("after TTL expiry the mark = %q, want MISS", info.Cache)
	}
	if n := d.count(url); n != 2 {
		t.Fatalf("upstream calls = %d, want 2", n)
	}
}

func TestFetchSingleFlightCollapsesConcurrentColdFetches(t *testing.T) {
	bar := make(chan struct{})
	d := &fakeDoer{barrier: bar}
	f := newTestFetcher(t, d, 15)
	url := Sources[0].URL

	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	marks := make([]string, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, info, err := f.Fetch(context.Background(), url)
			errs[i], marks[i] = err, info.Cache
		}(i)
	}
	// Give the goroutines time to stack onto the flight, then release it.
	time.Sleep(50 * time.Millisecond)
	close(bar)
	wg.Wait()

	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("caller %d: %v", i, errs[i])
		}
		if marks[i] != "MISS" {
			t.Fatalf("caller %d mark = %q; joiners share the leader's result", i, marks[i])
		}
	}
	if c := d.count(url); c != 1 {
		t.Fatalf("upstream calls = %d, want 1 (single-flight)", c)
	}
}

func TestFetchRefusesNonTableURL(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{}, 15)
	if _, _, _, err := f.Fetch(context.Background(), "https://evil.test/rss"); err == nil {
		t.Fatal("a URL outside the feed table must be refused (the cache is bounded by construction)")
	}
	if st := f.Stats(); st.Entries != 0 {
		t.Fatalf("a refused URL must not enter the cache: %+v", st)
	}
}

func TestCacheIsBoundedByConstruction(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 15)
	url := Sources[0].URL
	for i := 0; i < 5; i++ {
		if _, _, _, err := f.Fetch(context.Background(), url); err != nil {
			t.Fatal(err)
		}
	}
	if st := f.Stats(); st.Entries != 1 || st.Flights != 0 {
		t.Fatalf("stats = %+v, want one entry and no lingering flights", st)
	}
}

// --- failure arms -----------------------------------------------------------

func TestUpstreamStatusKeepsRealStatus(t *testing.T) {
	url := Sources[0].URL
	for _, code := range []int{403, 429, 500, 503} {
		d := &fakeDoer{code: map[string]int{url: code}, body: map[string]string{url: "<html>wall</html>"}}
		f := newTestFetcher(t, d, 15)
		_, _, _, err := f.Fetch(context.Background(), url)
		he, ok := IsHardError(err)
		if !ok {
			t.Fatalf("status %d: want a HardError, got %v", code, err)
		}
		if he.Status != code {
			t.Fatalf("status %d: HardError.Status = %d", code, he.Status)
		}
		if code == 429 && he.Kind != "rate-limit" {
			t.Fatalf("429 kind = %q, want rate-limit", he.Kind)
		}
		if code != 429 && he.Kind != "status" {
			t.Fatalf("status %d kind = %q", code, he.Kind)
		}
		if !he.HasBody || !strings.Contains(he.Body, "wall") {
			t.Fatalf("status %d must quote the real body: %+v", code, he)
		}
	}
}

func TestEmptyFeedIsALoudRefusal(t *testing.T) {
	url := Sources[0].URL
	d := &fakeDoer{body: map[string]string{url: "<rss><channel><title>none</title></channel></rss>"}}
	f := newTestFetcher(t, d, 15)
	_, _, _, err := f.Fetch(context.Background(), url)
	he, ok := IsHardError(err)
	if !ok || he.Kind != "empty" {
		t.Fatalf("an empty feed must be a HardError{empty}, got %v", err)
	}
	if he.Message() != "upstream returned an empty feed" {
		t.Fatalf("message %q", he.Message())
	}
}

func TestTransportFailureIsHardErrorWithoutBody(t *testing.T) {
	url := Sources[0].URL
	d := &fakeDoer{err: map[string]error{url: errors.New("dial tcp: refused")}}
	f := newTestFetcher(t, d, 15)
	_, _, _, err := f.Fetch(context.Background(), url)
	he, ok := IsHardError(err)
	if !ok || he.Kind != "transport" {
		t.Fatalf("want HardError{transport}, got %v", err)
	}
	if he.HasBody {
		t.Fatal("a transport failure has no upstream body to quote")
	}
	if he.Message() != "upstream request failed" {
		t.Fatalf("message %q", he.Message())
	}
}

func TestGzippedFeedIsDecoded(t *testing.T) {
	url := Sources[0].URL
	var buf strings.Builder
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(feedXML(item("Zipped", "https://n.test/z", "d")))); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	d := &fakeDoer{body: map[string]string{url: buf.String()}, gzip: map[string]bool{url: true}}
	f := newTestFetcher(t, d, 15)
	_, items, _, err := f.Fetch(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Title != "Zipped" {
		t.Fatalf("gzip body not decoded: %+v", items)
	}
}

// --- service ----------------------------------------------------------------

func TestEnvelopeHeadAndTotalAreDistinct(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 15)
	s := Service{F: f}
	env, err := s.Envelope(context.Background(), Sources[0], 1)
	if err != nil {
		t.Fatal(err)
	}
	if env.Total != 1 {
		t.Fatalf("total = %d, want the full parsed count", env.Total)
	}
	if env.Upstream != Sources[0].URL {
		t.Fatalf("upstream = %q", env.Upstream)
	}
	if env.Cache != "MISS" {
		t.Fatalf("cache = %q", env.Cache)
	}
	if env.Timestamp == 0 {
		t.Fatal("timestamp must be set (milliseconds, like Date.now())")
	}
	if env.Timestamp < 1e12 {
		t.Fatalf("timestamp = %d: the TS route wrote milliseconds", env.Timestamp)
	}
}

func TestEnvelopeLimitSlicesCachedDocument(t *testing.T) {
	url := Sources[0].URL
	three := feedXML(
		item("a", "https://n.test/a", "d"),
		item("b", "https://n.test/b", "d"),
		item("c", "https://n.test/c", "d"),
	)
	d := &fakeDoer{body: map[string]string{url: three}}
	f := newTestFetcher(t, d, 15)
	s := Service{F: f}

	env, err := s.Envelope(context.Background(), Sources[0], 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(env.Items) != 2 || env.Total != 3 {
		t.Fatalf("items=%d total=%d, want 2 of 3", len(env.Items), env.Total)
	}
	env2, err := s.Envelope(context.Background(), Sources[0], 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(env2.Items) != 3 {
		t.Fatalf("second limit items = %d, want 3", len(env2.Items))
	}
	if c := d.count(url); c != 1 {
		t.Fatalf("upstream calls = %d, want 1: the limit slice must apply to the cached document", c)
	}
}

func TestEnvelopeNeverSubstitutesPayloadForError(t *testing.T) {
	url := Sources[0].URL
	d := &fakeDoer{code: map[string]int{url: 503}}
	f := newTestFetcher(t, d, 15)
	s := Service{F: f}
	env, err := s.Envelope(context.Background(), Sources[0], 5)
	if err == nil {
		t.Fatalf("a failing upstream must return an error, got %+v", env)
	}
	if env.Items != nil {
		t.Fatal("no payload may be substituted for a failure")
	}
}

// --- helpers ----------------------------------------------------------------

// parseQuery turns a query fragment ("?limit=5") into url.Values.
func parseQuery(t *testing.T, raw string) url.Values {
	t.Helper()
	u, err := url.Parse("http://x/?" + strings.TrimPrefix(raw, "?"))
	if err != nil {
		t.Fatal(err)
	}
	return u.Query()
}
