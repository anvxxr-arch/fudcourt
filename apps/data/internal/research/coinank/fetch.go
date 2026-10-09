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
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

// DefaultCacheDir is the parent of this family's cache root, mirroring the
// CoinGlass family: the deploy unit sets FUDCOURT_DATA_CACHE_DIR ->
// ~/.cache/fudcourt-data and each family owns "<root>/<family>". A family must
// never share another family's cache directory (apps/data/README.md): a
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
	Cache  string // "MISS", "HIT" or "STALE" (the labelled last-good fallback)
	// FetchedAt is when the served body was downloaded from upstream. It is
	// envelope's fetchedAt mirrors llama/news/chainrank instead of stamping
	// shape time on a warm read.
	FetchedAt int64
}

type Doer = research.Doer

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
	// Now overrides the clock (tests pin cache age and staleness). Default
	// time.Now.
	Now func() time.Time
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

// flight is an in-flight upstream fetch other callers wait on (single-flight,
// keyed on the upstream URL). Its outcome -- success, refusal, or the STALE
// fallback -- is handed to every joiner verbatim.
type flight struct {
	done chan struct{}
	res  Result
	info CacheInfo
	err  error
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

	// mu guards flights and serialises cache writes/prunes.
	mu      sync.Mutex
	flights map[string]*flight
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
	now := o.Now
	if now == nil {
		now = time.Now
	}
	return &Fetcher{
		cacheDir: dir, ttl: ttl, timeout: to, client: c, noCache: o.NoCache,
		now: now, flights: map[string]*flight{},
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

// Fetch gets rawURL (cached) and returns the decoded envelope. It JOINS an
// in-flight fetch for the same URL (single-flight) and, when upstream refuses
// even after the bounded retry, falls back to the newest decodable body on
// disk served loudly as STALE -- real, labelled data rather than a blank board.
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

// Retry policy for a TRANSIENT upstream refusal.
//
// Measured, not assumed: `api.coinank.com` answers HTTP **200** with
// `{"success":false,"code":"403","msg":"please sub api to get data"}` in bursts
// and then serves the very same request normally seconds later. Verified live --
// every mode (`fundingRate` 1.8 MB, `longShort` 165 KB, `etf` 472 KB) returned
// `success:true` on the next pass with no change to the signature, the version
// header or the host. So "please sub api to get data" is NOT an entitlement
// wall and NOT a bug in the client-side signature (that is proven accepted: a
// garbage or absent signature produces a DIFFERENT message, `system error`).
// It is a self-clearing refusal -- most likely an abuse/rate heuristic, and one
// this family can trigger itself by bursting, which is exactly why the retry
// below is bounded and backed off rather than tight.
//
// Before this, one such refusal became a hard error on the first attempt, so a
// blip that clears in a second blanked the board and failed the uptime monitor.
const (
	// maxAttempts bounds the retry loop. Three attempts at 700ms then 1.4s is
	// ~2.1s of worst-case added latency inside a 30s request timeout and a 75s
	// BFF timeout: enough to ride out the measured blip, short enough that a
	// genuine outage still fails in a timely and visible way.
	maxAttempts = 3
	// retryBase is the first backoff. It is deliberately not tight: a burst is
	// the thing that appears to CAUSE the refusal, so the retry must not look
	// like more burst.
	retryBase = 700 * time.Millisecond
	// refusalCode and refusalDetail identify the measured transient refusal.
	// Matching on both keeps this narrow: a param error arrives with
	// `code:"0"` / `system error!` and must NEVER be retried, because it is
	// deterministic and retrying only burns the timeout.
	refusalCode   = "403"
	refusalDetail = "please sub api"
	// maxStaleSec bounds how old a cached body may be and still be served as
	// the STALE fallback. 24h: the measured walls lasted ~2h (2026-10-09) and
	// up to a day (2026-10-07). Beyond a day the numbers stop being something
	// a reader can use even labelled, so the refusal goes loud again instead.
	maxStaleSec = 24 * 3600
)

// transientRefusal reports whether a decode error is the upstream's
// self-clearing refusal rather than a deterministic one.
func transientRefusal(err error) bool {
	var he *HardError
	if !errors.As(err, &he) || he.Kind != "upstream" {
		return false
	}
	return he.Code == refusalCode && strings.Contains(strings.ToLower(he.Detail), refusalDetail)
}

// fetch is the ONE read path. useCache=true (Fetch) honours the disk cache,
// joins an in-flight fetch for the same URL, and falls back to the labelled
// last-good body below when the bounded retry gives up. useCache=false
// (FetchFresh, the `fresh=1` path) does NONE of these: a caller who asked for
// the live truth gets an error rather than a labelled old answer, which is
// what keeps the live verifiers honest.
func (f *Fetcher) fetch(ctx context.Context, rawURL string, useCache bool) (Result, CacheInfo, error) {
	info := CacheInfo{Cache: "MISS"}
	if !useCache {
		res, err := f.fetchUpstream(ctx, rawURL, &info)
		return res, info, err
	}
	if entry, ok := f.readCache(rawURL); ok {
		res, err := Decode(rawURL, []byte(entry.Body))
		if err == nil {
			info.Cache = "HIT"
			info.Status = entry.Status
			info.FetchedAt = entry.FetchedAt
			return res, info, nil
		}
		// A cached body that no longer decodes (schema drift, truncated
		// write) is a MISS, not a hard failure: fall through and re-fetch.
	}

	// Single-flight, keyed on the upstream URL: a request storm (every board
	// section mounted at once, or several boards) collapses to ONE upstream
	// fetch. That matters more here than the bandwidth -- CoinAnk's refusal
	// heuristic appears to trip on bursts, so our own concurrency must never
	// be able to trip it. The joiner receives the leader's outcome verbatim
	// (its MISS/STALE/error), never a second upstream call.
	f.mu.Lock()
	if fl, ok := f.flights[rawURL]; ok {
		f.mu.Unlock()
		<-fl.done
		return fl.res, fl.info, fl.err
	}
	fl := &flight{done: make(chan struct{})}
	f.flights[rawURL] = fl
	f.mu.Unlock()

	res, err := f.fetchUpstream(ctx, rawURL, &info)
	if err != nil {
		// The upstream refused (or died) even after the bounded retry. A
		// labelled last-good body is strictly better than a blank board: the
		// data is real, `fetchedAt` says WHEN it was true, and the envelope
		// carries `stale`/`staleAgeSec` so no consumer can mistake it for
		// current. Nothing decodable on disk? The refusal stands.
		if sres, sinfo, ok := f.staleFallback(rawURL); ok {
			res, info, err = sres, sinfo, nil
		}
	}
	f.mu.Lock()
	fl.res, fl.info, fl.err = res, info, err
	delete(f.flights, rawURL)
	f.mu.Unlock()
	close(fl.done)
	return res, info, err
}

// fetchUpstream runs the bounded, backed-off retry loop against upstream.
func (f *Fetcher) fetchUpstream(ctx context.Context, rawURL string, info *CacheInfo) (Result, error) {
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			wait := retryBase << (attempt - 2)
			select {
			case <-ctx.Done():
				return Result{}, ctx.Err()
			case <-time.After(wait):
			}
		}
		res, retryable, err := f.attempt(ctx, rawURL, info)
		if err == nil {
			return res, nil
		}
		lastErr = err
		if !retryable || attempt == maxAttempts {
			return res, err
		}
	}
	return Result{}, lastErr
}

