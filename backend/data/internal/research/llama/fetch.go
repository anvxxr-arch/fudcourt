package llama

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/data/internal/research"
	"github.com/anvxxr-arch/fudcourt/backend/data/platform/cache"
	"github.com/anvxxr-arch/fudcourt/backend/data/platform/httpx"
)

const (
	// defaultTTL is the per-process cache TTL in seconds. It is the TS route's
	// lib/rate-limit.ts CACHE_TTL_MS = 15_000 ported: the board fires all three
	// modes on mount and again on every poll, and a 15s window collapses that
	// traffic to one upstream fetch per URL. Overridable with
	// FUDCOURT_DATA_LLAMA_TTL (read in New, like khala reads its cache env there).
	defaultTTL = 15
	// defaultTimeout is the TS route's TIMEOUT_MS = 20_000, verbatim.
	defaultTimeout = 20 * time.Second
	// maxBodyBytes caps one upstream body at 16 MiB. The largest measured body
	// is /protocols at 8.9MB, so this is ~1.8x headroom; it exists to bound a
	// pathological body (the family fetches the FULL 8.9MB list on purpose —
	// upstreamTotal must be the real array length — so the cap cannot be far
	// from it).
	maxBodyBytes = 16 << 20
)

const (
	// UA is the exact User-Agent the TS route sent. api.llama.fi is public and
	// keyless and never challenged a non-browser client (measured 2026-09-27),
	// so the string is kept identical rather than "improved": it is what
	// upstream's logs already show.
	UA = "fudcourt-web/1.0"
	// Accept is likewise the TS route's header.
	Accept = "application/json"
	// detailBytes is the upstream-body prefix kept in an error's `detail`
	// field: the TS route's body.slice(0, 200).
	detailBytes = 200
)

// Options configures a Fetcher.
type Options struct {
	// Client is injectable so tests drive the cache/single-flight/error paths
	// without touching the network. When nil a plain *http.Client is built.
	Client Doer
	// Timeout for a single upstream request (default 20s).
	Timeout time.Duration
	// TTL is the cache lifetime in seconds (0 -> defaultTTL). New reads
	// FUDCOURT_DATA_LLAMA_TTL when this is zero.
	TTL int
}

type Doer = research.Doer

// CacheInfo is where a body came from and what it contained.
type CacheInfo struct {
	// Status is the upstream status of the response being returned (200 — only
	// 200s are cached).
	Status int
	// Cache is "MISS" or "HIT". It is the value the handler puts in the
	// X-Cache response header.
	//
	// "COALESCED" — which the TS route relayed from its limiter — is NOT
	// produced here, and must not be faked: in Go the cache and single-flight
	// live in the same object, so a second caller waits on the in-flight fetch
	// and then reads the very same cache entry the first caller just stored.
	// Its X-Cache is HIT, which is the truth about how it was served (from
	// cache, no upstream round-trip); COALESCED would have to lie about which
	// of the two mechanisms answered. scripts/verify-llama.py accepts HIT on a
	// warm repeat.
	Cache string
	// FetchedAt is when the served body was downloaded from upstream.
	FetchedAt int64
	// UpstreamTotal is the FULL length of the upstream array the body carried
	// (the envelope's upstreamTotal). It is measured once, at fetch time, and
	// cached with the body so a HIT cannot report a different count than the
	// MISS that produced those bytes.
	UpstreamTotal int
}

// HardError is a failure that must be alarmed on and never parsed as data:
// a transport failure, a non-200, or a 200 whose body is not a JSON list.
//
// It exists for the same reason cryptorank.HardError and khala.HardError do: the
// residual risk of the family is that upstream starts answering HTML/JSON
// errors and a naive path ships an empty rows:[] as if DeFiLlama had no chains.
// Kinds:
//
//	transport    the request never completed (no status at all)
//	rate-limit   a 429
//	status       any other non-200
//	non-json     a 200 whose body is not JSON
//	not-a-list   JSON, but not the array every measured read returns
type HardError struct {
	Kind   string
	Status int
	URL    string
	// Detail is the error text (Error()): what the handler logs.
	Detail string
	// Body is the upstream body truncated to detailBytes (the 400/502 body's
	// `detail` field, matching the TS route's body.slice(0, 200)).
	Body string
	// HasBody says whether there was an upstream body to quote at all. It is
	// what makes an empty 502 body distinguishable from a transport failure
	// that never had one, so the handler can omit `detail` instead of
	// asserting `""` — which would read as "upstream sent nothing".
	HasBody bool
}

