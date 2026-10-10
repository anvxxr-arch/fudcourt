package worldbank

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
	// Base is the World Bank Open Data v2 API host.
	Base = "https://api.worldbank.org/v2"

	// UA is the adapter's User-Agent. Public keyless endpoints, no secrets.
	UA = "fudcourt-data/1.0"

	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second

	// maxBodyBytes bounds one upstream body. per_page=20000 annual rows for
	// two countries is a few MiB; 32 MiB is ample headroom.
	maxBodyBytes = 32 << 20
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

// HardError is the typed failure: a non-2xx status, a World Bank
// {"message":[...]} error envelope, or a shape mismatch. The engine's breaker
// keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape" | "api-error"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("worldbank: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("worldbank: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v. The World Bank error
// envelope {"message":[{"id":"120","key":"...","value":"..."}]} arrives on
// non-200 statuses; non-JSON bodies (HTML blocks) are shape errors, never a
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

// sourceRow is one /source listing row: {"id":"2","value":"World Development
// Indicators",...}. The dataset listing exists for discovery/ops; the
// sourceList call is exercised by tests against the same client plumbing.
type sourceRow struct {
	ID    string `json:"id"`
	Value string `json:"value"`
}

// sources calls GET /source?format=json (envelope [meta, rows]).
func (c *client) sources(ctx context.Context) ([]sourceRow, error) {
	var res []json.RawMessage
	if err := c.getJSON(ctx, Base+"/source?format=json", &res); err != nil {
		return nil, err
	}
	if len(res) < 2 {
		return nil, &HardError{Kind: "shape", URL: Base + "/source?format=json",
			Detail: fmt.Sprintf("source envelope has %d elements, want [meta, rows]", len(res))}
	}
	var rows []sourceRow
	if err := json.Unmarshal(res[1], &rows); err != nil {
		return nil, &HardError{Kind: "shape", URL: Base + "/source?format=json", Detail: err.Error()}
	}
	return rows, nil
}

// parseF64 parses the wire's number-or-null value.
func parseF64(b []byte) (float64, bool) {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
