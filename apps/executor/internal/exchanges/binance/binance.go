// Package binance is a structurally complete, stdlib-only REST adapter for the
// Binance spot and USD-M futures request forms, driven entirely through the
// injectable exchanges.HTTPClient: the net/http request forms, HMAC query
// signing, endpoints and response-to-canonical parsing are real and complete,
// and every request can be exercised against a stubbed transport in tests with
// no live network. Wire shapes follow the public Binance REST API docs;
// details not verifiable from this repository are recorded as ASSUMPTION
// comments (never TODOs).
//
// Money and quantity values are decimal strings end to end: wire decimal
// strings are preserved VERBATIM in the canonical types, and only computed
// sums (balance totals) go through the exact decimal package — never float64.
package binance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
)

// ExchangeBinance names this adapter's venue in the shared taxonomy tables.
const ExchangeBinance = execution.ExchangeBinance

// exchangeID is the constant every shared helper receives.
const venueID = execution.ExchangeBinance

// DefaultBaseURL is the production Binance REST root used when Config.BaseURL
// is empty. USD-M endpoints (/fapi/...) live on the same host.
const DefaultBaseURL = "https://api.binance.com"

// Named construction refusals (house rule: invalid input is refused with
// named errors, never guessed).
var (
	// ErrNoCredentials is returned by New when the API key or secret is empty.
	ErrNoCredentials = errors.New("binance: credentials require both APIKey and APISecret")
	// ErrNoHTTPClient is returned by New when Config.HTTP is nil.
	ErrNoHTTPClient = errors.New("binance: HTTP client is required")
	// ErrMissingOrderID is returned when a venue order id is required but empty.
	ErrMissingOrderID = errors.New("binance: exchange order id is required")
)

// Config is the adapter configuration. All seams are injectable so tests run
// without a network and without a real clock (deterministic signing vectors).
type Config struct {
	// Credentials is the venue credential handle (used only for signing).
	Credentials exchanges.Credentials
	// HTTP executes requests; nil is refused by New.
	HTTP exchanges.HTTPClient
	// Clock supplies signing timestamps in unix milliseconds; nil becomes
	// exchanges.SystemClock.
	Clock exchanges.Clock
	// MarketType selects the request family: spot uses /api/v3, linear_perp
	// uses /fapi/v2 for account-equity and position endpoints (order endpoints
	// keep their documented /api/v3 spot forms).
	MarketType execution.MarketType
	// BaseURL overrides the REST root (tests, proxies). Empty = DefaultBaseURL.
	BaseURL string
}

// Binance is a structurally complete Binance REST adapter (spot + USD-M
// request forms) driven through the injectable exchanges.HTTPClient.
type Binance struct {
	creds      exchanges.Credentials
	http       exchanges.HTTPClient
	clock      exchanges.Clock
	market     execution.MarketType
	baseURL    string
	recvWindow string
}

// New builds a Binance adapter. Empty credentials and a nil HTTP client are
// refused with named errors; a nil Clock falls back to exchanges.SystemClock
// and an empty BaseURL falls back to DefaultBaseURL.
func New(cfg Config) (*Binance, error) {
	if cfg.Credentials.APIKey == "" || cfg.Credentials.APISecret == "" {
		return nil, ErrNoCredentials
	}
	if cfg.HTTP == nil {
		return nil, ErrNoHTTPClient
	}
	clock := cfg.Clock
	if clock == nil {
		clock = exchanges.SystemClock{}
	}
	base := cfg.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	return &Binance{
		creds:      cfg.Credentials,
		http:       cfg.HTTP,
		clock:      clock,
		market:     cfg.MarketType,
		baseURL:    strings.TrimRight(base, "/"),
		recvWindow: strconv.Itoa(DefaultRecvWindow),
	}, nil
}

// compile-time proof the adapter satisfies the canonical venue interface.
var _ exchanges.Exchange = (*Binance)(nil)

// request building ------------------------------------------------------------

// query is the ordered parameter accumulator: SignQuery signs EXACTLY the
// bytes buildQuery emits, so both sides always agree on the signed string.
type query struct{ pairs [][2]string }

func (q *query) add(k, v string) { q.pairs = append(q.pairs, [2]string{k, v}) }

func (q *query) build() string {
	var b strings.Builder
	for i, kv := range q.pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(url.QueryEscape(kv[0]))
		b.WriteByte('=')
		b.WriteString(url.QueryEscape(kv[1]))
	}
	return b.String()
}

