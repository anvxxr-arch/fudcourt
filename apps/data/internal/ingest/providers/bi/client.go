package bi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// Base is the Bank Indonesia public API host.
	Base = "https://api.bi.go.id/v1/public"

	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"

	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second

	// maxBodyBytes bounds one upstream body. One statistic's full history is
	// well under 1 MiB; 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
)

// client is one dataset fetcher's HTTP plumbing: an injected Doer (tests
// substitute canned responses), a per-request timeout, and the optional
// gateway key.
type client struct {
	do      canon.Doer
	timeout time.Duration
	apiKey  string
}

// newClient builds the client; a nil Doer gets the shared tuned transport.
func newClient(d canon.Doer, timeout time.Duration, apiKey string) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	return &client{do: d, timeout: timeout, apiKey: apiKey}
}

// HardError is the typed failure: a missing credential where the endpoint
// config demands one, a non-2xx status, a BI {"status":"error"} envelope, or
// a shape mismatch. The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape" | "api-error" | "no-credentials"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("bi: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("bi: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v. The key rides in the
// X-API-KEY header when configured (the BI API gateway demands it on some
// deployments; keyless ones ignore it). BI signals failures with
// {"status":"error","message":"..."} envelopes and HTML blocks; both are
// HardErrors, never a partial decode.
func (c *client) getJSON(ctx context.Context, url string, requiresKey bool, v any) error {
	if requiresKey && c.apiKey == "" {
		return &HardError{Kind: "no-credentials",
			URL:    url,
			Detail: "BI_API_KEY is empty: the BI gateway demands X-API-KEY for this endpoint"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return &HardError{Kind: "transport", URL: url, Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "application/json")
	if c.apiKey != "" {
		req.Header.Set("X-API-KEY", c.apiKey)
	}
	r, err := c.do.Do(req)
	if err != nil {
		return &HardError{Kind: "transport", URL: url, Detail: err.Error()}
	}
	if r == nil {
		return &HardError{Kind: "transport", URL: url, Detail: "transport returned no response and no error"}
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		return &HardError{Kind: "transport", URL: url, Status: r.StatusCode, Detail: err.Error()}
	}
	body := string(b)

	// BI error envelope, on any status.
	var apiErr struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	if json.Unmarshal(b, &apiErr) == nil && apiErr.Status == "error" {
		return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode,
			Detail: apiErr.Message}
	}
	if len(body) > 0 && body[0] == '<' {
		return &HardError{Kind: "status", URL: url, Status: r.StatusCode, Detail: preview(body)}
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return &HardError{Kind: "status", URL: url, Status: r.StatusCode, Detail: preview(body)}
	}
	if err := json.Unmarshal(b, v); err != nil {
		return &HardError{Kind: "shape", URL: url, Status: r.StatusCode, Detail: err.Error()}
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

// parseF64 parses the wire's string-or-number value; empty/unparseable is
// absent (skip, never 0).
func parseF64(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" || s == "-" || s == "null" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
