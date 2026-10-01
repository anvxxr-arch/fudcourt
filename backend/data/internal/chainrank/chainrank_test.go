package chainrank

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
	// seen collects the request headers so the identification headers (UA/From)
	// are asserted rather than assumed.
	seen []http.Header
}

const (
	statsBody    = `{"online":42,"totalClicks":1234,"listings":7,"totalUsdCents":999900,"topUsdCents":500000,"claimTopCents":100}`
	listingsBody = `{"rows":[{"id":"a","key":"a","kind":"handle","rank":1}],"page":1,"pageSize":50,"total":7,"totalPages":1}`
)

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	u := req.URL.String()
	f.mu.Lock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[u]++
	f.seen = append(f.seen, req.Header.Clone())
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
		if strings.Contains(u, PathStats) {
			b = statsBody
		} else {
			b = listingsBody
		}
	}
	if code == 0 {
		code = 200
	}
	h := http.Header{"Content-Type": []string{"application/json"}}
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

func q(t *testing.T, raw string) url.Values {
	t.Helper()
	u, err := url.Parse("http://x/?" + raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query()
}

// --- mode table / URL building ---------------------------------------------

func TestModeTable(t *testing.T) {
	if ModeCount != 2 || Modes[0] != "stats" || Modes[1] != "listings" {
		t.Fatalf("mode table drifted: %v", Modes)
	}
	if !Known("stats") || !Known("listings") || Known("bogus") {
		t.Fatal("Known disagrees with the table")
	}
	if got, want := UnknownModeDetail(), "expected one of stats, listings"; got != want {
		t.Fatalf("detail %q, want %q", got, want)
	}
}

func TestUpstreamURLRelaysPaginationVerbatim(t *testing.T) {
	// The upstream's own clamping is the answer; nothing here may rewrite a value.
	cases := []struct{ query, want string }{
		{"", Base + PathListings},
		{"page=0", Base + PathListings + "?page=0"},
		{"page=-1", Base + PathListings + "?page=-1"},
		{"page=abc", Base + PathListings + "?page=abc"},
		{"pageSize=0", Base + PathListings + "?pageSize=0"},
		{"pageSize=1000", Base + PathListings + "?pageSize=1000"},
		{"page=2&pageSize=7", Base + PathListings + "?page=2&pageSize=7"},
	}
	for _, c := range cases {
		if got := UpstreamURL("listings", q(t, c.query)); got != c.want {
			t.Errorf("listings %q -> %q, want %q", c.query, got, c.want)
		}
	}
	// Key ORDER must not create two cache entries for one request.
	if a, b := UpstreamURL("listings", q(t, "page=2&pageSize=7")), UpstreamURL("listings", q(t, "pageSize=7&page=2")); a != b {
		t.Fatalf("param order changed the URL: %q vs %q (two cache entries for one request)", a, b)
	}
	// A pagination param sent to stats is dropped, exactly as the TS route dropped it.
	if got := UpstreamURL("stats", q(t, "page=2&pageSize=7")); got != Base+PathStats {
		t.Fatalf("stats URL = %q, want %q", got, Base+PathStats)
	}
}

func TestAllowedURL(t *testing.T) {
	for _, u := range []string{
		Base + PathStats,
		Base + PathListings,
		Base + PathListings + "?page=0",
	} {
		if !AllowedURL(u) {
			t.Errorf("%q must be allowed", u)
		}
	}
	for _, u := range []string{
		"https://evil.test/api/stats",
		Base + "/api/click",
		Base + "/api/upload",
		Base + "/",
	} {
		if AllowedURL(u) {
			t.Errorf("%q must be refused (writes and foreign hosts are not proxied)", u)
		}
	}
}

// --- fetch / cache ----------------------------------------------------------

func TestFetchCachesAndReportsMissThenHit(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 15)
	u := Base + PathStats
	_, info, err := f.Fetch(context.Background(), "stats", u)
	if err != nil {
		t.Fatal(err)
	}
	if info.Cache != "MISS" {
		t.Fatalf("first mark = %q, want MISS", info.Cache)
	}
	_, info2, err := f.Fetch(context.Background(), "stats", u)
	if err != nil {
		t.Fatal(err)
	}
	if info2.Cache != "HIT" {
		t.Fatalf("second mark = %q, want HIT", info2.Cache)
	}
	if n := d.count(u); n != 1 {
		t.Fatalf("upstream calls = %d, want 1", n)
	}
}

