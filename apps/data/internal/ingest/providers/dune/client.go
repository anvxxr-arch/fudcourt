package dune

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// Base is the Dune API v1 host.
	Base = "https://api.dune.com/api/v1"
	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"
	// APIKeyEnv is the environment variable the Dune API key is read from.
	// The key is carried only in memory and in the X-DUNE-API-KEY request
	// header; it is never logged and never appears in an error.
	APIKeyEnv = "DUNE_API_KEY"
	// defaultLimit is the results page size when the job cursor carries none.
	defaultLimit = 1000
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. Dune result pages are bounded
	// by the limit; 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
)

// client is one dataset fetcher's HTTP plumbing: an injected Doer (tests
// substitute canned responses), a per-request timeout and the API key.
type client struct {
	do      canon.Doer
	timeout time.Duration
	apiKey  string
}

// newClient builds the client from the environment's API key; a nil Doer
// gets the shared tuned transport.
func newClient(d canon.Doer, timeout time.Duration) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	return &client{do: d, timeout: timeout, apiKey: os.Getenv(APIKeyEnv)}
}

// HardError is the typed failure: a non-2xx status, a missing credential, or
// a shape mismatch. The engine's breaker keys on the kind; "no-credentials"
// is terminal (the engine will not retry an empty key).
type HardError struct {
	Kind   string // "no-credentials" | "transport" | "status" | "api-error" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("dune: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("dune: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v. Dune signals failures
// with statuses plus an {"error":"..."} body; a non-2xx is a status HardError
// and a body that does not decode is a shape HardError - never a partial
// decode.
func (c *client) getJSON(ctx context.Context, url string, v any) error {
	if c.apiKey == "" {
		return &HardError{Kind: "no-credentials",
			Detail: "DUNE_API_KEY is empty; a Dune API key is required"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return &HardError{Kind: "transport", URL: url, Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "application/json")
	// The key rides in the header, never in the URL, so URLs are safe to
	// store on errors and the key cannot leak through a journal.
	req.Header.Set("X-DUNE-API-KEY", c.apiKey)
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
	// Dune error body: {"error":"..."} on any status.
	var apiErr struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(b, &apiErr) == nil && apiErr.Error != "" &&
		(r.StatusCode < 200 || r.StatusCode > 299) {
		return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode, Detail: apiErr.Error}
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

// f64 parses a number-or-string JSON value the wire uses interchangeably
// (DuneSQL double columns decode as numbers; decimal columns as strings).
func f64(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case json.Number:
		x, err := t.Float64()
		if err != nil {
			return 0, false
		}
		return x, true
	case string:
		x, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0, false
		}
		return x, true
	default:
		return 0, false
	}
}

// strPtr is a non-empty string as a pointer; "" stays nil (never-fake).
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
