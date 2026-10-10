package bybit

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
	// Base is the v5 market-data host.
	Base = "https://api.bybit.com"
	// UA is the adapter's User-Agent. Public keyless endpoints, no secrets.
	UA = "fudcourt-data/1.0"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. The widest response here is
	// instruments-info for the full spot+linear universe; 16 MiB is ample.
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

// HardError is the typed failure: a non-2xx status, an API error envelope, or
// a shape mismatch. The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "api-error" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("bybit: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("bybit: %s: %s", e.Kind, e.Detail)
}

// envelope is the v5 response wrapper. retCode 0 means success; any other
// value (on any HTTP status) is an API error. retExtInfo carries the
// human-readable detail on failures and is absent on success.
type envelope struct {
	RetCode    int             `json:"retCode"`
	RetMsg     string          `json:"retMsg"`
	Result     json.RawMessage `json:"result"`
	RetExtInfo json.RawMessage `json:"retExtInfo"`
}

// getJSON performs one GET, unwraps the v5 envelope, and decodes result into
// v. Bybit answers {"retCode":10001,"retMsg":"..."} both on non-200 statuses
// and on 200; both are HardErrors, never a partial decode.
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
	if r.StatusCode < 200 || r.StatusCode > 299 {
		// Prefer the envelope detail when the error body is one.
		var env envelope
		if json.Unmarshal(b, &env) == nil && env.RetCode != 0 {
			return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode,
				Detail: fmt.Sprintf("retCode %d: %s", env.RetCode, env.RetMsg)}
		}
		return &HardError{Kind: "status", URL: url, Status: r.StatusCode,
			Detail: preview(body)}
	}
	var env envelope
	if err := json.Unmarshal(b, &env); err != nil {
		return &HardError{Kind: "shape", URL: url, Status: r.StatusCode, Detail: err.Error()}
	}
	if env.RetCode != 0 {
		return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode,
			Detail: fmt.Sprintf("retCode %d: %s", env.RetCode, env.RetMsg)}
	}
	if len(env.Result) == 0 {
		return &HardError{Kind: "shape", URL: url, Status: r.StatusCode, Detail: "envelope missing result"}
	}
	if err := json.Unmarshal(env.Result, v); err != nil {
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

// ms parses a Bybit millisecond epoch. The v5 market endpoints carry
// timestamps as STRINGS ("1670604000000"); ticker JSON mixes in numbers.
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

// intervals is the platform timeframe -> Bybit v5 interval string. Bybit
// spells minutes/hours as bare numbers and days as D, with an extra 60d
// monthly frame the platform has no timeframe for.
var intervals = map[string]string{
	"1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
	"1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
	"1d": "D", "1w": "W", "1M": "M",
}

// intervalMs is each Bybit interval's length in milliseconds, used to compute
// bar close times: v5 kline rows carry only the open time (start).
var intervalMs = map[string]int64{
	"1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
	"1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "12h": 43_200_000,
	"1d": 86_400_000, "1w": 604_800_000, "1M": 2_592_000_000,
}

// splitSymbol splits a Bybit pair symbol into base/quote against the known
// quote vocabulary. Unknown quotes fall back to the last 4 characters (USDT /
// USDC width), which covers the pairs this adapter registers.
func splitSymbol(sym string) (base, quote string, ok bool) {
	s := strings.TrimSpace(strings.ToUpper(sym))
	for _, q := range []string{"USDT", "USDC", "USD", "DAI", "BTC", "ETH", "EUR", "TRY", "BRL"} {
		if strings.HasSuffix(s, q) && len(s) > len(q) {
			return strings.TrimSuffix(s, q), q, true
		}
	}
	return "", "", false
}
