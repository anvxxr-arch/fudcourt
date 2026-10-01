package chainrank

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

	"github.com/anvxxr-arch/fudcourt/apps/apicalls/internal/cache"
)

const (
	// defaultTTL is the per-process cache TTL in seconds. The TS route used
	// lib/rate-limit.ts; the board refreshes stats+listings every 20s, and a
	// window slightly under that collapses the refresh loop's traffic to one
	// upstream call per URL.
	defaultTTL = 15
	// defaultTimeout is the TS route's TIMEOUT_MS = 15_000, verbatim.
	defaultTimeout = 15 * time.Second
	// maxBodyBytes caps one upstream body at 4 MiB. Measured: listings with
	// pageSize=200 is a few hundred KB, so this is ample headroom; it exists to
	// bound a pathological body, not to trim a real one.
	maxBodyBytes = 4 << 20
)

const (
	// UA is the exact User-Agent the TS route sent.
	UA = "fudcourt-web/1.0"
	// Accept is the TS route's header.
	Accept = "application/json"
	// FromHeader is the TS route's `From`: robots.txt disallows /api/ to
	// crawlers, and this is the identification that makes the relay honest.
	FromHeader = "fudcourt (read-only leaderboard relay)"
	// detailBytes is the upstream-body prefix kept in an error's `detail`
	// field: the TS route's body.slice(0, 200).
	detailBytes = 200
)

// Options configures a Fetcher.
type Options struct {
	// Client is injectable so tests drive the cache/single-flight/error paths
	// without touching the network. When nil a plain *http.Client is built.
	Client Doer
	// Timeout for a single upstream request (default 15s).
	Timeout time.Duration
	// TTL is the cache lifetime in seconds (0 -> defaultTTL). New reads
	// APICALLS_CHAINRANK_TTL when this is zero.
	TTL int
}

// Doer is the subset of *http.Client the fetcher uses.
type Doer interface {
	Do(*http.Request) (*http.Response, error)
}

// CacheInfo describes how one Fetch was served.
type CacheInfo struct {
	Status    int
	Cache     string // "MISS" | "HIT" | "COALESCED"
	FetchedAt int64
	Upstream  string
}

// HardError is an alarmable fetch failure. Kinds:
//
//	transport  the request never completed (no status at all)
//	rate-limit a 429
//	method     a 405 from upstream (its own method gate)
//	status     any other non-2xx
//	non-json   a 2xx whose body is not JSON
type HardError struct {
	Kind   string
	Status int
	URL    string
	// Mode is the mode the request was for, so Message() can name it the way
	// the TS route did.
	Mode string
	// Detail is the error text (Error()): what the handler logs.
	Detail string
	// Body is the upstream body truncated to detailBytes (the error body's
	// `detail` field, matching the TS route's body.slice(0, 200)).
	Body string
	// HasBody says whether there was an upstream body to quote at all, so the
	// handler can omit `detail` instead of asserting `""`.
	HasBody bool
}

func (e *HardError) Error() string { return e.Detail }

// Message is the user-facing error string: the TS route's own wording, which
// scripts/verify-chainrank.py reads.
func (e *HardError) Message() string {
	switch e.Kind {
	case "transport":
		return "upstream " + e.Mode + " unreachable: " + e.Detail
	case "rate-limit":
		return "upstream " + e.Mode + " rate limited (429) — too many requests in a short window"
	case "method":
		return "upstream " + e.Mode + " answered 405 (method gate)"
	case "non-json":
		return "upstream " + e.Mode + " returned a non-JSON body"
	}
	return "upstream " + e.Mode + " HTTP " + strconv.Itoa(e.Status)
}

// IsHardError reports whether err is alarmable.
func IsHardError(err error) (*HardError, bool) {
	var he *HardError
	errors.As(err, &he)
	return he, he != nil
}

// Requirement is one of the TLS/feature facts this family does NOT need, kept as
// prose only: chainrank.fyi serves its API over plain HTTPS behind no
// fingerprinting wall, so the tls-client chrome_131 stack internal/cryptorank
// needs is deliberately not used here.

