package jupiter

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// BaseLite is the primary Jupiter host. Every dataset URL builds off it.
	BaseLite = "https://lite-api.jup.ag"
	// FallbackBase is the legacy v6 quote host. It is NOT used automatically:
	// the adapter stays on BaseLite and only an operator pointing the client
	// elsewhere (a code change, documented here) may switch. Silent
	// host-hopping would fork provenance (SourceEndpoint) mid-stream, so a
	// fallback must be a deliberate, reviewed change, never a runtime retry.
	FallbackBase = "https://quote-api.jup.ag/v6"
	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"
	// APIKeyEnv is the optional credential. When set it rides the x-api-key
	// header (never a query parameter, never an error string); when empty the
	// provider still serves the keyless tier, so nothing gates on it.
	APIKeyEnv = "JUPITER_API_KEY"
	// APIKeyHeader carries the optional key.
	APIKeyHeader = "x-api-key"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. A quote is ~1 KiB and the token
	// list is a few hundred KiB; 4 MiB is ample headroom.
	maxBodyBytes = 4 << 20
	// chainSolana is the canonical chain name every Jupiter row is about.
	chainSolana = "solana"
)

// client is one dataset fetcher's HTTP plumbing: an injected Doer (tests
// substitute canned responses), a per-request timeout, the optional API key
// and the base URL.
type client struct {
	do      canon.Doer
	timeout time.Duration
	apiKey  string
	base    string
}

// newClient builds the client; the key is read once from JUPITER_API_KEY and
// a nil Doer gets the shared tuned transport. An empty key is fine: the
// provider serves a keyless tier.
func newClient(d canon.Doer, timeout time.Duration) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	return &client{do: d, timeout: timeout, apiKey: os.Getenv(APIKeyEnv), base: BaseLite}
}

// HardError is the typed failure: a transport failure, a non-2xx status or a
// shape mismatch. The engine's breaker keys on the kind. There is no
// "no-credentials" kind: the keyless tier means a missing key is never an
// error.
type HardError struct {
	Kind   string // "transport" | "status" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("jupiter: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("jupiter: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v with UseNumber, so
// every numeric the adapter reads keeps its exact spelling. A non-2xx is a
// status HardError and a body that does not decode is a shape HardError,
// never a partial decode. The optional key rides the x-api-key header, so
// URLs are safe to store on errors.
func (c *client) getJSON(ctx context.Context, url string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return &HardError{Kind: "transport", URL: url, Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "application/json")
	if c.apiKey != "" {
		req.Header.Set(APIKeyHeader, c.apiKey)
	}
	r, err := c.do.Do(req)
	if err != nil {
		return &HardError{Kind: "transport", URL: url, Detail: err.Error()}
	}
	if r == nil {
		return &HardError{Kind: "transport", URL: url, Detail: "transport returned no response and no error"}
	}
	defer r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
		return &HardError{Kind: "status", URL: url, Status: r.StatusCode,
			Detail: preview(string(b))}
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes))
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
		return &HardError{Kind: "shape", URL: url, Status: r.StatusCode, Detail: err.Error()}
	}
	return nil
}

// preview keeps the first bytes of an unexpected body for the error detail.
func preview(s string) string {
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