func (e *HardError) Error() string { return e.Detail }

// Message is the user-facing error string for a mode. The rate-limit and
// shape texts are the TS route's, verbatim (scripts/verify-llama.py reads
// them); the transport text quotes the real cause, never an invented one.
func (e *HardError) Message(mode string) string {
	switch e.Kind {
	case "transport":
		return "upstream " + mode + " unreachable: " + e.Detail
	case "rate-limit":
		return "upstream " + mode + " rate limited (429) — back off and retry"
	case "non-json":
		return "upstream " + mode + " returned a non-JSON body"
	case "not-a-list":
		return "upstream " + mode + " returned an unrecognised shape (expected a list)"
	}
	return "upstream " + mode + " HTTP " + strconv.Itoa(e.Status)
}

// IsHardError reports whether err is alarmable.
func IsHardError(err error) (*HardError, bool) {
	var he *HardError
	if errors.As(err, &he) {
		return he, true
	}
	return nil, false
}

// Requirement is one of the TLS/feature facts this family does NOT need, kept
// as prose only: api.llama.fi is plain HTTPS behind no fingerprinting wall, so
// the tls-client chrome_131 stack internal/research/cryptorank needs is deliberately not used here
// (same call as the khala fetcher's). A browser fingerprint would buy nothing
// and cost a dependency.

// entry is one cached body.
type entry struct {
	body          string
	upstreamTotal int
	fetchedAt     int64
}

// flight is an in-flight fetch other callers wait on.
type flight struct {
	done          chan struct{}
	body          string
	upstreamTotal int
	info          CacheInfo
	err           error
}

// Fetcher is the family's acquisition layer: an in-memory TTL cache plus
// single-flight, keyed on the upstream URL.
//
// The cache is BOUNDED BY CONSTRUCTION rather than by an eviction policy:
// AllowedURL admits exactly three URLs, so `entries` can hold three bodies
// (~9MB worst case — the /protocols body dominates) and no more. An LRU here
// would be ceremony around a map that cannot grow; the TS limiter needed one
// (CACHE_MAX_ENTRIES) only because it also cached per-query URLs such as a
// search box's. Nothing in this family is per-query: top/days are applied to
// the cached array, which is why `top=3` and `top=7` share one 8.9MB fetch.
type Fetcher struct {
	client  Doer
	timeout time.Duration
	ttl     time.Duration
	mu      sync.Mutex
	entries map[string]*entry
	flights map[string]*flight
}

// New builds a Fetcher.
func New(o Options) (*Fetcher, error) {
	ttl := o.TTL
	if ttl == 0 {
		if v := os.Getenv("FUDCOURT_DATA_LLAMA_TTL"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 {
				return nil, fmt.Errorf("FUDCOURT_DATA_LLAMA_TTL=%q is not a positive integer", v)
			}
			ttl = n
		} else {
			ttl = defaultTTL
		}
	}
	timeout := o.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	f := &Fetcher{
		client:  o.Client,
		timeout: timeout,
		ttl:     time.Duration(ttl) * time.Second,
		entries: map[string]*entry{},
		flights: map[string]*flight{},
	}
	if f.client == nil {
		// Redirects are followed (net/http's default), asserted rather than
		// inherited silently: a redirect silently turned into a failure is
		// exactly the behaviour change internal/research/cryptorank measured on another family.
		f.client = httpx.NewClient(timeout)
	}
	return f, nil
}

// TTL is the resolved cache lifetime in seconds (logs/healthz).
func (f *Fetcher) TTL() int { return int(f.ttl / time.Second) }

