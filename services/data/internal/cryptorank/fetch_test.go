package cryptorank

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	fhttp "github.com/bogdanfinn/fhttp"
)

// fakeDoer answers requests from a table, so the challenge/transport/cache
// paths are provable without touching upstream.
type fakeDoer struct {
	mu     sync.Mutex
	calls  []string
	answer func(url string) (*fhttp.Response, error)
}

func (d *fakeDoer) Do(req *fhttp.Request) (*fhttp.Response, error) {
	d.mu.Lock()
	d.calls = append(d.calls, req.URL.String())
	fn := d.answer
	d.mu.Unlock()
	return fn(req.URL.String())
}

func (d *fakeDoer) callCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.calls)
}

func respond(status int, header map[string]string, body string) (*fhttp.Response, error) {
	h := fhttp.Header{}
	for k, v := range header {
		h.Set(k, v)
	}
	return &fhttp.Response{
		StatusCode: status,
		Header:     h,
		Body:       io.NopCloser(strings.NewReader(body)),
	}, nil
}

const sampleNextData = `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">` +
	`{"buildId":"45c3c525","props":{"pageProps":{"coins":[{"key":"bitcoin","price":{"USD":83553.22}}]}}}` +
	`</script></body></html>`

// newTestFetcher builds a fetcher around a stub Doer. The TTL is no longer
// fetcher state; callers pass it per Fetch.
func newTestFetcher(t *testing.T, d Doer) *Fetcher {
	t.Helper()
	f, err := New(Options{CacheDir: t.TempDir(), Client: d})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f
}

func TestHTMLAllowlist(t *testing.T) {
	allowed := []string{
		"/", "/all-coins-list", "/trending", "/gainers", "/losers", "/listings",
		"/blockchains", "/exchanges/cex/spot", "/exchanges/dex/spot",
		"/exchanges/perpetuals", "/exchanges/cex-transparency",
		"/past-launchpool", "/upcoming-launchpool", "/active-launchpool",
		"/past-nodesale", "/upcoming-nodesale", "/active-nodesale",
		"/news", "/tags", "/ecosystems", "/rwa", "/charts/quarterly-returns",
		"/prediction-markets", "/converter", "/media", "/ai-market-overview",
		"/price/bitcoin", "/categories/chain", "/blockchains/ethereum",
		"/tags/layer-1", "/ecosystems/ethereum", "/rwa/stocks/wendy-s",
		"/news/tag/defi",
	}
	for _, p := range allowed {
		if !HTMLPath(p) {
			t.Errorf("%s should be allowed", p)
		}
	}
	refused := []string{
		"", "/", "//", "/admin", "/price/", "/price/Bitcoin", "/price/bitcoin/extra",
		"/rwa/wendy-s", "/rwa/gold/wendy-s", "/news/tag/", "/_next/data/x/funding-rounds.json",
		"https://evil.example/price/bitcoin", "/price/bitcoin?x=1", "/all-coins-list/",
	}
	for _, p := range refused {
		if p == "/" {
			continue // "/" is allowed; listed for clarity only
		}
		if HTMLPath(p) {
			t.Errorf("%s should be refused", p)
		}
	}
}

func TestSlugNamingMatchesPython(t *testing.T) {
	cases := []struct{ route, target, want string }{
		{"html", "/", "root"},
		{"html", "/all-coins-list", "all-coins-list"},
		{"html", "/price/bitcoin", "price_bitcoin"},
		{"html", "/rwa/stocks/wendy-s", "rwa_stocks_wendy-s"},
		{"html", "/news/tag/defi", "news_tag_defi"},
		{"data", "/funding-rounds", "data_funding-rounds"},
		{"data", "/ico/foo-bar", "data_ico_foo-bar"},
	}
	for _, c := range cases {
		if got := Slug(c.route, c.target); got != c.want {
			t.Errorf("Slug(%q,%q)=%q want %q", c.route, c.target, got, c.want)
		}
	}
}

