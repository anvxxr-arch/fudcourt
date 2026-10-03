package news

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/data/platform/cache"
	"github.com/anvxxr-arch/fudcourt/backend/data/platform/httpx"
)

const (
	// defaultTTL is the per-process cache TTL in seconds. The TS route used
	// lib/rate-limit.ts CACHE_TTL_MS = 15_000; a 15s window collapses the
	// board's mount + poll traffic to one fetch of the 340KB feed.
	// Overridable with FUDCOURT_DATA_NEWS_TTL (read in New, like llama/khala read
	// their cache env there).
	defaultTTL = 15
	// defaultTimeout is the TS route's TIMEOUT_MS = 20_000, verbatim.
	defaultTimeout = 20 * time.Second
	// maxBodyBytes caps one feed body at 4 MiB. The measured feed is ~340KB, so
	// this is >10x headroom; it exists to bound a pathological body.
	maxBodyBytes = 4 << 20
)

const (
	// UA is the exact User-Agent the TS route sent. The feed is public and
	// keyless and never challenged a non-browser client (measured 2026-09-29),
	// so the string is kept identical rather than "improved": it is what
	// upstream's logs already show.
	UA = "fudcourt-web/1.0"
	// Accept is the TS route's Accept header for the XML feed.
	Accept = "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1"
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
	// FUDCOURT_DATA_NEWS_TTL when this is zero.
	TTL int
}

// Doer is the subset of *http.Client the fetcher uses.
type Doer interface {
	Do(*http.Request) (*http.Response, error)
}

// CacheInfo describes how one Fetch was served. It is the port of the TS
// limiter's `{status, cache, fetchedAt}` mark.
type CacheInfo struct {
	Status    int
	Cache     string // "MISS" | "HIT"
	FetchedAt int64
	ItemCount int
	Upstream  string
}

// HardError is an alarmable fetch failure: the family's whole point is that a
// broken feed must never be served as an empty news list. Kinds:
//
//	transport  the request never completed (no status at all)
//	rate-limit a 429
//	status     any other non-200
//	not-xml    a 200 whose body carries no <item>
//	empty      a 200 whose parsed item list is empty
type HardError struct {
	Kind   string
	Status int
	URL    string
	// Detail is the error text (Error()): what the handler logs.
	Detail string
	// Body is the upstream body truncated to detailBytes (the error body's
	// `detail` field, matching the TS route's body.slice(0, 200)).
	Body string
	// HasBody says whether there was an upstream body to quote at all. It is
	// what makes an empty error body distinguishable from a transport failure
	// that never had one, so the handler can omit `detail` instead of
	// asserting `""` — which would read as "upstream sent nothing".
	HasBody bool
}

func (e *HardError) Error() string { return e.Detail }