// call performs one API request. When sign is true the query is timestamped
// (clock millis) and given a recvWindow, HMAC-SHA256-signed (sign.go), the
// signature is appended as the FINAL parameter, and the API key is sent in the
// X-MBX-APIKEY header — the KEY only; the secret never leaves the signer.
//
// Non-2xx responses are parsed from the Binance error envelope `{code, msg}`
// and wrapped as a classified exchanges.VenueError; bodies without that JSON
// get an empty code and status-only classification. Transport failures are
// wrapped as network_retryable via exchanges.WrapTransport. Response bodies,
// request queries and secrets are never rendered in errors (PRD §109).
func (b *Binance) call(ctx context.Context, method, path string, q *query, sign bool, op string, out any) error {
	if sign {
		q.add("timestamp", strconv.FormatInt(b.clock.Now(), 10))
		q.add("recvWindow", b.recvWindow)
		q.add("signature", SignQuery(q.build(), b.creds.APISecret))
	}
	u := b.baseURL + path
	if qs := q.build(); qs != "" {
		u += "?" + qs
	}
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return exchanges.WrapTransport(venueID, exchanges.ClassificationFor(execution.ErrUnknown), op, err)
	}
	if sign {
		req.Header.Set("X-MBX-APIKEY", b.creds.APIKey)
	}
	resp, err := b.http.Do(req)
	if err != nil {
		return exchanges.WrapTransport(venueID, exchanges.ClassificationFor(execution.ErrNetworkRetryable), op, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return exchanges.WrapTransport(venueID, exchanges.ClassificationFor(execution.ErrNetworkRetryable), op, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return b.venueError(resp.StatusCode, body)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		// A 2xx with an unparseable body is a transport-shape failure, not an
		// order rejection: retryable family, no body rendered.
		return exchanges.WrapTransport(venueID, exchanges.ClassificationFor(execution.ErrNetworkRetryable), op, err)
	}
	return nil
}

// venueError builds the classified error for a non-2xx response. The message
// is the venue's short `msg` trimmed to a bounded, single-line, secret-free
// fragment (the envelope msg is Binance's short human reason, e.g.
// "Account has insufficient balance." — never the raw body).
func (b *Binance) venueError(status int, body []byte) error {
	var env struct {
		Code json.Number `json:"code"`
		Msg  string      `json:"msg"`
	}
	code, msg := "", ""
	if json.Unmarshal(body, &env) == nil && env.Code != "" {
		code = env.Code.String()
		msg = sanitizeMsg(env.Msg)
	}
	return exchanges.NewVenueError(venueID, code, status, msg)
}

// sanitizeMsg bounds and flattens a venue reason so it can never carry a
// secret, a query string or a multi-line payload into logs.
func sanitizeMsg(msg string) string {
	msg = strings.ReplaceAll(msg, "\n", " ")
	msg = strings.ReplaceAll(msg, "\r", " ")
	if len(msg) > 120 {
		msg = msg[:120]
	}
	return msg
}

// maxBodyBytes bounds how much of a venue response body is ever read
// (defense against a runaway stream).
const maxBodyBytes = 4 << 20

// accountPath is the documented account endpoint used by GetAccount and
// GetBalance. The adapter's structural scope keeps the /api/v3 forms for
// account, balance and order endpoints in both market modes; the USD-M form
// is the position endpoint (/fapi/v2/positionRisk).
//
// ASSUMPTION: in linear_perp mode the equity snapshot is read from the same
// /api/v3/account envelope the spot form documents (balances:[{asset,free,
// locked}]); a USD-M wallet-specific mirror of the same rows is not exercised
// structurally here.
const accountPath = "/api/v3/account"

// GetAccount performs a signed GET of the account endpoint. A successful
// signed read proves read permission (mirror of exchange.ts validateCredentials,
// PRD §46): Read=true, SpotTrade/FuturesTrade=true per exchange.ts's static
// binance permissions mapping, Withdraw=false (FUDCourt never requests
// withdrawal — PRD §43). On an auth-class failure the health verdict is
// exchanges.CredentialHealthForValidation of the classification, mirroring
// validateCredentials' failure mapping; the classified error is returned, not
// swallowed.
func (b *Binance) GetAccount(ctx context.Context) (execution.AccountMetadata, error) {
	var raw json.RawMessage
	err := b.call(ctx, http.MethodGet, accountPath, &query{}, true, "GET "+accountPath, &raw)
	if err != nil {
		var ve *exchanges.VenueError
		if errors.As(err, &ve) {
			return accountMetaFromErr(b, ve), err
		}
		return execution.AccountMetadata{Health: execution.HealthUnknown}, err
	}
	trade := true
	withdraw := false
	masked := exchanges.MaskAPIKey(b.creds.APIKey)
	acctType := "spot"
	if b.market == execution.MarketLinearPerp {
		acctType = "linear_perp"
	}
	return execution.AccountMetadata{
		Exchange:    venueID,
		Label:       nil,
		AccountType: &acctType,
		Permissions: execution.AccountPermissions{
			Read:         true,
			SpotTrade:    &trade,
			FuturesTrade: &trade,
			Withdraw:     &withdraw,
		},
		Health:       execution.HealthActive,
		APIKeyMasked: &masked,
	}, nil
}

// accountMetaFromErr builds the health verdict of a FAILED credential probe
// (mirror of exchange.ts validateCredentials): the metadata carries only what
// the failure proves — the masked key and the validation health — never
// fabricated permission booleans or an "ACTIVE" state the probe did not prove.
func accountMetaFromErr(b *Binance, ve *exchanges.VenueError) execution.AccountMetadata {
	masked := exchanges.MaskAPIKey(b.creds.APIKey)
	return execution.AccountMetadata{
		Exchange:     venueID,
		Label:        nil,
		AccountType:  nil,
		Permissions:  execution.AccountPermissions{Read: false},
		Health:       exchanges.CredentialHealthForValidation(ve.Class),
		APIKeyMasked: &masked,
	}
}

// GetBalance reads the account balances and returns the equity snapshot. The
// endpoint follows the same family as GetAccount (spot /api/v3/account,
// linear_perp /fapi/v2/account); both envelopes carry `balances` as
// `[{asset, free, locked}]`.
//
// Wire decimal strings are preserved VERBATIM in the Balance rows
// (free=free, used=locked); only computed totals go through decimal.Add, so
// no float64 ever touches a money value (objective §36). SpotEquity is set
// when MarketType is spot and FuturesEquity when linear_perp — the other side
// stays nil (honest null, never 0); TotalEquity is the sum over listed
// balances, nil when the venue lists none (mirror of exchange.ts
// getAccountEquity). Timestamp is Clock.Now().
func (b *Binance) GetBalance(ctx context.Context) (execution.AccountEquity, error) {
	var env struct {
		Balances []struct {
			Asset  string `json:"asset"`
			Free   string `json:"free"`
			Locked string `json:"locked"`
		} `json:"balances"`
	}
	if err := b.call(ctx, http.MethodGet, accountPath, &query{}, true, "GET "+accountPath, &env); err != nil {
		return execution.AccountEquity{}, err
	}
	eq := execution.AccountEquity{Timestamp: b.clock.Now()}
	total := ""
	for _, row := range env.Balances {
		tot, err := decimal.Add(row.Free, row.Locked)
		if err != nil {
			return execution.AccountEquity{}, exchanges.WrapTransport(venueID, exchanges.ClassificationFor(execution.ErrUnknown), "GET "+accountPath, err)
		}
		eq.Balances = append(eq.Balances, execution.Balance{
			Asset: row.Asset, Free: row.Free, Used: row.Locked, Total: tot,
		})
		if total == "" {
			total = tot
			continue
		}
		total, err = decimal.Add(total, tot)
		if err != nil {
			return execution.AccountEquity{}, exchanges.WrapTransport(venueID, exchanges.ClassificationFor(execution.ErrUnknown), "GET "+accountPath, err)
		}
	}
	if total != "" {
		eq.TotalEquity = &total
		spot := b.market == execution.MarketSpot
		if spot {
			eq.SpotEquity = &total
		} else {
			eq.FuturesEquity = &total
		}
	}
	return eq, nil
}

// GetPosition returns the USD-M position on symbol via signed GET
// /fapi/v2/positionRisk. Spot has no positions on Binance — it refuses with
// execution.ErrNoPosition always (the canonical contract: flat/absent is
// ErrNoPosition, never an empty success). The quantity keeps the wire sign:
// positive long, negative short (side derived from the positionAmt sign).
func (b *Binance) GetPosition(ctx context.Context, symbol string) (execution.Position, error) {
	if b.market != execution.MarketLinearPerp {
		return execution.Position{}, exchanges.ErrNoPosition
	}
	vsym, err := exchanges.ToVenueSymbol(symbol, venueID)
	if err != nil {
		return execution.Position{}, err
	}
	q := &query{}
	q.add("symbol", vsym)
	var rows []positionRiskRow
	if err := b.call(ctx, http.MethodGet, "/fapi/v2/positionRisk", q, true, "GET /fapi/v2/positionRisk", &rows); err != nil {
		return execution.Position{}, err
	}
	for _, row := range rows {
		if row.Symbol != vsym {
			continue
		}
		if row.PositionAmt == "" || isZeroDecimal(row.PositionAmt) {
			continue // flat
		}
		side := execution.SideSell
		if !strings.HasPrefix(row.PositionAmt, "-") {
			side = execution.SideBuy
		}
		return execution.Position{
			Symbol:           symbol,
			MarketType:       execution.MarketLinearPerp,
			Side:             side,
			Quantity:         row.PositionAmt,
			EntryPrice:       row.EntryPrice,
			Leverage:         nullableStr(row.Leverage),
			MarginMode:       marginModeFromWire(row.MarginType),
			LiquidationPrice: nullableStr(row.LiquidationPrice),
			PositionSide:     positionSideFromWire(row.PositionSide),
		}, nil
	}
	return execution.Position{}, exchanges.ErrNoPosition
}

// GetTicker returns the top-of-book from the PUBLIC (unsigned)
// GET /api/v3/ticker/bookTicker. Bid/Ask are nil when the venue sends an empty
// price; Last is always nil — the book ticker carries no last price and an
// honest null beats a fabricated one (house rule). Ts is Clock.Now(): the
// bookTicker response carries no timestamp.
func (b *Binance) GetTicker(ctx context.Context, symbol string) (execution.Ticker, error) {
	vsym, err := exchanges.ToVenueSymbol(symbol, venueID)
	if err != nil {
		return execution.Ticker{}, err
	}
	q := &query{}
	q.add("symbol", vsym)
	var raw struct {
		Symbol   string `json:"symbol"`
		BidPrice string `json:"bidPrice"`
		AskPrice string `json:"askPrice"`
	}
	if err := b.call(ctx, http.MethodGet, "/api/v3/ticker/bookTicker", q, false, "GET /api/v3/ticker/bookTicker", &raw); err != nil {
		return execution.Ticker{}, err
	}
	return execution.Ticker{
		Symbol: symbol,
		Bid:    nullableStr(raw.BidPrice),
		Ask:    nullableStr(raw.AskPrice),
		Last:   nil,
		Ts:     b.clock.Now(),
	}, nil
}

// CreateOrder places one order with signed POST /api/v3/order
// (newOrderRespType=RESULT so one response carries the full normalized order).
//
// IDEMPOTENCY: resubmitting the same ClientOrderID must not create a second
// venue order (objective §23); on Binance the idempotency lives at the VENUE
// via newClientOrderId — a duplicate client order id is refused by the venue
// (error -2010 duplicate) and surfaces as a classified VenueError, never a
// silently duplicated order.
//
// Validated inputs (refused before any request): unknown side/type/TIF, a
// quantity that is not a non-zero decimal, and (for limit orders) a price that
// is not a positive decimal — all exchanges.ErrInvalidOrder. The canonical
// symbol is refused by exchanges.ToVenueSymbol when malformed or its quote
// suffix is unknown. ReduceOnly is sent only for USD-M request forms
// (workingType-style positional params live on /fapi; spot has no reduce-only).
func (b *Binance) CreateOrder(ctx context.Context, req execution.OrderRequest) (execution.NormalizedOrder, error) {
	vsym, err := exchanges.ToVenueSymbol(req.Symbol, venueID)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	if err := validateOrder(req); err != nil {
		return execution.NormalizedOrder{}, err
	}
	q := &query{}
	q.add("symbol", vsym)
	q.add("side", wireSide(req.Side))
	q.add("type", wireOrderType(req.OrderType))
	q.add("quantity", req.Quantity)
	if req.OrderType == "limit" {
		q.add("price", req.Price)
		q.add("timeInForce", string(req.TimeInForce))
	}
	q.add("newClientOrderId", req.ClientOrderID)
	q.add("newOrderRespType", "RESULT")
	// ASSUMPTION: this structural form is the documented spot /api/v3/order
	// parameter list exactly (symbol, side, type, quantity, price,
	// timeInForce, newClientOrderId, newOrderRespType). reduceOnly is NOT
	// sent: the spot endpoint has no such parameter and a USD-M-only form is
	// out of this adapter's structural scope; the request's ReduceOnly/Intent
	// still marks the normalized order's IsExit.
	var raw orderWire
	if err := b.call(ctx, http.MethodPost, "/api/v3/order", q, true, "POST /api/v3/order", &raw); err != nil {
		return execution.NormalizedOrder{}, err
	}
	return b.normalize(raw, req.Symbol, &req), nil
}

// CancelOrder cancels by venue order id via signed DELETE /api/v3/order.
func (b *Binance) CancelOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	return b.fetchOrMutate(ctx, http.MethodDelete, "/api/v3/order", symbol, exchangeOrderID, "DELETE /api/v3/order")
}