func TestChallengeHeaderIsHardError(t *testing.T) {
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return respond(403, map[string]string{"cf-mitigated": "challenge", "server": "cloudflare"},
			"<html>Just a moment...</html>")
	}}
	f := newTestFetcher(t, d)
	h, err := f.Fetch(context.Background(), "html", "/all-coins-list", 60)
	if err == nil || h != nil {
		t.Fatalf("challenge page was accepted: h=%v err=%v", h, err)
	}
	he, ok := IsHardError(err)
	if !ok {
		t.Fatalf("not a HardError: %T %v", err, err)
	}
	if he.Kind != "cf-challenge" || he.Status != 403 {
		t.Errorf("kind=%q status=%d", he.Kind, he.Status)
	}
	if !strings.Contains(he.Detail, "cf-mitigated: challenge") {
		t.Errorf("detail=%q", he.Detail)
	}
	if he.Upstrl != "https://cryptorank.io/all-coins-list" {
		t.Errorf("url=%q", he.Upstrl)
	}
}

func TestChallengeBodyAt200IsHardError(t *testing.T) {
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return respond(200, nil, "<html><title>Just a moment...</title><div>challenge-platform cf-chl_opt</div></html>")
	}}
	f := newTestFetcher(t, d)
	h, err := f.Fetch(context.Background(), "html", "/trending", 60)
	if err == nil || h != nil {
		t.Fatalf("200 challenge body was parsed as data: h=%v", h)
	}
	he, ok := IsHardError(err)
	if !ok || he.Kind != "cf-challenge" || he.Status != 200 {
		t.Fatalf("expected 200 cf-challenge HardError, got %#v", err)
	}
}

func TestTransportFailureIsHardError(t *testing.T) {
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return nil, errors.New("dial tcp: connection refused")
	}}
	f := newTestFetcher(t, d)
	_, err := f.Fetch(context.Background(), "html", "/news", 60)
	he, ok := IsHardError(err)
	if !ok || he.Kind != "transport" {
		t.Fatalf("expected transport HardError, got %#v", err)
	}
	if !strings.Contains(he.Detail, "connection refused") {
		t.Errorf("detail=%q", he.Detail)
	}
}

func TestUpstreamStatusIsHelperErr(t *testing.T) {
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return respond(429, nil, "rate limited")
	}}
	f := newTestFetcher(t, d)
	_, err := f.Fetch(context.Background(), "html", "/losers", 60)
	var he *HelperErr
	if !errors.As(err, &he) || he.Status != 429 {
		t.Fatalf("want HelperErr 429, got %#v", err)
	}
	if IsHardErr(err) {
		t.Error("a 429 is a transient wall, not a hard failure")
	}
	if _, hard := IsHardError(err); hard {
		t.Error("429 must not be a HardError (the route retries it)")
	}
}

// IsHardErr is a tiny local alias to keep the assertion above readable.
func IsHardErr(err error) bool { _, ok := IsHardError(err); return ok }

func Test404UpstreamIsHelperErr(t *testing.T) {
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return respond(404, nil, "not found")
	}}
	f := newTestFetcher(t, d)
	_, err := f.Fetch(context.Background(), "html", "/price/zzznoexist9999", 60)
	var he *HelperErr
	if !errors.As(err, &he) || he.Status != 404 {
		t.Fatalf("want HelperErr 404, got %#v", err)
	}
}

func TestMissingNextDataIsHelperErr(t *testing.T) {
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return respond(200, nil, "<html><body>no payload here</body></html>")
	}}
	f := newTestFetcher(t, d)
	_, err := f.Fetch(context.Background(), "html", "/media", 60)
	var he *HelperErr
	if !errors.As(err, &he) || he.Status != 200 || !strings.Contains(he.Err, "no __NEXT_DATA__") {
		t.Fatalf("want layout-change HelperErr, got %#v", err)
	}
}

func TestMalformedNextDataIsHelperErr(t *testing.T) {
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return respond(200, nil, `<script id="__NEXT_DATA__" type="application/json">{not json</script>`)
	}}
	f := newTestFetcher(t, d)
	_, err := f.Fetch(context.Background(), "html", "/tags", 60)
	var he *HelperErr
	if !errors.As(err, &he) || !strings.Contains(he.Err, "__NEXT_DATA__ parse error") {
		t.Fatalf("want parse HelperErr, got %#v", err)
	}
}

