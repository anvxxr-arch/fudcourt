package okx

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
	// Base is the public market-data host.
	Base = "https://www.okx.com"
	// UA is the adapter's User-Agent. Public keyless endpoints, no secrets.
	UA = "fudcourt-data/1.0"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 30 * time.Second
	// maxBodyBytes bounds one upstream body. The widest response here is
	// the full-market tickers listing; 16 MiB is ample headroom.
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
		return fmt.Sprintf("okx: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("okx: %s: %s", e.Kind, e.Detail)
}

// envelope is the OKX response wrapper. code "0" means success; any other
// value (on any HTTP status) is an API error. data stays raw so each fetcher
// decodes its own payload shape.
type envelope struct {
	Code string          `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

// getJSON performs one GET, unwraps the envelope, and decodes data into v.
// OKX answers {"code":"1","msg":"...","data":[]} both on non-200 statuses and
// on 200; both are HardErrors, never a partial decode.
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
		if json.Unmarshal(b, &env) == nil && env.Code != "" && env.Code != "0" {
			return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode,
				Detail: fmt.Sprintf("code %s: %s", env.Code, env.Msg)}
		}
		return &HardError{Kind: "status", URL: url, Status: r.StatusCode,
			Detail: preview(body)}
	}
	var env envelope
	if err := json.Unmarshal(b, &env); err != nil {
		return &HardError{Kind: "shape", URL: url, Status: r.StatusCode, Detail: err.Error()}
	}
	if env.Code != "0" {
		return &HardError{Kind: "api-error", URL: url, Status: r.StatusCode,
			Detail: fmt.Sprintf("code %s: %s", env.Code, env.Msg)}
	}
	if len(env.Data) == 0 {
		return &HardError{Kind: "shape", URL: url, Status: r.StatusCode, Detail: "envelope missing data"}
	}
	if err := json.Unmarshal(env.Data, v); err != nil {
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

// ms parses an OKX millisecond epoch. The wire carries timestamps as STRINGS
// everywhere ("ts":"1707163200000"); the array-of-arrays candle rows too.
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

// bars is the platform timeframe -> OKX bar string. OKX spells minutes as
// <n>m, hours as <n>H, days as <n>Dutc and months as <n>M (calendar month);
// 1M and 1m differ by case, which canon.ValidateTimeframe treats as distinct.
var bars = map[string]string{
	"1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
	"1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H",
	"1d": "1Dutc", "1w": "1Wutc", "1M": "1M",
}

// barMs is each OKX bar's length in milliseconds, used to compute candle
// close times: v5 candle rows carry only the open time (ts).
var barMs = map[string]int64{
	"1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
	"1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "12h": 43_200_000,
	"1d": 86_400_000, "1w": 604_800_000, "1M": 2_592_000_000,
}

// splitInstID splits an OKX instrument id into base/quote. SPOT ids are
// BTC-USDT; SWAP ids carry the -SWAP suffix (BTC-USDT-SWAP), which is peeled
// before the pair split. Unknown quotes fall back to the last dash segment.
func splitInstID(instID string) (base, quote string, ok bool) {
	s := strings.TrimSpace(strings.ToUpper(instID))
	s = strings.TrimSuffix(s, "-SWAP")
	for _, q := range []string{"USDT", "USDC", "USD", "BTC", "ETH", "DAI"} {
		if strings.HasSuffix(s, "-"+q) && len(s) > len(q)+1 {
			return strings.TrimSuffix(s, "-"+q), q, true
		}
	}
	return "", "", false
}

// hasPrefixFold is a case-insensitive strings.HasPrefix.
func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && lowerASCII(s[:len(prefix)]) == lowerASCII(prefix)
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

// subjectInstID strips the optional market prefix from a job subject and
// returns the OKX instrument id: "spot:BTC-USDT" -> "BTC-USDT",
// "linear_perp:BTC-USDT" -> "BTC-USDT-SWAP". A bare subject is the instId
// verbatim (SPOT ids carry no suffix; SWAP subjects must spell it).
func subjectInstID(subject string) string {
	if hasPrefixFold(subject, "linear_perp:") {
		id := subject[len("linear_perp:"):]
		if !strings.HasSuffix(strings.ToUpper(id), "-SWAP") {
			id += "-SWAP"
		}
		return id
	}
	if hasPrefixFold(subject, "spot:") {
		return subject[len("spot:"):]
	}
	return subject
}

// subjectIsPerp reports whether a job subject encodes the SWAP market: the
// prefixed form "linear_perp:BTC-USDT", the bare market name "linear_perp"
// (instruments), or a verbatim SWAP id.
func subjectIsPerp(subject string) bool {
	return strings.EqualFold(subject, "linear_perp") || hasPrefixFold(subject, "linear_perp:") ||
		strings.HasSuffix(strings.ToUpper(subject), "-SWAP")
}