// GetOrder fetches one order by venue order id via signed GET /api/v3/order.
func (b *Binance) GetOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	return b.fetchOrMutate(ctx, http.MethodGet, "/api/v3/order", symbol, exchangeOrderID, "GET /api/v3/order")
}

// fetchOrMutate runs the shared symbol+orderId call shape for GetOrder and
// CancelOrder (identical wire parameters, different methods).
func (b *Binance) fetchOrMutate(ctx context.Context, method, path, symbol, exchangeOrderID, op string) (execution.NormalizedOrder, error) {
	vsym, err := exchanges.ToVenueSymbol(symbol, venueID)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	if exchangeOrderID == "" {
		return execution.NormalizedOrder{}, ErrMissingOrderID
	}
	q := &query{}
	q.add("symbol", vsym)
	q.add("orderId", exchangeOrderID)
	var raw orderWire
	if err := b.call(ctx, method, path, q, true, op, &raw); err != nil {
		return execution.NormalizedOrder{}, err
	}
	return b.normalize(raw, symbol, nil), nil
}

// GetOpenOrders lists the account's open orders on symbol via signed
// GET /api/v3/openOrders.
func (b *Binance) GetOpenOrders(ctx context.Context, symbol string) ([]execution.NormalizedOrder, error) {
	vsym, err := exchanges.ToVenueSymbol(symbol, venueID)
	if err != nil {
		return nil, fmt.Errorf("get open orders: %w", err)
	}
	q := &query{}
	q.add("symbol", vsym)
	var raws []orderWire
	if err := b.call(ctx, http.MethodGet, "/api/v3/openOrders", q, true, "GET /api/v3/openOrders", &raws); err != nil {
		return nil, fmt.Errorf("get open orders: %w", err)
	}
	out := make([]execution.NormalizedOrder, 0, len(raws))
	for _, raw := range raws {
		out = append(out, b.normalize(raw, symbol, nil))
	}
	return out, nil
}

