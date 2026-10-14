package coinmetrics

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
	// Base is the CoinMetrics Community API host.
	Base = "https://community-api.coinmetrics.io/v4"

	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"

	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second

	// maxBodyBytes bounds one upstream body. A page_size=10000 daily pull is a
	// few MiB; 32 MiB is ample headroom.
	maxBodyBytes = 32 << 20
)

// client is the dataset fetcher's HTTP plumbing.
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

// HardError is the typed failure: a non-2xx status, a transport fault, or a
// shape mismatch. The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("coinmetrics: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("coinmetrics: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v.
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
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return &HardError{Kind: "status", URL: url, Status: r.StatusCode, Detail: preview(string(b))}
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
