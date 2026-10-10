package imf

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
	// Base is the IMF DataMapper public v1 API host.
	Base = "https://www.imf.org/external/datamapper/api/v1"

	// UA is the adapter's User-Agent. Public keyless endpoints, no secrets.
	UA = "fudcourt-data/1.0"

	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second

	// maxBodyBytes bounds one upstream body. One indicator for a handful of
	// countries is well under 1 MiB; 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
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

// HardError is the typed failure: a non-2xx status, a DataMapper
// {"error":true,"errors":"..."} envelope, or a shape mismatch. The engine's
// breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape" | "api-error"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("imf: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("imf: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v. DataMapper signals
// failures with {"error":true,"errors":"..."} envelopes (HTTP 200 or 404) and
// non-JSON blocks; both are HardErrors, never a partial decode. A values
// response decodes into the caller's target.
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

	// DataMapper error envelope, on any status.
	var apiErr struct {
		Error  bool   `json:"error"`
		Errors string `json:"errors"`
	}
	if json.Unmarshal(b, &apiErr) == nil && apiErr.Error && apiErr.Errors != "" {
		return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode, Detail: apiErr.Errors}
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return &HardError{Kind: "status", URL: url, Status: r.StatusCode,
			Detail: preview(string(b))}
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
