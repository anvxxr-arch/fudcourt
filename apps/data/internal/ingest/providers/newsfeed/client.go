package newsfeed

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// UA is the adapter's User-Agent. Public keyless feeds, no secrets.
	UA = "FUDCourt-NewsBot/1.0 (+fc.dwirijal.my.id)"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. Feeds are typically under
	// 1 MiB; 10 MiB is ample headroom. A body that reaches the cap is a
	// loud shape error, never a truncated parse.
	maxBodyBytes = 10 << 20
)

// client is one dataset fetcher's HTTP plumbing: an injected Doer (tests
// substitute canned responses) and a per-request timeout.
type client struct {
	do      canon.Doer
	timeout time.Duration
}

// newClient builds the client; a nil Doer gets the shared tuned transport.
func newClient(d canon.Doer, timeout time.Duration) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	return &client{do: d, timeout: timeout}
}

// HardError is the typed failure: a blocked URL, a transport failure, a
// non-2xx status, or a shape mismatch. The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape" | "api-error" | "no-credentials"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("newsfeed: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("newsfeed: %s: %s", e.Kind, e.Detail)
}

// condHeaders carries the conditional-request state from the job cursor.
type condHeaders struct {
	ETag         string
	LastModified string
}

// ssrfBlocked reports why raw must not be fetched, or "" when allowed.
// It blocks non-http(s) schemes, userinfo, empty hosts, localhost, and
// literal private/link-local/loopback/multicast IPs. Hostnames that resolve
// to private IPs are NOT blocked here (no DNS lookup); the shared transport
// dials directly. Documented limitation, not a bypass.
func ssrfBlocked(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "unparseable URL: " + err.Error()
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "scheme must be http or https"
	}
	if u.User != nil {
		return "userinfo not allowed"
	}
	host := u.Hostname()
	if host == "" {
		return "empty host"
	}
	lh := strings.ToLower(strings.TrimSuffix(host, "."))
	if lh == "localhost" || strings.HasSuffix(lh, ".localhost") {
		return "localhost blocked"
	}
	if ip := net.ParseIP(lh); ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
			return "private/link-local/loopback IP blocked"
		}
	}
	return ""
}

// getBytes performs one GET and buffers the body IN FULL before any parse:
// the reader caps at maxBodyBytes, and a body that reaches the cap is a loud
// shape error — a capped reader that silently truncates mid-feed is exactly
// the "unexpected EOF on HTTP 200" class this adapter refuses to ship, so
// truncation can never look like a parse result. A 304 returns notModified
// with no body. A 429 surfaces the Retry-After value in the Detail so the
// engine's backoff can honor it. Single attempt only; the engine owns retries.
func (c *client) getBytes(ctx context.Context, rawurl string, cond condHeaders) ([]byte, string, string, string, bool, error) {
	if reason := ssrfBlocked(rawurl); reason != "" {
		return nil, "", "", "", false, &HardError{Kind: "transport", URL: rawurl, Detail: "blocked URL: " + reason}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawurl, nil)
	if err != nil {
		return nil, "", "", "", false, &HardError{Kind: "transport", URL: rawurl, Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*;q=0.8")
	if cond.ETag != "" {
		req.Header.Set("If-None-Match", cond.ETag)
	}
	if cond.LastModified != "" {
		req.Header.Set("If-Modified-Since", cond.LastModified)
	}
	r, err := c.do.Do(req)
	if err != nil {
		return nil, "", "", "", false, &HardError{Kind: "transport", URL: rawurl, Detail: err.Error()}
	}
	if r == nil {
		return nil, "", "", "", false, &HardError{Kind: "transport", URL: rawurl, Detail: "transport returned no response and no error"}
	}
	defer r.Body.Close()
	finalURL := rawurl
	if r.Request != nil && r.Request.URL != nil {
		finalURL = r.Request.URL.String()
		if reason := ssrfBlocked(finalURL); reason != "" {
			return nil, "", "", "", false, &HardError{Kind: "transport", URL: rawurl, Detail: "redirect to blocked URL: " + reason}
		}
	}
	etag := r.Header.Get("ETag")
	lastMod := r.Header.Get("Last-Modified")
	if r.StatusCode == http.StatusNotModified {
		return nil, etag, lastMod, finalURL, true, nil
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		return nil, "", "", "", false, &HardError{Kind: "transport", URL: rawurl, Status: r.StatusCode, Detail: err.Error()}
	}
	if len(b) >= maxBodyBytes {
		return nil, "", "", "", false, &HardError{Kind: "shape", URL: rawurl, Status: r.StatusCode,
			Detail: fmt.Sprintf("body reached the %d byte cap; response truncated", maxBodyBytes)}
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		detail := preview(string(b))
		if r.StatusCode == 429 {
			if ra := r.Header.Get("Retry-After"); ra != "" {
				detail = "retry-after:" + ra + "; " + detail
			}
		}
		return nil, "", "", "", false, &HardError{Kind: "status", URL: rawurl, Status: r.StatusCode, Detail: detail}
	}
	return b, etag, lastMod, finalURL, false, nil
}

// preview keeps the first bytes of an unexpected body for the error detail.
func preview(s string) string {
	const n = 200
	if len(s) <= n {
		return s
	}
	return s[:n]
}
