package coinglass

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DefaultCacheDir is the coinglass cache root, *below* the fudcourt-data cache
// root the deploy unit sets (FUDCOURT_DATA_CACHE_DIR -> ~/.cache/fudcourt-data):
// "<root>/coinglass". A family must never share another family's cache
// directory (backend/data/README.md): a shared cache turns an independent
// verification fetch into self-confirmation.
const DefaultCacheDir = "~/.cache/fudcourt-data"

const (
	// maxBodyBytes caps one upstream body at 12 MiB. The largest measured
	// encrypted payload (openInterest/info) is ~6.4 KB decoded; the cap exists
	// to bound a pathological frame, not to fit today's content.
	maxBodyBytes = 12 << 20
	// defaultTTL is the per-request disk-cache TTL in seconds. CoinGlass sends
	// `cache-control: no-cache, no-store, must-revalidate`, so there is no
	// HTTP-level freshness to lean on and the TTL is ours. Futures statistics
	// move constantly; 60s keeps a board responsive without hammering an
	// undocumented-rate endpoint.
	defaultTTL = 60
)

// UA is the honest User-Agent for this family. The dashboard itself is a
// browser, but the API host does not fingerprint the TLS ClientHello (measured:
// plain net/http gets a real encrypted 200), so there is nothing a browser
// fingerprint would buy. Do not "fix" this into the tls-client stack.
const UA = "fudcourt-data/1.0 (+https://fc.dwirijal.my.id)"

// Hosts. capi serves the futures/spot dashboard data; fapi serves treasury,
// kline and community routes with the SAME encryption scheme.
const (
	CapiBase = "https://capi.coinglass.com"
	FapiBase = "https://fapi.coinglass.com"
)

// Doer is the subset of *http.Client the fetcher uses (injectable so tests
// drive every path without touching the network).
type Doer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Options configures a Fetcher.
type Options struct {
	// CacheDir overrides the resolved cache root (used as the cache directory
	// directly, not as a parent): "" -> FUDCOURT_DATA_COINGLASS_CACHE_DIR ->
	// <FUDCOURT_DATA_CACHE_DIR>/coinglass -> ~/.cache/fudcourt-data/coinglass.
	CacheDir string
	// Timeout for a single upstream request (default 30s).
	Timeout time.Duration
	// TTL in seconds for disk-cache entries (default defaultTTL).
	TTL int
	// Client is injectable.
	Client Doer
	// NoCache disables the disk cache (used by the live verifier so it never
	// reads a stale body and calls it a success).
	NoCache bool
}

// Entry is one cached response. The RAW body and the decryption headers are
// stored together: caching the decrypted JSON alone would make a `v`-table bug
// undetectable on a warm read, and would hide a rotated `v` from the next call.
type Entry struct {
	URL       string `json:"url"`
	Status    int    `json:"status"`
	Body      string `json:"body"`
	V         string `json:"v,omitempty"`
	User      string `json:"user,omitempty"`
	TimeHdr   string `json:"time,omitempty"`
	CacheTS   string `json:"cacheTs"`
	FetchedAt int64  `json:"fetchedAt"`
}

// CacheInfo says where the bytes came from.
type CacheInfo struct {
	Status int
	Cache  string // "MISS" or "HIT"
}

// Fetcher is the coinglass HTTP client + disk cache.
type Fetcher struct {
	cacheDir string
	ttl      int
	timeout  time.Duration
	client   Doer
	noCache  bool

	mu sync.Mutex // serialises cache writes
}

// New builds a Fetcher.
func New(o Options) (*Fetcher, error) {
	dir := o.CacheDir
	if dir == "" {
		dir = ResolveCacheDir()
	}
	if dir == "" {
		return nil, errors.New("coinglass: no cache dir: set FUDCOURT_DATA_COINGLASS_CACHE_DIR")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("coinglass: cache dir: %w", err)
	}
	ttl := o.TTL
	if ttl == 0 {
		ttl = defaultTTL
	}
	to := o.Timeout
	if to == 0 {
		to = 30 * time.Second
	}
	c := o.Client
	if c == nil {
		c = &http.Client{Timeout: to}
	}
	return &Fetcher{cacheDir: dir, ttl: ttl, timeout: to, client: c, noCache: o.NoCache}, nil
}

// ResolveCacheDir applies the documented precedence.
func ResolveCacheDir() string {
	if d := os.Getenv("FUDCOURT_DATA_COINGLASS_CACHE_DIR"); d != "" {
		return expand(d)
	}
	root := os.Getenv("FUDCOURT_DATA_CACHE_DIR")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		root = filepath.Join(home, ".cache", "fudcourt-data")
	}
	return filepath.Join(expand(root), "coinglass")
}

