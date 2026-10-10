package bps

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
	// Base is the BPS WebAPI v1 host.
	Base = "https://webapi.bps.go.id/v1/api"

	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"

	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second

	// maxBodyBytes bounds one upstream body. One variable's full history is
	// well under 1 MiB; 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
)

// client is one dataset fetcher's HTTP plumbing: an injected Doer (tests
// substitute canned responses), a per-request timeout, and the BPS key pair.
type client struct {
	do      canon.Doer
	timeout time.Duration
	apiKey  string
	apiID   string
}

// newClient builds the client; a nil Doer gets the shared tuned transport.
func newClient(d canon.Doer, timeout time.Duration, apiKey, apiID string) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	return &client{do: d, timeout: timeout, apiKey: apiKey, apiID: apiID}
}

// HardError is the typed failure: a missing key pair, a non-2xx status, a BPS
// {"status":"Error"} envelope, or a shape mismatch. The engine's breaker keys
// on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape" | "api-error" | "no-credentials"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("bps: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("bps: %s: %s", e.Kind, e.Detail)
}

// errNoCredentials is the typed no-credentials failure. The BPS WebAPI needs
// the (key, id) pair: without both, the attempt fails at start and nothing is
// fetched.
func errNoCredentials() *HardError {
	return &HardError{Kind: "no-credentials",
		Detail: "BPS_API_KEY/BPS_API_ID are empty: the BPS WebAPI requires the key pair"}
}

// hasCredentials reports whether both halves of the key pair are present.
func (c *client) hasCredentials() bool { return c.apiKey != "" && c.apiID != "" }

// getJSON performs one GET (the key pair rides in the path, as BPS requires)
// and decodes the body into v. BPS signals failures with
// {"status":"Error","message":"..."} (HTTP 200 or 4xx) and WAF HTML blocks;
// both are HardErrors, never a partial decode.
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

	// BPS error envelope, on any status.
	var apiErr struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	if json.Unmarshal(b, &apiErr) == nil && apiErr.Status == "Error" {
		return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode,
			Detail: preview(body)}
	}
	// WAF blocks answer HTML.
	if len(body) > 0 && (body[0] == '<') {
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