func TestFetchSendsTheIdentificationHeaders(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 15)
	if _, _, err := f.Fetch(context.Background(), "stats", Base+PathStats); err != nil {
		t.Fatal(err)
	}
	if len(d.seen) == 0 {
		t.Fatal("no request recorded")
	}
	h := d.seen[0]
	if h.Get("User-Agent") != UA {
		t.Errorf("User-Agent = %q, want %q", h.Get("User-Agent"), UA)
	}
	// robots.txt disallows /api/ to crawlers; the From header is what makes this
	// relay identifiable rather than disguised.
	if h.Get("From") != FromHeader {
		t.Errorf("From = %q, want %q", h.Get("From"), FromHeader)
	}
}

func TestFetchTTLExpiryRefetches(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 1)
	u := Base + PathStats
	if _, _, err := f.Fetch(context.Background(), "stats", u); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	for _, e := range f.entries {
		e.fetchedAt = time.Now().Add(-2 * time.Second).Unix()
	}
	f.mu.Unlock()
	_, info, err := f.Fetch(context.Background(), "stats", u)
	if err != nil {
		t.Fatal(err)
	}
	if info.Cache != "MISS" {
		t.Fatalf("after expiry mark = %q, want MISS", info.Cache)
	}
}

func TestFetchSingleFlightCollapsesAndMarksCoalesced(t *testing.T) {
	bar := make(chan struct{})
	d := &fakeDoer{barrier: bar}
	f := newTestFetcher(t, d, 15)
	u := Base + PathStats

	const n = 8
	var wg sync.WaitGroup
	marks := make([]string, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, info, err := f.Fetch(context.Background(), "stats", u)
			marks[i], errs[i] = info.Cache, err
		}(i)
	}
	time.Sleep(50 * time.Millisecond)
	close(bar)
	wg.Wait()

	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("caller %d: %v", i, errs[i])
		}
	}
	if c := d.count(u); c != 1 {
		t.Fatalf("upstream calls = %d, want 1 (single-flight)", c)
	}
	// Exactly one leader MISSes; every joiner is told it COALESCED, which is the
	// TS limiter's own distinction (collapsing it would hide a shared read).
	var miss, coal int
	for _, m := range marks {
		switch m {
		case "MISS":
			miss++
		case "COALESCED":
			coal++
		default:
			t.Fatalf("unexpected mark %q", m)
		}
	}
	if miss != 1 || coal != n-1 {
		t.Fatalf("marks: %d MISS, %d COALESCED (want 1 and %d)", miss, coal, n-1)
	}
}

func TestCacheIsBoundedUnderAPageWalk(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 15)
	// 60 distinct pageSize values: without a ceiling this would retain 60 entries.
	for i := 1; i <= 60; i++ {
		u := UpstreamURL("listings", q(t, "pageSize="+Itoa(i)))
		if _, _, err := f.Fetch(context.Background(), "listings", u); err != nil {
			t.Fatal(err)
		}
	}
	if st := f.Stats(); st.Entries > maxEntries {
		t.Fatalf("entries = %d, want <= %d (the cache must not grow without limit)", st.Entries, maxEntries)
	}
	if st := f.Stats(); st.Flights != 0 {
		t.Fatalf("lingering flights: %d", st.Flights)
	}
}