// Timeout is the per-request timeout (logs).
func (f *Fetcher) Timeout() time.Duration { return f.timeout }

// Stats is what the cache currently retains. It exists for the same reason the
// TS limiter exposed __cacheStats: an eviction/bounding claim with no
// observable is a claim nobody ever verifies.
type Stats struct {
	Entries int
	Flights int
}

// Stats reports the cache size (tests assert the map cannot grow).
func (f *Fetcher) Stats() Stats {
	f.mu.Lock()
	defer f.mu.Unlock()
	return Stats{Entries: len(f.entries), Flights: len(f.flights)}
}

// Fetch retrieves url, honouring the in-process TTL cache and single-flight.
//
// It returns the body, the FULL upstream array length, and the cache info. The
// length is returned alongside the bytes because only the JSON parse knows it,
// and a HIT must report the count belonging to the bytes it serves.
func (f *Fetcher) Fetch(ctx context.Context, url string) (body string, upstreamTotal int, info CacheInfo, err error) {
	if !AllowedURL(url) {
		return "", 0, CacheInfo{}, fmt.Errorf("url not allowed: %s", url)
	}
	f.mu.Lock()
	if e, ok := f.entries[url]; ok && time.Since(time.Unix(e.fetchedAt, 0)) < f.ttl {
		f.mu.Unlock()
		return e.body, e.upstreamTotal, CacheInfo{
			Status: 200, Cache: "HIT", FetchedAt: e.fetchedAt, UpstreamTotal: e.upstreamTotal,
		}, nil
	}
	if fl, ok := f.flights[url]; ok {
		// Join the in-flight fetch. Its result is handed over as-is, so a
		// joiner sees the same bytes and the same MISS/HIT mark.
		f.mu.Unlock()
		<-fl.done
		return fl.body, fl.upstreamTotal, fl.info, fl.err
	}
	fl := &flight{done: make(chan struct{})}
	f.flights[url] = fl
	f.mu.Unlock()

	// L2 (Valkey): consulted only when this process has no fresh copy — which is
	// exactly the state after a restart or a deploy. A hit here is counted as a
	// HIT and re-primed into L1, so the next caller pays nothing either. The
	// stored count travels with the bytes, because only the JSON parse knew it.
	key := cache.Key("llama", url)
	if body, total, fetchedAt, ok := f.l2Get(ctx, key); ok {
		f.mu.Lock()
		f.entries[url] = &entry{body: body, upstreamTotal: total, fetchedAt: fetchedAt}
		delete(f.flights, url)
		fl.body, fl.upstreamTotal = body, total
		fl.info = CacheInfo{Status: 200, Cache: "HIT", FetchedAt: fetchedAt, UpstreamTotal: total}
		close(fl.done)
		f.mu.Unlock()
		return body, total, fl.info, nil
	}

	b, n, i, e := f.fetch(ctx, url)

	// Only a success is cached; the shared flight carries either way.
	f.mu.Lock()
	if e == nil {
		f.entries[url] = &entry{body: b, upstreamTotal: n, fetchedAt: i.FetchedAt}
	}
	delete(f.flights, url)
	fl.body, fl.upstreamTotal, fl.info, fl.err = b, n, i, e
	close(fl.done)
	f.mu.Unlock()
	if e == nil {
		f.l2Set(ctx, key, b, n, i.FetchedAt)
	}
	return b, n, i, e
}

// l2Get reads the Valkey copy. The upstream count and the ORIGINAL fetch time
// travel with the bytes (cache.Encode), because a HIT must report the length of
// the array it is serving and the moment that array was actually observed —
// reporting time.Now() on a hit would tell the board an hour-old body was
// fetched this second. Any malformed value is a miss, never an error.
func (f *Fetcher) l2Get(ctx context.Context, key string) (string, int, int64, bool) {
	if !cache.Enabled() {
		return "", 0, 0, false
	}
	v, ok := cache.Get(ctx, key)
	if !ok {
		return "", 0, 0, false
	}
	body, meta, ok := cache.Decode(v, 2)
	if !ok {
		return "", 0, 0, false
	}
	return body, int(meta[0]), meta[1], true
}

