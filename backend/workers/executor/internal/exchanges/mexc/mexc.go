// Package mexc is a structurally complete, stdlib-only REST adapter for the
// MEXC exchange — both the spot request form and the contract request form —
// driven entirely through the injectable exchanges.HTTPClient seam so tests
// exercise every code path against fixture responses without network access.
//
// The adapter absorbs every MEXC wire difference (underscored symbols,
// envelope shapes, order-status names, contract numeric request codes,
// honest-unreported figures) behind the canonical exchanges.Exchange
// interface; venue conditionals never leave this package.
//
// Wire-format honesty: MEXC's exact REST wire formats are not verifiable from
// this repository (no live calls in CI), so every uncertain wire detail is
// documented on the symbol that uses it as an `ASSUMPTION:` comment. The two
// signing variants are no exception: this adapter implements exactly one —
// the documented header variant, hex(HMAC-SHA256(secret, apiKey+timestampMs))
// carried in request headers (see sign.go) — and the `paramTime`/query-string
// signing variant is NOT implemented.
//
// All money and quantity values travel as decimal strings (exact literals
// preserved from the venue JSON, never routed through float64); computed sums
// use the internal/platform/decimal package (objective §36).
package mexc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// digestPattern matches hex digest tokens (an HMAC-SHA256 signature is 64
// hex chars) so a venue error message that reflects signature material back
// is redacted exactly like credential text (PRD §109).
var digestPattern = regexp.MustCompile(`(?i)\b[a-f0-9]{32,}\b`)

// DefaultBaseURL is the MEXC API host this adapter assumes serves BOTH the
// spot (`/api/v3/...`) and the contract (`/api/v1/contract/...`) request
// forms.
//
// ASSUMPTION: host names for spot vs contract — MEXC deployments are also
// documented with a separate contract host (contract.mexc.com); this adapter
// keeps one BaseURL per instance and routes the two request forms under it,
// which is also what the configurable BaseURL seam is for.
const DefaultBaseURL = "https://api.mexc.com"

// Request-path constants. Every path is an ASSUMPTION: the exact MEXC REST
// paths are not verifiable from this repository, so the assumed form is
// recorded here honestly instead of pretended to be oracle-verified. The
// split is structural — spot paths below `spotAPI`, contract paths below
// `contractAPI` — and each Exchange method documents which form it uses.
const (
	spotAPI     = "/api/v3"
	contractAPI = "/api/v1/contract"

	// pathSpotAccount is the signed spot account/key read. ASSUMPTION: it
	// doubles as the credential probe and the spot balance source.
	pathSpotAccount = spotAPI + "/account"
	// pathSpotTicker is the public spot ticker (bid/ask/last). ASSUMPTION.
	pathSpotTicker = spotAPI + "/ticker/24hr"
	// pathSpotOrder places, fetches and cancels one spot order. ASSUMPTION:
	// POST places, GET fetches, DELETE cancels, all keyed by orderId+symbol.
	pathSpotOrder = spotAPI + "/order"
	// pathSpotOpenOrders lists open spot orders. ASSUMPTION.
	pathSpotOpenOrders = spotAPI + "/openOrders"
	// pathSpotMyTrades lists spot fills. ASSUMPTION.
	pathSpotMyTrades = spotAPI + "/myTrades"

	// pathContractAssets is the signed contract asset list, used as both the
	// perp credential probe and the perp balance source. ASSUMPTION.
	pathContractAssets = contractAPI + "/assets"
	// pathContractPosition is the contract position read; the venue symbol is
	// appended as a path segment. ASSUMPTION.
	pathContractPosition = contractAPI + "/position/"
	// pathContractTicker is the public contract ticker. ASSUMPTION.
	pathContractTicker = contractAPI + "/ticker"
	// pathContractSubmit places one contract order (the "submit" form).
	// ASSUMPTION.
	pathContractSubmit = contractAPI + "/submit"
	// pathContractCancel cancels one contract order. ASSUMPTION.
	pathContractCancel = contractAPI + "/cancel"
	// pathContractOrder fetches one contract order. ASSUMPTION.
	pathContractOrder = contractAPI + "/order"
	// pathContractOpenOrders lists open contract orders. ASSUMPTION.
	pathContractOpenOrders = contractAPI + "/openOrders"
	// pathContractFills lists contract fills. ASSUMPTION.
	pathContractFills = contractAPI + "/fills"
)

