package dexscreener

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// Base is the public API host.
	Base = "https://api.dexscreener.com"
	// UA is the adapter's User-Agent. Public keyless endpoints, no secrets.
	UA = "fudcourt-data/1.0"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. The widest response here is a
	// search page (~1 MiB); 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
	// Source is the provider name on every written row.
	Source = "dexscreener"
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
// DexScreener signals failures with statuses; there is no success envelope.
// The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("dexscreener: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("dexscreener: %s: %s", e.Kind, e.Detail)
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

// tokenRef is one side of a pair: {"address":"0x...","name":"Tether USD",
// "symbol":"USDT"}.
type tokenRef struct {
	Address string `json:"address"`
	Name    string `json:"name"`
	Symbol  string `json:"symbol"`
}

// pairRow is one DexScreener pair (trimmed to the fields the adapter reads).
// Numerics arrive as numbers on token-pairs and as strings elsewhere, so the
// any-typed fields parse both. liquidity.usd and volume.h24 are sub-objects.
type pairRow struct {
	ChainID     string   `json:"chainId"`
	DexID       string   `json:"dexId"`
	PairAddress string   `json:"pairAddress"`
	BaseToken   tokenRef `json:"baseToken"`
	QuoteToken  tokenRef `json:"quoteToken"`
	PriceUSD    any      `json:"priceUsd"`
	Liquidity   struct {
		USD any `json:"usd"`
	} `json:"liquidity"`
	Volume struct {
		H24 any `json:"h24"`
	} `json:"volume"`
	FDV           any   `json:"fdv"`
	PairCreatedAt int64 `json:"pairCreatedAt"`
}

// f64 parses a number-or-string JSON value the wire uses interchangeably.
func f64(v any) (float64, bool) {
	switch t := v.(type) {
	case string:
		if t == "" {
			return 0, false
		}
		return parseF64(t)
	case float64:
		return t, true
	case json.Number:
		x, err := t.Float64()
		if err != nil {
			return 0, false
		}
		return x, true
	default:
		return 0, false
	}
}

// chainKind guesses the canonical chain kind from the slug. The tree only
// needs a stable label; evm covers every slug DexScreener serves except the
// few non-EVM networks with well-known spellings.
func chainKind(chain string) string {
	switch chain {
	case "solana":
		return "solana"
	case "sui":
		return "sui"
	case "ton":
		return "ton"
	case "aptos":
		return "aptos"
	case "near":
		return "near"
	case "cosmos":
		return "cosmos"
	case "tron":
		return "tron"
	default:
		return "evm"
	}
}

// parseF64 is strconv.ParseFloat with the error collapsed to ok.
func parseF64(s string) (float64, bool) {
	x, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return x, true
}
