// Package cryptorank is the CryptoRank acquisition family: it fetches a
// cryptorank.io market page (or, for the decoy detector only, a Next.js data
// route), extracts the __NEXT_DATA__ SSR payload and returns the helper-shaped
// result the shapers consume.
//
// Why a bespoke TLS stack (measured 2026-09-29, /home/dwizzy/apicalls-probe):
// api.cryptorank.io/v0/* answers a Cloudflare managed challenge to every
// non-browser client, and the MARKET pages do the same unless the ClientHello
// really is Chrome. Two things are required TOGETHER -- a Chrome 131 TLS
// fingerprint (tls-client's bundled profile; the curl_cffi analogue) AND
// HTTP/2. Either alone still gets 403 with `cf-mitigated: challenge`
// (plain net/http: 403; uTLS HelloChrome_131 over HTTP/1.1: 403;
// tls-client chrome_131 over HTTP/2: 200, 738673 bytes, identical to the
// curl_cffi chrome131 Python baseline). Header ORDER was measured NOT to
// matter, but the Chrome-like order is kept anyway for durability.
//
// Politeness: the per-route disk cache below (TTL, default 60s) is what keeps
// upstream volume low. Do not drop it.
package cryptorank

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

// HelperOut is the JSON contract of scripts/cr_fetch.py's stdout and the input
// both the TS and the Go shapers consume. Field names/omitting match the
// Python `emit({...})` dictionaries (and lib/shapers.ts's HelperOut type).
type HelperOut struct {
	OK        bool                   `json:"ok"`
	Path      string                 `json:"path,omitempty"`
	Route     string                 `json:"route,omitempty"`
	Status    *int                   `json:"status,omitempty"`
	PageProps map[string]interface{} `json:"pageProps,omitempty"`
	FetchedAt int64                  `json:"fetchedAt,omitempty"`
	Cache     string                 `json:"cache,omitempty"`
	HTMLBytes int                    `json:"htmlBytes,omitempty"`
	Error     string                 `json:"error,omitempty"`
}

// DefaultCacheDir is the Python helper's TTL cache location. Node/SSR code
// reads the same directory, so the Go service must write it too.
const DefaultCacheDir = "~/.cache/crfetch"

const (
	base          = "https://cryptorank.io"
	buildIDTTL    = 3600 // refresh the buildId at most hourly (rotates on deploy)
	maxBodyBytes  = 32 << 20
	challengeMark = "Just a moment"
)

// Allowlists, verbatim from cr_fetch.py (defense in depth: the route only ever
// builds a path from the mode table, but a stray path must still be refused).
var htmlAllowed = map[string]bool{
	"/": true, "/all-coins-list": true, "/trending": true, "/gainers": true,
	"/losers": true, "/listings": true, "/blockchains": true,
	"/exchanges/cex/spot": true, "/exchanges/dex/spot": true,
	"/exchanges/perpetuals": true, "/exchanges/cex-transparency": true,
	"/past-launchpool": true, "/upcoming-launchpool": true, "/active-launchpool": true,
	"/past-nodesale": true, "/upcoming-nodesale": true, "/active-nodesale": true,
	"/news": true, "/tags": true, "/ecosystems": true, "/rwa": true,
	"/charts/quarterly-returns": true, "/prediction-markets": true,
	"/converter": true, "/media": true, "/ai-market-overview": true,
}

var htmlAllowedRe = []*regexp.Regexp{
	regexp.MustCompile(`^/price/[a-z0-9][a-z0-9-]{0,63}$`),
	regexp.MustCompile(`^/categories/[a-z0-9][a-z0-9-]{0,63}$`),
	regexp.MustCompile(`^/blockchains/[a-z0-9][a-z0-9-]{0,63}$`),
	regexp.MustCompile(`^/tags/[a-z0-9][a-z0-9-]{0,63}$`),
	regexp.MustCompile(`^/ecosystems/[a-z0-9][a-z0-9-]{0,63}$`),
	regexp.MustCompile(`^/rwa/(bonds|commodities|etfs|stocks)/[a-z0-9][a-z0-9-]{0,63}$`),
	// news/tag pages are 200 + tag:null upstream (soft-404); the route turns
	// that marker into a real 404 instead of forwarding the unfiltered feed.
	regexp.MustCompile(`^/news/tag/[a-z0-9][a-z0-9-]{0,63}$`),
}

