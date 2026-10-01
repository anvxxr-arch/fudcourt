package khala

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DefaultCacheDir is the khala cache root, *below* the fudcourt-data cache root the
// deploy unit already sets (FUDCOURT_DATA_CACHE_DIR -> ~/.cache/fudcourt-data):
// "<root>/khala". A family must never share another family's cache directory
// (backend/data/README.md "keep the oracle's cache separate"): a shared cache
// turns an independent verification fetch into self-confirmation. It is a
// SUBDIR of FUDCOURT_DATA_CACHE_DIR rather than a second cache-root env var so the
// deploy unit keeps setting exactly one root.
const DefaultCacheDir = "~/.cache/fudcourt-data"

const (
	// maxBodyBytes caps one upstream body at 8 MiB. The largest measured khala
	// page is a report at 468140 bytes, so this is ~18x headroom; it exists to
	// bound a pathological/frame page, not to fit today's content.
	maxBodyBytes = 8 << 20
	// defaultTTL is the per-request disk-cache TTL in seconds. khala.io
	// publishes roughly monthly and every page carries
	// `cache-control: public, max-age=0, must-revalidate` + a strong ETag, so
	// 900s keeps upstream volume tiny; a revalidation (304) is the real
	// freshness mechanism, not the TTL.
	defaultTTL = 900
	// Framer's real error page for an unknown path (7384 bytes, `<title>Page
	// Not Found | Framer</title>`). A 404 without it is not the decoy contract
	// we measured, so it is reported as an honest failure instead of a 404.
	framerNotFoundMark = "Page Not Found | Framer"
)

// UA is the honest User-Agent. A browser-looking UA would be a lie: the site
// answers this one with a real 200 (measured), so there is nothing to spoof.
const UA = "fudcourt-khala/1.0 (+https://fc.dwirijal.my.id)"

// Options configures a Fetcher.
type Options struct {
	// CacheDir overrides the resolved cache root (which is then used as the
	// cache directory directly, not as a parent). "" -> FUDCOURT_DATA_KHALA_CACHE_DIR
	// -> <FUDCOURT_DATA_CACHE_DIR>/khala -> ~/.cache/fudcourt-data/khala.
	CacheDir string
	// Timeout for a single upstream request (default 30s).
	Timeout time.Duration
	// Client is injectable so tests drive the cache/ETag/304/transport paths
	// without touching the network. When nil a plain *http.Client is built.
	Client Doer
}

// Doer is the subset of *http.Client the fetcher uses.
type Doer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Entry is one cached upstream response.
//
// It stores the ETag and the URL it was fetched from, which is what makes the
// measured 304 revalidation possible: khala.io answers
// `cache-control: public, max-age=0, must-revalidate` with a strong ETag, so a
// conditional GET is the polite way to re-check ~250-470 KB pages.
type Entry struct {
	URL       string `json:"url"`
	Status    int    `json:"status"`
	ETag      string `json:"etag,omitempty"`
	Body      string `json:"body"`
	FetchedAt int64  `json:"fetchedAt"`
}

// CacheInfo is what Fetch reports back about where the bytes came from.
type CacheInfo struct {
	// Status is the status of the response whose body is being returned. It is
	// the upstream status (200, or the cached 200 after a 304).
	Status int
	// Cache is "MISS" or "HIT". A 304 revalidation serves the stored body as a
	// HIT.
	Cache string
	// Revalidated is true when a HIT came from a conditional GET (ETag match),
	// i.e. the body is the cached one and upstream said 304.
	Revalidated bool
	// FetchedAt is the time the returned body was last downloaded; for a 304
	// it is when that body was first fetched, not when it was revalidated.
	FetchedAt int64
}

// Fetcher performs allowlisted fetches with a disk cache, strong-ETag
// revalidation and single-flight.
type Fetcher struct {
	cacheDir string
	timeout  time.Duration
	client   Doer
	sfMu     sync.Mutex
	sf       map[string]*flight
}