func (f *Fetcher) l2Set(ctx context.Context, key, body string, total int, fetchedAt int64) {
	if !cache.Enabled() {
		return
	}
	cache.Set(ctx, key, cache.Encode(body, int64(total), fetchedAt), f.ttl)
}

// fetch performs one unconditional upstream read and validates it into a JSON
// array. Every refusal keeps the REAL status and the real body prefix.
func (f *Fetcher) fetch(ctx context.Context, url string) (string, int, CacheInfo, error) {
	status, raw, err := f.do(ctx, url)
	if err != nil {
		return "", 0, CacheInfo{}, err
	}
	if status != http.StatusOK {
		he := &HardError{Kind: "status", Status: status, URL: url, Body: sliceBody(raw), HasBody: raw != ""}
		if status == http.StatusTooManyRequests {
			he.Kind = "rate-limit"
			he.Detail = fmt.Sprintf("upstream 429 with body: %s", he.Body)
			return "", 0, CacheInfo{}, he
		}
		he.Detail = fmt.Sprintf("upstream HTTP %d with body: %s", status, he.Body)
		return "", 0, CacheInfo{}, he
	}
	// The Content-Type header is deliberately NOT asserted here: the body
	// checks below are strictly stronger (a non-JSON body is refused whether or
	// not the header lied), and a header check would refuse a valid JSON body
	// served as text/plain, which the TS route accepted. api.llama.fi answers
	// application/json for every measured read.
	var arr []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &arr); err != nil || !strings.HasPrefix(strings.TrimSpace(raw), "[") {
		he := &HardError{Status: status, URL: url, Body: sliceBody(raw), HasBody: raw != ""}
		if json.Valid([]byte(raw)) {
			// "null" unmarshals into a slice without error, so the bracket test
			// above is what makes a JSON null/object/string a shape refusal
			// instead of a 0-row list.
			he.Kind = "not-a-list"
			he.Detail = "upstream 200 body is valid JSON but not a list: " + he.Body
			return "", 0, CacheInfo{}, he
		}
		he.Kind = "non-json"
		he.Detail = "upstream 200 body is not JSON: " + he.Body
		return "", 0, CacheInfo{}, he
	}
	now := time.Now().Unix()
	info := CacheInfo{Status: status, Cache: "MISS", FetchedAt: now, UpstreamTotal: len(arr)}
	return raw, len(arr), info, nil
}

// do performs the request with the family's headers.
func (f *Fetcher) do(ctx context.Context, url string) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", Accept)
	r, err := f.client.Do(req)
	if err != nil {
		return 0, "", &HardError{
			Kind:   "transport",
			URL:    url,
			Detail: fmt.Sprintf("%T: %v", err, err),
		}
	}
	if r == nil {
		// A Doer returning (nil, nil) is broken, but it must surface as an
		// alarmable failure rather than a nil dereference.
		return 0, "", &HardError{Kind: "transport", URL: url, Detail: "transport returned no response and no error"}
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
		return 0, "", &HardError{Kind: "transport", URL: url, Detail: fmt.Sprintf("read failed: %T: %v", err, err)}
	}
	return r.StatusCode, string(b), nil
}

// sliceBody is the error body's `detail`: the first 200 BYTES of the upstream
// body, the TS route's body.slice(0, 200). Truncating mid-rune would emit
// invalid UTF-8 into JSON, so the cut is pushed back to the last rune
// boundary — an honest prefix, never a lossy one.
func sliceBody(s string) string {
	if len(s) <= detailBytes {
		return s
	}
	cut := detailBytes
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut]
}

// utf8Start reports whether b can start a UTF-8 rune.
func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// AllowedURL is the URL allowlist. The mode table only ever builds three URLs,
// so this is a fence around them, not a router: anything else (a path, a query,
// a second host) is refused before a request is built.
func AllowedURL(u string) bool {
	switch u {
	case Base + PathChains, Base + PathProtocols, Base + PathHistorical:
		return true
	}
	return false
}
