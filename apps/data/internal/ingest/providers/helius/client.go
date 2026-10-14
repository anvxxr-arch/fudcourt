package helius

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// Base is the Helius API host; the address endpoints live under /v0.
	Base = "https://api.helius.xyz/v0"
	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"
	// APIKeysEnv is the environment variable holding a COMMA-SEPARATED list of
	// Helius API keys. Requests round-robin across the list, so a burst of
	// pages spreads over several keys' rate limits instead of exhausting one.
	APIKeysEnv = "HELIUS_API_KEYS"
	// APIKeyEnv is the single-key spelling, still honored (and still the
	// documented name); it is appended to whatever APIKeysEnv holds.
	// The key rides in the request URL as ?api-key= (Helius has no header
	// auth on this endpoint); it is carried only in memory and in the
	// outbound request, never in a log line and never in an error.
	APIKeyEnv = "HELIUS_API_KEY"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. One address page is at most
	// ~100 enhanced transactions; 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
	// pageTypeSwap is the Helius transaction type filter for the swaps feed.
	pageTypeSwap = "SWAP"
)

// client is one dataset fetcher's HTTP plumbing: an injected Doer (tests
// substitute canned responses), a per-request timeout and the API keys it
// round-robins across.
type client struct {
	do      canon.Doer
	timeout time.Duration
	apiKeys []string
	// next is the round-robin cursor. Atomic because the engine dispatches
	// fetches concurrently; a plain int would be a data race and, worse, would
	// hand the same key to several in-flight requests.
	next atomic.Uint64
}

// newClient builds the client from the environment's API keys; a nil Doer
// gets the shared tuned transport.
func newClient(d canon.Doer, timeout time.Duration) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	return &client{do: d, timeout: timeout, apiKeys: keysFromEnv()}
}

// keysFromEnv collects the configured keys: APIKeysEnv is a comma-separated
// list, APIKeyEnv the single-key spelling, and both may be set. Duplicates
// collapse — otherwise a repeated key would be selected twice in a row and the
// rotation would silently not rotate.
func keysFromEnv() []string {
	var out []string
	seen := make(map[string]bool, 2)
	add := func(k string) {
		k = strings.TrimSpace(k)
		if k == "" || seen[k] {
			return
		}
		seen[k] = true
		out = append(out, k)
	}
	for _, k := range strings.Split(os.Getenv(APIKeysEnv), ",") {
		add(k)
	}
	add(os.Getenv(APIKeyEnv))
	return out
}

// pickKey returns the next key in round-robin order, or "" when none is
// configured. The single-key case skips the atomic entirely, since that is the
// common deployment.
func (c *client) pickKey() string {
	if len(c.apiKeys) == 1 {
		return c.apiKeys[0]
	}
	if len(c.apiKeys) == 0 {
		return ""
	}
	n := c.next.Add(1) - 1
	return c.apiKeys[int(n%uint64(len(c.apiKeys)))]
}

// HardError is the typed failure: a missing credential, a transport failure,
// a non-2xx status, or a shape mismatch. The engine's breaker keys on the
// kind; "no-credentials" is terminal (the engine will not retry an empty key).
type HardError struct {
	Kind   string // "no-credentials" | "transport" | "status" | "shape"
	URL    string // redacted: the api-key parameter is stripped before storing
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("helius: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("helius: %s: %s", e.Kind, e.Detail)
}

// redact strips the api-key query parameter from a URL before it is stored on
// an error. The key must never reach a journal, a log line or a test failure
// message.
func redact(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		// Not parseable: refuse to risk leaking the key, drop the URL.
		return "(unparseable url)"
	}
	q := u.Query()
	if q.Get("api-key") != "" {
		q.Set("api-key", "REDACTED")
		u.RawQuery = q.Encode()
	}
	return u.String()
}

// txnsURL builds one address-transactions page request. The key rides in the
// URL as ?api-key=; typ filters by Helius transaction type when non-empty
// (the swaps feed pins SWAP, the wallet feed leaves it open); before pages
// backward from a signature cursor.
func (c *client) txnsURL(address, typ, before string) string {
	u := Base + "/addresses/" + url.PathEscape(address) + "/transactions?api-key=" + url.QueryEscape(c.pickKey())
	if typ != "" {
		u += "&type=" + url.QueryEscape(typ)
	}
	if before != "" {
		u += "&before=" + url.QueryEscape(before)
	}
	return u
}

// getJSON performs one GET and decodes the body into v with UseNumber, so
// every amount on the wire stays an exact json.Number or string and no value
// ever passes through a float64. A non-2xx is a status HardError and a body
// that does not decode is a shape HardError - never a partial decode. Every
// stored URL passes through redact first.
func (c *client) getJSON(ctx context.Context, rawURL string, v any) error {
	if len(c.apiKeys) == 0 {
		return &HardError{Kind: "no-credentials",
			Detail: "HELIUS_API_KEY/HELIUS_API_KEYS is empty; a Helius API key is required"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return &HardError{Kind: "transport", URL: redact(rawURL), Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "application/json")
	r, err := c.do.Do(req)
	if err != nil {
		return &HardError{Kind: "transport", URL: redact(rawURL), Detail: err.Error()}
	}
	if r == nil {
		return &HardError{Kind: "transport", URL: redact(rawURL), Detail: "transport returned no response and no error"}
	}
	defer r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode > 299 {
		b, readErr := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
		if readErr != nil {
			return &HardError{Kind: "transport", URL: redact(rawURL), Status: r.StatusCode, Detail: readErr.Error()}
		}
		return &HardError{Kind: "status", URL: redact(rawURL), Status: r.StatusCode,
			Detail: preview(string(b))}
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes))
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
		return &HardError{Kind: "shape", URL: redact(rawURL), Status: r.StatusCode, Detail: err.Error()}
	}
	return nil
}

// preview keeps the first bytes of an unexpected body for the error detail.
func preview(s string) string {
	const n = 200
	if len(s) <= n {
		return s
	}
	return s[:n]
}