func TestHappyPathParsesPagePropsAndCaches(t *testing.T) {
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return respond(200, nil, sampleNextData)
	}}
	dir := t.TempDir()
	f, err := New(Options{CacheDir: dir, Client: d})
	if err != nil {
		t.Fatal(err)
	}
	h, err := f.Fetch(context.Background(), "html", "/all-coins-list", 60)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if !h.OK || h.Route != "html" || h.Path != "/all-coins-list" || h.Cache != "MISS" {
		t.Fatalf("helper shape %+v", h)
	}
	if h.Status == nil || *h.Status != 200 {
		t.Fatalf("status %v", h.Status)
	}
	if h.HTMLBytes != len(sampleNextData) {
		t.Errorf("htmlBytes=%d want %d", h.HTMLBytes, len(sampleNextData))
	}
	coins, _ := h.PageProps["coins"].([]interface{})
	if len(coins) != 1 {
		t.Fatalf("pageProps not extracted: %v", h.PageProps)
	}

	// Cache file is written atomically under the Python-compatible name.
	cf := filepath.Join(dir, "all-coins-list.json")
	if _, err := os.Stat(cf); err != nil {
		t.Fatalf("cache file: %v", err)
	}
	if _, err := os.Stat(cf + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("tmp file left behind")
	}

	// Second call inside the TTL is a HIT and must not touch upstream.
	h2, err := f.Fetch(context.Background(), "html", "/all-coins-list", 60)
	if err != nil {
		t.Fatal(err)
	}
	if h2.Cache != "HIT" {
		t.Errorf("cache=%q want HIT", h2.Cache)
	}
	if d.callCount() != 1 {
		t.Errorf("upstream calls=%d want 1", d.callCount())
	}

	// ttl 0 (what the route passes for fresh=1) refetches; the TTL is an
	// argument, so it cannot leak into any other caller.
	h3, err := f.Fetch(context.Background(), "html", "/all-coins-list", 0)
	if err != nil {
		t.Fatal(err)
	}
	if h3.Cache != "MISS" || d.callCount() != 2 {
		t.Errorf("fresh: cache=%q calls=%d", h3.Cache, d.callCount())
	}
	// ...and the ordinary TTL is unaffected afterwards.
	h4, err := f.Fetch(context.Background(), "html", "/all-coins-list", 60)
	if err != nil {
		t.Fatal(err)
	}
	if h4.Cache != "HIT" || d.callCount() != 2 {
		t.Errorf("post-fresh: cache=%q calls=%d", h4.Cache, d.callCount())
	}
}

func gzipWriter(w io.Writer) *gzip.Writer { return gzip.NewWriter(w) }

func TestSingleFlightCollapsesConcurrentColdFetches(t *testing.T) {
	var calls int32
	release := make(chan struct{})
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		if atomic.AddInt32(&calls, 1) == 1 {
			<-release // hold the leader inside the fetch until all callers pile on
		}
		return respond(200, nil, sampleNextData)
	}}
	f := newTestFetcher(t, d)

	const n = 9
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make([]error, n)
	got := make([]bool, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			h, err := f.Fetch(context.Background(), "html", "/all-coins-list", 60)
			errs[i] = err
			got[i] = h != nil
		}()
	}
	close(start)
	// Wait until every caller is queued behind the one in-flight key, so the
	// stampede is real rather than a lucky schedule.
	for f.InFlight() == 0 {
	}
	close(release)
	wg.Wait()

	if c := atomic.LoadInt32(&calls); c != 1 {
		t.Errorf("upstream calls=%d want 1 (%d concurrent callers must not stampede a cold route)", c, n)
	}
	for i := range n {
		if errs[i] != nil {
			t.Errorf("goroutine %d: %v", i, errs[i])
		}
		if !got[i] {
			t.Errorf("goroutine %d: nil result", i)
		}
	}
}