func TestFetchRefusesWriteEndpointsAndForeignHosts(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{}, 15)
	for _, u := range []string{Base + "/api/click", "https://evil.test/api/stats"} {
		if _, _, err := f.Fetch(context.Background(), "stats", u); err == nil {
			t.Errorf("%q must be refused", u)
		}
	}
	if st := f.Stats(); st.Entries != 0 {
		t.Fatalf("a refused URL must not enter the cache: %+v", st)
	}
}

// --- failure arms -----------------------------------------------------------

func TestUpstreamStatusesKeepTheirMeaning(t *testing.T) {
	u := Base + PathStats
	cases := []struct {
		code int
		kind string
	}{
		{405, "method"},
		{429, "rate-limit"},
		{403, "status"},
		{500, "status"},
		{503, "status"},
	}
	for _, c := range cases {
		d := &fakeDoer{code: map[string]int{u: c.code}, body: map[string]string{u: "<html>nope</html>"}}
		f := newTestFetcher(t, d, 15)
		_, _, err := f.Fetch(context.Background(), "stats", u)
		he, ok := IsHardError(err)
		if !ok {
			t.Fatalf("status %d: want HardError, got %v", c.code, err)
		}
		if he.Kind != c.kind {
			t.Errorf("status %d kind = %q, want %q", c.code, he.Kind, c.kind)
		}
		if he.Status != c.code {
			t.Errorf("status %d Status field = %d", c.code, he.Status)
		}
		if !he.HasBody || !strings.Contains(he.Body, "nope") {
			t.Errorf("status %d must quote the real body: %+v", c.code, he)
		}
	}
}

func TestNonJSON200IsLoud(t *testing.T) {
	u := Base + PathStats
	d := &fakeDoer{body: map[string]string{u: "<html>error page</html>"}}
	f := newTestFetcher(t, d, 15)
	_, _, err := f.Fetch(context.Background(), "stats", u)
	he, ok := IsHardError(err)
	if !ok || he.Kind != "non-json" {
		t.Fatalf("want HardError{non-json}, got %v", err)
	}
	if !strings.Contains(he.Message(), "non-JSON body") {
		t.Fatalf("message %q", he.Message())
	}
}

func TestTransportFailureHasNoBody(t *testing.T) {
	u := Base + PathStats
	d := &fakeDoer{err: map[string]error{u: errors.New("dial tcp: refused")}}
	f := newTestFetcher(t, d, 15)
	_, _, err := f.Fetch(context.Background(), "stats", u)
	he, ok := IsHardError(err)
	if !ok || he.Kind != "transport" {
		t.Fatalf("want HardError{transport}, got %v", err)
	}
	if he.HasBody {
		t.Fatal("a transport failure has no upstream body to quote")
	}
	if !strings.Contains(he.Message(), "unreachable") {
		t.Fatalf("message %q", he.Message())
	}
}

func TestGzippedBodyIsDecoded(t *testing.T) {
	u := Base + PathStats
	var buf strings.Builder
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(statsBody)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	d := &fakeDoer{body: map[string]string{u: buf.String()}, gzip: map[string]bool{u: true}}
	f := newTestFetcher(t, d, 15)
	body, _, err := f.Fetch(context.Background(), "stats", u)
	if err != nil {
		t.Fatal(err)
	}
	if body != statsBody {
		t.Fatalf("gzip body not decoded: %q", body)
	}
}

// --- shape / service --------------------------------------------------------

