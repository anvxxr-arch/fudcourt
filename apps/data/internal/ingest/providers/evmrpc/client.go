package evmrpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// UA is the adapter's User-Agent.
	UA = "fudcourt-data/1.0"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. eth_getLogs over a wide range can
	// return tens of thousands of logs and a block header with full
	// transactions is large; 32 MiB is ample headroom while still bounding a
	// hostile response.
	maxBodyBytes = 32 << 20
	// jsonRPCVersion is the only version the adapter speaks.
	jsonRPCVersion = "2.0"
	// rpcID is the request id. Calls are sequential and unbatched, so a single
	// constant id cannot be mismatched with a response; batching would require
	// per-request ids and is deliberately not used yet.
	rpcID = 1
)

// HardError is the typed failure: a non-2xx status, a JSON-RPC error object, a
// missing endpoint, or a shape mismatch. The engine's breaker keys on Kind;
// "no-credentials" is terminal (the engine will not retry an unconfigured
// chain).
type HardError struct {
	Kind   string // "no-credentials" | "transport" | "status" | "rpc-error" | "shape"
	URL    string // redacted to scheme://host: RPC keys live in the path
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("evmrpc: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("evmrpc: %s: %s", e.Kind, e.Detail)
}

// client is the adapter's JSON-RPC plumbing: an injected Doer (tests
// substitute canned responses), a per-request timeout and the method name it
// reports on errors.
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

// rpcRequest is the JSON-RPC 2.0 request envelope. Params is always an array
// (the spec allows a named-object form too, but no method here uses it).
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

// rpcError is the JSON-RPC error object: a node reporting a failure INSIDE a
// 200 response. It is distinct from an HTTP failure and is never retried into
// success, so it gets its own Kind.
type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// rpcResponse is the JSON-RPC 2.0 response envelope. Result stays raw so each
// caller decodes its own shape and a null result (an absent block, an absent
// receipt) is distinguishable from a present-but-empty one.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

// call performs one JSON-RPC request and decodes result into out.
//
// Failure classification, in order:
//   - an empty endpoint is no-credentials, before any request is built;
//   - a request/transport failure is transport;
//   - a JSON-RPC error object is rpc-error, whatever the HTTP status;
//   - a non-2xx without one is status;
//   - a null or undecodable result is shape.
//
// out may be nil for a call whose result is not needed (a node's answer is
// still validated: a JSON-RPC error is reported even when out is nil).
func (c *client) call(ctx context.Context, endpoint, method string, params []any, out any) error {
	if strings.TrimSpace(endpoint) == "" {
		return &HardError{Kind: "no-credentials",
			Detail: method + ": no RPC endpoint configured for this chain"}
	}
	body, err := json.Marshal(rpcRequest{JSONRPC: jsonRPCVersion, ID: rpcID, Method: method, Params: params})
	if err != nil {
		return &HardError{Kind: "transport", URL: redact(endpoint), Detail: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return &HardError{Kind: "transport", URL: redact(endpoint), Detail: err.Error()}
	}
	req.Header.Set("User-Agent", UA)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	r, err := c.do.Do(req)
	if err != nil {
		return &HardError{Kind: "transport", URL: redact(endpoint), Detail: method + ": " + err.Error()}
	}
	if r == nil {
		return &HardError{Kind: "transport", URL: redact(endpoint),
			Detail: method + ": transport returned no response and no error"}
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		return &HardError{Kind: "transport", URL: redact(endpoint), Status: r.StatusCode,
			Detail: method + ": " + err.Error()}
	}
	// A JSON-RPC error object is the node's own failure report and arrives
	// with HTTP 200; it is checked before the status so the node's code and
	// message survive instead of being flattened into "HTTP 200".
	var env rpcResponse
	if json.Unmarshal(b, &env) == nil && env.Error != nil {
		return &HardError{Kind: "rpc-error", URL: redact(endpoint), Status: r.StatusCode,
			Detail: fmt.Sprintf("%s: code %d: %s: %s", method, env.Error.Code,
				env.Error.Message, preview(string(env.Error.Data)))}
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return &HardError{Kind: "status", URL: redact(endpoint), Status: r.StatusCode,
			Detail: method + ": " + preview(string(b))}
	}
	if err := json.Unmarshal(b, &env); err != nil {
		return &HardError{Kind: "shape", URL: redact(endpoint), Status: r.StatusCode,
			Detail: method + ": " + err.Error()}
	}
	if len(env.Result) == 0 || string(env.Result) == "null" {
		return &HardError{Kind: "shape", URL: redact(endpoint), Status: r.StatusCode,
			Detail: method + ": result is null"}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return &HardError{Kind: "shape", URL: redact(endpoint), Status: r.StatusCode,
			Detail: method + ": result: " + err.Error()}
	}
	return nil
}

// blockNumber reads the chain tip height.
func (c *client) blockNumber(ctx context.Context, endpoint string) (uint64, error) {
	var hexNum string
	if err := c.call(ctx, endpoint, "eth_blockNumber", []any{}, &hexNum); err != nil {
		return 0, err
	}
	n, ok := hexToUint64(hexNum)
	if !ok {
		return 0, &HardError{Kind: "shape", URL: redact(endpoint),
			Detail: "eth_blockNumber: " + preview(hexNum)}
	}
	return n, nil
}

// blockByNumber reads one block header. full=false keeps the transaction list
// as hashes: the adapter reads header facts only, and a full body would
// multiply the payload for data it discards.
func (c *client) blockByNumber(ctx context.Context, endpoint string, number uint64, full bool) (*blockHeader, error) {
	var hdr blockHeader
	if err := c.call(ctx, endpoint, "eth_getBlockByNumber", []any{hexUint64(number), full}, &hdr); err != nil {
		return nil, err
	}
	if hdr.Number == "" || hdr.Hash == "" {
		return nil, &HardError{Kind: "shape", URL: redact(endpoint),
			Detail: "eth_getBlockByNumber: header without number/hash"}
	}
	return &hdr, nil
}

// getLogs reads the logs matching filter. The caller owns the range: the
// adapter never widens it, because an unbounded eth_getLogs is rejected by most
// nodes and rate-limited by the rest.
func (c *client) getLogs(ctx context.Context, endpoint string, f logFilter) ([]logEntry, error) {
	arg := map[string]any{
		"fromBlock": hexUint64(f.FromBlock),
		"toBlock":   hexUint64(f.ToBlock),
	}
	if f.Address != "" {
		arg["address"] = f.Address
	}
	if len(f.Topics) > 0 {
		arg["topics"] = f.Topics
	}
	var logs []logEntry
	if err := c.call(ctx, endpoint, "eth_getLogs", []any{arg}, &logs); err != nil {
		return nil, err
	}
	return logs, nil
}

// logFilter is one eth_getLogs filter object. Topics is the positional
// topic0..topic3 matcher: an empty inner slice is a wildcard at that position
// (the JSON-RPC convention), which is why the field is [][]string and not
// []string.
type logFilter struct {
	FromBlock uint64
	ToBlock   uint64
	Address   string
	Topics    [][]string
}

// preview keeps the first bytes of an unexpected body for the error detail.
func preview(s string) string {
	const n = 200
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// hexUint64 encodes n as a 0x-prefixed lowercase hex quantity, the JSON-RPC
// spelling for block numbers and timestamps. strconv.FormatUint's %x is
// already lowercase and unpadded, which is what the spec requires.
func hexUint64(n uint64) string {
	return "0x" + strconv.FormatUint(n, 16)
}

// hexToUint64 decodes a 0x-prefixed hex quantity. A bare decimal string is
// also accepted: some proxies re-encode quantities, and rejecting a
// numerically identical value would be a false failure. An empty string is
// never 0 - it is not a number, and callers must treat it as absent.
func hexToUint64(s string) (uint64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		n, err := strconv.ParseUint(s[2:], 16, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// strPtr is a non-empty string as a pointer; "" stays nil (never-fake).
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// hexToBigFloat decodes a 0x hex quantity into a float64 through big.Float.
//
// This is for block-header magnitudes only: a base fee is ~1e10 wei and a gas
// count ~1e7, both far below binary64's 53-bit exact range, so the rounding is
// orders of magnitude finer than the reported precision. It must NEVER carry a
// token balance or a wei amount - plan §54 forbids float for those, and this
// helper exists so the header path does not tempt a caller into reusing it
// there.
func hexToBigFloat(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	base := 10
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		s = s[2:]
		base = 16
	}
	v, ok := new(big.Int).SetString(s, base)
	if !ok || v.Sign() < 0 {
		return 0, false
	}
	f, _ := new(big.Float).SetInt(v).Float64()
	return f, true
}