// Named refusal errors from New and the request entry points. Each is a
// NAMED error so callers can refuse invalid configuration/input instead of
// guessing (house rule).
var (
	// ErrMissingCredentials is returned by New when the credential handle is
	// incomplete: an adapter without both APIKey and APISecret cannot sign a
	// request and must never be constructed half-configured.
	ErrMissingCredentials = errors.New("mexc: config needs a non-empty Credentials.APIKey and Credentials.APISecret")
	// ErrMissingHTTPClient is returned by New when the HTTP client seam is
	// nil: every request goes through the injectable client, so there is no
	// silent default inside the adapter.
	ErrMissingHTTPClient = errors.New("mexc: config needs a non-nil HTTP client")
	// ErrInvalidMarketType is returned by New for a market type that is not
	// spot or linear_perp — the adapter never guesses which request form an
	// unknown market type should use.
	ErrInvalidMarketType = errors.New("mexc: market type must be spot or linear_perp")
	// ErrInvalidBaseURL is returned by New for a BaseURL that is not an
	// absolute http(s) URL.
	ErrInvalidBaseURL = errors.New("mexc: base URL must be an absolute http(s) URL")
	// ErrNilContext is returned by the request entry points when the caller
	// passes a nil context (refused, never dereferenced).
	ErrNilContext = errors.New("mexc: nil context")
)

// errNoOrderID marks a venue response that parsed but carried no venue order
// id: for GET/cancel that honestly means the venue does not know the order
// (mapped to exchanges.ErrOrderNotFound), for placement it is a malformed ack.
var errNoOrderID = errors.New("mexc: venue payload carries no order id")

// errMalformedPayload marks a venue response whose JSON shape does not carry
// the fields this adapter needs. It is rendered only as a short constant
// reason — never the raw body.
var errMalformedPayload = errors.New("mexc: malformed venue payload")

// Config is the adapter configuration. The HTTP and Clock seams are
// injectable so tests drive fixture responses with pinned timestamps (no
// network, deterministic signing).
type Config struct {
	// Credentials is the signing handle (the secret is used only inside
	// Sign and never rendered anywhere).
	Credentials exchanges.Credentials
	// HTTP executes requests; nil is refused (ErrMissingHTTPClient).
	HTTP exchanges.HTTPClient
	// Clock supplies signing timestamps; nil falls back to
	// exchanges.SystemClock.
	Clock exchanges.Clock
	// MarketType selects the request form: MarketSpot uses the spot REST
	// form, MarketLinearPerp uses the contract request form. Anything else
	// is refused (ErrInvalidMarketType).
	MarketType execution.MarketType
	// BaseURL overrides DefaultBaseURL — default https://api.mexc.com,
	// ASSUMPTION on host names for spot vs contract (see DefaultBaseURL).
	// Trailing slashes are trimmed; a non-empty value must be an absolute
	// http(s) URL (ErrInvalidBaseURL).
	BaseURL string
}

// MEXC is the MEXC adapter (spot + contract request forms). It is safe for
// concurrent use once constructed: it holds only immutable configuration and
// the injected seams.
type MEXC struct {
	creds exchanges.Credentials
	http  exchanges.HTTPClient
	clock exchanges.Clock
	mkt   execution.MarketType
	base  string
}

// New builds a MEXC adapter, refusing incomplete credentials (ErrMissing
// Credentials), a nil HTTP seam (ErrMissingHTTPClient), an unknown market
// type (ErrInvalidMarketType) and a malformed BaseURL (ErrInvalidBaseURL).
func New(cfg Config) (*MEXC, error) {
	if cfg.Credentials.APIKey == "" || cfg.Credentials.APISecret == "" {
		return nil, ErrMissingCredentials
	}
	if cfg.HTTP == nil {
		return nil, ErrMissingHTTPClient
	}
	if cfg.MarketType != execution.MarketSpot && cfg.MarketType != execution.MarketLinearPerp {
		return nil, ErrInvalidMarketType
	}
	base := DefaultBaseURL
	if cfg.BaseURL != "" {
		u, err := url.Parse(cfg.BaseURL)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, ErrInvalidBaseURL
		}
		base = strings.TrimRight(cfg.BaseURL, "/")
	}
	clk := cfg.Clock
	if clk == nil {
		clk = exchanges.SystemClock{}
	}
	return &MEXC{creds: cfg.Credentials, http: cfg.HTTP, clock: clk, mkt: cfg.MarketType, base: base}, nil
}