// Message is the user-facing error string. The rate-limit, empty and
// unreachable texts are the TS route's, verbatim (scripts/verify-news.py reads
// them).
func (e *HardError) Message() string {
	switch e.Kind {
	case "transport":
		return "upstream request failed"
	case "rate-limit":
		return "upstream 429 from the RSS feed"
	case "empty":
		return "upstream returned an empty feed"
	case "not-xml":
		return "upstream returned a body with no RSS items"
	}
	return "upstream " + strconv.Itoa(e.Status) + " from the RSS feed"
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
// as prose only: cointelegraph.com/rss is plain HTTPS behind no fingerprinting
// wall, so the tls-client chrome_131 stack internal/research/cryptorank needs is
// deliberately not used here (same call as the khala and llama fetchers').

// entry is one cached body.
type entry struct {
	body      string
	items     []Item
	fetchedAt int64
}

// flight is an in-flight fetch other callers wait on.
type flight struct {
	done  chan struct{}
	body  string
	items []Item
	info  CacheInfo
	err   error
}

// Fetcher is the family's acquisition layer: an in-memory TTL cache plus
// single-flight, keyed on the FEED URL (not the request query), so every
// `limit` shares one 340KB fetch.
//
// The cache is BOUNDED BY CONSTRUCTION rather than by an eviction policy:
// `Sources` admits exactly one URL today, so `entries` can hold one body. The
// TS limiter needed CACHE_MAX_ENTRIES only because it also cached per-query
// URLs; nothing here is per-query, because `limit` is applied to the cached
// item list after the fetch.
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
		if v := os.Getenv("FUDCOURT_DATA_NEWS_TTL"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 {
				return nil, fmt.Errorf("FUDCOURT_DATA_NEWS_TTL=%q is not a positive integer", v)
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
		// exactly the behaviour change internal/research/cryptorank measured on another
		// family.
		f.client = httpx.NewClient(timeout)
	}
	return f, nil
}

// TTL is the resolved cache lifetime in seconds (logs/healthz).
func (f *Fetcher) TTL() int { return int(f.ttl / time.Second) }

// Timeout is the per-request timeout (logs).
func (f *Fetcher) Timeout() time.Duration { return f.timeout }

// Stats is what the cache currently retains, so the bounding claim is
// observable rather than asserted.
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

// AllowedURL reports whether url is one of the table's feeds. It is the
// boundary that makes the cache bounded by construction.
func AllowedURL(url string) bool {
	for _, s := range Sources {
		if s.URL == url {
			return true
		}
	}
	return false
}

// Fetch retrieves url, honouring the in-process TTL cache and single-flight.
//
// It returns the body, the parsed item list and the cache info. The items are
// returned alongside the bytes because only the parse knows them, and a HIT
// must serve the list belonging to the bytes it reports.
func (f *Fetcher) Fetch(ctx context.Context, url string) (body string, items []Item, info CacheInfo, err error) {
	if !AllowedURL(url) {
		return "", nil, CacheInfo{}, fmt.Errorf("url not allowed: %s", url)
	}
	f.mu.Lock()
	if e, ok := f.entries[url]; ok && time.Since(time.Unix(e.fetchedAt, 0)) < f.ttl {
		f.mu.Unlock()
		return e.body, e.items, CacheInfo{
			Status: 200, Cache: "HIT", FetchedAt: e.fetchedAt, ItemCount: len(e.items), Upstream: url,
		}, nil
	}
	if fl, ok := f.flights[url]; ok {
		// Join the in-flight fetch. Its result is handed over as-is, so a
		// joiner sees the same bytes, list and MISS/HIT mark.
		f.mu.Unlock()
		<-fl.done
		return fl.body, fl.items, fl.info, fl.err
	}
	fl := &flight{done: make(chan struct{})}
	f.flights[url] = fl
	f.mu.Unlock()

	// L2 (Valkey): items are re-parsed from the cached body, so the cached copy
	// is the same bytes the parser produced items from — never a deserialised
	// item list, which could drift from the parser in a later release.
	key := cache.Key("news", url)
	if v, ok := cache.Get(ctx, key); ok {
		if cached, meta, decoded := cache.Decode(v, 1); decoded {
			items := ParseItems(cached, labelOf(url))
			if len(items) > 0 {
				f.mu.Lock()
				f.entries[url] = &entry{body: cached, items: items, fetchedAt: meta[0]}
				delete(f.flights, url)
				fl.body, fl.items = cached, items
				// meta[0] is the original fetch time, not the re-parse time.
				fl.info = CacheInfo{Status: 200, Cache: "HIT", FetchedAt: meta[0], ItemCount: len(items), Upstream: url}
				close(fl.done)
				f.mu.Unlock()
				return cached, items, fl.info, nil
			}
		}
	}

	b, items, i, e := f.fetch(ctx, url)

	// Only a success is cached; the shared flight carries either way.
	f.mu.Lock()
	if e == nil {
		f.entries[url] = &entry{body: b, items: items, fetchedAt: i.FetchedAt}
	}
	delete(f.flights, url)
	fl.body, fl.items, fl.info, fl.err = b, items, i, e
	close(fl.done)
	f.mu.Unlock()
	if e == nil {
		cache.Set(ctx, key, cache.Encode(b, i.FetchedAt), f.ttl)
	}
	return b, items, i, e
}

// fetch is the uncached path: one request, one parse, loud failure.
func (f *Fetcher) fetch(ctx context.Context, url string) (string, []Item, CacheInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", nil, CacheInfo{}, &HardError{
			Kind: "transport", URL: url, HasBody: false,
			Detail: "request build failed: " + err.Error(),
		}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", Accept)
	res, err := f.client.Do(req)
	if err != nil {
		return "", nil, CacheInfo{}, &HardError{
			Kind: "transport", URL: url, HasBody: false,
			Detail: err.Error(),
		}
	}
	defer res.Body.Close()

	var r io.Reader = res.Body
	// The sheet does not negotiate gzip for us the way the TS fetch did, so
	// honour it when the server sends it anyway.
	if strings.EqualFold(res.Header.Get("Content-Encoding"), "gzip") {
		gz, gerr := gzip.NewReader(res.Body)
		if gerr != nil {
			return "", nil, CacheInfo{}, &HardError{
				Kind: "transport", URL: url, HasBody: false,
				Detail: "gzip decode failed: " + gerr.Error(),
			}
		}
		defer gz.Close()
		r = gz
	}
	raw, err := io.ReadAll(io.LimitReader(r, maxBodyBytes))
	if err != nil {
		return "", nil, CacheInfo{}, &HardError{
			Kind: "transport", URL: url, HasBody: false,
			Detail: "read failed: " + err.Error(),
		}
	}
	body := string(raw)

	if res.StatusCode != http.StatusOK {
		he := &HardError{
			Kind: "status", Status: res.StatusCode, URL: url,
			Detail: "upstream HTTP " + strconv.Itoa(res.StatusCode),
			Body:   truncate(body, detailBytes), HasBody: body != "",
		}
		if res.StatusCode == http.StatusTooManyRequests {
			he.Kind = "rate-limit"
		}
		return "", nil, CacheInfo{}, he
	}

	items := ParseItems(body, labelOf(url))
	if len(items) == 0 {
		// An empty feed is breakage, not "no news exists".
		return "", nil, CacheInfo{}, &HardError{
			Kind: "empty", Status: 200, URL: url,
			Detail: "upstream returned an empty feed",
			Body:   truncate(body, detailBytes), HasBody: body != "",
		}
	}
	fetchedAt := Now()
	return body, items, CacheInfo{
		Status: 200, Cache: "MISS", FetchedAt: fetchedAt, ItemCount: len(items), Upstream: url,
	}, nil
}

// truncate cuts s to n bytes, appending "…" when it actually cut (the TS
// route's `body.slice(0, 200)` reported the same way).
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