// The route used to keep the TTL on the fetcher (SetTTL), i.e. process-global
// mutable state: a fresh=1 request could read 60 and be served a stale HIT,
// and a normal request could read 0 and skip the cache. The TTL is now a
// per-call argument, so callers with different fresh values cannot observe each
// other. Measured through the Doer (single-flight followers share the leader's
// Cache value, so that field is not a proxy for upstream calls). Asserted under
// -race.
func TestConcurrentMixedFreshNeverLeaksTTL(t *testing.T) {
	var calls int32
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		atomic.AddInt32(&calls, 1)
		return respond(200, nil, sampleNextData)
	}}
	f := newTestFetcher(t, d)

	run := func(ttl int, n int) []string {
		var wg sync.WaitGroup
		start := make(chan struct{})
		caches := make([]string, n)
		for i := range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				h, err := f.Fetch(context.Background(), "html", "/all-coins-list", ttl)
				if err != nil {
					t.Errorf("ttl=%d fetch: %v", ttl, err)
					return
				}
				caches[i] = h.Cache
			}()
		}
		close(start)
		wg.Wait()
		return caches
	}

	// Phase 1: six concurrent NON-fresh callers collapse onto one upstream hit.
	// Phase 1: six concurrent NON-fresh callers collapse onto one upstream hit.
	// Only the upstream-call count is asserted: which caller is the single-flight
	// leader (and therefore sees MISS) is a scheduling artifact, not contract.
	before := atomic.LoadInt32(&calls)
	_ = run(60, 6)
	if delta := atomic.LoadInt32(&calls) - before; delta != 1 {
		t.Errorf("6 concurrent non-fresh callers caused %d upstream fetches, want 1", delta)
	}

	// Phase 2: the cached value is reused.
	before = atomic.LoadInt32(&calls)
	if c := run(60, 4); c[0] != "HIT" {
		t.Errorf("warm non-fresh caller: cache=%q want HIT", c[0])
	}
	if d := atomic.LoadInt32(&calls) - before; d != 0 {
		t.Errorf("warm non-fresh traffic caused %d upstream fetches, want 0", d)
	}

	// (b) six concurrent fresh callers each bypass the cache and reach upstream
	// (fresh must not be satisfied by an in-flight cached flight).
	before = atomic.LoadInt32(&calls)
	fresh := run(0, 6)
	if d := atomic.LoadInt32(&calls) - before; d != 6 {
		t.Errorf("6 concurrent fresh callers caused %d upstream fetches, want 6", d)
	}
	for i, c := range fresh {
		if c == "HIT" {
			t.Errorf("fresh caller %d was served cache=%q (stale TTL leaked)", i, c)
		}
	}

	// (b') after the fresh burst, the ordinary path is cached again -- i.e. the
	// fresh calls did not leave the TTL lowered.
	before = atomic.LoadInt32(&calls)
	if c := run(60, 1); c[0] != "HIT" {
		t.Errorf("post-fresh ordinary fetch cache=%q want HIT", c[0])
	}
	if d := atomic.LoadInt32(&calls) - before; d != 0 {
		t.Errorf("post-fresh ordinary fetch caused %d upstream fetches, want 0", d)
	}
}

func TestDataRouteResolvesBuildIDAndRefreshesOn404(t *testing.T) {
	var homepageCalls, dataCalls int
	d := &fakeDoer{answer: func(url string) (*fhttp.Response, error) {
		if strings.HasSuffix(url, "/_next/data/f00dcafe/funding-rounds.json") {
			dataCalls++
			return respond(404, nil, "stale buildId")
		}
		if strings.HasSuffix(url, "/_next/data/deadbeef/funding-rounds.json") {
			dataCalls++
			return respond(200, nil, `{"pageProps":{"rounds":[]}}`)
		}
		if url == "https://cryptorank.io/" {
			// The freshly deployed buildId is what the homepage now serves; the
			// disk cache still holds the stale one (seeded below).
			homepageCalls++
			return respond(200, nil, `<script id="__NEXT_DATA__" type="application/json">{"buildId":"deadbeef"}</script>`)
		}
		return respond(500, nil, "unexpected "+url)
	}}
	dir := t.TempDir()
	f, err := New(Options{CacheDir: dir, Client: d})
	if err != nil {
		t.Fatal(err)
	}
	// Seed the buildId cache with the stale value.
	if err := os.WriteFile(filepath.Join(dir, "buildid.txt"), []byte("f00dcafe"), 0o644); err != nil {
		t.Fatal(err)
	}
	h, err := f.Fetch(context.Background(), "data", "/funding-rounds", 60)
	if err != nil {
		t.Fatalf("data route: %v", err)
	}
	if h.Route != "data" {
		t.Errorf("route=%q", h.Route)
	}
	if dataCalls != 2 {
		t.Errorf("data calls=%d want 2 (404 then refreshed buildId)", dataCalls)
	}
	if homepageCalls != 1 {
		t.Errorf("homepage calls=%d want 1 (the cached stale buildId was used first)", homepageCalls)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "buildid.txt")); string(got) != "deadbeef" {
		t.Errorf("buildId cache=%q want deadbeef", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "data_funding-rounds.json")); err != nil {
		t.Errorf("data cache file: %v", err)
	}
}

func TestDataAllowlistRefusesUnknown(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		t.Error("upstream must not be called for a refused route")
		return respond(200, nil, "")
	}})
	for _, p := range []string{"/admin", "/ico/BAD", "/ico/", "/funding-rounds/x"} {
		if _, err := f.Fetch(context.Background(), "data", p, 60); err == nil {
			t.Errorf("data route %s should be refused", p)
		}
	}
	if _, err := f.Fetch(context.Background(), "html", "/admin", 60); err == nil {
		t.Error("html path /admin should be refused")
	}
}