// Compile-time proof that MEXC satisfies the canonical venue boundary.
var _ exchanges.Exchange = (*MEXC)(nil)

// GetAccount runs a signed account/key read and returns the credential view.
//
// MEXC does not report key-restriction flags, so AccountPermissions.SpotTrade,
// AccountPermissions.FuturesTrade and AccountPermissions.Withdraw are ALWAYS
// nil — never inferred true or false (house-rule honest nulls; this is the
// repo's named example). Read is true only after a successful signed read
// (which proves read). Health is HealthActive on success; on failure the
// returned metadata carries the probe verdict
// exchanges.CredentialHealthForValidation (mirroring exchange.ts
// validateCredentials) alongside the error so the caller can persist it.
//
// Paths: spot → GET /api/v3/account (signed); linear_perp → GET
// /api/v1/contract/assets (signed).
func (m *MEXC) GetAccount(ctx context.Context) (execution.AccountMetadata, error) {
	masked := exchanges.MaskAPIKey(m.creds.APIKey)
	accountType := string(m.mkt)
	meta := execution.AccountMetadata{
		Exchange:     execution.ExchangeMEXC,
		Label:        nil, // MEXC does not report an account label — honest nil.
		AccountType:  &accountType,
		Permissions:  execution.AccountPermissions{Read: false, SpotTrade: nil, FuturesTrade: nil, Withdraw: nil},
		Health:       execution.HealthUnknown,
		APIKeyMasked: &masked,
	}
	if m.mkt == execution.MarketSpot {
		_, _, err := m.do(ctx, "get account", http.MethodGet, pathSpotAccount, nil, true)
		if err != nil {
			meta.Health = exchanges.CredentialHealthForValidation(exchanges.Classify(err))
			return meta, err
		}
	} else {
		_, _, err := m.do(ctx, "get account", http.MethodGet, pathContractAssets, nil, true)
		if err != nil {
			meta.Health = exchanges.CredentialHealthForValidation(exchanges.Classify(err))
			return meta, err
		}
	}
	// The successful signed read proves read and nothing else: trade and
	// withdraw capability are NOT reported by MEXC and stay nil.
	meta.Permissions.Read = true
	meta.Health = execution.HealthActive
	return meta, nil
}

// GetBalance returns the account equity snapshot as exact decimal strings.
//
// Spot equity and futures equity are mutually exclusive here: the configured
// MarketType selects the balance source and only that basis is filled — the
// other stays nil (honest null: this call reports one account type only).
// TotalEquity is the same exact sum as the filled basis (TS getAccountEquity
// parity: totalEquity = typeEquity). When the venue reports no balances at
// all, every figure is nil — an empty list is "nothing reported", never a
// fabricated zero (TS equityOf([]) → null).
//
// Paths: spot → GET /api/v3/account (signed, `balances` rows); linear_perp →
// GET /api/v1/contract/assets (signed, asset rows).
func (m *MEXC) GetBalance(ctx context.Context) (execution.AccountEquity, error) {
	eq := execution.AccountEquity{Timestamp: m.clock.Now()}
	var payload json.RawMessage
	var err error
	if m.mkt == execution.MarketSpot {
		payload, _, err = m.do(ctx, "get balance", http.MethodGet, pathSpotAccount, nil, true)
	} else {
		payload, _, err = m.do(ctx, "get balance", http.MethodGet, pathContractAssets, nil, true)
	}
	if err != nil {
		return eq, err
	}
	rows, sum, err := parseBalances(payload, m.mkt)
	if err != nil {
		return eq, m.malformed("get balance")
	}
	eq.Balances = rows
	if sum != nil {
		eq.SpotEquity = sum
		eq.TotalEquity = sum
		if m.mkt != execution.MarketSpot {
			eq.SpotEquity = nil
			eq.FuturesEquity = sum
		}
	}
	return eq, nil
}

// GetPosition returns the contract position on symbol, or ErrNoPosition when
// the account is flat (flat is an answer, a failed fetch is an error — never
// conflated). Spot has no positions at all and answers ErrNoPosition without
// touching the network.
//
// Path (linear_perp only): GET /api/v1/contract/position/<venue-symbol>
// (signed).
func (m *MEXC) GetPosition(ctx context.Context, symbol string) (execution.Position, error) {
	if m.mkt == execution.MarketSpot {
		return execution.Position{}, exchanges.ErrNoPosition
	}
	venueSym, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeMEXC)
	if err != nil {
		return execution.Position{}, err
	}
	payload, _, err := m.do(ctx, "get position", http.MethodGet, pathContractPosition+venueSym, nil, true)
	if err != nil {
		return execution.Position{}, err
	}
	pos, err := parsePosition(payload, symbol)
	if errors.Is(err, errMalformedPayload) {
		return execution.Position{}, m.malformed("get position")
	}
	return pos, err
}