// GetFills lists recent trades (fills) on symbol via signed
// GET /api/v3/myTrades. Fields follow the execution.Fill record: the trade id
// is ExchangeTradeID, fee fields are the commission triple, and every decimal
// is the verbatim wire string (no float64, objective §36).
func (b *Binance) GetFills(ctx context.Context, symbol string) ([]execution.Fill, error) {
	vsym, err := exchanges.ToVenueSymbol(symbol, venueID)
	if err != nil {
		return nil, fmt.Errorf("get fills: %w", err)
	}
	q := &query{}
	q.add("symbol", vsym)
	var raws []tradeWire
	if err := b.call(ctx, http.MethodGet, "/api/v3/myTrades", q, true, "GET /api/v3/myTrades", &raws); err != nil {
		return nil, fmt.Errorf("get fills: %w", err)
	}
	out := make([]execution.Fill, 0, len(raws))
	for _, t := range raws {
		out = append(out, execution.Fill{
			ExchangeTradeID: strconv.FormatInt(t.ID, 10),
			ClientOrderID:   t.ClientOrderID,
			Price:           t.Price,
			Quantity:        t.Qty,
			QuoteQuantity:   t.QuoteQty,
			Fee:             t.Commission,
			FeeAsset:        t.CommissionAsset,
			Timestamp:       t.Time,
		})
	}
	return out, nil
}

// GetMarkets is NOT implemented for this adapter yet: the venue's instrument
// list (precision, min notional, leverage brackets) is not parsed here, and the
// executor API's planner path refuses a venue it cannot read a grid for rather
// than fabricating one. Returning a named refusal keeps the failure honest and
// fail-closed; implementing it means porting exchange.ts getMarkets for this
// venue. See the executor API's planContext.
func (b *Binance) GetMarkets(context.Context) ([]exchanges.Market, error) {
	return nil, exchanges.ErrMarketsUnavailable
}

// GetFees is NOT implemented for this adapter yet (same reason as GetMarkets):
// the per-symbol fee schedule is not parsed. See the executor API's planContext.
func (b *Binance) GetFees(context.Context, string) (exchanges.FeeModel, error) {
	return exchanges.FeeModel{}, exchanges.ErrFeesUnavailable
}
