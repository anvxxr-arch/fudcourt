package khala

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeDoer is the injected transport: every test below proves a cache/ETag/
// error path without touching the network.
type fakeDoer struct {
	mu    sync.Mutex
	calls []string
	// conds records the If-None-Match value of every request.
	conds []string
	// resp maps a URL to a canned response builder; body is the raw bytes.
	n       atomic.Int64
	handler func(req *http.Request) *http.Response
	delay   time.Duration
}

func (d *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	d.n.Add(1)
	d.mu.Lock()
	d.calls = append(d.calls, req.URL.String())
	d.conds = append(d.conds, req.Header.Get("If-None-Match"))
	h := d.handler
	d.mu.Unlock()
	if d.delay > 0 {
		time.Sleep(d.delay)
	}
	if h == nil {
		return nil, errors.New("no handler")
	}
	return h(req), nil
}

func (d *fakeDoer) callCount() int { return int(d.n.Load()) }

func (d *fakeDoer) ifNoneMatch() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.conds...)
}

func res(status int, body string, hdr map[string]string) *http.Response {
	h := http.Header{}
	for k, v := range hdr {
		h.Set(k, v)
	}
	return &http.Response{
		StatusCode: status,
		Header:     h,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func newTestFetcher(t *testing.T, d Doer) *Fetcher {
	t.Helper()
	f, err := New(Options{CacheDir: t.TempDir(), Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f
}

func TestFetchMissThenHitWithinTTL(t *testing.T) {
	d := &fakeDoer{handler: func(*http.Request) *http.Response {
		return res(200, "<html>one</html>", map[string]string{"ETag": `"abc"`})
	}}
	f := newTestFetcher(t, d)
	body, info, err := f.Fetch(context.Background(), HomeURL, 900)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if body != "<html>one</html>" || info.Cache != "MISS" {
		t.Fatalf("first: body=%q cache=%q", body, info.Cache)
	}
	body, info, err = f.Fetch(context.Background(), HomeURL, 900)
	if err != nil {
		t.Fatalf("Fetch 2: %v", err)
	}
	if body != "<html>one</html>" || info.Cache != "HIT" {
		t.Fatalf("second: body=%q cache=%q want HIT", body, info.Cache)
	}
	if d.callCount() != 1 {
		t.Errorf("upstream calls=%d want 1 (a TTL HIT must not refetch)", d.callCount())
	}
}

func TestFreshBypassesTheCache(t *testing.T) {
	var n atomic.Int64
	d := &fakeDoer{handler: func(*http.Request) *http.Response {
		return res(200, "body", map[string]string{"ETag": `"e"`})
	}}
	f := newTestFetcher(t, d)
	if _, _, err := f.Fetch(context.Background(), HomeURL, 900); err != nil {
		t.Fatal(err)
	}
	// ttl 0 (fresh=1) must go upstream even though a fresh entry is on disk.
	_, info, err := f.Fetch(context.Background(), HomeURL, 0)
	if err != nil {
		t.Fatal(err)
	}
	if info.Cache != "MISS" {
		t.Errorf("cache=%q want MISS for ttl=0", info.Cache)
	}
	if d.callCount() != 2 {
		t.Errorf("calls=%d want 2 (fresh bypasses the TTL cache)", d.callCount())
	}
	_ = n.Load()
}

// The measured politeness mechanism: khala.io sends a strong ETag and answers a
// conditional GET with 304. A 304 must serve the STORED body as a HIT, and the
// request must carry If-None-Match.
func TestETagRevalidationServesStoredBodyAsHit(t *testing.T) {
	d := &fakeDoer{}
	d.handler = func(req *http.Request) *http.Response {
		if req.Header.Get("If-None-Match") == `"v1"` {
			return res(304, "", map[string]string{"ETag": `"v1"`})
		}
		return res(200, "<html>stored</html>", map[string]string{"ETag": `"v1"`})
	}
	f := newTestFetcher(t, d)
	if _, _, err := f.Fetch(context.Background(), HomeURL, 900); err != nil {
		t.Fatal(err)
	}
	// Age the entry past the TTL to force a revalidation rather than a HIT.
	cf := f.CacheFile(HomeURL)
	e, err := readEntry(cf)
	if err != nil {
		t.Fatal(err)
	}
	e.FetchedAt = time.Now().Add(-2 * time.Hour).Unix()
	if err := writeEntry(cf, e); err != nil {
		t.Fatal(err)
	}
	body, info, err := f.Fetch(context.Background(), HomeURL, 900)
	if err != nil {
		t.Fatal(err)
	}
	if body != "<html>stored</html>" {
		t.Fatalf("body=%q want the stored body", body)
	}
	if info.Cache != "HIT" || !info.Revalidated {
		t.Errorf("info=%+v want HIT+Revalidated", info)
	}
	conds := d.ifNoneMatch()
	if len(conds) < 2 || conds[1] != `"v1"` {
		t.Errorf("second request If-None-Match=%v want the stored ETag", conds)
	}
	// The refreshed timestamp restarts the TTL window.
	e2, err := readEntry(cf)
	if err != nil {
		t.Fatal(err)
	}
	if e2.FetchedAt <= e.FetchedAt {
		t.Errorf("FetchedAt not refreshed: %d -> %d", e.FetchedAt, e2.FetchedAt)
	}
}

func TestSingleFlightCollapsesConcurrentIdenticalKeys(t *testing.T) {
	d := &fakeDoer{delay: 50 * time.Millisecond}
	d.handler = func(*http.Request) *http.Response {
		return res(200, "slow", map[string]string{"ETag": `"x"`})
	}
	f := newTestFetcher(t, d)
	const n = 8
	var wg sync.WaitGroup
	wg.Add(n)
	for range n {
		go func() {
			defer wg.Done()
			if _, _, err := f.Fetch(context.Background(), HomeURL, 900); err != nil {
				t.Errorf("Fetch: %v", err)
			}
		}()
	}
	wg.Wait()
	if d.callCount() != 1 {
		t.Errorf("upstream calls=%d want 1 (single-flight)", d.callCount())
	}
	if f.InFlight() != 0 {
		t.Errorf("InFlight=%d want 0 after completion", f.InFlight())
	}
}

// fresh=1 (ttl 0) deliberately bypasses single-flight: a fresh request must
// never be satisfied by an in-flight fetch.
func TestFreshBypassesSingleFlight(t *testing.T) {
	d := &fakeDoer{delay: 50 * time.Millisecond}
	d.handler = func(*http.Request) *http.Response {
		return res(200, "slow", map[string]string{"ETag": `"x"`})
	}
	f := newTestFetcher(t, d)
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := f.Fetch(context.Background(), HomeURL, 0); err != nil {
				t.Errorf("Fetch: %v", err)
			}
		}()
	}
	wg.Wait()
	if d.callCount() != 4 {
		t.Errorf("upstream calls=%d want 4 (ttl=0 bypasses single-flight)", d.callCount())
	}
}

// The decoy contract: a nonexistent slug is a REAL 404 carrying Framer's
// "Page Not Found" page -> a NotFoundError (which the handler turns into its
// own 404), never a fabricated 200.
func TestUpstream404WithFramerMarkerIsNotFound(t *testing.T) {
	d := &fakeDoer{handler: func(*http.Request) *http.Response {
		return res(404, fixture(t, "notfound.html"), map[string]string{"Content-Type": "text/html; charset=utf-8"})
	}}
	f := newTestFetcher(t, d)
	_, _, err := f.Fetch(context.Background(), KeyURL("no-such-report-xyz"), 900)
	var nf *NotFoundError
	if !errors.As(err, &nf) {
		t.Fatalf("err=%v (%T) want *NotFoundError", err, err)
	}
	if nf.Status != 404 {
		t.Errorf("status=%d", nf.Status)
	}
}

// A 404 that is NOT Framer's page is an honest failure, not a "no such report".
func TestUnmarked404IsAHardError(t *testing.T) {
	d := &fakeDoer{handler: func(*http.Request) *http.Response {
		return res(404, "nope", nil)
	}}
	f := newTestFetcher(t, d)
	_, _, err := f.Fetch(context.Background(), KeyURL("some-slug"), 900)
	he, ok := IsHardError(err)
	if !ok {
		t.Fatalf("err=%v (%T) want *HardError", err, err)
	}
	if he.Kind != "status" || he.Status != 404 {
		t.Errorf("hard=%+v", he)
	}
}

// A missing Framer CMS resource answers 403 with an S3-style AccessDenied XML
// body (NOT 404) -- it must be a loud 502 with the real status.
func TestXML403IsAHardError(t *testing.T) {
	d := &fakeDoer{handler: func(*http.Request) *http.Response {
		return res(403, fixture(t, "cms-403.xml"), map[string]string{"Content-Type": "application/xml"})
	}}
	f := newTestFetcher(t, d)
	_, _, err := f.Fetch(context.Background(), SitemapURL, 900)
	he, ok := IsHardError(err)
	if !ok {
		t.Fatalf("err=%v (%T) want *HardError", err, err)
	}
	if he.Kind != "xml-403" || he.Status != 403 {
		t.Errorf("hard=%+v", he)
	}
	if !strings.Contains(he.Detail, "AccessDenied") {
		t.Errorf("detail should carry the real body text: %q", he.Detail)
	}
}

func TestTransportFailureIsAHardError(t *testing.T) {
	d := &fakeDoer{handler: func(*http.Request) *http.Response { return nil }}
	f := newTestFetcher(t, d)
	_, _, err := f.Fetch(context.Background(), HomeURL, 900)
	he, ok := IsHardError(err)
	if !ok || he.Kind != "transport" {
		t.Fatalf("err=%v want transport HardError", err)
	}
	if !strings.Contains(he.Detail, "nil") && !strings.Contains(he.Detail, "panic") {
		t.Logf("transport detail: %q", he.Detail)
	}
}

func TestCacheWritesAreAtomicAndUniqueTmp(t *testing.T) {
	d := &fakeDoer{handler: func(*http.Request) *http.Response {
		return res(200, "x", map[string]string{"ETag": `"e"`})
	}}
	f := newTestFetcher(t, d)
	if _, _, err := f.Fetch(context.Background(), HomeURL, 900); err != nil {
		t.Fatal(err)
	}
	cf := f.CacheFile(HomeURL)
	fi, err := os.Stat(cf)
	if err != nil {
		t.Fatalf("cache file not written: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o644 {
		t.Errorf("cache file mode=%o want 644", perm)
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(f.CacheDir())
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("leftover temp file %s", e.Name())
		}
	}
	// Concurrent fresh writes to the same key must not fail (unique temp name).
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := f.Fetch(context.Background(), HomeURL, 0)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent fresh write: %v", err)
		}
	}
}