var dataAllowedExact = map[string]bool{"/funding-rounds": true, "/token-unlock": true}

var dataAllowedRe = []*regexp.Regexp{
	regexp.MustCompile(`^/ico/[a-z0-9][a-z0-9-]{0,63}$`),
}

var (
	ndRe    = regexp.MustCompile(`(?s)<script id="__NEXT_DATA__" type="application/json"[^>]*>(.*?)</script>`)
	buildRe = regexp.MustCompile(`"buildId"\s*:\s*"([0-9a-f]+)"`)
)

// Options configures a Fetcher.
type Options struct {
	// CacheDir is the disk cache directory ("" -> APICALLS_CACHE_DIR ->
	// ~/.cache/crfetch).
	CacheDir string
	// Timeout for a single upstream request.
	Timeout time.Duration
	// Client is injectable so tests can drive the challenge/transport failure
	// paths without touching the network. When nil, a tls-client HTTP client
	// with the bundled Chrome 131 profile is constructed.
	Client Doer
}

// Doer is the subset of the tls-client HTTP client this package uses.
type Doer interface {
	Do(req *fhttp.Request) (*fhttp.Response, error)
}

// Fetcher performs allowlisted fetches with a disk cache, single-flight and the
// transient-wall retry policy.
type Fetcher struct {
	cacheDir string
	timeout  time.Duration
	client   Doer

	buildIDMu sync.Mutex

	sfMu sync.Mutex
	sf   map[string]*flight
}

type flight struct {
	done chan struct{}
	res  flightResult
}

type flightResult struct {
	h   *HelperOut
	err error
}

// New builds a Fetcher. When o.Client is nil a tls-client HTTP client with the
// bundled Chrome 131 profile is created (the whole point of this package).
func New(o Options) (*Fetcher, error) {
	dir := o.CacheDir
	if dir == "" {
		dir = os.Getenv("APICALLS_CACHE_DIR")
	}
	if dir == "" {
		dir = DefaultCacheDir
	}
	if strings.HasPrefix(dir, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, strings.TrimPrefix(dir, "~/"))
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("cache dir %s: %w", dir, err)
	}
	timeout := o.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	f := &Fetcher{
		cacheDir: dir,
		timeout:  timeout,
		client:   o.Client,
		sf:       map[string]*flight{},
	}
	if f.client == nil {
		// NOTE: redirects MUST be followed. curl_cffi's requests.get follows
		// them (max 30) and the Python helper relies on that: /news/tag/<unknown>
		// answers 307 -> 200 with tag:null, which is the soft-404 marker the
		// route turns into a real 404. With WithNotFollowRedirects the 307 would
		// surface as an upstream wall instead (measured: 502 vs 404).
		c, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(),
			tls_client.WithTimeoutSeconds(int(timeout.Seconds())),
			tls_client.WithClientProfile(profiles.Chrome_131), // <-- the whole trick
		)
		if err != nil {
			return nil, fmt.Errorf("tls-client: %w", err)
		}
		f.client = c
	}
	return f, nil
}

// CacheDir is the resolved cache directory (for logs/README/healthz).
func (f *Fetcher) CacheDir() string { return f.cacheDir }

// HTMLPath reports whether p is in the HTML allowlist (used by tests).
func HTMLPath(p string) bool { return allow(htmlAllowed, htmlAllowedRe, p) }

func allow(exact map[string]bool, res []*regexp.Regexp, p string) bool {
	if exact[p] {
		return true
	}
	for _, rx := range res {
		if rx.MatchString(p) {
			return true
		}
	}
	return false
}

func cacheFile(dir, slug string) string { return filepath.Join(dir, slug+".json") }

