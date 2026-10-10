package oecd

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// Base is the OECD SDMX public REST data host.
	Base = "https://sdmx.oecd.org/public/rest/data"

	// UA is the adapter's User-Agent. Public keyless endpoints, no secrets.
	UA = "fudcourt-data/1.0"

	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second

	// maxBodyBytes bounds one upstream body. A full annual dataflow CSV can
	// reach a few hundred MiB upstream, but the adapter's flows pin a key or
	// a startPeriod; 64 MiB covers the realistic slices.
	maxBodyBytes = 64 << 20
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

// HardError is the typed failure: a non-2xx status, an SDMX error body
// ("NoResultsFound", HTML blocks), or a shape mismatch (a missing configured
// column). The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("oecd: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("oecd: %s: %s", e.Kind, e.Detail)
}

// getCSV performs one GET and returns the body text. SDMX signals failures
// with non-2xx statuses or a 200 whose body is a bare error token
// ("NoRecordsFound" / "No Results Found") or HTML; all are HardErrors, never
// a partial parse.
func (c *client) getCSV(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", &HardError{Kind: "transport", URL: url, Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "text/csv")
	r, err := c.do.Do(req)
	if err != nil {
		return "", &HardError{Kind: "transport", URL: url, Detail: err.Error()}
	}
	if r == nil {
		return "", &HardError{Kind: "transport", URL: url, Detail: "transport returned no response and no error"}
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		return "", &HardError{Kind: "transport", URL: url, Status: r.StatusCode, Detail: err.Error()}
	}
	body := string(b)
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return "", &HardError{Kind: "status", URL: url, Status: r.StatusCode, Detail: preview(body)}
	}
	if isSDMXErrorBody(body) {
		return "", &HardError{Kind: "status", URL: url, Status: r.StatusCode, Detail: preview(body)}
	}
	return body, nil
}

// isSDMXErrorBody reports whether a 200 body is actually an SDMX error token
// (the registry answers some no-data requests with 200 + a bare token) or an
// HTML block.
func isSDMXErrorBody(body string) bool {
	t := strings.TrimSpace(body)
	if strings.HasPrefix(t, "<") {
		return true
	}
	for _, tok := range []string{"NoRecordsFound", "No Results Found", "Could not find"} {
		if strings.HasPrefix(t, tok) {
			return true
		}
	}
	return false
}

// preview keeps the first bytes of an unexpected body for the error detail.
func preview(s string) string {
	const n = 200
	if len(s) <= n {
		return s
	}
	return s[:n]
}