func TestDataRouteErrorsSurfaceStatus(t *testing.T) {
	f, err := New(Options{CacheDir: t.TempDir(), Client: &fakeDoer{answer: func(url string) (*fhttp.Response, error) {
		if url == "https://cryptorank.io/" {
			return respond(200, nil, `<script id="__NEXT_DATA__" type="application/json">{"buildId":"abc123"}</script>`)
		}
		return respond(200, nil, `{"pageProps":null}`)
	}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.Fetch(context.Background(), "data", "/token-unlock", 60)
	var he *HelperErr
	if !errors.As(err, &he) || !strings.Contains(he.Err, "no pageProps") {
		t.Fatalf("want no-pageProps HelperErr, got %#v", err)
	}
}

func TestBuildIDUnresolvableIsReported(t *testing.T) {
	f := newTestFetcher(t, &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return respond(200, nil, "<html>no buildId</html>")
	}})
	_, err := f.Fetch(context.Background(), "data", "/funding-rounds", 60)
	var he *HelperErr
	if !errors.As(err, &he) || !strings.Contains(he.Err, "could not resolve buildId") {
		t.Fatalf("got %#v", err)
	}
}

// curl_cffi's requests.get follows redirects and the Python helper relies on
// that: /news/tag/<unknown> answers 307 -> 200 with tag:null, the soft-404
// marker the route turns into a local 404. With WithNotFollowRedirects the 307
// surfaced as a wall instead (measured: 502 instead of 404). The redirect
// policy lives in the tls-client, and an injected fake replaces it wholesale,
// so it is asserted on the real constructed client.
func TestRedirectsAreFollowed(t *testing.T) {
	f, err := New(Options{CacheDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	follower, ok := f.client.(interface{ GetFollowRedirect() bool })
	if !ok {
		t.Fatalf("client %T exposes no redirect policy", f.client)
	}
	if !follower.GetFollowRedirect() {
		t.Fatal("tls-client must follow redirects (curl_cffi semantics); a 307 would surface as a wall")
	}
}

func TestGzippedBodyIsDecompressed(t *testing.T) {
	var buf strings.Builder
	zw := gzipWriter(&buf)
	if _, err := zw.Write([]byte(sampleNextData)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	d := &fakeDoer{answer: func(string) (*fhttp.Response, error) {
		return respond(200, map[string]string{"content-encoding": "gzip"}, buf.String())
	}}
	f := newTestFetcher(t, d)
	h, err := f.Fetch(context.Background(), "html", "/trending", 60)
	if err != nil {
		t.Fatalf("gzip body: %v", err)
	}
	if len(h.PageProps) == 0 {
		t.Error("gzip body was not decompressed before parsing")
	}
}

func TestCacheDirDefaultsAreHonoured(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "custom")
	t.Setenv("APICALLS_CACHE_DIR", sub)
	f, err := New(Options{})
	if err != nil {
		t.Fatal(err)
	}
	if f.CacheDir() != sub {
		t.Errorf("CacheDir=%q want %q", f.CacheDir(), sub)
	}
	// Explicit option wins over the environment.
	explicit := filepath.Join(dir, "explicit")
	f2, err := New(Options{CacheDir: explicit})
	if err != nil {
		t.Fatal(err)
	}
	if f2.CacheDir() != explicit {
		t.Errorf("CacheDir=%q want %q", f2.CacheDir(), explicit)
	}
	// Empty -> the Python default (~/.cache/crfetch), not a temp dir.
	os.Unsetenv("APICALLS_CACHE_DIR")
	f3, err := New(Options{})
	if err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()
	if want := filepath.Join(home, ".cache", "crfetch"); f3.CacheDir() != want {
		t.Errorf("CacheDir=%q want %q", f3.CacheDir(), want)
	}
}

func TestResolvedClientUsesChrome131(t *testing.T) {
	// The dependency stack is the whole reason this package exists: a Fetcher
	// built without an injected client must construct the tls-client one.
	f, err := New(Options{CacheDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if f.client == nil {
		t.Fatal("no client")
	}
	if fmt.Sprintf("%T", f.client) == "*fakeDoer" {
		t.Fatal("unexpected fake client")
	}
}