// attempt performs ONE signed upstream call.
//
// `retryable` reports whether the failure is the kind measured to clear on its
// own. It is a separate return rather than something the caller re-derives from
// the error because the classifier differs by failure class: a transport error
// and a 5xx are transient by nature, an upstream envelope refusal is transient
// only when it is the measured message, and a 4xx other than 429 is not.
//
// The signature is clock-derived, so a retry MUST re-sign: it does, because the
// request headers are rebuilt here on every attempt. Reusing attempt 1's signed
// headers on attempt 2 would send a stale clock and fail for a second reason.
func (f *Fetcher) attempt(ctx context.Context, rawURL string, info *CacheInfo) (Result, bool, error) {
	nowMs := f.now().UnixMilli()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return Result{}, false, fmt.Errorf("coinank: request: %w", err)
	}
	for k, v := range RequestHeaders(nowMs) {
		req.Header.Set(k, v)
	}
	resp, err := f.client.Do(req)
	if err != nil {
		// A transport failure is transient by nature and worth one retry, but
		// only when the context is still live -- a cancelled request is not a
		// blip and must not be retried.
		return Result{}, ctx.Err() == nil, fmt.Errorf("coinank: fetch %s: %w", rawURL, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return Result{}, ctx.Err() == nil, fmt.Errorf("coinank: read body: %w", err)
	}
	info.Status = resp.StatusCode
	info.FetchedAt = f.now().Unix()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		transient := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
		return Result{}, transient, fmt.Errorf("coinank: HTTP %d from %s", resp.StatusCode, rawURL)
	}

	res, err := Decode(rawURL, body)
	if err != nil {
		return res, transientRefusal(err), err
	}

	// Cache ONLY a body that DECODED. This write used to happen before Decode,
	// which meant a refused envelope (`success:false`) was stored as if it were
	// data: a warm read then re-decoded it, failed, and fell through to a
	// re-fetch, so the poisoning was survivable but it wasted one of the 64
	// slots and left a body on disk that no reader would ever accept.
	f.writeCache(Entry{
		URL:       rawURL,
		Status:    resp.StatusCode,
		Body:      string(body),
		FetchedAt: f.now().Unix(),
	})
	return res, false, nil
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
	// The TTL is PER-MODE (modes.go:TTLFor): a 1-hour etf body must not be
	// re-pulled every minute, and an unclaimed URL falls back to the short
	// fetcher-level TTL rather than the longest per-mode value.
	if f.now().Unix()-e.FetchedAt > int64(TTLFor(rawURL, f.ttl)) {
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
	f.pruneCache()
}

