package geckoterminal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/data/internal/canon"
	"github.com/anvxxr-arch/fudcourt/apps/data/platform/httpx"
)

const (
	// Base is the public API host.
	Base = "https://api.geckoterminal.com/api/v2"
	// UA is the adapter's User-Agent. Public keyless endpoint, no secrets.
	UA = "fudcourt-data/1.0"
	// APIKeysEnv holds a COMMA-SEPARATED list of CoinGecko demo API keys.
	// The CoinGecko family (api.coingecko.com v3 and api.geckoterminal.com)
	// bills one shared per-IP budget; a demo key authenticates the app and
	// may earn a better fair share, but does NOT open a parallel bucket —
	// measured live: two keys still 429 alternately while the family bucket
	// recovers. Keys are optional: keyless requests keep working. Keys ride
	// the x-cg-demo-api-key header, never the URL, and live only in the
	// git-ignored .env.
	APIKeysEnv = "CG_DEMO_API_KEYS"
	// APIKeyEnv is the single-key spelling, still honored (and still the
	// documented name); it is appended to whatever APIKeysEnv holds.
	APIKeyEnv = "CG_DEMO_API_KEY"
	// demoKeyHeader is the header name CoinGecko documents for demo keys.
	demoKeyHeader = "x-cg-demo-api-key"
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
// substitute canned responses), a per-request timeout and the demo keys it
// round-robins across.
type client struct {
	do      canon.Doer
	timeout time.Duration
	apiKeys []string
	next    atomic.Uint64
}

// newClient builds the client; a nil Doer gets the shared tuned transport.
func newClient(d canon.Doer, timeout time.Duration) *client {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if d == nil {
		d = httpx.NewClient(timeout)
	}
	return &client{do: d, timeout: timeout, apiKeys: keysFromEnv()}
}

// keysFromEnv collects the configured demo keys: APIKeysEnv is a comma-
// separated list, APIKeyEnv the single-key spelling, and both may be set.
// Duplicates collapse — otherwise a repeated key would be selected twice in
// a row and the rotation would silently not rotate.
func keysFromEnv() []string {
	var out []string
	seen := make(map[string]bool, 2)
	add := func(k string) {
		k = trimSpace(k)
		if k == "" || seen[k] {
			return
		}
		seen[k] = true
		out = append(out, k)
	}
	for _, k := range strings.Split(os.Getenv(APIKeysEnv), ",") {
		add(k)
	}
	add(os.Getenv(APIKeyEnv))
	return out
}

// pickKey rotates across the configured keys so a burst of pages spreads
// over several keys instead of draining one.
func (c *client) pickKey() string {
	if len(c.apiKeys) == 0 {
		return ""
	}
	if len(c.apiKeys) == 1 {
		return c.apiKeys[0]
	}
	n := c.next.Add(1) - 1
	return c.apiKeys[int(n%uint64(len(c.apiKeys)))]
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
	if k := c.pickKey(); k != "" {
		req.Header.Set(demoKeyHeader, k)
	}
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
	// Decode with UseNumber so a JSON number keeps its exact digits (a float64
	// would round them): the OHLCV prices arrive as bare JSON numbers and are
	// read as json.Number spellings before being turned into exact canon.Dec
	// values.
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
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
	// PoolCreatedAt is when the pool was created on chain (RFC3339 upstream).
	// It is pool metadata, not the snapshot's time: parsePoolCreatedAt keeps an
	// unparseable or absent value nil rather than guessing.
	PoolCreatedAt string `json:"pool_created_at"`
	VolumeUSD     struct {
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
	// The newer EVM L1s and the non-EVM networks this platform serves.
	// Slugs are GeckoTerminal's own /networks vocabulary (verified live):
	// "sui-network" is Sui; "hyperliquid", "berachain", "sonic", "plasma"
	// and "robinhood" are EVM-compatible chains.
	"hyperliquid": "hyperliquid",
	"berachain":   "berachain",
	"sonic":       "sonic",
	"plasma":      "plasma",
	"robinhood":   "robinhood",
	"aptos":       "aptos",
	"sui-network": "sui",
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