// The cache root is <FUDCOURT_DATA_CACHE_DIR>/khala: a family must never share the
// cryptorank cache dir (a shared cache turns an independent verification fetch
// into self-confirmation).
func TestCacheDirIsFUDCOURT_DATA_CACHE_DIRSubdir(t *testing.T) {
	root := t.TempDir()
	t.Setenv("FUDCOURT_DATA_CACHE_DIR", root)
	t.Setenv("FUDCOURT_DATA_KHALA_CACHE_DIR", "")
	f, err := New(Options{})
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "khala"); f.CacheDir() != want {
		t.Errorf("CacheDir=%q want %q", f.CacheDir(), want)
	}
	if !strings.HasSuffix(f.CacheDir(), "/khala") {
		t.Errorf("CacheDir=%q must end in /khala", f.CacheDir())
	}
}

func TestAllowedURLRejectsStrayPaths(t *testing.T) {
	ok := []string{HomeURL, SitemapURL, KeyURL(wantSlugs[0])}
	for _, u := range ok {
		if !AllowedURL(u) {
			t.Errorf("AllowedURL(%q) = false, want true", u)
		}
	}
	bad := []string{
		"https://evil.example/",
		Base + "/" + strings.ToUpper(wantSlugs[0]),
		Base + "/../etc/passwd",
		Base + "/foo/bar",
		"https://framerusercontent.com/sites/x/searchIndex.json",
		// Hostile keys must never become a path segment: traversal (raw and
		// percent-encoded), separators, a fragment and unicode all fail KeyRe,
		// so the KeyURL() of any of them is refused by AllowedURL even if a
		// caller above skipped ValidKey.
		KeyURL(".."),
		KeyURL("../etc/passwd"),
		KeyURL("%2e%2e"),
		KeyURL("a?b"),
		KeyURL("a#b"),
		KeyURL("café"),
		KeyURL("https://evil.example/x"),
	}
	for _, u := range bad {
		if AllowedURL(u) {
			t.Errorf("AllowedURL(%q) = true, want false", u)
		}
	}
	// The slug allowlist itself refuses the same vectors (the fetch-layer gate
	// is defense in depth on top of this predicate).
	for _, k := range []string{"..", "../etc/passwd", "%2e%2e", "a?b", "a#b", "café", "https://evil.example/x"} {
		if ValidKey(k) {
			t.Errorf("ValidKey(%q) = true, want false", k)
		}
	}
}