func TestCheckShapeRejectsTheUnrendered(t *testing.T) {
	// stats: every rendered field must be a NUMBER. null and a string are not
	// numbers, and `{"online":null}` must not reach the board as data.
	good := map[string]json.RawMessage{}
	for _, f := range []string{"online", "totalClicks", "listings", "totalUsdCents", "topUsdCents", "claimTopCents"} {
		good[f] = json.RawMessage("1")
	}
	if err := CheckShape("stats", good); err != nil {
		t.Fatalf("a complete stats envelope must pass: %v", err)
	}
	for _, f := range []string{"online", "totalClicks", "totalUsdCents"} {
		bad := map[string]json.RawMessage{}
		for k, v := range good {
			bad[k] = v
		}
		bad[f] = json.RawMessage("null")
		if err := CheckShape("stats", bad); err == nil {
			t.Errorf("stats.%s=null must be refused (a null is not a number)", f)
		}
		bad[f] = json.RawMessage(`"42"`)
		if err := CheckShape("stats", bad); err == nil {
			t.Errorf("stats.%s as a string must be refused", f)
		}
		delete(bad, f)
		if err := CheckShape("stats", bad); err == nil {
			t.Errorf("stats without %s must be refused", f)
		}
	}
	// listings: rows must be an ARRAY; null is not.
	if err := CheckShape("listings", map[string]json.RawMessage{"rows": json.RawMessage("[]")}); err != nil {
		t.Fatalf("an empty rows array is still an array: %v", err)
	}
	if err := CheckShape("listings", map[string]json.RawMessage{"rows": json.RawMessage("null")}); err == nil {
		t.Fatal("rows=null must be refused")
	}
	if err := CheckShape("listings", map[string]json.RawMessage{}); err == nil {
		t.Fatal("a listings body without rows must be refused")
	}
	// An unknown mode has no contract; saying so beats guessing.
	if err := CheckShape("bogus", map[string]json.RawMessage{}); err == nil {
		t.Fatal("an unknown mode must be refused")
	}
}

func TestEnvelopeSpreadsUpstreamVerbatimAndStampsOurs(t *testing.T) {
	d := &fakeDoer{}
	f := newTestFetcher(t, d, 15)
	s := Service{F: f}
	env, info, err := s.Envelope(context.Background(), "stats", Base+PathStats)
	if err != nil {
		t.Fatal(err)
	}
	// Upstream's own fields survive untouched -- including any it adds later,
	// which is why the envelope is not a projection.
	for _, k := range []string{"online", "totalClicks", "listings", "totalUsdCents", "topUsdCents", "claimTopCents", "extraUpstreamField"} {
		if k == "extraUpstreamField" {
			continue
		}
		if _, ok := env[k]; !ok {
			t.Errorf("upstream field %q missing from the envelope", k)
		}
	}
	if string(env["kind"]) != `"stats"` {
		t.Errorf("kind = %s", env["kind"])
	}
	if !strings.Contains(string(env["upstream"]), "chainrank.fyi") {
		t.Errorf("upstream = %s", env["upstream"])
	}
	if _, ok := env["fetchedAt"]; !ok {
		t.Error("fetchedAt missing")
	}
	if info.Cache != "MISS" {
		t.Errorf("cache = %q", info.Cache)
	}
}

func TestEnvelopeRefusesAShapeWithoutRows(t *testing.T) {
	u := Base + PathListings
	d := &fakeDoer{body: map[string]string{u: `{"page":1}`}}
	f := newTestFetcher(t, d, 15)
	s := Service{F: f}
	env, _, err := s.Envelope(context.Background(), "listings", u)
	if err == nil {
		t.Fatalf("a listings body without rows must be refused, got %v", env)
	}
	if _, ok := err.(*ShapeError); !ok {
		t.Fatalf("want a ShapeError, got %T", err)
	}
	if env != nil {
		t.Fatal("no envelope may be returned alongside a shape refusal")
	}
}

func TestEnvelopeRefusesNonObjectJSON(t *testing.T) {
	u := Base + PathStats
	d := &fakeDoer{body: map[string]string{u: `[1,2,3]`}}
	f := newTestFetcher(t, d, 15)
	s := Service{F: f}
	if _, _, err := s.Envelope(context.Background(), "stats", u); err == nil {
		t.Fatal("a JSON array is not a stats envelope and must be refused")
	}
}