// GetTicker returns the current ticker. Bid/Ask/Last are honest nils when the
// venue reports an empty or absent touch — a last-only ticker is never turned
// into a fabricated touch price (house rule).
//
// Paths (public, unsigned): spot → GET /api/v3/ticker/24hr?symbol=;
// linear_perp → GET /api/v1/contract/ticker?symbol=.
func (m *MEXC) GetTicker(ctx context.Context, symbol string) (execution.Ticker, error) {
	venueSym, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeMEXC)
	if err != nil {
		return execution.Ticker{}, err
	}
	path := pathSpotTicker
	if m.mkt != execution.MarketSpot {
		path = pathContractTicker
	}
	payload, _, err := m.do(ctx, "get ticker", http.MethodGet, path, url.Values{"symbol": {venueSym}}, false)
	if err != nil {
		return execution.Ticker{}, err
	}
	tick, err := parseTicker(payload, symbol, m.clock.Now())
	if errors.Is(err, errMalformedPayload) {
		return execution.Ticker{}, m.malformed("get ticker")
	}
	return tick, err
}

// CreateOrder places one order idempotently: req.ClientOrderID is sent as the
// venue's client-order-id field, which is what makes a resubmit a no-op at
// the venue (objective §23). Malformed requests are refused with the named
// exchanges.ErrInvalidOrder (or the symbol sentinels) before any network I/O.
//
// Request forms (ASSUMPTION on every wire name below):
//   - spot → POST /api/v3/order, form fields symbol, side (BUY/SELL), type
//     (LIMIT/MARKET), quantity, price (limit only), timeInForce (sent only
//     when set; the venue default applies otherwise), clientOrderId (the
//     idempotency field — some MEXC spot docs call it newClientOrderId; this
//     adapter sends clientOrderId).
//   - linear_perp → POST /api/v1/contract/submit, the assumed contract
//     category-1/2 form: vol=quantity, side as numeric open/close codes
//     (1=open long, 2=close short, 3=open short, 4=close long — a reduce-only
//     order uses the close codes 2/4), type (5=limit, 6=market), openType as
//     the margin-category field (1=isolated, 2=cross; this adapter sends
//     category 2, cross), price (limit only), clientOrderId. Leverage is NOT
//     sent per order — the contract form takes it from the account's leverage
//     setting.
func (m *MEXC) CreateOrder(ctx context.Context, req execution.OrderRequest) (execution.NormalizedOrder, error) {
	if err := validateOrderRequest(req); err != nil {
		return execution.NormalizedOrder{}, err
	}
	venueSym, err := exchanges.ToVenueSymbol(req.Symbol, execution.ExchangeMEXC)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	form := url.Values{}
	var path string
	if m.mkt == execution.MarketSpot {
		path = pathSpotOrder
		side, orderType, tif := wireSpotOrderFields(req)
		form.Set("symbol", venueSym)
		form.Set("side", side)
		form.Set("type", orderType)
		form.Set("quantity", req.Quantity)
		if req.Price != "" {
			form.Set("price", req.Price)
		}
		if tif != "" {
			form.Set("timeInForce", tif)
		}
		form.Set("clientOrderId", req.ClientOrderID)
	} else {
		path = pathContractSubmit
		form.Set("symbol", venueSym)
		form.Set("vol", req.Quantity)
		form.Set("side", strconv.Itoa(wireContractSide(req)))
		form.Set("type", strconv.Itoa(wireContractOrderType(req)))
		// ASSUMPTION: the category-1/2 openType field, cross margin (2).
		form.Set("openType", strconv.Itoa(contractOpenTypeCross))
		if req.Price != "" {
			form.Set("price", req.Price)
		}
		form.Set("clientOrderId", req.ClientOrderID)
	}
	payload, _, err := m.do(ctx, "create order", http.MethodPost, path, form, true)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	order, err := parseOrder(payload, orderFallback{
		symbol:        req.Symbol,
		side:          req.Side,
		orderType:     req.OrderType,
		quantity:      req.Quantity,
		price:         req.Price,
		clientOrderID: req.ClientOrderID,
		isExit:        req.Intent != execution.IntentOpen,
	})
	if errors.Is(err, errNoOrderID) {
		// A placement ack without a venue order id is unverifiable — refused,
		// never reported as a placed order.
		return execution.NormalizedOrder{}, m.malformed("create order")
	}
	if errors.Is(err, errMalformedPayload) {
		return execution.NormalizedOrder{}, m.malformed("create order")
	}
	if err != nil {
		// Named symbol refusals pass through unwrapped.
		return execution.NormalizedOrder{}, err
	}
	return order, nil
}