// Slug mirrors the Python helper's per-route cache naming:
// `path.strip("/").replace("/", "_") or "root"`, prefixed with `data_` for
// data routes.
func Slug(route, target string) string {
	t := strings.Trim(target, "/")
	s := strings.ReplaceAll(t, "/", "_")
	if route == "data" {
		if s == "" {
			return "data_"
		}
		return "data_" + s
	}
	if s == "" {
		return "root"
	}
	return s
}

func readCache(cf string, ttl int) *HelperOut {
	if ttl <= 0 {
		return nil
	}
	st, err := os.Stat(cf)
	if err != nil {
		return nil
	}
	if time.Since(st.ModTime()) >= time.Duration(ttl)*time.Second {
		return nil
	}
	raw, err := os.ReadFile(cf)
	if err != nil {
		return nil
	}
	var out HelperOut
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	out.Cache = "HIT"
	return &out
}

// writeCache is atomic (tmp + rename) so concurrent callers never read a
// half-file, exactly like the Python helper. Unlike the Python helper it uses a
// UNIQUE temp name: fresh=1 requests deliberately bypass single-flight, so two
// of them can write the same cache file at once, and a fixed ".tmp" path made
// one of the renames fail (measured: "rename ...: no such file or directory").
// The temp file is created in the destination directory so the rename stays
// same-filesystem and therefore atomic.
func writeCache(cf string, obj *HelperOut) error {
	raw, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(cf), filepath.Base(cf)+".*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Chmod(name, 0o644); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, cf); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// HardError marks a failure that must be alarmed on, never parsed as "no data".
// The `cf-mitigated: challenge` verdict from Cloudflare is the case that
// matters: the residual risk of this whole architecture is that a pinned
// profile goes stale and upstream starts 403ing silently.
type HardError struct {
	Kind    string // "cf-challenge" | "transport"
	Status  int    // 0 when the request never completed
	Detail  string
	Upstrl  string
	RawBody string
}

func (e *HardError) Error() string { return e.Detail }

// IsHardError reports whether err is an alarmable wall/challenge failure.
func IsHardError(err error) (*HardError, bool) {
	var he *HardError
	if errors.As(err, &he) {
		return he, true
	}
	return nil, false
}

// Fetch retrieves target (an allowlisted HTML path, or a data route when
// route=="data") and returns the helper-shaped payload. ttl is the per-route
// cache TTL in seconds and is an ARGUMENT, never fetcher state: the route
// passes 60 normally and 0 for fresh=1 (the Python helper's --ttl 0). Sharing
// one mutable TTL across requests let a fresh request read the cached value and
// be served a HIT, defeating the whole point of fresh. Errors of type
// *HardError are alarmable.
func (f *Fetcher) Fetch(ctx context.Context, route, target string, ttl int) (*HelperOut, error) {
	if route == "data" {
		if !dataAllowedExact[target] && !allow(nil, dataAllowedRe, target) {
			return nil, fmt.Errorf("data route not allowed: %s", target)
		}
	} else {
		route = "html"
		if !allow(htmlAllowed, htmlAllowedRe, target) {
			return nil, fmt.Errorf("path not allowed: %s", target)
		}
	}
	// ttl <= 0 means "bypass the TTL cache entirely" and therefore nothing to
	// dedupe: a fresh request must never be satisfied by an in-flight cached
	// fetch. Non-fresh calls still collapse onto one upstream hit.
	if ttl <= 0 {
		return f.fetch(ctx, route, target, ttl)
	}
	return f.singleFlight(route+" "+target, func() (*HelperOut, error) {
		return f.fetch(ctx, route, target, ttl)
	})
}

// singleFlight collapses concurrent identical cache keys onto one upstream
// fetch: a board mount fires ~9 modes at once, which must not stampede a cold
// route (the Python helper got a process per call and could not do this).
func (f *Fetcher) singleFlight(key string, fn func() (*HelperOut, error)) (*HelperOut, error) {
	f.sfMu.Lock()
	if fl, ok := f.sf[key]; ok {
		f.sfMu.Unlock()
		<-fl.done
		if fl.res.err != nil {
			return nil, fl.res.err
		}
		out := *fl.res.h
		return &out, nil
	}
	fl := &flight{done: make(chan struct{})}
	f.sf[key] = fl
	f.sfMu.Unlock()

	h, err := fn()
	fl.res = flightResult{h: h, err: err}
	close(fl.done)

	f.sfMu.Lock()
	delete(f.sf, key)
	f.sfMu.Unlock()
	return h, err
}

// InFlight reports the number of in-flight single-flight keys (tests).
func (f *Fetcher) InFlight() int {
	f.sfMu.Lock()
	defer f.sfMu.Unlock()
	return len(f.sf)
}

func (f *Fetcher) fetch(ctx context.Context, route, target string, ttl int) (*HelperOut, error) {
	cf := cacheFile(f.cacheDir, Slug(route, target))
	if cached := readCache(cf, ttl); cached != nil {
		return cached, nil
	}

	var buildID string
	if route == "data" {
		id, err := f.resolveBuildID(ctx, false)
		if err != nil {
			return nil, err
		}
		buildID = id
	}

	r, err := f.fetchOnce(ctx, route, target, buildID)
	if err != nil {
		return nil, err
	}
	// buildId rotated (deploy between our cache and now): refresh once.
	if route == "data" && r.StatusCode == 404 {
		id, ierr := f.resolveBuildID(ctx, true)
		if ierr != nil {
			return nil, ierr
		}
		r, err = f.fetchOnce(ctx, route, target, id)
		if err != nil {
			return nil, err
		}
	}

	if r.StatusCode != 200 {
		if r.StatusCode == 403 && r.Header.Get("cf-mitigated") == "challenge" {
			return nil, &HardError{
				Kind:    "cf-challenge",
				Status:  r.StatusCode,
				Detail:  "upstream cf-mitigated: challenge (Cloudflare wall -- TLS/h2 fingerprint rejected or profile stale)",
				Upstrl:  urlFor(route, target, buildID),
				RawBody: r.Body,
			}
		}
		return nil, &HelperErr{
			Path:   target,
			Route:  route,
			Status: r.StatusCode,
			Err:    fmt.Sprintf("upstream HTTP %d (Cloudflare wall or stale route)", r.StatusCode),
		}
	}

	out := &HelperOut{OK: true, Path: target, Route: route, FetchedAt: time.Now().Unix(), Cache: "MISS"}
	status := 200
	out.Status = &status
	out.HTMLBytes = len(r.Body)

	if route == "html" {
		if strings.Contains(r.Body, challengeMark) && !ndRe.MatchString(r.Body) {
			// A 200 that is actually a challenge interstitial: hard failure.
			return nil, &HardError{
				Kind:    "cf-challenge",
				Status:  200,
				Detail:  "upstream served a Cloudflare challenge page with HTTP 200 (unparseable as data)",
				Upstrl:  urlFor(route, target, buildID),
				RawBody: r.Body,
			}
		}
		m := ndRe.FindStringSubmatch(r.Body)
		if m == nil {
			return nil, &HelperErr{
				Path: target, Route: "html", Status: 200,
				Err: "page has no __NEXT_DATA__ (unexpected layout)",
			}
		}
		var nd struct {
			Props struct {
				PageProps map[string]interface{} `json:"pageProps"`
			} `json:"props"`
		}
		if err := json.Unmarshal([]byte(m[1]), &nd); err != nil {
			return nil, &HelperErr{
				Path: target, Route: "html", Status: 200,
				Err: fmt.Sprintf("__NEXT_DATA__ parse error: %v", err),
			}
		}
		out.PageProps = nd.Props.PageProps
	} else {
		var body struct {
			PageProps map[string]interface{} `json:"pageProps"`
		}
		if err := json.Unmarshal([]byte(r.Body), &body); err != nil {
			return nil, &HelperErr{
				Path: target, Route: "data", Status: 200,
				Err: "data route returned non-JSON (layout changed?)",
			}
		}
		if body.PageProps == nil {
			return nil, &HelperErr{
				Path: target, Route: "data", Status: 200,
				Err: "data route JSON has no pageProps",
			}
		}
		out.PageProps = body.PageProps
	}

	if err := writeCache(cf, out); err != nil {
		return nil, fmt.Errorf("cache write %s: %w", cf, err)
	}
	return out, nil
}

// HelperErr is a non-alarmable helper-level failure (non-200 upstream, layout
// change, unparseable payload) carrying the upstream status, mirroring
// cr_fetch.py's exit 3/4 branches.
type HelperErr struct {
	Path   string
	Route  string
	Status int
	Err    string
}

func (e *HelperErr) Error() string { return e.Err }

type resp struct {
	StatusCode int
	Header     fhttp.Header
	Body       string
}

func urlFor(route, target, buildID string) string {
	if route == "data" {
		return fmt.Sprintf("%s/_next/data/%s%s.json", base, buildID, target)
	}
	return base + target
}

func (f *Fetcher) fetchOnce(ctx context.Context, route, target, buildID string) (*resp, error) {
	url := urlFor(route, target, buildID)
	req, err := fhttp.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header[fhttp.HeaderOrderKey] = []string{
		"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
		"upgrade-insecure-requests", "user-agent", "accept",
		"sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest",
		"accept-encoding", "accept-language",
	}
	req.Header[fhttp.PHeaderOrderKey] = []string{":method", ":authority", ":scheme", ":path"}
	req.Header.Set("user-agent", userAgent)
	req.Header.Set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
	req.Header.Set("accept-language", "en-US,en;q=0.9")
	req.Header.Set("sec-ch-ua", `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`)
	req.Header.Set("sec-ch-ua-mobile", "?0")
	req.Header.Set("sec-ch-ua-platform", `"Linux"`)
	req.Header.Set("upgrade-insecure-requests", "1")
	req.Header.Set("sec-fetch-site", "none")
	req.Header.Set("sec-fetch-mode", "navigate")
	req.Header.Set("sec-fetch-user", "?1")
	req.Header.Set("sec-fetch-dest", "document")

	r, err := f.client.Do(req)
	if err != nil {
		return nil, &HardError{Kind: "transport", Detail: fmt.Sprintf("fetch failed: %T: %v", err, err), Upstrl: url}
	}
	defer r.Body.Close()
	var rd io.Reader = r.Body
	if strings.Contains(r.Header.Get("content-encoding"), "gzip") {
		if zr, e := gzip.NewReader(r.Body); e == nil {
			rd = zr
		}
	}
	body, err := io.ReadAll(io.LimitReader(rd, maxBodyBytes))
	if err != nil {
		return nil, &HardError{Kind: "transport", Detail: fmt.Sprintf("read failed: %T: %v", err, err), Upstrl: url}
	}
	return &resp{StatusCode: r.StatusCode, Header: r.Header, Body: string(body)}, nil
}

const userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// resolveBuildID reads the current buildId from the homepage, cached on disk
// with a 1-hour TTL; force ignores the cache (refresh-once-on-404).
func (f *Fetcher) resolveBuildID(ctx context.Context, force bool) (string, error) {
	f.buildIDMu.Lock()
	defer f.buildIDMu.Unlock()

	bf := filepath.Join(f.cacheDir, "buildid.txt")
	if !force {
		if st, err := os.Stat(bf); err == nil && time.Since(st.ModTime()) < buildIDTTL*time.Second {
			if raw, err := os.ReadFile(bf); err == nil {
				if v := strings.TrimSpace(string(raw)); v != "" {
					return v, nil
				}
			}
		}
	}
	r, err := f.fetchOnce(ctx, "html", "/", "")
	if err != nil {
		return "", err
	}
	m := buildRe.FindStringSubmatch(r.Body)
	if m == nil {
		return "", &HelperErr{Path: "/", Route: "html", Status: r.StatusCode, Err: "could not resolve buildId from homepage"}
	}
	tmp := bf + ".tmp"
	if err := os.WriteFile(tmp, []byte(m[1]), 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, bf); err != nil {
		return "", err
	}
	return m[1], nil
}
