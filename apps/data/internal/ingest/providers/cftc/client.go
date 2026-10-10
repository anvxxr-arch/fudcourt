package cftc

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
	// Base is the Socrata host serving the CFTC public reports.
	Base = "https://publicreporting.cftc.gov"
	// datasetID is the Legacy Futures Only report's Socrata resource id.
	datasetID = "6dca-aqww"
	// pageSize is the SoQL $limit per backfill page. The full report year is
	// well under this; one page is the common case.
	pageSize = 50000
	// UA is the adapter's User-Agent. Public keyless endpoint, no secrets.
	UA = "fudcourt-data/1.0"
	// defaultTimeout bounds one upstream request; the engine's retries own
	// what happens after.
	defaultTimeout = 60 * time.Second
	// maxBodyBytes bounds one upstream body. With the cotFields $select
	// projection one page of the Legacy Futures Only report is a few MiB;
	// 16 MiB (the other providers' cap) is ample headroom.
	maxBodyBytes = 16 << 20
	// Source is the provider name on every written row.
	Source = "cftc"
	// schemaVersion pins the wire mapping this adapter implements.
	schemaVersion = "1"
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
// Socrata signals failures with statuses (and an HTML or JSON error body);
// there is no success envelope. The engine's breaker keys on the kind.
type HardError struct {
	Kind   string // "transport" | "status" | "shape"
	URL    string
	Status int
	Detail string
}

func (e *HardError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("cftc: %s: HTTP %d: %s", e.Kind, e.Status, e.Detail)
	}
	return fmt.Sprintf("cftc: %s: %s", e.Kind, e.Detail)
}

// getJSON performs one GET and decodes the body into v. A non-2xx is a status
// HardError and a body that does not decode is a shape HardError, never a
// partial decode. The body is buffered IN FULL before any parse: the reader
// caps at maxBodyBytes, and a body that reaches the cap is a loud shape
// error — a capped reader that silently truncates mid-JSON is exactly the
// "unexpected end of JSON input on HTTP 200" this adapter once shipped, so
// truncation can never look like a parse result.
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
	if len(b) >= maxBodyBytes {
		return &HardError{Kind: "shape", URL: url, Status: r.StatusCode,
			Detail: fmt.Sprintf("body reached the %d byte cap; response truncated", maxBodyBytes)}
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

// reportRow is one COT report row (trimmed to the fields the adapter reads).
// Every field is a string on the wire, including the numerics.
type reportRow struct {
	MarketAndExchangeNames string `json:"market_and_exchange_names"`
	ReportDate             string `json:"report_date_as_yyyy_mm_dd"`
	ContractMarketCode     string `json:"cftc_contract_market_code"`
	OpenInterestAll        string `json:"open_interest_all"`
	NoncommLongAll         string `json:"noncomm_positions_long_all"`
	NoncommShortAll        string `json:"noncomm_positions_short_all"`
	CommLongAll            string `json:"comm_positions_long_all"`
	CommShortAll           string `json:"comm_positions_short_all"`
}

// contractAssets maps the COT contract names this adapter tracks to canonical
// asset symbols. GOLD/WHEAT/CRUDE OIL are the report's own name spellings
// (matched on the market_and_exchange_names prefix, uppercased); BTC/ETH are
// the CFTC's crypto derivatives names ("BITCOIN - CBOE ..."). An unlisted
// contract mints no series: the row is counted, never guessed.
var contractAssets = []struct {
	// prefix matches uppercased market_and_exchange_names from the start.
	prefix string
	// symbol is the canonical asset symbol the series subject carries.
	symbol string
}{
	{"GOLD", "XAU"},
	{"WHEAT", "WHEAT"},
	{"CRUDE OIL", "WTI"},
	{"BTC", "BTC"},
	{"ETH", "ETH"},
}

// metrics is the report field -> positioning metric spelling, in the order
// observations are built for one row.
var metrics = []struct {
	field  func(reportRow) string
	metric string
}{
	{func(r reportRow) string { return r.NoncommLongAll }, "cot_noncomm_long"},
	{func(r reportRow) string { return r.NoncommShortAll }, "cot_noncomm_short"},
	{func(r reportRow) string { return r.CommLongAll }, "cot_comm_long"},
	{func(r reportRow) string { return r.CommShortAll }, "cot_comm_short"},
	{func(r reportRow) string { return r.OpenInterestAll }, "cot_open_interest"},
}

// assetKinds is the canonical AssetKind per tracked symbol. XAU/WTI are
// commodity units the reference tree does not pin, so they mint as "other";
// BTC/ETH keep the reference kinds (native) so their asset ids stay stable.
var assetKinds = map[string]canon.AssetKind{
	"XAU":   canon.AssetOther,
	"WHEAT": canon.AssetOther,
	"WTI":   canon.AssetOther,
	"BTC":   canon.AssetNative,
	"ETH":   canon.AssetNative,
}

// assetID mints the canonical asset id for a tracked symbol.
func assetID(symbol string) string {
	return canon.MintID(canon.KindAsset, canon.AssetKey(assetKinds[symbol], symbol))
}

// resolveAsset maps a COT contract name to its tracked canonical symbol; ok
// is false for contracts outside the tracked list.
func resolveAsset(marketAndExchangeNames string) (symbol string, ok bool) {
	name := strings.ToUpper(strings.TrimSpace(marketAndExchangeNames))
	for _, m := range contractAssets {
		if strings.HasPrefix(name, m.prefix) {
			return m.symbol, true
		}
	}
	return "", false
}

// parseDate parses the report week. The wire carries
// "2022-09-13T00:00:00.000" (Socrata's floating-time rendering of a date);
// the fractional digit count is not fixed, so the layouts are tried first and
// a trailing time-of-day is stripped as the last resort — the report week is
// a calendar date, and any spelling that yields that date parses.
func parseDate(s string) (time.Time, bool) {
	for _, layout := range []string{"2006-01-02T15:04:05.000", "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			// Go's Parse accepts a longer fraction than the layout's ".000"
			// spells and keeps it; the report week is a calendar date, so the
			// result is truncated to the UTC day before returning.
			return t.UTC().Truncate(24 * time.Hour), true
		}
	}
	if i := strings.IndexByte(s, 'T'); i > 0 {
		if t, err := time.Parse("2006-01-02", s[:i]); err == nil {
			return t.UTC().Truncate(24 * time.Hour), true
		}
	}
	return time.Time{}, false
}

// parseI64 parses one numeric COT field. Absent or unparseable stays absent:
// the caller writes a nil value, never a zero (never-fake).
func parseI64(s string) (*float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, false
	}
	x, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil, false
	}
	return &x, true
}

// period spells the observation period key: the report week's UTC calendar
// day, the ISO date the CFTC itself publishes the report under.
func period(t time.Time) string {
	return t.Format("2006-01-02")
}