// readStaleCache is readCache WITHOUT the TTL: any entry that still decodes is
// eligible, bounded only by maxStaleSec. A NoCache fetcher returns nothing --
// the live verifier must never see a stale body dressed as an answer.
func (f *Fetcher) readStaleCache(rawURL string) (Entry, bool) {
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
	age := f.now().Unix() - e.FetchedAt
	if age < 0 || age > maxStaleSec {
		return Entry{}, false
	}
	return e, true
}

// staleFallback is the labelled last-good serve: the newest decodable body on
// disk, with Cache=STALE and its ORIGINAL FetchedAt, so the envelope's
// fetchedAt stays the moment the data was true. A refusal can never be here --
// refusals are never written to disk (attempt writes only after Decode).
func (f *Fetcher) staleFallback(rawURL string) (Result, CacheInfo, bool) {
	entry, ok := f.readStaleCache(rawURL)
	if !ok {
		return Result{}, CacheInfo{}, false
	}
	res, err := Decode(rawURL, []byte(entry.Body))
	if err != nil {
		return Result{}, CacheInfo{}, false
	}
	return res, CacheInfo{Cache: "STALE", Status: entry.Status, FetchedAt: entry.FetchedAt}, true
}

// maxCacheEntries bounds the on-disk cache. The chainrank family caps its
// in-memory cache at 32; this family's disk cache had NO bound and grew once
// per distinct URL forever. 64 entries is ~2x the URLs the board actually
// requests (each mode a handful of intervals/symbols) and keeps the directory
// listable.
const maxCacheEntries = 64

// pruneCache evicts the oldest entries (by Entry.FetchedAt, falling back to
// file mtime when an entry cannot be decoded) so at most maxCacheEntries
// remain. Best-effort: a read/remove failure never fails the request. Called
// under f.mu, after the write.
func (f *Fetcher) pruneCache() {
	dirs, err := os.ReadDir(f.cacheDir)
	if err != nil || len(dirs) <= maxCacheEntries {
		return
	}
	type cand struct {
		name      string
		fetchedAt int64
	}
	cands := make([]cand, 0, len(dirs))
	for _, d := range dirs {
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".json") {
			continue
		}
		v, err := os.ReadFile(filepath.Join(f.cacheDir, d.Name()))
		if err == nil {
			var e Entry
			if json.Unmarshal(v, &e) == nil && e.FetchedAt > 0 {
				cands = append(cands, cand{name: d.Name(), fetchedAt: e.FetchedAt})
				continue
			}
		}
		if info, err := d.Info(); err == nil {
			cands = append(cands, cand{name: d.Name(), fetchedAt: info.ModTime().Unix()})
		}
	}
	if len(cands) <= maxCacheEntries {
		return
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].fetchedAt < cands[j].fetchedAt })
	for i := 0; i < len(cands)-maxCacheEntries; i++ {
		_ = os.Remove(filepath.Join(f.cacheDir, cands[i].name))
	}
}