// entry is one cached body.
type entry struct {
	body      string
	fetchedAt int64
}

// flight is an in-flight fetch other callers wait on.
type flight struct {
	done chan struct{}
	body string
	info CacheInfo
	err  error
}

// Fetcher is the family's acquisition layer: an in-memory TTL cache plus
// single-flight, keyed on the full upstream URL (query included -- see the
// package doc for why that differs from llama/news).
//
// Unlike the other families the entry count is NOT bounded by construction: the
// pagination query is part of the key, so a caller walking `pageSize=1..200`
// would mint 200 entries. The bound is therefore explicit and small, and
// eviction is oldest-first; `Stats()` makes the ceiling observable and a test
// asserts it holds under a walk.
type Fetcher struct {
	client  Doer
	timeout time.Duration
	ttl     time.Duration
	mu      sync.Mutex
	entries map[string]*entry
	flights map[string]*flight
}

// maxEntries bounds the cache. 32 is ~2x the distinct URLs the board itself
// requests (stats + a handful of listing pages) and ~2MB worst case at the
// measured listing sizes; anything past it is a caller walking pages, which is
// exactly the traffic that must not grow without limit.
const maxEntries = 32

// New builds a Fetcher.
func New(o Options) (*Fetcher, error) {
	ttl := o.TTL
	if ttl == 0 {
		if v := os.Getenv("APICALLS_CHAINRANK_TTL"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 {
				return nil, fmt.Errorf("APICALLS_CHAINRANK_TTL=%q is not a positive integer", v)
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
		// exactly the behaviour change internal/cryptorank measured elsewhere.
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

// TTL is the resolved cache lifetime in seconds (logs/healthz).
func (f *Fetcher) TTL() int { return int(f.ttl / time.Second) }

// Timeout is the per-request timeout (logs).
func (f *Fetcher) Timeout() time.Duration { return f.timeout }

// Stats is what the cache currently retains.
type Stats struct {
	Entries int
	Flights int
}

// Stats reports the cache size (tests assert the ceiling holds).
func (f *Fetcher) Stats() Stats {
	f.mu.Lock()
	defer f.mu.Unlock()
	return Stats{Entries: len(f.entries), Flights: len(f.flights)}
}

// Fetch retrieves url, honouring the in-process TTL cache and single-flight.
func (f *Fetcher) Fetch(ctx context.Context, mode, url string) (string, CacheInfo, error) {
	if !AllowedURL(url) {
		return "", CacheInfo{}, fmt.Errorf("url not allowed: %s", url)
	}
	f.mu.Lock()
	if e, ok := f.entries[url]; ok && time.Since(time.Unix(e.fetchedAt, 0)) < f.ttl {
		f.mu.Unlock()
		return e.body, CacheInfo{
			Status: 200, Cache: "HIT", FetchedAt: e.fetchedAt, Upstream: url,
		}, nil
	}
	if fl, ok := f.flights[url]; ok {
		// Join the in-flight fetch. Its result is handed over as-is, but the
		// joiner is told it COALESCED rather than MISS: the TS limiter drew the
		// same distinction, and collapsing it would hide that two callers shared
		// one upstream read.
		f.mu.Unlock()
		<-fl.done
		info := fl.info
		if fl.err == nil && info.Cache == "MISS" {
			info.Cache = "COALESCED"
		}
		return fl.body, info, fl.err
	}
	fl := &flight{done: make(chan struct{})}
	f.flights[url] = fl
	f.mu.Unlock()

	// L2 (Valkey): the in-process map dies with the process, and this family's
	// upstream is a burst-limited third party, so a restart is the worst moment
	// to lose every cached listing. A hit re-primes L1 and travels as HIT.
	key := cache.Key("chainrank", url)
	if v, ok := cache.Get(ctx, key); ok {
		if body, meta, decoded := cache.Decode(v, 1); decoded {
			f.mu.Lock()
			f.evictIfFull()
			f.entries[url] = &entry{body: body, fetchedAt: meta[0]}
			delete(f.flights, url)
			fl.body = body
			// meta[0] is the ORIGINAL fetch time: this response is a cache hit
			// but the body is not new, and the board renders that time.
			fl.info = CacheInfo{Status: 200, Cache: "HIT", FetchedAt: meta[0], Upstream: url}
			close(fl.done)
			f.mu.Unlock()
			return body, fl.info, nil
		}
	}

	b, i, e := f.fetch(ctx, mode, url)

	f.mu.Lock()
	if e == nil {
		f.evictIfFull()
		f.entries[url] = &entry{body: b, fetchedAt: i.FetchedAt}
	}
	delete(f.flights, url)
	fl.body, fl.info, fl.err = b, i, e
	close(fl.done)
	f.mu.Unlock()
	if e == nil {
		cache.Set(ctx, key, cache.Encode(b, i.FetchedAt), f.ttl)
	}
	return b, i, e
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

// AllowedURL reports whether url belongs to this family's two read endpoints.
// It is what keeps the fetcher from being pointed at an arbitrary host, and it
// deliberately does NOT constrain the query (pagination is relayed untouched).
func AllowedURL(url string) bool {
	if !strings.HasPrefix(url, Base) {
		return false
	}
	path := strings.TrimPrefix(url, Base)
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	return path == PathStats || path == PathListings
}

// fetch is the uncached path: one request, one parse, loud failure.
func (f *Fetcher) fetch(ctx context.Context, mode, url string) (string, CacheInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", CacheInfo{}, &HardError{
			Kind: "transport", URL: url, Mode: mode, HasBody: false,
			Detail: "request build failed: " + err.Error(),
		}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", Accept)
	req.Header.Set("From", FromHeader)

	res, err := f.client.Do(req)
	if err != nil {
		return "", CacheInfo{}, &HardError{
			Kind: "transport", URL: url, Mode: mode, HasBody: false, Detail: err.Error(),
		}
	}
	defer res.Body.Close()

	var r io.Reader = res.Body
	if strings.EqualFold(res.Header.Get("Content-Encoding"), "gzip") {
		gz, gerr := gzip.NewReader(res.Body)
		if gerr != nil {
			return "", CacheInfo{}, &HardError{
				Kind: "transport", URL: url, Mode: mode, HasBody: false,
				Detail: "gzip decode failed: " + gerr.Error(),
			}
		}
		defer gz.Close()
		r = gz
	}
	raw, err := io.ReadAll(io.LimitReader(r, maxBodyBytes))
	if err != nil {
		return "", CacheInfo{}, &HardError{
			Kind: "transport", URL: url, Mode: mode, HasBody: false,
			Detail: "read failed: " + err.Error(),
		}
	}
	body := string(raw)

	if res.StatusCode < 200 || res.StatusCode > 299 {
		he := &HardError{
			Kind: "status", Status: res.StatusCode, URL: url, Mode: mode,
			Detail: "upstream HTTP " + strconv.Itoa(res.StatusCode),
			Body:   truncate(body, detailBytes), HasBody: body != "",
		}
		switch res.StatusCode {
		case http.StatusTooManyRequests:
			he.Kind = "rate-limit"
		case http.StatusMethodNotAllowed:
			he.Kind = "method"
		}
		return "", CacheInfo{}, he
	}
	if !json.Valid([]byte(body)) {
		// Upstream error pages are HTML. Report with its status, not a fake 200.
		return "", CacheInfo{}, &HardError{
			Kind: "non-json", Status: res.StatusCode, URL: url, Mode: mode,
			Detail: "upstream returned a non-JSON body",
			Body:   truncate(body, detailBytes), HasBody: body != "",
		}
	}
	return body, CacheInfo{
		Status: res.StatusCode, Cache: "MISS", FetchedAt: Now(), Upstream: url,
	}, nil
}

// truncate cuts s to n bytes, appending "…" when it actually cut.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
