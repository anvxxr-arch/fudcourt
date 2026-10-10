package etherscan

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// Base is the v2 multi-chain API host; the chain is selected by the
	// chainid query parameter, not by the host.
	Base = "https://api.etherscan.io/v2/api"
	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"
	// APIKeyEnv is the environment variable the Etherscan API key is read
	// from. The key is carried only in memory and in the apikey query
	// parameter of the upstream request; it is never logged and never
	// appears in an error.
	APIKeyEnv = "ETHERSCAN_API_KEY"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. The widest response here is a
	// gasoracle object (~1 KiB); 4 MiB is ample headroom.
	maxBodyBytes = 4 << 20
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

// HardError is the typed failure: a non-2xx status, an API error envelope, a
// missing credential, or a shape mismatch. The engine's breaker keys on the
// kind; "no-credentials" is terminal (the engine will not retry an empty key).
type HardError struct {
	Kind   string // "no-credentials" | "transport" | "status" | "api-error" | "shape"
	URL    string // redacted: the apikey parameter is stripped before storing
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("etherscan: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("etherscan: %s: %s", e.Kind, e.Detail)
}

// redact strips the apikey query parameter from a URL before it is stored on
// an error. The key must never reach a journal, a log line or a test failure
// message.
func redact(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		// Not parseable: refuse to risk leaking the key, drop the URL.
		return "(unparseable url)"
	}
	q := u.Query()
	if q.Get("apikey") != "" {
		q.Set("apikey", "REDACTED")
		u.RawQuery = q.Encode()
	}
	return u.String()
}

// getJSON performs one GET and decodes the body into v. Etherscan signals
// failures with the {"status":"0","message":"NOTOK",...} envelope on any HTTP
// status; that envelope is an api-error HardError, a non-2xx without it a
// status HardError, and a body that does not decode a shape HardError - never
// a partial decode.
func (c *client) getJSON(ctx context.Context, url string, v any) error {
	if c.apiKey == "" {
		return &HardError{Kind: "no-credentials",
			Detail: "ETHERSCAN_API_KEY is empty; an Etherscan API key is required"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return &HardError{Kind: "transport", URL: redact(url), Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Accept", "application/json")
	r, err := c.do.Do(req)
	if err != nil {
		return &HardError{Kind: "transport", URL: redact(url), Detail: err.Error()}
	}
	if r == nil {
		return &HardError{Kind: "transport", URL: redact(url), Detail: "transport returned no response and no error"}
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		return &HardError{Kind: "transport", URL: redact(url), Status: r.StatusCode, Detail: err.Error()}
	}
	body := string(b)
	// Etherscan error envelope: status "0" is failure on any HTTP status.
	var env struct {
		Status  string          `json:"status"`
		Message string          `json:"message"`
		Result  json.RawMessage `json:"result"`
	}
	if json.Unmarshal(b, &env) == nil && env.Status == "0" {
		return &HardError{Kind: "api-error", URL: redact(url), Status: r.StatusCode,
			Detail: fmt.Sprintf("status %s: %s: %s", env.Status, env.Message, preview(string(env.Result)))}
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return &HardError{Kind: "status", URL: redact(url), Status: r.StatusCode,
			Detail: preview(body)}
	}
	if err := json.Unmarshal(b, v); err != nil {
		return &HardError{Kind: "shape", URL: redact(url), Status: r.StatusCode, Detail: err.Error()}
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

// weiToETH converts a wei decimal string to whole ETH units as float64. The
// Etherscan supply endpoints report wei ("120473186340..."); the canon supply
// row is in native units. 18 decimals is exact for every EVM native coin in
// the chain map.
func weiToETH(wei string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.TrimSpace(wei), 64)
	if err != nil || f < 0 {
		return 0, false
	}
	return f / 1e18, true
}

// f64 parses a decimal-string JSON value.
func f64(s string) (float64, bool) {
	x, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, false
	}
	return x, true
}

// strPtr is a non-empty string as a pointer; "" stays nil (never-fake).
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
