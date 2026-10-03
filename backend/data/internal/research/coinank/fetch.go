package coinank

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

	"github.com/anvxxr-arch/fudcourt/backend/data/platform/httpx"
)

// DefaultCacheDir is the parent of this family's cache root, mirroring the
// CoinGlass family: the deploy unit sets FUDCOURT_DATA_CACHE_DIR ->
// ~/.cache/fudcourt-data and each family owns "<root>/<family>". A family must
// never share another family's cache directory (backend/data/README.md): a
// shared cache turns an independent verification fetch into self-confirmation.
//
// It matters more here than usual. This family and the coinglass family are both
// "keyless futures data" and would look interchangeable to a future maintainer
// consolidating caches -- they are not interchangeable, and a shared directory
// would make the two families' cached bodies indistinguishable.
const DefaultCacheDir = "~/.cache/fudcourt-data"

const (
	// maxBodyBytes caps one upstream body at 12 MiB. The largest measured
	// response is fundingRate/current at ~1.85 MB (882 symbols, each carrying
	// per-exchange maps) -- an order of magnitude above every other endpoint
	// here, so the cap is loose enough for the real content and tight enough to
	// bound a pathological frame.
	maxBodyBytes = 12 << 20
	// defaultTTL is the disk-cache TTL in seconds. CoinAnk sends no useful
	// cache-control, so the TTL is ours. Funding rates, liquidation turns and
	// whale positions all move constantly; 60s keeps a board responsive without
	// hammering an undocumented endpoint.
	defaultTTL = 60
)

// UA is the honest User-Agent for this family. CoinAnk's API host does not
// fingerprint the TLS ClientHello (measured: a plain net/http GET with the
// computed signature returns HTTP 200 with real data), so a browser-shaped
// fingerprint would buy nothing. Do not "fix" this into the tls-client stack.
const UA = "fudcourt-data/1.0 (+https://fc.dwirijal.my.id)"

// Base is the dashboard backend host -- the keyless surface. The DOCUMENTED
// host is open-api.coinank.com, which needs a real issued apikey and is not used
// by this family.
const Base = "https://api.coinank.com"

// Envelope is the CoinAnk response wrapper.
//
// Every field is preserved rather than reduced to `data`. An upstream refusal
// arrives as HTTP **200** with `success:false` and `msg:"system error!"`, so
// dropping Success/Msg would turn "CoinAnk rejected this request" into "no
// data" -- the silent-empty failure this codebase forbids.
type Envelope struct {
	Success bool            `json:"success"`
	Code    string          `json:"code"`
	ExtCode *string         `json:"extCode"`
	Msg     *string         `json:"msg"`
	Data    json.RawMessage `json:"data"`
}

// Result is one decoded upstream response.
type Result struct {
	// URL is the exact request URL the data came from.
	URL string
	// Envelope is the upstream envelope, verbatim.
	Envelope Envelope
}

// CacheInfo says where the bytes came from.
type CacheInfo struct {
	Status int
	Cache  string // "MISS" or "HIT"
}

