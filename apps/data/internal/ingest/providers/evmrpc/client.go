package evmrpc

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
	// maxBodyBytes bounds one upstream body; a 1000-log page is well under.
	maxBodyBytes = 32 << 20
	// defaultTimeout bounds one upstream request. A wide getLogs range can take
	// longer than an indexer's read, so this is looser than the other adapters.
	defaultTimeout = 60 * time.Second
)

// client is the transport: one JSON-RPC endpoint, an injected Doer, a timeout.
// It knows NOTHING about AMMs — it returns raw logs and the parsers in events.go
// interpret them.
type client struct {
	do       canon.Doer
	timeout  time.Duration
	endpoint string
	// meta caches pool token identity + decimals per process, since a swap
	// event carries neither and a re-read per swap would multiply RPC calls.
	meta metaCache
	// blocks caches block number -> timestamp, so a page of swaps in the same
	// few blocks costs a handful of header reads, not one per swap.
	blocks blockTimeCache
}

// newClient builds the client; a nil Doer gets the shared tuned transport. The
// node URL is read ONCE from the environment here — it may embed an API key, so
// it never reaches a stored error.
func newClient(d canon.Doer, timeout time.Duration) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	endpoint := os.Getenv(RPCEndpointEnv)
	if endpoint == "" {
		endpoint = os.Getenv(FallbackRPCEndpointEnv)
	}
	return &client{do: d, timeout: timeout, endpoint: endpoint}
}

// HardError is the typed failure: a missing endpoint, a transport failure, an
// RPC error object, or a shape mismatch. "no-credentials" is terminal — the
// engine does not retry an empty endpoint.
type HardError struct {
	Kind   string // "no-credentials" | "transport" | "rpc" | "shape"
	Detail string
}

func (e *HardError) Error() string {
	return fmt.Sprintf("evmrpc: %s: %s", e.Kind, e.Detail)
}

// rpcRequest is one JSON-RPC 2.0 call.
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

// rpcResponse is the JSON-RPC envelope. A non-null Error with a 200 status is a
// failure (a node reports a bad range or a rate limit there, not via HTTP).
type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// call performs one JSON-RPC call and unmarshals `result` into out. The endpoint
// is the credential and is deliberately absent from every error string.
func (c *client) call(ctx context.Context, method string, params []any, out any) error {
	if c.endpoint == "" {
		return &HardError{Kind: "no-credentials", Detail: RPCEndpointEnv + " is not set"}
	}
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: 1, Method: method, Params: params})
	if err != nil {
		return &HardError{Kind: "shape", Detail: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		// The error from NewRequest can echo the URL (and therefore a key); do
		// not propagate it verbatim.
		return &HardError{Kind: "shape", Detail: "invalid RPC request"}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Content-Type", "application/json")
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
		return &HardError{Kind: "transport", Detail: err.Error()}
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return &HardError{Kind: "transport", Detail: fmt.Sprintf("HTTP %d: %s", r.StatusCode, preview(string(b)))}
	}
	var env rpcResponse
	if err := json.Unmarshal(b, &env); err != nil {
		return &HardError{Kind: "shape", Detail: err.Error()}
	}
	if env.Error != nil {
		return &HardError{Kind: "rpc", Detail: fmt.Sprintf("code %d: %s", env.Error.Code, env.Error.Message)}
	}
	if len(env.Result) == 0 {
		return &HardError{Kind: "shape", Detail: "response carried no result"}
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return &HardError{Kind: "shape", Detail: err.Error()}
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
