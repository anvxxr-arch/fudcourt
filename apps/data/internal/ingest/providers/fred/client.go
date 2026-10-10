package fred

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// Base is the FRED API host.
	Base = "https://api.stlouisfed.org"

	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"

	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second

	// maxBodyBytes bounds one upstream body. The widest response here is a
	// full-history observation pull (~2 MiB); 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
)

// client is one dataset fetcher's HTTP plumbing: an injected Doer (tests
// substitute canned responses), a per-request timeout, and the FRED API key.
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

// HardError is the typed failure: a missing credential, a non-2xx status, a
// FRED error envelope, or a shape mismatch. The engine's breaker keys on the
// kind; no-credentials never backoff-crashes the engine, it just fails the
// attempt like any other error.
type HardError struct {
	Kind   string // "transport" | "status" | "shape" | "api-error" | "no-credentials"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("fred: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("fred: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v. FRED error envelopes
// {"error_code":400,"error_message":"..."} arrive on non-200 statuses and (in
// some auth edge cases) on 200; both are api-error HardErrors, never a
// partial decode.
func (c *client) getJSON(ctx context.Context, url string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return &HardError{Kind: "transport", URL: url, Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "application/json")
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

	// FRED error envelope, on any status.
	var apiErr struct {
		ErrorCode int    `json:"error_code"`
		Message   string `json:"error_message"`
	}
	if json.Unmarshal(b, &apiErr) == nil && apiErr.Message != "" {
		return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode,
			Detail: fmt.Sprintf("code %d: %s", apiErr.ErrorCode, apiErr.Message)}
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return &HardError{Kind: "status", URL: url, Status: r.StatusCode,
			Detail: preview(body)}
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