// CancelOrder cancels one order by venue order id and returns the venue's
// final view of it. A venue response that knows no such order maps to
// exchanges.ErrOrderNotFound.
//
// Paths: spot → DELETE /api/v3/order (signed, orderId+symbol query);
// linear_perp → POST /api/v1/contract/cancel (signed, orderId+symbol form).
func (m *MEXC) CancelOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	return m.fetchOrCancelOrder(ctx, "cancel order", symbol, exchangeOrderID, true)
}

// GetOrder fetches one order by venue order id. A venue response that knows
// no such order maps to exchanges.ErrOrderNotFound.
//
// Paths: spot → GET /api/v3/order (signed, orderId+symbol query);
// linear_perp → GET /api/v1/contract/order (signed, orderId+symbol query).
func (m *MEXC) GetOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	return m.fetchOrCancelOrder(ctx, "get order", symbol, exchangeOrderID, false)
}

// fetchOrCancelOrder shares the get/cancel request shape: both are keyed by
// (symbol, venue order id) and both parse into the canonical order view.
func (m *MEXC) fetchOrCancelOrder(ctx context.Context, op, symbol, exchangeOrderID string, cancel bool) (execution.NormalizedOrder, error) {
	if ctx == nil {
		return execution.NormalizedOrder{}, ErrNilContext
	}
	venueSym, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeMEXC)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	if exchangeOrderID == "" {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: empty exchange order id", exchanges.ErrInvalidOrder)
	}
	params := url.Values{"orderId": {exchangeOrderID}, "symbol": {venueSym}}
	var payload json.RawMessage
	switch {
	case cancel && m.mkt == execution.MarketSpot:
		payload, _, err = m.do(ctx, op, http.MethodDelete, pathSpotOrder, params, true)
	case cancel:
		payload, _, err = m.do(ctx, op, http.MethodPost, pathContractCancel, params, true)
	case m.mkt == execution.MarketSpot:
		payload, _, err = m.do(ctx, op, http.MethodGet, pathSpotOrder, params, true)
	default:
		payload, _, err = m.do(ctx, op, http.MethodGet, pathContractOrder, params, true)
	}
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	order, err := parseOrder(payload, orderFallback{symbol: symbol})
	if errors.Is(err, errNoOrderID) {
		// The venue answered but names no order — it does not know the id.
		return execution.NormalizedOrder{}, exchanges.ErrOrderNotFound
	}
	if errors.Is(err, errMalformedPayload) {
		return execution.NormalizedOrder{}, m.malformed(op)
	}
	if err != nil {
		// Named symbol refusals (ErrUnknownQuote, ErrInvalidSymbol) pass
		// through unwrapped — they are input refusals, not venue failures.
		return execution.NormalizedOrder{}, err
	}
	return order, nil
}

// GetOpenOrders lists the account's open orders on symbol.
//
// Paths: spot → GET /api/v3/openOrders?symbol= (signed); linear_perp → GET
// /api/v1/contract/openOrders?symbol= (signed).
func (m *MEXC) GetOpenOrders(ctx context.Context, symbol string) ([]execution.NormalizedOrder, error) {
	venueSym, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeMEXC)
	if err != nil {
		return nil, fmt.Errorf("get open orders: %w", err)
	}
	path := pathSpotOpenOrders
	if m.mkt != execution.MarketSpot {
		path = pathContractOpenOrders
	}
	payload, _, err := m.do(ctx, "get open orders", http.MethodGet, path, url.Values{"symbol": {venueSym}}, true)
	if err != nil {
		return nil, fmt.Errorf("get open orders: %w", err)
	}
	items, err := parseOrderList(payload, symbol)
	if errors.Is(err, errMalformedPayload) {
		return nil, m.malformed("get open orders")
	}
	if err != nil {
		return nil, fmt.Errorf("parse open orders: %w", err)
	}
	return items, nil
}

