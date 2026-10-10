package polymarket

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
	// Base is the Gamma API host.
	Base = "https://gamma-api.polymarket.com"
	// UA is the adapter's User-Agent. Public keyless endpoint, no secrets.
	UA = "fudcourt-data/1.0"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. A 100-market page is well under
	// 1 MiB; 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
	// Source is the provider name on every written row.
	Source = "polymarket"
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

// HardError is the typed failure: a non-2xx status or a shape mismatch.
// Gamma signals failures with statuses (JSON {"error":"..."} or plain text);
// there is no success envelope. The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("polymarket: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("polymarket: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v. A non-2xx is a status
// HardError and a body that does not decode is a shape HardError, never a
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

// marketRow is one Gamma /markets entry (trimmed to the fields the adapter
// reads). Outcomes/OutcomePrices arrive as JSON-encoded strings and decode
// twice; VolumeNum/LiquidityNum are numbers, Volume24hr a number.
type marketRow struct {
	ID            string  `json:"id"`
	Question      string  `json:"question"`
	Outcomes      string  `json:"outcomes"`
	OutcomePrices string  `json:"outcomePrices"`
	LiquidityNum  float64 `json:"liquidityNum"`
	VolumeNum     float64 `json:"volumeNum"`
	Volume24hr    float64 `json:"volume24hr"`
	EndDate       string  `json:"endDate"`
	Closed        bool    `json:"closed"`
	Active        bool    `json:"active"`
}

// decodeStrings decodes one of Gamma's JSON-in-a-string fields
// ('["Yes","No"]'). A blank field decodes to a nil slice, not an error: the
// prices field is optional on fresh markets.
func decodeStrings(s string) ([]string, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, true
	}
	var out []string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil, false
	}
	return out, true
}

// decodeFloats decodes the prices array ('["0.52","0.48"]'); the elements are
// strings on the wire, though Gamma has also emitted bare numbers, so both
// spellings parse.
func decodeFloats(s string) ([]float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, true
	}
	var raw []any
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return nil, false
	}
	out := make([]float64, 0, len(raw))
	for _, el := range raw {
		switch v := el.(type) {
		case string:
			x, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
			if err != nil {
				return nil, false
			}
			out = append(out, x)
		case float64:
			out = append(out, v)
		default:
			return nil, false
		}
	}
	return out, true
}

// parseTime parses Gamma's RFC3339 timestamps ("2027-01-01T04:59:00Z"; some
// rows carry fractional seconds). Empty stays nil (never-fake).
func parseTime(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return &t
		}
	}
	return nil
}

// resolution maps the wire's active/closed pair to the canon resolution
// status vocabulary. Gamma publishes no explicit resolution field on the
// markets list, so the status is the closed flag, verbatim, never guessed.
func resolution(active, closed bool) string {
	switch {
	case closed:
		return "closed"
	case active:
		return "active"
	default:
		return "inactive"
	}
}

// f64Ptr is a positive-or-zero value as a pointer; a missing number (0 on the
// wire where Gamma has no data) stays nil (never-fake).
func f64Ptr(v float64) *float64 {
	if v == 0 {
		return nil
	}
	return &v
}
