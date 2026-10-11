package newsfeed

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/ingest"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// UA identifies this deployment to publishers, with a contact URL.
	UA = "fudcourt-data/1.0 (+newsfeed; +https://fudcourt.my.id)"
	// defaultTimeout bounds one feed request; the engine owns retries.
	defaultTimeout = 20 * time.Second
	// maxBodyBytes bounds one feed body. The widest measured feed in the
	// registry is dlnews at 264 KB; 8 MiB is two orders of magnitude of
	// headroom and still bounds a decompression-bomb response.
	maxBodyBytes = 8 << 20
	// redirectLimit bounds redirect following. Feeds are served from one
	// host; a redirected feed is followed only within that host (see fetch).
	redirectLimit = 3
)

// validators are the HTTP conditional-request validators carried in the job
// cursor between runs. They are what makes a poll cheap: an unchanged feed
// answers 304 and costs no body.
type validators struct {
	ETag         string
	LastModified string
}

// fetchMeta is what a fetch reports about the exchange itself: the status, the
// validators to persist for the next run, and the body size.
type fetchMeta struct {
	Status       int
	ETag         string
	LastModified string
	NotModified  bool
	Bytes        int
}

// client is the feed transport: an injected Doer (tests substitute canned
// responses) and a per-request timeout.
type client struct {
	do       canon.Doer
	timeout  time.Duration
	maxBytes int64
}

// newClient builds the client; a nil Doer gets the shared tuned transport.
func newClient(d canon.Doer, timeout time.Duration) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	return &client{do: d, timeout: timeout, maxBytes: maxBodyBytes}
}

// validatorsFrom reads the conditional-request state a previous run left in
// the job cursor. Absent keys are absent validators (a first run sends none).
func validatorsFrom(cursor ingest.Cursor) validators {
	v := validators{}
	if cursor == nil {
		return v
	}
	if s, ok := cursor["etag"].(string); ok {
		v.ETag = s
	}
	if s, ok := cursor["last_modified"].(string); ok {
		v.LastModified = s
	}
	return v
}

// guardURL refuses any URL this adapter must not request. The registry is the
// allowlist, so the guard is about the invariants a registry edit could break:
// https only, a real host, and no credentials embedded in the URL.
func guardURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return &HardError{Kind: "shape", Detail: "unparsable feed url: " + err.Error()}
	}
	if u.Scheme != "https" {
		return &HardError{Kind: "shape", Detail: "feed url must be https, got " + u.Scheme}
	}
	if u.Host == "" {
		return &HardError{Kind: "shape", Detail: "feed url has no host"}
	}
	if u.User != nil {
		return &HardError{Kind: "shape", Detail: "feed url must not carry credentials"}
	}
	if isBlockedHost(u.Hostname()) {
		return &HardError{Kind: "shape", Detail: "feed host is a loopback/private address: " + u.Hostname()}
	}
	return nil
}

// isBlockedHost refuses the SSRF primitives: loopback, RFC1918, link-local
// (including the cloud metadata address) and the unspecified address. A feed
// endpoint is a public host by definition, so a registry row that resolves
// inward is a mistake this must catch.
func isBlockedHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	switch {
	case h == "", h == "localhost", h == "localhost.localdomain", h == "::1", h == "0.0.0.0":
		return true
	case strings.HasPrefix(h, "127."), strings.HasPrefix(h, "10."), strings.HasPrefix(h, "192.168."),
		strings.HasPrefix(h, "169.254."), strings.HasPrefix(h, "127.0.0.1"):
		return true
	}
	// 172.16.0.0/12 (compared numerically - a string compare would read
	// "172.9.x.x" as inside the block)
	if strings.HasPrefix(h, "172.") {
		if parts := strings.Split(h, "."); len(parts) > 1 {
			if oct, err := strconv.Atoi(parts[1]); err == nil && oct >= 16 && oct <= 31 {
				return true
			}
		}
	}
	return strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal")
}

// fetch retrieves one feed with HTTP conditional requests. A 304 returns
// NotModified with no body - the caller refreshes its cursor and writes
// nothing, which is the cheap steady state for a feed that has not moved.
func (c *client) fetch(ctx context.Context, feed Feed, v validators) ([]byte, fetchMeta, error) {
	if err := guardURL(feed.URL); err != nil {
		return nil, fetchMeta{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, feed.URL, nil)
	if err != nil {
		return nil, fetchMeta{}, &HardError{Kind: "transport", Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "application/feed+json, application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5")
	req.Header.Set("Accept-Language", feed.Language)
	if v.ETag != "" {
		req.Header.Set("If-None-Match", v.ETag)
	}
	if v.LastModified != "" {
		req.Header.Set("If-Modified-Since", v.LastModified)
	}

	resp, err := c.do.Do(req)
	if err != nil {
		return nil, fetchMeta{}, &HardError{Kind: "transport", Detail: err.Error()}
	}
	defer resp.Body.Close()

	meta := fetchMeta{
		Status:       resp.StatusCode,
		ETag:         resp.Header.Get("ETag"),
		LastModified: resp.Header.Get("Last-Modified"),
	}
	// Redirect containment: a feed that redirects off its own host is not
	// followed into the body read. The transport may have followed it, so the
	// final request URL is what is checked here.
	if resp.Request != nil && resp.Request.URL != nil {
		want, err := url.Parse(feed.URL)
		if err == nil && !sameHost(want.Hostname(), resp.Request.URL.Hostname()) {
			return nil, meta, &HardError{Kind: "shape", Detail: "feed redirected off-host to " + resp.Request.URL.Hostname()}
		}
	}
	switch {
	case resp.StatusCode == http.StatusNotModified:
		meta.NotModified = true
		return nil, meta, nil
	case resp.StatusCode == http.StatusForbidden, resp.StatusCode == http.StatusTooManyRequests:
		// Access control or rate limiting: reported as-is, never retried in a
		// tight loop and never worked around.
		return nil, meta, &HardError{Kind: "restricted", Detail: fmt.Sprintf("HTTP %d from %s", resp.StatusCode, feed.URL)}
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return nil, meta, &HardError{Kind: "status", Detail: fmt.Sprintf("HTTP %d from %s", resp.StatusCode, feed.URL)}
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, c.maxBytes+1))
	if err != nil {
		return nil, meta, &HardError{Kind: "transport", Detail: "read body: " + err.Error()}
	}
	if int64(len(body)) > c.maxBytes {
		return nil, meta, &HardError{Kind: "shape", Detail: fmt.Sprintf("body exceeds %d bytes", c.maxBytes)}
	}
	meta.Bytes = len(body)
	return body, meta, nil
}

func sameHost(a, b string) bool {
	return strings.EqualFold(strings.TrimPrefix(a, "www."), strings.TrimPrefix(b, "www."))
}

// bodyHash fingerprints a feed body. It is used to prove in tests that an
// unchanged body still produced an idempotent write, and by the admin surface
// to show what a run actually received without storing the body.
func bodyHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
