package bitquery

import (
	"bytes"
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
	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"
	// endpoint is Bitquery's v2 GraphQL gateway. It carries no credential (the
	// key is a header), so it may be named in source and in errors.
	endpoint = "https://streaming.bitquery.io/graphql"
	// maxBodyBytes bounds one upstream body; a 1000-row trade page is well under.
	maxBodyBytes = 16 << 20
	// defaultTimeout bounds one upstream request.
	defaultTimeout = 30 * time.Second
)

// client is one dataset fetcher's HTTP plumbing: an injected Doer (tests
// substitute canned responses), a per-request timeout, and the API key.
type client struct {
	do      canon.Doer
	timeout time.Duration
	apiKey  string
}

// newClient builds the client; a nil Doer gets the shared tuned transport. The
// API key is read ONCE from the environment here — a secret that never reaches a
// URL, a log line or an error string.
func newClient(d canon.Doer, timeout time.Duration) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	return &client{do: d, timeout: timeout, apiKey: os.Getenv(APIKeyEnv)}
}

// HardError is the typed failure: a missing credential, a transport failure, a
// non-2xx status, a GraphQL error envelope, or a shape mismatch.
// "no-credentials" is terminal — the engine does not retry an empty key.
type HardError struct {
	Kind   string // "no-credentials" | "transport" | "status" | "graphql" | "shape"
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("bitquery: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("bitquery: %s: %s", e.Kind, e.Detail)
}

// gqlRequest is a GraphQL POST body.
type gqlRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables,omitempty"`
}

// gqlResponse is the GraphQL envelope. Bitquery signals a bad query or a partial
// failure through errors even with a 200, so an errors array is a failure.
type gqlResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// post performs one GraphQL POST and returns the raw `data` object. UseNumber
// keeps every numeric Bitquery sends (an amount, a price) exact until it is
// mapped, so no value passes through a float64. The key is set as the
// Authorization header and is deliberately absent from the error strings.
func (c *client) post(ctx context.Context, query string, vars map[string]any, out any) error {
	if c.apiKey == "" {
		return &HardError{Kind: "no-credentials", Detail: APIKeyEnv + " is not set"}
	}
	body, err := json.Marshal(gqlRequest{Query: query, Variables: vars})
	if err != nil {
		return &HardError{Kind: "shape", Detail: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return &HardError{Kind: "shape", Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Content-Type", "application/json")
	// Bitquery v2 documents the OAuth-style `Authorization: Bearer <token>`
	// form on its GraphQL gateway; the bare-token spelling is the documented
	// 401 case. The gateway URL carries no key, so it may be named in source.
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	r, err := c.do.Do(req)
	if err != nil {
		return &HardError{Kind: "transport", Detail: err.Error()}
	}
	if r == nil {
		return &HardError{Kind: "transport", Detail: "transport returned no response and no error"}
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		return &HardError{Kind: "transport", Status: r.StatusCode, Detail: err.Error()}
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return &HardError{Kind: "status", Status: r.StatusCode, Detail: preview(string(b))}
	}
	var env gqlResponse
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&env); err != nil {
		return &HardError{Kind: "shape", Status: r.StatusCode, Detail: err.Error()}
	}
	if len(env.Errors) > 0 {
		return &HardError{Kind: "graphql", Status: r.StatusCode, Detail: env.Errors[0].Message}
	}
	// A JSON `null` data member is four bytes, not zero, and Unmarshal("null")
	// is a silent no-op — so a null payload must be refused explicitly rather
	// than reported as an empty success.
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return &HardError{Kind: "shape", Status: r.StatusCode, Detail: "response carried no data"}
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return &HardError{Kind: "shape", Status: r.StatusCode, Detail: err.Error()}
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
