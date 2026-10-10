package geckoterminal

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
	Base = "https://api.geckoterminal.com/api/v2"
	// UA is the adapter's User-Agent. Public keyless endpoint, no secrets.
	UA = "fudcourt-data/1.0"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. One pool document with included
	// tokens is a few KiB; 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
	// Source is the provider name on every written row.
	Source = "geckoterminal"
	// fallbackVenue is the venue id a pool without a relationships.dex gets:
	// the pool exists and traded somewhere, and the provider is the only
	// honest label — never a guessed dex name.
	fallbackVenue = "geckoterminal"
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
// GeckoTerminal signals failures with statuses and a JSON-API error document
// {"errors":[{"status":"404","title":"Not Found"}]}; there is no success
// envelope. The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("geckoterminal: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("geckoterminal: %s: %s", e.Kind, e.Detail)
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

// poolAttrs is one data.attributes object (trimmed to the fields the adapter
// reads). Numerics arrive as strings.
type poolAttrs struct {
	Address           string `json:"address"`
	Name              string `json:"name"`
	BaseTokenPriceUSD string `json:"base_token_price_usd"`
	ReserveInUSD      string `json:"reserve_in_usd"`
	FDVUSD            string `json:"fdv_usd"`
	VolumeUSD         struct {
		H24 string `json:"h24"`
	} `json:"volume_usd"`
}

// poolDoc is the JSON-API envelope for one pool: data.attributes plus the
// relationships block; included carries the base/quote tokens when the
// request asked for them.
type poolDoc struct {
	Data struct {
		Attributes   poolAttrs `json:"attributes"`
		Relationship struct {
			Dex struct {
				Data struct {
					ID string `json:"id"`
				} `json:"data"`
			} `json:"dex"`
		} `json:"relationships"`
	} `json:"data"`
	Included []struct {
		Type       string `json:"type"`
		Attributes struct {
			Address  string `json:"address"`
			Symbol   string `json:"symbol"`
			Name     string `json:"name"`
			Decimals int    `json:"decimals"`
		} `json:"attributes"`
	} `json:"included"`
}

// poolTokens are the included tokens the doc resolved to, in the order the
// relationships named them (base first, quote second).
type poolTokens struct {
	base  *includedToken
	quote *includedToken
}

// includedToken is one included[] token row the pool references.
type includedToken struct {
	Address  string
	Symbol   string
	Name     string
	Decimals *int
}

// parseF64 parses one wire numeric string. Blank or unparseable stays
// absent: the caller writes a nil field, never a zero (never-fake).
func parseF64(s string) *float64 {
	s = trimSpace(s)
	if s == "" {
		return nil
	}
	x, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &x
}

// dexID extracts the dex id from the relationships block ("uniswap_v3");
// some pools omit the relationship entirely.
func (d *poolDoc) dexID() string {
	return trimSpace(d.Data.Relationship.Dex.Data.ID)
}

// tokens resolves the included[] rows to the base/quote pair. The JSON-API
// relationship ids ("eth_0x...") are positional on this endpoint: base and
// quote arrive in that order, so a missing dex relationship does not disturb
// the pairing.
func (d *poolDoc) tokens() poolTokens {
	var t poolTokens
	for i := range d.Included {
		row := &d.Included[i]
		if row.Type != "token" || row.Attributes.Address == "" {
			continue
		}
		tok := &includedToken{
			Address: row.Attributes.Address,
			Symbol:  row.Attributes.Symbol,
			Name:    row.Attributes.Name,
		}
		if row.Attributes.Decimals != 0 {
			n := row.Attributes.Decimals
			tok.Decimals = &n
		}
		switch {
		case t.base == nil:
			t.base = tok
		case t.quote == nil:
			t.quote = tok
		}
	}
	return t
}

// chainName maps a GeckoTerminal network slug to the canonical chain name.
// The slugs are GeckoTerminal's own vocabulary and differ from the
// dexscreener spellings where CoinGecko's ids differ from the chain brands
// ("eth" vs "ethereum"); the seeded networks map explicitly, everything else
// passes through lowercased (the slug is then the chain name by definition).
var networkToChain = map[string]string{
	"eth":         "ethereum",
	"solana":      "solana",
	"bsc":         "bsc",
	"polygon_pos": "polygon",
	"arbitrum":    "arbitrum",
	"optimism":    "optimism",
	"base":        "base",
	"avax":        "avalanche",
}

// chainKind reports the canonical chain kind for a chain name.
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

// trimSpace is strings.TrimSpace local (avoids a strings import per file).
func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}