// GetFills lists recent fills on symbol as canonical Fill rows (dedup by
// (account, exchangeTradeId) belongs to the fill store, not this adapter).
// QuoteQuantity is computed exactly (price*quantity) only when the venue does
// not report it (TS getFills parity); Fee defaults to "0" when unreported (TS
// parity) but FeeAsset stays "" when unreported — an asset code is never
// fabricated (honest nulls outrank the TS 'USDT' default).
//
// Paths: spot → GET /api/v3/myTrades?symbol= (signed); linear_perp → GET
// /api/v1/contract/fills?symbol= (signed).
func (m *MEXC) GetFills(ctx context.Context, symbol string) ([]execution.Fill, error) {
	venueSym, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeMEXC)
	if err != nil {
		return nil, fmt.Errorf("get fills: %w", err)
	}
	path := pathSpotMyTrades
	if m.mkt != execution.MarketSpot {
		path = pathContractFills
	}
	payload, _, err := m.do(ctx, "get fills", http.MethodGet, path, url.Values{"symbol": {venueSym}}, true)
	if err != nil {
		return nil, fmt.Errorf("get fills: %w", err)
	}
	fills, err := parseFills(payload, m.clock.Now())
	if err != nil {
		return nil, m.malformed("get fills")
	}
	return fills, nil
}