// Doer is the subset of *http.Client the fetcher uses (injectable so tests drive
// every path without touching the network).
type Doer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Options configures a Fetcher.
type Options struct {
	// CacheDir overrides the resolved cache root (used as the cache directory
	// directly, not as a parent): "" -> FUDCOURT_DATA_COINANK_CACHE_DIR ->
	// <FUDCOURT_DATA_CACHE_DIR>/coinank -> ~/.cache/fudcourt-data/coinank.
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

// Entry is one cached response: the upstream body, verbatim.
//
// Unlike CoinGlass there is no ciphertext to keep, but the body is still stored
// UNPARSED for a related reason -- re-parsing a cached string on every read means
// a validation rule added later applies to warm entries too, instead of being
// silently bypassed for whatever is already on disk.
type Entry struct {
	URL       string `json:"url"`
	Status    int    `json:"status"`
	Body      string `json:"body"`
	FetchedAt int64  `json:"fetchedAt"`
}

// Fetcher is the CoinAnk HTTP client + disk cache.
type Fetcher struct {
	cacheDir string
	ttl      int
	timeout  time.Duration
	client   Doer
	noCache  bool
	// now is the clock, injectable so the signature and cache age are testable.
	now func() time.Time

	mu sync.Mutex // serialises cache writes
}

// New builds a Fetcher.
func New(o Options) (*Fetcher, error) {
	dir := o.CacheDir
	if dir == "" {
		dir = ResolveCacheDir()
	}
	if dir == "" {
		return nil, errors.New("coinank: no cache dir: set FUDCOURT_DATA_COINANK_CACHE_DIR")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("coinank: cache dir: %w", err)
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
		c = httpx.NewClient(to)
	}
	return &Fetcher{
		cacheDir: dir, ttl: ttl, timeout: to, client: c, noCache: o.NoCache,
		now: time.Now,
	}, nil
}

// ResolveCacheDir applies the documented precedence.
func ResolveCacheDir() string {
	if d := os.Getenv("FUDCOURT_DATA_COINANK_CACHE_DIR"); d != "" {
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
	return filepath.Join(expand(root), "coinank")
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

// Fetch gets rawURL (cached) and returns the decoded envelope.
func (f *Fetcher) Fetch(ctx context.Context, rawURL string) (Result, CacheInfo, error) {
	return f.fetch(ctx, rawURL, true)
}

// FetchFresh bypasses the disk cache for THIS call only (the family's
// `fresh=1`). It is an argument rather than fetcher state so two concurrent
// requests cannot observe each other's policy.
//
// It also matters for a second reason specific to this family: the signature is
// derived from the millisecond clock, so a fresh call re-signs. A cached read
// reuses whatever was signed earlier -- correct for a stored body, but it means
// only `fresh=1` exercises the live signature path.
func (f *Fetcher) FetchFresh(ctx context.Context, rawURL string) (Result, CacheInfo, error) {
	return f.fetch(ctx, rawURL, false)
}

func (f *Fetcher) fetch(ctx context.Context, rawURL string, useCache bool) (Result, CacheInfo, error) {
	info := CacheInfo{Cache: "MISS"}
	if useCache {
		if entry, ok := f.readCache(rawURL); ok {
			res, err := Decode(rawURL, []byte(entry.Body))
			if err == nil {
				info.Cache = "HIT"
				info.Status = entry.Status
				return res, info, nil
			}
			// A cached body that no longer decodes (schema drift, truncated
			// write) is a MISS, not a hard failure: fall through and re-fetch.
		}
	}

	nowMs := f.now().UnixMilli()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return Result{}, info, fmt.Errorf("coinank: request: %w", err)
	}
	for k, v := range RequestHeaders(nowMs) {
		req.Header.Set(k, v)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		return Result{}, info, fmt.Errorf("coinank: fetch %s: %w", rawURL, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return Result{}, info, fmt.Errorf("coinank: read body: %w", err)
	}
	info.Status = resp.StatusCode
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Result{}, info, fmt.Errorf("coinank: HTTP %d from %s", resp.StatusCode, rawURL)
	}

	f.writeCache(Entry{
		URL:       rawURL,
		Status:    resp.StatusCode,
		Body:      string(body),
		FetchedAt: f.now().Unix(),
	})

	res, err := Decode(rawURL, body)
	return res, info, err
}

// Decode parses an upstream body into a Result.
//
// A 200 whose envelope says `success:false` is an ERROR here, never an empty
// result. That is the whole point of keeping the envelope: CoinAnk reports
// "system error!" (missing/unsupported param) with a 200 status, so a client
// that only checks the HTTP code renders a refusal as an empty table.
func Decode(rawURL string, body []byte) (Result, error) {
	var env Envelope
	if err := json.Unmarshal(body, &env); err != nil {
		return Result{URL: rawURL}, fmt.Errorf("coinank: decode %s: %w", rawURL, err)
	}
	res := Result{URL: rawURL, Envelope: env}
	if !env.Success {
		msg := ""
		if env.Msg != nil {
			msg = *env.Msg
		}
		return res, &HardError{
			Kind: "upstream", URL: rawURL, Code: env.Code,
			Detail: fmt.Sprintf("CoinAnk refused the request: %s", firstNonEmpty(msg, "(no message)")),
		}
	}
	return res, nil
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
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
	if f.now().Unix()-e.FetchedAt > int64(f.ttl) {
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