type flight struct {
	done chan struct{}
	res  flightResult
}

type flightResult struct {
	body string
	info CacheInfo
	err  error
}

// HardError marks a failure that must be alarmed on, never parsed as "no
// data". This mirrors cryptorank.HardError: the residual risk of the whole family
// is that the Framer markup changes (or the site starts refusing us) and the
// extractor silently returns an empty report. Kinds:
//
//	transport    the request never completed
//	layout       a 200 whose HTML has no body container / no headings / a body
//	             too short to be a real report
//	xml-403      a 403 with an S3-style XML body (a missing framerusercontent
//	             CMS resource answers 403, not 404 -- measured, 243 bytes,
//	             AccessDenied, application/xml)
//	status       any other unexpected upstream status
type HardError struct {
	Kind   string
	Status int
	Detail string
	URL    string
}

func (e *HardError) Error() string { return e.Detail }

// IsHardError reports whether err is alarmable.
func IsHardError(err error) (*HardError, bool) {
	var he *HardError
	if errors.As(err, &he) {
		return he, true
	}
	return nil, false
}

// NotFoundError is a real upstream 404 (the Framer "Page Not Found" page), the
// signal the handler turns into its own 404.
type NotFoundError struct {
	URL    string
	Status int
}

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("upstream %d: no such report", e.Status)
}

// New builds a Fetcher.
func New(o Options) (*Fetcher, error) {
	dir := o.CacheDir
	if dir == "" {
		dir = os.Getenv("FUDCOURT_DATA_KHALA_CACHE_DIR")
	}
	if dir == "" {
		root := os.Getenv("FUDCOURT_DATA_CACHE_DIR")
		if root == "" {
			root = DefaultCacheDir
		}
		dir = filepath.Join(root, "khala")
	}
	if strings.HasPrefix(dir, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve %s: %w", dir, err)
		}
		dir = filepath.Join(home, strings.TrimPrefix(dir, "~/"))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("cache dir %s: %w", dir, err)
	}
	timeout := o.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	f := &Fetcher{cacheDir: dir, timeout: timeout, client: o.Client, sf: map[string]*flight{}}
	if f.client == nil {
		// Redirects are followed (net/http's default, max 10). This is asserted
		// rather than inherited silently: khala.io is a static host today and
		// does not redirect, but a redirect turned into a hard failure is
		// exactly the kind of silent behaviour change internal/research/cryptorank measured
		// (WithNotFollowRedirects turned a 404 into a 502 there).
		f.client = &http.Client{
			Timeout: timeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 10 {
					return errors.New("stopped after 10 redirects")
				}
				return nil
			},
		}
	}
	return f, nil
}

// CacheDir is the resolved cache directory (logs/README/healthz).
func (f *Fetcher) CacheDir() string { return f.cacheDir }

// TTLDefault is the default per-request TTL in seconds.
func TTLDefault() int { return defaultTTL }

// CacheFile is the on-disk path of a URL's cache entry (exported for tests and
// for the smoke evidence that the file really exists).
func (f *Fetcher) CacheFile(url string) string {
	sum := sha256.Sum256([]byte(url))
	name := filepath.Base(strings.TrimSuffix(url, "/"))
	name = strings.NewReplacer("/", "_", ":", "_", "?", "_", "&", "_").Replace(name)
	if name == "" || name == "." {
		name = "root"
	}
	if len(name) > 48 {
		name = name[:48]
	}
	return filepath.Join(f.cacheDir, name+"."+hex.EncodeToString(sum[:8])+".json")
}

