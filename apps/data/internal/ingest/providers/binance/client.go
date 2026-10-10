package binance

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
	// Base endpoints. Spot and futures live on different hosts.
	SpotBase = "https://api.binance.com"
	PerpBase = "https://fapi.binance.com"

	// UA is the adapter's User-Agent. Public keyless endpoints, no secrets.
	UA = "fudcourt-data/1.0"

	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second

	// maxBodyBytes bounds one upstream body. The widest response here is
	// ticker/24hr for the full market (~2 MiB); 16 MiB is ample headroom.
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

// HardError is the typed failure: a non-2xx status, an API error body, or a
// shape mismatch. The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "api-error" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("binance: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("binance: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v. Binance error
// envelopes {"code":-1121,"msg":"..."} arrive on non-200 statuses and (on some
// legacy endpoints) on 200; both are HardErrors, never a partial decode.
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
	body := string(b)

	// API error envelope, on any status.
	var apiErr struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if json.Unmarshal(b, &apiErr) == nil && apiErr.Code != 0 && apiErr.Msg != "" {
		return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode,
			Detail: fmt.Sprintf("code %d: %s", apiErr.Code, apiErr.Msg)}
	}
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return &HardError{Kind: "status", URL: url, Status: r.StatusCode,
			Detail: preview(body)}
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

// ms parses a Binance millisecond epoch string/int (klines use strings, ticker
// JSON uses numbers).
func ms(v any) (time.Time, bool) {
	switch t := v.(type) {
	case string:
		n, err := strconv.ParseInt(t, 10, 64)
		if err != nil {
			return time.Time{}, false
		}
		return time.UnixMilli(n).UTC(), true
	case float64:
		return time.UnixMilli(int64(t)).UTC(), true
	case json.Number:
		n, err := t.Int64()
		if err != nil {
			return time.Time{}, false
		}
		return time.UnixMilli(n).UTC(), true
	default:
		return time.Time{}, false
	}
}

// f64 parses a string-or-number JSON value the wire uses interchangeably.
func f64(v any) (float64, bool) {
	switch t := v.(type) {
	case string:
		x, err := strconv.ParseFloat(t, 64)
		if err != nil {
			return 0, false
		}
		return x, true
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

// intervals is the platform timeframe -> Binance interval string. Binance's
// vocabulary matches the platform's minute/hour/day set closely; 1w and 1M
// differ only by case, which canon.ValidateTimeframe treats as distinct.
var intervals = map[string]string{
	"1s": "1s",
	"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
	"1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "8h": "8h", "12h": "12h",
	"1d": "1d", "3d": "3d", "1w": "1w", "1M": "1M",
}

// intervalMs is each Binance interval's length in milliseconds, used to
// compute bar close times from the open time (klines carry closeTime, but the
// array row's 7th field is quote volume; keeping the map lets the spot and
// perp shapes share one row parser with per-endpoint close-time handling).
var intervalMs = map[string]int64{
	"1s": 1000,
	"1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
	"1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
	"8h": 28_800_000, "12h": 43_200_000,
	"1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000, "1M": 2_592_000_000,
}

// splitSymbol splits a Binance pair symbol into base/quote against the known
// quote vocabulary. Unknown quotes fall back to the last 4 characters (USDT /
// USDC / FDUSD width), which covers the pairs this adapter registers.
func splitSymbol(sym string) (base, quote string, ok bool) {
	s := strings.TrimSpace(strings.ToUpper(sym))
	for _, q := range []string{"USDT", "USDC", "FDUSD", "TUSD", "BUSD", "BTC", "ETH", "BNB", "EUR", "TRY", "BRL"} {
		if strings.HasSuffix(s, q) && len(s) > len(q) {
			return strings.TrimSuffix(s, q), q, true
		}
	}
	return "", "", false
}