// do issues one request and returns the unwrapped response payload plus the
// HTTP status. Signed requests carry the header-variant signature produced by
// Sign (see sign.go); the signature, timestamp and API key travel only in
// headers and are never logged, rendered or attached to errors.
//
// Transport failures become exchanges.WrapTransport(network_retryable); venue
// failures become exchanges.NewVenueError with the code-as-string and a
// SANITIZED short message (never the raw envelope).
func (m *MEXC) do(ctx context.Context, op, method, path string, params url.Values, signed bool) (json.RawMessage, int, error) {
	if ctx == nil {
		return nil, 0, ErrNilContext
	}
	u := m.base + path
	var body io.Reader
	if method == http.MethodPost {
		body = strings.NewReader(params.Encode())
	} else {
		u += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, 0, exchanges.WrapTransport(execution.ExchangeMEXC, exchanges.ClassificationFor(execution.ErrNetworkRetryable), op, err)
	}
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if signed {
		ts := strconv.FormatInt(m.clock.Now(), 10)
		req.Header.Set("X-MEXC-APIKEY", m.creds.APIKey)
		req.Header.Set("X-MEXC-TIMESTAMP", ts)
		req.Header.Set("X-MEXC-SIGNATURE", Sign(m.creds.APISecret, m.creds.APIKey, ts))
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return nil, 0, exchanges.WrapTransport(execution.ExchangeMEXC, exchanges.ClassificationFor(execution.ErrNetworkRetryable), op, err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		return nil, resp.StatusCode, exchanges.WrapTransport(execution.ExchangeMEXC, exchanges.ClassificationFor(execution.ErrNetworkRetryable), op, err)
	}
	bodyBytes := buf.Bytes()
	if code, msg, ok := parseAPIError(bodyBytes, resp.StatusCode); ok {
		return nil, resp.StatusCode, exchanges.NewVenueError(execution.ExchangeMEXC, code, resp.StatusCode, m.sanitize(msg))
	}
	return unwrapData(bodyBytes), resp.StatusCode, nil
}

// parseAPIError recognizes the MEXC error envelope.
//
// ASSUMPTION: the envelope field names are `code` (number or string) and
// `msg` (string) — the MEXC error convention (verified only from the TS
// mapError contract, which stringifies err.code; the raw field names are not
// verifiable from this repository). An envelope qualifies when the contract
// form reports `success:false`, or when it carries a `code` with no non-null
// `data` member and either a non-2xx status or a code outside {"0","200"}
// with a msg (venues do answer 200 with business errors).
func parseAPIError(body []byte, status int) (code, msg string, ok bool) {
	if obj, isObj := asObject(body); isObj {
		code, _ = fieldStr(obj, "code")
		msg, _ = fieldStr(obj, "msg")
		if successRaw, has := obj["success"]; has {
			var success bool
			if err := json.Unmarshal(successRaw, &success); err == nil && !success {
				return code, msg, true
			}
		}
		hasData := false
		if d, has := obj["data"]; has {
			t := bytes.TrimSpace(d)
			hasData = len(t) > 0 && string(t) != "null"
		}
		_, hasCode := obj["code"]
		if hasCode && !hasData {
			if status < 200 || status >= 300 || (msg != "" && code != "0" && code != "200") {
				return code, msg, true
			}
		}
	}
	if status < 200 || status >= 300 {
		return "", "", true
	}
	return "", "", false
}

// malformed wraps a shape-level parse failure as a short, body-free
// VenueError: the raw response never reaches the message.
func (m *MEXC) malformed(op string) error {
	return exchanges.NewVenueError(execution.ExchangeMEXC, "", 0, "malformed venue response during "+op)
}

// sanitize renders a venue message safe for logs and errors (PRD §109): any
// credential material that a venue echoed back — the API key, the secret, or
// a hex signature/digest the venue may have reflected — is redacted, and the
// message is capped so an accidental raw-envelope echo cannot ride along.
func (m *MEXC) sanitize(msg string) string {
	const maxLen = 160
	for _, secret := range []string{m.creds.APIKey, m.creds.APISecret} {
		if secret != "" {
			msg = strings.ReplaceAll(msg, secret, "[REDACTED]")
		}
	}
	msg = digestPattern.ReplaceAllString(msg, "[REDACTED]")
	runes := []rune(msg)
	if len(runes) > maxLen {
		msg = string(runes[:maxLen]) + "..."
	}
	return msg
}

// validateOrderRequest refuses malformed order instructions with the named
// exchanges.ErrInvalidOrder before any request is built — an invalid request
// is never guessed into a wire form.
func validateOrderRequest(req execution.OrderRequest) error {
	if req.ClientOrderID == "" {
		return fmt.Errorf("%w: client order id is required for venue-side idempotency", exchanges.ErrInvalidOrder)
	}
	if req.Side != execution.SideBuy && req.Side != execution.SideSell {
		return fmt.Errorf("%w: unknown side %q", exchanges.ErrInvalidOrder, req.Side)
	}
	if req.OrderType != "market" && req.OrderType != "limit" {
		return fmt.Errorf("%w: unknown order type %q", exchanges.ErrInvalidOrder, req.OrderType)
	}
	if err := positiveDecimal(req.Quantity, "quantity"); err != nil {
		return fmt.Errorf("validate order request: %w", err)
	}
	if req.OrderType == "limit" {
		if err := positiveDecimal(req.Price, "price"); err != nil {
			return fmt.Errorf("validate order request: %w", err)
		}
	} else if req.Price != "" {
		return fmt.Errorf("%w: market orders must not carry a price", exchanges.ErrInvalidOrder)
	}
	switch req.TimeInForce {
	case execution.TIFGTC, execution.TIFIOC, execution.TIFFOK, "":
		// "" means "venue default": the TIF field is simply not sent.
	default:
		return fmt.Errorf("%w: unknown time in force %q", exchanges.ErrInvalidOrder, req.TimeInForce)
	}
	return nil
}

// positiveDecimal refuses a money/quantity field that is not a strictly
// positive exact decimal (internal/platform/decimal — big.Rat, never float64).
func positiveDecimal(v, name string) error {
	if v == "" {
		return fmt.Errorf("%w: %s is required", exchanges.ErrInvalidOrder, name)
	}
	r, err := decimal.Parse(v)
	if err != nil || r.Sign() <= 0 {
		return fmt.Errorf("%w: %s is not a positive decimal", exchanges.ErrInvalidOrder, name)
	}
	return nil
}

// GetMarkets is NOT implemented for this adapter yet: the venue's instrument
// list (precision, min notional, leverage brackets) is not parsed here, and the
// executor API's planner path refuses a venue it cannot read a grid for rather
// than fabricating one. Returning a named refusal keeps the failure honest and
// fail-closed; implementing it means porting exchange.ts getMarkets for this
// venue. See the executor API's planContext.
func (m *MEXC) GetMarkets(context.Context) ([]exchanges.Market, error) {
	return nil, exchanges.ErrMarketsUnavailable
}

// GetFees is NOT implemented for this adapter yet (same reason as GetMarkets):
// the per-symbol fee schedule is not parsed. See the executor API's planContext.
func (m *MEXC) GetFees(context.Context, string) (exchanges.FeeModel, error) {
	return exchanges.FeeModel{}, exchanges.ErrFeesUnavailable
}