// Fetch retrieves url, honouring the disk cache.
//
// ttl is the per-request TTL in seconds and is an ARGUMENT, never fetcher
// state: the handler passes FUDCOURT_DATA_KHALA_TTL (default 900) normally and 0 for
// ?fresh=1. ttl <= 0 bypasses the TTL cache AND single-flight entirely (a
// fresh request must never be satisfied by an in-flight or cached fetch).
//
// On a cache miss the cached ETag is sent as If-None-Match; a 304 serves the
// stored body as a HIT (this is the politeness mechanism the site invites with
// `must-revalidate` + a strong ETag).
func (f *Fetcher) Fetch(ctx context.Context, url string, ttl int) (body string, info CacheInfo, err error) {
	if !AllowedURL(url) {
		return "", CacheInfo{}, fmt.Errorf("url not allowed: %s", url)
	}
	if ttl <= 0 {
		return f.fetch(ctx, url, ttl)
	}
	type res struct {
		body string
		info CacheInfo
		err  error
	}
	f.sfMu.Lock()
	if fl, ok := f.sf[url]; ok {
		f.sfMu.Unlock()
		<-fl.done
		return fl.res.body, fl.res.info, fl.res.err
	}
	fl := &flight{done: make(chan struct{})}
	f.sf[url] = fl
	f.sfMu.Unlock()
	b, i, e := f.fetch(ctx, url, ttl)
	fl.res = flightResult{body: b, info: i, err: e}
	close(fl.done)
	f.sfMu.Lock()
	delete(f.sf, url)
	f.sfMu.Unlock()
	return b, i, e
}

// InFlight reports the number of in-flight single-flight URLs (tests).
func (f *Fetcher) InFlight() int {
	f.sfMu.Lock()
	defer f.sfMu.Unlock()
	return len(f.sf)
}

func (f *Fetcher) fetch(ctx context.Context, url string, ttl int) (string, CacheInfo, error) {
	cf := f.CacheFile(url)
	stored, _ := readEntry(cf)
	// A stored entry with a non-200 status is never served: only real 200
	// bodies are cached, so nothing later mistakes an error page for data.
	if stored != nil && stored.Status != 200 {
		stored = nil
	}
	if stored != nil && ttl > 0 && time.Since(time.Unix(stored.FetchedAt, 0)) < time.Duration(ttl)*time.Second {
		return stored.Body, CacheInfo{Status: 200, Cache: "HIT", FetchedAt: stored.FetchedAt}, nil
	}
	etag := ""
	// A conditional GET is only for a TTL-driven revalidation. On `fresh=1`
	// (ttl <= 0) the caller asked for the LIVE page, so sending the stored
	// validator would let a 304 turn it into a cache HIT -- the exact opposite
	// of the request. cryptorank's route behaves this way (fresh=1 -> MISS),
	// and scripts/verify-khala.py asserts it here too.
	if stored != nil && ttl > 0 {
		etag = stored.ETag
	}
	status, hdr, raw, err := f.do(ctx, url, etag)
	if err != nil {
		return "", CacheInfo{}, err
	}
	if status == http.StatusNotModified {
		if stored == nil {
			// 304 with nothing stored: we cannot honour it. Refetch
			// unconditionally rather than invent a body.
			status, hdr, raw, err = f.do(ctx, url, "")
			if err != nil {
				return "", CacheInfo{}, err
			}
		} else {
			// Refresh the timestamp so the TTL window restarts, keep the body.
			stored.FetchedAt = time.Now().Unix()
			if e := writeEntry(cf, stored); e != nil {
				log.Printf("khala: cache write %s: %v", cf, e)
			}
			return stored.Body, CacheInfo{Status: 200, Cache: "HIT", Revalidated: true, FetchedAt: stored.FetchedAt}, nil
		}
	}
	switch {
	case status == http.StatusNotFound:
		// The decoy contract: a nonexistent slug is a REAL 404 (7384 bytes,
		// `<title>Page Not Found | Framer</title>`). A 404 that is not that
		// page is reported as an unexpected status instead of being trusted.
		if strings.Contains(raw, framerNotFoundMark) {
			return "", CacheInfo{}, &NotFoundError{URL: url, Status: status}
		}
		return "", CacheInfo{}, &HardError{
			Kind: "status", Status: status, URL: url,
			Detail: fmt.Sprintf("upstream %d without the Framer 'Page Not Found' marker (unexpected error page)", status),
		}
	case status == http.StatusForbidden && isXML(hdr):
		// A missing Framer CMS resource answers 403 with an S3-style
		// AccessDenied XML body (measured: 243 bytes, application/xml) -- note
		// 403, NOT 404. Never empty data.
		return "", CacheInfo{}, &HardError{
			Kind: "xml-403", Status: status, URL: url,
			Detail: fmt.Sprintf("upstream 403 with an XML body (missing CMS resource; S3-style AccessDenied): %s", truncate(raw, 120)),
		}
	case status != http.StatusOK:
		return "", CacheInfo{}, &HardError{
			Kind: "status", Status: status, URL: url,
			Detail: fmt.Sprintf("upstream HTTP %d (unexpected status)", status),
		}
	}
	ent := &Entry{URL: url, Status: status, ETag: hdr.Get("ETag"), Body: raw, FetchedAt: time.Now().Unix()}
	if err := writeEntry(cf, ent); err != nil {
		return "", CacheInfo{}, fmt.Errorf("cache write %s: %w", cf, err)
	}
	return raw, CacheInfo{Status: status, Cache: "MISS", FetchedAt: ent.FetchedAt}, nil
}