func expand(p string) string {
	if strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

// CacheDir is the resolved cache directory.
func (f *Fetcher) CacheDir() string { return f.cacheDir }

// TTL is the effective cache TTL in seconds.
func (f *Fetcher) TTL() int { return f.ttl }

func (f *Fetcher) pathFor(rawURL string) string {
	sum := sha256.Sum256([]byte(rawURL))
	return filepath.Join(f.cacheDir, hex.EncodeToString(sum[:16])+".json")
}

// Fetch gets rawURL and returns the decrypted payload.
//
// The disk cache stores the RAW encrypted response (see Entry), so a cache hit
// still runs the full two-layer decryption. That is deliberate: it means a
// rotated `v` or a broken key derivation fails on a warm read exactly as it
// would on a cold one, instead of being masked by a stored plaintext.
//
// A warm entry is served only when it decrypts AND is not an upstream refusal;
// otherwise the read is a MISS and falls through to a live fetch (see fetch).
// That guard is what keeps a cached refusal from pinning upstream's "no" to the
// disk for the whole TTL.
func (f *Fetcher) Fetch(ctx context.Context, rawURL string) (Result, CacheInfo, error) {
	return f.fetch(ctx, rawURL, true)
}

// FetchFresh bypasses the disk cache for THIS call only (the family's
// `fresh=1`). It is an argument rather than fetcher state so two concurrent
// requests cannot observe each other's policy.
func (f *Fetcher) FetchFresh(ctx context.Context, rawURL string) (Result, CacheInfo, error) {
	return f.fetch(ctx, rawURL, false)
}

func (f *Fetcher) fetch(ctx context.Context, rawURL string, useCache bool) (Result, CacheInfo, error) {
	info := CacheInfo{Cache: "MISS"}
	if useCache {
		entry, fresh := f.readCache(rawURL)
		if fresh {
			res, err := Decrypt([]byte(entry.Body), entry.User, entry.V, rawURL, entry.CacheTS, entry.TimeHdr)
			// A cached body is a HIT only when it still decrypts AND is not
			// an upstream refusal. Anything else falls through to a live
			// re-fetch:
			//
			//   - a body that no longer decrypts (a rotated `v` this table
			//     cannot derive, a truncated write) is a MISS, not a hard
			//     failure: the live fetch re-derives and, if it is still
			//     broken, reports the real error instead of a stale one.
			//   - a cached REFUSAL is a MISS too. Serving it as a HIT would
			//     pin upstream's "no" to the disk for the whole TTL, so a
			//     recovered upstream would stay invisible until the entry
			//     aged out — the refusal would be sticky. CoinAnk's read
			//     path guards the same way (coinank/fetch.go, where Decode
			//     returns a HardError for `success:false`); this family
			//     cached the raw body from the start but served it without
			//     the guard.
			if err == nil && !res.Refused() {
				info.Cache = "HIT"
				info.Status = entry.Status
				return res, info, nil
			}
		}
	}

	cacheTS := fmt.Sprintf("%d", time.Now().UnixMilli())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return Result{}, info, fmt.Errorf("coinglass: request: %w", err)
	}
	for k, v := range RequestHeaders(cacheTS) {
		req.Header.Set(k, v)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return Result{}, info, fmt.Errorf("coinglass: fetch %s: %w", rawURL, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return Result{}, info, fmt.Errorf("coinglass: read body: %w", err)
	}
	info.Status = resp.StatusCode
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Result{}, info, fmt.Errorf("coinglass: HTTP %d from %s", resp.StatusCode, rawURL)
	}

	e := Entry{
		URL:       rawURL,
		Status:    resp.StatusCode,
		Body:      string(body),
		V:         resp.Header.Get(HeaderV),
		User:      resp.Header.Get(HeaderUser),
		TimeHdr:   resp.Header.Get(HeaderTime),
		CacheTS:   cacheTS,
		FetchedAt: time.Now().Unix(),
	}
	f.writeCache(e)

	res, err := Decrypt(body, e.User, e.V, rawURL, cacheTS, e.TimeHdr)
	return res, info, err
}

// RequestHeaders is the header set the dashboard sends. Every value is
// load-bearing: `encryption: true` is what makes the server encrypt the body at
// all — without it the same endpoint answers a small UNENCRYPTED stub (measured:
// {"code":"0","msg":"success","success":true}, 43 bytes, no data), which a naive
// client would happily render as an empty result.
func RequestHeaders(cacheTS string) map[string]string {
	return map[string]string{
		"Accept":          "application/json, text/plain, */*",
		"Accept-Language": "en-US,en;q=0.9",
		"Cache-Ts-V2":     cacheTS,
		"Encryption":      "true",
		"Language":        "en",
		"Origin":          "https://www.coinglass.com",
		"Referer":         "https://www.coinglass.com/",
		"User-Agent":      UA,
	}
}

func (f *Fetcher) readCache(rawURL string) (Entry, bool) {
	if f.noCache {
		return Entry{}, false
	}
	b, err := os.ReadFile(f.pathFor(rawURL))
	if err != nil {
		return Entry{}, false
	}
	var e Entry
	if err := json.Unmarshal(b, &e); err != nil {
		return Entry{}, false
	}
	if e.Status != http.StatusOK || e.Body == "" {
		return Entry{}, false
	}
	if time.Now().Unix()-e.FetchedAt > int64(f.ttl) {
		return Entry{}, false
	}
	return e, true
}

func (f *Fetcher) writeCache(e Entry) {
	if f.noCache {
		return
	}
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	// Best-effort: a cache write failure must never fail the request.
	_ = os.WriteFile(f.pathFor(e.URL), b, 0o644)
}