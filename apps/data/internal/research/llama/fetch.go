package llama

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	urlpkg "net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/research"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/cache"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
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
// a transport failure, a non-200, or a 200 whose body is not the shape its URL
// promises.
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
//	not-a-list   JSON, but not the shape the URL promises (a list for the
//	             list-shaped URLs, an object for the object-shaped ones, a
//	             number for /tvl/{protocol})
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

// entry is one cached body. The raw bytes are kept, but so are the shaped
// projections the Service actually serves: a HIT must not re-decode and re-sort
// the 8.9MB /protocols body for every request. The projections are computed
// ONCE, at the time the body is first stored, and re-used by every HIT and
// coalesced flight below. shapeRows(body, url) knows which projection the URL
// promises, so rows/sorted are per-shape (see fetch.go's shapeRows).
type entry struct {
	body          string
	upstreamTotal int
	fetchedAt     int64
	rows          []json.RawMessage // decoded rows (nil when not yet computed)
	sorted        []json.RawMessage // rows sorted by tvl desc, for chains/protocols
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
// The cache is bounded by an LRU at maxEntries: the three original URLs are
// fixed, but the parameterized modes take one entry per distinct chain,
// protocol or coin-set, so a fixed three-key map can no longer hold the
// family. The per-URL TTL (TTLFor) decides freshness; the LRU only decides
// which entry leaves when the map is full. Nothing in this family is
// per-query beyond the URL itself: top/days are applied to the cached array,
// which is why `top=3` and `top=7` share one 8.9MB fetch.
// maxEntries bounds the cache at 100 entries: ~2x the distinct URLs the board
// itself requests (seven fixed modes plus a handful of chains, protocols and
// coin-sets), so anything past it is a caller walking parameters, which is
// exactly the traffic that must not grow without limit.
const maxEntries = 100

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

// ShapedByURL returns the decoded/sorted projections computed when the url's
// entry was first stored. It is the HIT-path twin of Fetch: the Service pairs
// Fetch (which proves the bytes are cached) with ShapedByURL (which returns
// the memoized projections without re-decoding). ok is false when no fresh
// entry exists, in which case the caller falls back to decoding the raw body.
// Freshness is the entry's per-URL TTL (TTLFor), not the fetcher default: a
// 1-hour chainHistory body must not be re-pulled every 15s, and a 60s prices
// body must not be served for an hour.
func (f *Fetcher) ShapedByURL(url string) (rows, sorted []json.RawMessage, ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e, ok := f.entries[url]
	if !ok || time.Since(time.Unix(e.fetchedAt, 0)) >= time.Duration(TTLFor(url, int(f.ttl/time.Second)))*time.Second {
		return nil, nil, false
	}
	return e.rows, e.sorted, true
}

// Fetch retrieves url, honouring the in-process TTL cache and single-flight.
//
// It returns the body, the FULL upstream row count, and the cache info. The
// count is returned alongside the bytes because only the JSON parse knows it,
// and a HIT must report the count belonging to the bytes it serves.
// Freshness is the URL's per-mode TTL (TTLFor with the fetcher default as the
// fallback), so a 1-hour chainHistory body is not re-pulled every 15s.
func (f *Fetcher) Fetch(ctx context.Context, url string) (body string, upstreamTotal int, info CacheInfo, err error) {
	if !AllowedURL(url) {
		return "", 0, CacheInfo{}, fmt.Errorf("url not allowed: %s", url)
	}
	ttl := time.Duration(TTLFor(url, int(f.ttl/time.Second))) * time.Second
	f.mu.Lock()
	if e, ok := f.entries[url]; ok && time.Since(time.Unix(e.fetchedAt, 0)) < ttl {
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
		rows, sorted, projErr := shapeRows(body, url)
		if projErr != nil {
			// The L2 body is valid JSON (l2Get only returns what Encode
			// stored, which fetch already validated); shapeRows failing
			// would mean a schema drift mid-process, which must not pin a
			// broken projection into L1. Fall through to a live fetch.
			f.mu.Lock()
			delete(f.flights, url)
			fl.err = projErr
			close(fl.done)
			f.mu.Unlock()
			return "", 0, CacheInfo{}, projErr
		} else {
			f.mu.Lock()
			f.evictIfFull()
			f.entries[url] = &entry{body: body, upstreamTotal: total, fetchedAt: fetchedAt,
				rows: rows, sorted: sorted}
			delete(f.flights, url)
			fl.body, fl.upstreamTotal = body, total
			fl.info = CacheInfo{Status: 200, Cache: "HIT", FetchedAt: fetchedAt, UpstreamTotal: total}
			close(fl.done)
			f.mu.Unlock()
			return body, total, fl.info, nil
		}
	}

	b, n, i, e := f.fetch(ctx, url)

	// Only a success is cached; the shared flight carries either way.
	f.mu.Lock()
	if e == nil {
		rows, sorted, projErr := shapeRows(b, url)
		if projErr != nil {
			// Unreachable via fetch (fetch already proved the body is the
			// shape its URL promises); kept so a second BodyFetcher
			// implementation cannot ship a half-parsed projection.
			f.evictIfFull()
			f.entries[url] = &entry{body: b, upstreamTotal: n, fetchedAt: i.FetchedAt}
		} else {
			f.evictIfFull()
			f.entries[url] = &entry{body: b, upstreamTotal: n, fetchedAt: i.FetchedAt,
				rows: rows, sorted: sorted}
		}
	}
	delete(f.flights, url)
	fl.body, fl.upstreamTotal, fl.info, fl.err = b, n, i, e
	close(fl.done)
	f.mu.Unlock()
	if e == nil {
		f.l2Set(ctx, key, url, b, n, i.FetchedAt)
	}
	return b, n, i, e
}

// evictIfFull drops the oldest entry when the cache is at its ceiling. Called
// with f.mu held.
func (f *Fetcher) evictIfFull() {
	if len(f.entries) < maxEntries {
		return
	}
	oldestKey, oldest := "", int64(1<<62)
	for k, e := range f.entries {
		if e.fetchedAt < oldest {
			oldestKey, oldest = k, e.fetchedAt
		}
	}
	if oldestKey != "" {
		delete(f.entries, oldestKey)
	}
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

func (f *Fetcher) l2Set(ctx context.Context, key, url, body string, total int, fetchedAt int64) {
	if !cache.Enabled() {
		return
	}
	// Detach from the request ctx: a client abort must not skip the L2 write,
	// which primes Valkey for the next deploy/restart. Short timeout so a hung
	// Valkey cannot leak the goroutine past the response.
	setCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The L2 lifetime is the URL's per-mode TTL (TTLFor): a 1-hour
	// chainHistory body must not evaporate after the 15s fallback, and a 60s
	// prices body must not linger for an hour. Unknown URLs keep the fetcher
	// default -- the SHORTER value, so a harness URL can never inherit the
	// longest per-mode TTL by accident.
	cache.Set(setCtx, key, cache.Encode(body, int64(total), fetchedAt), time.Duration(TTLFor(url, int(f.ttl/time.Second)))*time.Second)
}

// shapeRows decodes a validated body into the projections the Service serves.
// It runs ONCE per body (at the moment the body is stored in L1 or primed from
// L2) so a HIT pays no decode and no sort; the 8.9MB /protocols body is the
// case that forced this (see the entry comment). The url selects the shape:
// object-shaped bodies yield their inner array (stablecoins' peggedAssets,
// dexs/fees' protocols, yields' data, prices' coins map), and the sort key is
// the shape's own ordering (see shape.go's sort helpers).
func shapeRows(body, url string) ([]json.RawMessage, []json.RawMessage, error) {
	rows, err := extractRows(body, url)
	if err != nil {
		return nil, nil, err
	}
	return rows, sortRows(rows, url), nil
}

// fetch performs one unconditional upstream read and validates it into the
// shape its URL promises. Every refusal keeps the REAL status and the real
// body prefix.
func (f *Fetcher) fetch(ctx context.Context, url string) (string, int, CacheInfo, error) {
	status, raw, err := f.do(ctx, url)
	if err != nil {
		return "", 0, CacheInfo{}, err
	}
	if status != http.StatusOK {
		he := &HardError{Kind: "status", Status: status, URL: url, Body: research.SliceBody(raw, detailBytes), HasBody: raw != ""}
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
	total, shapeErr := checkShape(raw, url)
	if shapeErr != "" {
		he := &HardError{Status: 0, URL: url, Body: research.SliceBody(raw, detailBytes), HasBody: raw != ""}
		if json.Valid([]byte(raw)) {
			// "null" unmarshals into a slice without error, so the shape
			// check above is what makes a JSON null/object/string a shape
			// refusal instead of a 0-row list.
			he.Kind = "not-a-list"
			he.Detail = "upstream 200 body is valid JSON but not a list: " + he.Body
			return "", 0, CacheInfo{}, he
		}
		he.Kind = "non-json"
		he.Detail = "upstream 200 body is not JSON: " + he.Body
		return "", 0, CacheInfo{}, he
	}
	now := time.Now().Unix()
	info := CacheInfo{Status: status, Cache: "MISS", FetchedAt: now, UpstreamTotal: total}
	return raw, total, info, nil
}

// shapeKind names what a URL's body must be: a top-level JSON list, a JSON
// object carrying the rows, or a bare JSON number.
func shapeKind(url string) string {
	u, err := urlpkg.Parse(url)
	if err != nil {
		return "list"
	}
	host, path := u.Hostname(), u.Path
	switch host {
	case "coins.llama.fi":
		return "object"
	case "stablecoins.llama.fi", "yields.llama.fi":
		return "object"
	}
	if host != "api.llama.fi" {
		return "list"
	}
	switch path {
	case "/overview/dexs", "/overview/fees":
		return "object"
	}
	if strings.HasPrefix(path, PrefixTVL) && len(path) > len(PrefixTVL) {
		return "number"
	}
	return "list"
}

// checkShape validates raw against the shape its URL promises and returns the
// upstreamTotal the envelope reports: the list length for list bodies, the
// inner array length for object bodies, the coins map length for prices, 1
// for a tvl number. shapeErr is "" on success; callers distinguish non-JSON
// from wrong-shape with json.Valid, exactly as before.
func checkShape(raw, url string) (total int, shapeErr string) {
	trimmed := strings.TrimSpace(raw)
	switch shapeKind(url) {
	case "number":
		var v float64
		if err := json.Unmarshal([]byte(raw), &v); err != nil || !isBareNumber(trimmed) {
			return 0, "not-a-number"
		}
		return 1, ""
	case "object":
		if !strings.HasPrefix(trimmed, "{") {
			return 0, "not-an-object"
		}
		rows, err := extractRows(raw, url)
		if err != nil {
			return 0, "bad-object"
		}
		return len(rows), ""
	default:
		var arr []json.RawMessage
		if err := json.Unmarshal([]byte(raw), &arr); err != nil || !strings.HasPrefix(trimmed, "[") {
			return 0, "not-a-list"
		}
		return len(arr), ""
	}
}

// isBareNumber reports whether s is a bare JSON number: no quotes, no
// brackets, no braces, and it decodes as a float64. "null" decodes into a
// float64 target without error, so the charset test is what keeps a JSON null
// from passing as a TVL.
func isBareNumber(s string) bool {
	if s == "" {
		return false
	}
	for i := range s {
		c := s[i]
		if c >= '0' && c <= '9' || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' {
			continue
		}
		return false
	}
	return true
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

// AllowedURL is the URL allowlist: the seven fixed mode URLs plus the three
// parameterized prefixes with charset guards. Anything else (a path, a query
// on a parameterized URL, a fifth host) is refused before a request is built.
func AllowedURL(u string) bool {
	switch u {
	case Base + PathChains, Base + PathProtocols, Base + PathHistorical,
		StableBase + PathStablecoins, YieldsBase + PathYields,
		Base + PathDexs, Base + PathFees:
		return true
	}
	pu, err := urlpkg.Parse(u)
	if err != nil || pu.RawQuery != "" || pu.Fragment != "" {
		return false
	}
	host, path := pu.Hostname(), pu.Path
	if host == "api.llama.fi" {
		if rest, ok := strings.CutPrefix(path, PrefixChainHistory); ok {
			return isChainURL(rest)
		}
		if rest, ok := strings.CutPrefix(path, PrefixTVL); ok {
			return isProtocolURL(rest)
		}
		return false
	}
	if host == "coins.llama.fi" {
		if rest, ok := strings.CutPrefix(path, PrefixPrices); ok {
			return isCoinsURL(rest)
		}
	}
	return false
}

// isChainURL reports whether the escaped segment after the chainHistory
// prefix decodes to an admissible chain name. The handler validates the
// parameter before building the URL; this is defence in depth at the fetch
// boundary, never the validation itself.
func isChainURL(rest string) bool {
	if rest == "" {
		return false
	}
	un, err := urlpkg.PathUnescape(rest)
	if err != nil {
		return false
	}
	return isChainStr(un)
}

// isProtocolURL reports whether the escaped segment after the tvl prefix
// decodes to an admissible protocol slug.
func isProtocolURL(rest string) bool {
	if rest == "" {
		return false
	}
	un, err := urlpkg.PathUnescape(rest)
	if err != nil {
		return false
	}
	return isProtocolStr(un)
}

// isCoinsURL reports whether the escaped segment after the prices prefix
// decodes to an admissible coin list. PathEscape encodes the commas, so the
// check runs on the unescaped spelling the validator approved.
func isCoinsURL(rest string) bool {
	if rest == "" {
		return false
	}
	un, err := urlpkg.PathUnescape(rest)
	if err != nil {
		return false
	}
	return isCoinsStr(un)
}

// priceRow is one synthesized prices row: the coin id plus the fields the
// board renders. Built in extractRows so the fixed key order is stable on the
// wire (a map would serialise in random order).
type priceRow struct {
	ID         string `json:"id"`
	Price      any    `json:"price"`
	Symbol     any    `json:"symbol"`
	Timestamp  any    `json:"timestamp"`
	Confidence any    `json:"confidence"`
}

// extractRows pulls the servable row array out of a validated body: the body
// itself for list shapes; peggedAssets / protocols / data / the coins map for
// object shapes; a one-row [{tvl}] synthesis for a tvl number (the Service
// serves it as-is, so the row is identity, not data).
func extractRows(body, url string) ([]json.RawMessage, error) {
	kind := shapeKind(url)
	if kind == "list" {
		var rows []json.RawMessage
		if err := json.Unmarshal([]byte(body), &rows); err != nil {
			return nil, err
		}
		if rows == nil {
			rows = []json.RawMessage{}
		}
		return rows, nil
	}
	if kind == "number" {
		var v float64
		if err := json.Unmarshal([]byte(body), &v); err != nil {
			return nil, err
		}
		return []json.RawMessage{json.RawMessage([]byte(`{"tvl":` + strings.TrimSpace(body) + `}`))}, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &obj); err != nil {
		return nil, err
	}
	inner := innerKey(url)
	raw, ok := obj[inner]
	if !ok {
		return nil, fmt.Errorf("object body is missing %q", inner)
	}
	if inner == "coins" {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, err
		}
		rows := make([]json.RawMessage, 0, len(m))
		for id, v := range m {
			var detail map[string]any
			if err := json.Unmarshal(v, &detail); err != nil {
				detail = map[string]any{}
			}
			b, err := json.Marshal(priceRow{
				ID:         id,
				Price:      detail["price"],
				Symbol:     detail["symbol"],
				Timestamp:  detail["timestamp"],
				Confidence: detail["confidence"],
			})
			if err != nil {
				continue
			}
			rows = append(rows, b)
		}
		return rows, nil
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []json.RawMessage{}
	}
	return rows, nil
}

// innerKey names the object member carrying the rows for an object-shaped URL.
func innerKey(url string) string {
	u, err := urlpkg.Parse(url)
	if err != nil {
		return ""
	}
	switch u.Hostname() {
	case "stablecoins.llama.fi":
		return "peggedAssets"
	case "yields.llama.fi":
		return "data"
	case "coins.llama.fi":
		return "coins"
	}
	switch u.Path {
	case "/overview/dexs", "/overview/fees":
		return "protocols"
	}
	return ""
}

// sortRows orders extracted rows by the shape's own key: tvl desc for
// list-shaped bodies (the existing comparator), circulating desc for
// stablecoins, total24h desc for dexs/fees, tvlUsd desc for yields, price desc
// for prices. A missing key sorts as -1, below every real row — never 0.
func sortRows(rows []json.RawMessage, url string) []json.RawMessage {
	key := sortKey(url)
	if key == "tvl" {
		return SortByTVLDesc(rows)
	}
	out := make([]json.RawMessage, len(rows))
	copy(out, rows)
	sort.SliceStable(out, func(i, j int) bool {
		return numOf(out[i], key) > numOf(out[j], key)
	})
	return out
}

// sortKey names the numeric member sortRows orders by for a URL.
func sortKey(url string) string {
	u, err := urlpkg.Parse(url)
	if err != nil {
		return "tvl"
	}
	switch u.Hostname() {
	case "stablecoins.llama.fi":
		return "circulating"
	case "yields.llama.fi":
		return "tvlUsd"
	case "coins.llama.fi":
		return "price"
	}
	switch u.Path {
	case "/overview/dexs", "/overview/fees":
		return "total24h"
	}
	return "tvl"
}

// numOf reads a row's numeric member, descending into circulating.peggedUSD
// for stablecoin rows. Missing/null/non-numeric sorts as -1, never 0.
func numOf(raw json.RawMessage, key string) float64 {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return -1
	}
	v := m[key]
	if key == "circulating" {
		if inner, ok := v.(map[string]any); ok {
			v = inner["peggedUSD"]
		} else {
			return -1
		}
	}
	f, ok := f64of(v)
	if !ok {
		return -1
	}
	return f
}

// f64of reads a JSON number-or-numeric-string. A bare string that is not
// numeric is not a value, so it sorts last with the missing keys.
func f64of(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case string:
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			return f, true
		}
	}
	return 0, false
}