// do performs the request. When etag != "" it is sent as If-None-Match (the
// conditional GET that yields the measured 304).
func (f *Fetcher) do(ctx context.Context, url, etag string) (int, http.Header, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, "", err
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	r, err := f.client.Do(req)
	if err != nil {
		return 0, nil, "", &HardError{Kind: "transport", Detail: fmt.Sprintf("fetch failed: %T: %v", err, err), URL: url}
	}
	if r == nil {
		// A Doer that returns (nil, nil) is broken, but it must still surface as
		// an alarmable transport failure rather than a nil dereference.
		return 0, nil, "", &HardError{Kind: "transport", Detail: "transport returned no response and no error", URL: url}
	}
	defer r.Body.Close()
	var rd io.Reader = r.Body
	if strings.Contains(r.Header.Get("Content-Encoding"), "gzip") {
		if zr, e := gzip.NewReader(r.Body); e == nil {
			rd = zr
		}
	}
	b, err := io.ReadAll(io.LimitReader(rd, maxBodyBytes))
	if err != nil {
		return 0, r.Header, "", &HardError{Kind: "transport", Detail: fmt.Sprintf("read failed: %T: %v", err, err), URL: url}
	}
	return r.StatusCode, r.Header, string(b), nil
}

func isXML(h http.Header) bool {
	return strings.Contains(strings.ToLower(h.Get("Content-Type")), "xml")
}

func truncate(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func readEntry(cf string) (*Entry, error) {
	raw, err := os.ReadFile(cf)
	if err != nil {
		return nil, err
	}
	var e Entry
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, err
	}
	return &e, nil
}

// writeEntry is atomic (tmp + rename) with a UNIQUE temp name in the
// destination directory (same filesystem, so the rename is atomic). The unique
// name matters for the same reason it did in internal/research/cryptorank: ?fresh=1 deliberately
// bypasses single-flight, so two fresh requests can write the same cache file
// at once and a fixed ".tmp" path makes one rename fail with "no such file or
// directory" (measured there).
func writeEntry(cf string, e *Entry) error {
	raw, err := json.Marshal(e)
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

// AllowedURL is the path allowlist (defense in depth: the mode table only ever
// builds these URLs, but a stray one must still be refused). Exactly three
// URL shapes exist: the homepage, the sitemap and a report page.
func AllowedURL(u string) bool {
	switch u {
	case HomeURL, SitemapURL:
		return true
	}
	if !strings.HasPrefix(u, Base+"/") {
		return false
	}
	return ValidKey(strings.TrimPrefix(u, Base+"/"))
}
