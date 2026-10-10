package coingecko

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
	// Base is the v3 public API host.
	Base = "https://api.coingecko.com/api/v3"
	// UA is the adapter's User-Agent. Public keyless endpoints, no secrets.
	UA = "fudcourt-data/1.0"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. The widest response here is a
	// full 250-coin markets page (~1 MiB); 16 MiB is ample headroom.
	maxBodyBytes = 16 << 20
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
// CoinGecko has no error envelope; a rate-limited or blocked request arrives
// as a non-2xx status (often HTML). The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("coingecko: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("coingecko: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v. CoinGecko signals
// failures with statuses, not envelopes: a non-2xx is a status HardError and
// a body that does not decode is a shape HardError, never a partial decode.
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

// ms parses a CoinGecko millisecond epoch. The wire carries timestamps as
// JSON NUMBERS ([1707163200000,42630] points, updated_at ints).
func ms(v any) (time.Time, bool) {
	switch t := v.(type) {
	case float64:
		return time.UnixMilli(int64(t)).UTC(), true
	case json.Number:
		n, err := t.Int64()
		if err != nil {
			return time.Time{}, false
		}
		return time.UnixMilli(n).UTC(), true
	case string:
		n, err := strconv.ParseInt(t, 10, 64)
		if err != nil {
			return time.Time{}, false
		}
		return time.UnixMilli(n).UTC(), true
	default:
		return time.Time{}, false
	}
}

// secs parses a CoinGecko UNIX-seconds epoch (global.updated_at).
func secs(v float64) time.Time {
	return time.Unix(int64(v), 0).UTC()
}

// f64 parses a number-or-string JSON value.
func f64(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case json.Number:
		x, err := t.Float64()
		if err != nil {
			return 0, false
		}
		return x, true
	case string:
		x, err := strconv.ParseFloat(t, 64)
		if err != nil {
			return 0, false
		}
		return x, true
	default:
		return 0, false
	}
}

// assetKinds is the closed symbol -> AssetKind vocabulary for the assets this
// adapter mints. The reference artifact (contracts/data/reference.json) keys
// BTC/ETH/... as native and USDT/USDC/... as stablecoin; minting those with
// kind "other" would fork the canonical asset identity, so the known symbols
// keep their reference kinds and everything else defaults to other.
var assetKinds = func() map[string]canon.AssetKind {
	m := map[string]canon.AssetKind{}
	for _, s := range []string{"BTC", "ETH", "SOL", "BNB", "POL", "TRX"} {
		m[s] = canon.AssetNative
	}
	for _, s := range []string{"USDT", "USDC", "DAI", "FDUSD", "TUSD"} {
		m[s] = canon.AssetStablecoin
	}
	return m
}()

// assetKind reports the canonical AssetKind for a symbol. Symbols arrive in
// the provider's own spelling (CoinGecko /coins/markets rows carry lowercase
// symbols), so the lookup normalizes case and trims whitespace before
// consulting the vocabulary.
func assetKind(symbol string) canon.AssetKind {
	if k, ok := assetKinds[upper(strings.TrimSpace(symbol))]; ok {
		return k
	}
	return canon.AssetOther
}

// assetID mints the canonical asset id for a symbol.
func assetID(symbol string) string {
	return canon.MintID(canon.KindAsset, canon.AssetKey(assetKind(upper(symbol)), symbol))
}

// strPtr is a non-empty string as a pointer; "" stays nil (never-fake).
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
