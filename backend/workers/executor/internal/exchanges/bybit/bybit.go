// Package bybit is a structurally complete, stdlib-only REST adapter for the
// Bybit v5 API, driven entirely through the injectable exchanges.HTTPClient
// (and exchanges.Clock) — it never opens a network connection of its own in
// tests and never vendors a dependency: net/http, crypto/hmac and encoding/json
// only.
//
// Venue differences (wire symbols BTCUSDT, orderStatus names, retCode error
// envelope, category=spot|linear routing) are absorbed here and never leak
// past the exchanges.Exchange boundary (objective §8.16). Money and quantity
// values travel as exact decimal strings (objective §36); no float64 touches a
// financial path.
//
// Wire-format details that cannot be verified without live calls are marked
// `ASSUMPTION:` in the doc comments that use them — honest, never a TODO.
package bybit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// Construction refusals — named so callers can refuse bad configuration
// instead of guessing at runtime (house rule).
var (
	// ErrCredentialsRequired is returned by New when the API key or secret is empty.
	ErrCredentialsRequired = errors.New("bybit: credentials are required")
	// ErrHTTPClientRequired is returned by New when no HTTP client is supplied.
	ErrHTTPClientRequired = errors.New("bybit: http client is required")
	// ErrInvalidMarketType is returned by New when MarketType is not spot or
	// linear_perp — the category parameter would otherwise be guessed.
	ErrInvalidMarketType = errors.New("bybit: market type must be spot or linear_perp")
)

// DefaultBaseURL is the public Bybit v5 REST base (Config.BaseURL default).
const DefaultBaseURL = "https://api.bybit.com"

// maxResponseBytes bounds how much of a venue response is read: a venue must
// never be able to pin a worker with an unbounded body.
const maxResponseBytes = 8 << 20

// Config wires one Bybit adapter. All seams are injected so tests drive
// recorded fixtures through a stub exchanges.HTTPClient — no live network.
type Config struct {
	// Credentials is the API key/secret handle. The secret is used only inside
	// Sign and never rendered anywhere (PRD §109).
	Credentials exchanges.Credentials
	// HTTP executes requests. Required; typically exchanges.DefaultHTTPClient.
	HTTP exchanges.HTTPClient
	// Clock supplies signing timestamps (unix millis). nil means SystemClock.
	Clock exchanges.Clock
	// MarketType selects the Bybit category routed on every call:
	// spot → category=spot, linear_perp → category=linear.
	MarketType execution.MarketType
	// BaseURL overrides the venue root; empty means DefaultBaseURL. A trailing
	// slash is trimmed.
	BaseURL string
}

// Bybit implements exchanges.Exchange against the Bybit v5 REST API.
type Bybit struct {
	creds  exchanges.Credentials
	http   exchanges.HTTPClient
	clock  exchanges.Clock
	market execution.MarketType
	base   string
}

// Interface conformance is checked at compile time, never at runtime.
var _ exchanges.Exchange = (*Bybit)(nil)

// New validates cfg and returns a ready adapter. Empty credentials, a nil HTTP
// client or an unknown MarketType are refused with the named errors above —
// the category and signer inputs would otherwise be guesses.
func New(cfg Config) (*Bybit, error) {
	if cfg.Credentials.APIKey == "" || cfg.Credentials.APISecret == "" {
		return nil, ErrCredentialsRequired
	}
	if cfg.HTTP == nil {
		return nil, ErrHTTPClientRequired
	}
	if cfg.MarketType != execution.MarketSpot && cfg.MarketType != execution.MarketLinearPerp {
		return nil, ErrInvalidMarketType
	}
	clock := cfg.Clock
	if clock == nil {
		clock = exchanges.SystemClock{}
	}
	base := cfg.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	return &Bybit{
		creds:  cfg.Credentials,
		http:   cfg.HTTP,
		clock:  clock,
		market: cfg.MarketType,
		base:   strings.TrimRight(base, "/"),
	}, nil
}

// category maps the configured market type to the Bybit v5 category parameter
// (the venue routes instruments by category, not by symbol shape).
func (b *Bybit) category() string {
	if b.market == execution.MarketSpot {
		return "spot"
	}
	return "linear"
}

// accountType maps the configured market type to the wallet-balance
// accountType parameter.
//
// ASSUMPTION: Bybit's /v5/account/wallet-balance distinguishes accountType
// UNIFIED (Unified Trading Account) from CONTRACT (the classic derivatives
// wallet). This adapter queries UNIFIED for spot and CONTRACT for
// linear_perp, per this package's assignment; if the account in front of the
// key is a UTA covering both books the CONTRACT query may come back empty for
// a purely spot-configured adapter. The value is never guessed at call time —
// it is fixed here and documented.
func (b *Bybit) accountType() string {
	if b.market == execution.MarketSpot {
		return "UNIFIED"
	}
	return "CONTRACT"
}

// do executes one signed Bybit v5 request and returns the envelope's raw
// `result`. GET payloads sign the ASCII-sorted query string (without '?'); POST
// payloads sign the raw JSON body exactly as sent.
//
// ASSUMPTION: POST bodies are application/json and every signed call carries
// recv-window 5000 ms (see sign.go).
func (b *Bybit) do(ctx context.Context, method, path string, query url.Values, body map[string]any, out *json.RawMessage) error {
	payload := ""
	full := b.base + path
	if query != nil {
		// url.Values.Encode sorts keys in ascending byte order — the exact
		// string signed is the exact string sent.
		payload = query.Encode()
		full += "?" + payload
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body) // map keys render sorted: deterministic
		if err != nil {
			return exchanges.NewVenueError(execution.ExchangeBybit, "", 0, "bybit: request body cannot be encoded")
		}
		payload = string(raw)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, full, reader)
	if err != nil {
		return exchanges.NewVenueError(execution.ExchangeBybit, "", 0, "bybit: request cannot be built")
	}
	ts := strconv.FormatInt(b.clock.Now(), 10)
	req.Header.Set("X-BAPI-API-Key", b.creds.APIKey)
	req.Header.Set("X-BAPI-TIMESTAMP", ts)
	req.Header.Set("X-BAPI-RECV-WINDOW", defaultRecvWindow)
	req.Header.Set("X-BAPI-SIGN", Sign(ts, b.creds.APIKey, b.creds.APISecret, defaultRecvWindow, payload))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := b.http.Do(req)
	if err != nil {
		// Transport failure: network_retryable via the shared taxonomy. The
		// message is the operation only — never the request URL or query.
		return exchanges.WrapTransport(execution.ExchangeBybit,
			exchanges.ClassificationFor(execution.ErrNetworkRetryable),
			"bybit "+path+" transport failure", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return exchanges.WrapTransport(execution.ExchangeBybit,
			exchanges.ClassificationFor(execution.ErrNetworkRetryable),
			"bybit "+path+" response read failure", err)
	}

	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return exchanges.NewVenueError(execution.ExchangeBybit, "", resp.StatusCode, "bybit: unparseable response body")
	}
	if env.RetCode != 0 {
		return venueError(env.RetCode, env.RetMsg, resp.StatusCode, b.creds)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return exchanges.NewVenueError(execution.ExchangeBybit, "", resp.StatusCode, "bybit: unexpected http status")
	}
	*out = env.Result
	return nil
}

// GetAccount validates the credential and reports what the venue says about
// it. It queries /v5/user/query-api-key — the key-info endpoint (NOT the
// wallet-balance call) because that is the only Bybit endpoint that reports
// key restrictions.
//
// Permission flags are honest: trade/withdraw are true/false only where the
// venue's reported permission list grants or withholds that capability, and
// nil where the venue reports no permissions list at all (house rule).
// APIKeyMasked is the masked display form (PRD §109); Health is ACTIVE on
// success. On failure the returned metadata's Health is the strict
// exchanges.CredentialHealthForValidation verdict for the failure
// (permission_error → PERMISSION_ERROR, rate_limited → RATE_LIMITED, else
// INVALID) and the wrapped venue error is returned alongside it.
//
// ASSUMPTION: Bybit's query-api-key result reports `readOnly` (0/1), `note`
// (the key's label) and a `permissions` list of scope strings shaped like
// "Spot.Order" / "Contract.*" / "Wallet.Withdraw"; the exact scope strings are
// mapped in mapPermissions and are not verifiable from this repository.
func (b *Bybit) GetAccount(ctx context.Context) (execution.AccountMetadata, error) {
	masked := exchanges.MaskAPIKey(b.creds.APIKey)
	meta := execution.AccountMetadata{
		Exchange:     execution.ExchangeBybit,
		Label:        nil,
		AccountType:  strPtr(string(b.market)),
		Permissions:  execution.AccountPermissions{Read: true},
		Health:       execution.HealthActive,
		APIKeyMasked: &masked,
	}
	var result json.RawMessage
	if err := b.do(ctx, http.MethodGet, "/v5/user/query-api-key", url.Values{}, nil, &result); err != nil {
		meta.Permissions = execution.AccountPermissions{} // nothing proven — do not fake read
		meta.Health = exchanges.CredentialHealthForValidation(exchanges.Classify(err))
		return meta, err
	}
	info, err := parseKeyInfo(result)
	if err != nil {
		meta.Permissions = execution.AccountPermissions{}
		meta.Health = execution.HealthUnknown
		return meta, err
	}
	if info.Note != "" {
		meta.Label = &info.Note
	}
	if info.ReadOnly != nil {
		meta.Permissions.Read = *info.ReadOnly == 0
	}
	if info.Permissions != nil {
		spot, futures, withdraw := mapPermissions(*info.Permissions)
		meta.Permissions.SpotTrade = spot
		meta.Permissions.FuturesTrade = futures
		meta.Permissions.Withdraw = withdraw
	}
	return meta, nil
}

// GetBalance reads /v5/account/wallet-balance for the configured account type
// (UNIFIED for spot, CONTRACT for linear_perp — see accountType) and reports
// execution.AccountEquity. The equity figure for the configured market lands in
// SpotEquity or FuturesEquity; the OTHER basis is nil because this query never
// reads it (honest null, never a fabricated 0). Balance rows keep the venue's
// exact decimal strings: Total is walletBalance, Free is availableToWithdraw
// and Used is computed exactly with decimal.Sub.
//
// ASSUMPTION: wallet-balance rows report `walletBalance` (total),
// `availableToWithdraw` (free) and `coin`; `availableToWithdraw` is the
// withdrawable free figure closest to the contract's `free` meaning.
func (b *Bybit) GetBalance(ctx context.Context) (execution.AccountEquity, error) {
	q := url.Values{}
	q.Set("accountType", b.accountType())
	var result json.RawMessage
	if err := b.do(ctx, http.MethodGet, "/v5/account/wallet-balance", q, nil, &result); err != nil {
		return execution.AccountEquity{}, err
	}
	wallet, err := parseWallet(result)
	if err != nil {
		return execution.AccountEquity{}, err
	}
	equity := execution.AccountEquity{Timestamp: b.clock.Now(), Balances: []execution.Balance{}}
	for _, row := range wallet.Coins {
		free := row.AvailableToWithdraw
		used, uerr := decimal.Sub(row.WalletBalance, free)
		if uerr != nil {
			return execution.AccountEquity{}, exchanges.NewVenueError(execution.ExchangeBybit, "", 0, "bybit: wallet balance row has non-decimal figures")
		}
		equity.Balances = append(equity.Balances, execution.Balance{
			Asset: row.Coin, Free: free, Used: used, Total: row.WalletBalance,
		})
	}
	total := wallet.TotalEquity
	equity.TotalEquity = &total
	if b.market == execution.MarketSpot {
		equity.SpotEquity = &total
	} else {
		equity.FuturesEquity = &total
	}
	return equity, nil
}

// GetPosition reads /v5/position/list for one symbol and reports the position
// with a SIGNED quantity in one-way semantics: bybit side Buy → positive,
// Sell → negative (positionIdx 0 is one-way/net; hedge-mode idx 1/2 report
// "long"/"short" in PositionSide). A flat or absent position returns
// exchanges.ErrNoPosition — flat is an answer, a failed fetch is an error.
func (b *Bybit) GetPosition(ctx context.Context, symbol string) (execution.Position, error) {
	venueSymbol, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeBybit)
	if err != nil {
		return execution.Position{}, err
	}
	q := url.Values{}
	q.Set("category", b.category())
	q.Set("symbol", venueSymbol)
	var result json.RawMessage
	if err := b.do(ctx, http.MethodGet, "/v5/position/list", q, nil, &result); err != nil {
		return execution.Position{}, err
	}
	rows, err := parsePositions(result)
	if err != nil {
		return execution.Position{}, err
	}
	for _, row := range rows {
		if row.Size == "" || row.Size == "0" {
			continue // flat row: keep looking, then ErrNoPosition
		}
		pos := execution.Position{
			Symbol:       symbol,
			MarketType:   b.market,
			Quantity:     signedQuantity(row.Side, row.Size),
			EntryPrice:   row.EntryPrice,
			Side:         mapSide(row.Side),
			PositionSide: mapPositionSide(row.PositionIdx),
		}
		if row.Leverage != "" {
			pos.Leverage = &row.Leverage
		}
		if mm := mapMarginMode(row.TradeMode); mm != nil {
			pos.MarginMode = mm
		}
		if row.LiqPrice != "" {
			pos.LiquidationPrice = &row.LiqPrice
		}
		return pos, nil
	}
	return execution.Position{}, exchanges.ErrNoPosition
}

// GetTicker reads /v5/market/tickers for one symbol. bid1Price/ask1Price/
// lastPrice become the nullable touch prices — an empty venue field is nil
// (honest null, never a fabricated touch). Ts is Clock.Now(): the venue ticker
// carries its own timestamp fields but this adapter reports the read instant
// per the assignment.
func (b *Bybit) GetTicker(ctx context.Context, symbol string) (execution.Ticker, error) {
	venueSymbol, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeBybit)
	if err != nil {
		return execution.Ticker{}, err
	}
	q := url.Values{}
	q.Set("category", b.category())
	q.Set("symbol", venueSymbol)
	var result json.RawMessage
	if err := b.do(ctx, http.MethodGet, "/v5/market/tickers", q, nil, &result); err != nil {
		return execution.Ticker{}, err
	}
	rows, err := parseTickers(result)
	if err != nil {
		return execution.Ticker{}, err
	}
	if len(rows) == 0 {
		return execution.Ticker{}, exchanges.ErrInvalidSymbol
	}
	row := rows[0]
	return execution.Ticker{
		Symbol: symbol,
		Bid:    emptyToNil(row.Bid1Price),
		Ask:    emptyToNil(row.Ask1Price),
		Last:   emptyToNil(row.LastPrice),
		Ts:     b.clock.Now(),
	}, nil
}

// CreateOrder places one order via POST /v5/order/create. Idempotency lives at
// the venue through orderLinkId (objective §23): resubmitting the same
// ClientOrderID does not create a second venue order (bybit rejects the
// duplicate orderLinkId), so the client order id travels as orderLinkId
// unchanged.
//
// The create acknowledgement reports orderId (and echoes orderLinkId) but NO
// order status; when the venue omits it the returned status is ChildUnknown —
// never a fabricated OPEN — and callers resolve the true state with GetOrder
// (parity with exchange.ts placeOrder, which maps a missing status to
// UNKNOWN). FilledQuantity is "0" until a status read says otherwise.
func (b *Bybit) CreateOrder(ctx context.Context, req execution.OrderRequest) (execution.NormalizedOrder, error) {
	if req.ClientOrderID == "" {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: client order id is required", exchanges.ErrInvalidOrder)
	}
	if req.Quantity == "" {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: quantity is required", exchanges.ErrInvalidOrder)
	}
	if _, err := decimal.Parse(req.Quantity); err != nil {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: quantity is not a decimal string", exchanges.ErrInvalidOrder)
	}
	side, ok := mapSideOut(req.Side)
	if !ok {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: unknown side %q", exchanges.ErrInvalidOrder, req.Side)
	}
	orderType, ok := mapOrderTypeOut(req.OrderType)
	if !ok {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: unknown order type %q", exchanges.ErrInvalidOrder, req.OrderType)
	}
	if req.OrderType == "limit" && req.Price == "" {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: limit order requires a price", exchanges.ErrInvalidOrder)
	}
	if req.Price != "" {
		if _, err := decimal.Parse(req.Price); err != nil {
			return execution.NormalizedOrder{}, fmt.Errorf("%w: price is not a decimal string", exchanges.ErrInvalidOrder)
		}
	}
	if !mapTimeInForceOut(req.TimeInForce) {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: unknown time in force %q", exchanges.ErrInvalidOrder, req.TimeInForce)
	}
	venueSymbol, err := exchanges.ToVenueSymbol(req.Symbol, execution.ExchangeBybit)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	body := map[string]any{
		"category":    b.category(),
		"symbol":      venueSymbol,
		"side":        side,
		"orderType":   orderType,
		"qty":         req.Quantity,
		"timeInForce": string(req.TimeInForce),
		"reduceOnly":  req.ReduceOnly,
		"orderLinkId": req.ClientOrderID,
	}
	if req.Price != "" {
		body["price"] = req.Price
	}
	var result json.RawMessage
	if err := b.do(ctx, http.MethodPost, "/v5/order/create", nil, body, &result); err != nil {
		return execution.NormalizedOrder{}, err
	}
	ack, err := parseOrderAck(result)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	now := b.clock.Now()
	order := execution.NormalizedOrder{
		ExchangeOrderID: ack.OrderID,
		ClientOrderID:   firstNonEmpty(ack.OrderLinkID, req.ClientOrderID),
		Symbol:          req.Symbol,
		Side:            req.Side,
		Type:            req.OrderType,
		Quantity:        req.Quantity,
		FilledQuantity:  "0",
		Status:          mapOrderStatus(ack.OrderStatus),
		IsExit:          req.Intent != execution.IntentOpen,
		SubmittedAt:     now,
		UpdatedAt:       now,
	}
	if req.Price != "" {
		order.Price = &req.Price
	}
	return order, nil
}

// CancelOrder cancels by venue order id via POST /v5/order/cancel. The cancel
// acknowledgement reports only orderId/orderLinkId, so the returned
// NormalizedOrder carries those plus Status=ChildCancelled (the venue accepted
// the cancellation — a documented choice); fields the acknowledgement does not
// report (side, type, quantity, timestamps) stay zero-valued rather than
// fabricated. An unknown order id fails with exchanges.ErrOrderNotFound.
func (b *Bybit) CancelOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	venueSymbol, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeBybit)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	if exchangeOrderID == "" {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: order id is required", exchanges.ErrInvalidOrder)
	}
	body := map[string]any{
		"category": b.category(),
		"symbol":   venueSymbol,
		"orderId":  exchangeOrderID,
	}
	var result json.RawMessage
	if err := b.do(ctx, http.MethodPost, "/v5/order/cancel", nil, body, &result); err != nil {
		return execution.NormalizedOrder{}, mapOrderLookupFailure(err)
	}
	ack, err := parseOrderAck(result)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	return execution.NormalizedOrder{
		ExchangeOrderID: firstNonEmpty(ack.OrderID, exchangeOrderID),
		ClientOrderID:   ack.OrderLinkID,
		Symbol:          symbol,
		Status:          execution.ChildCancelled,
	}, nil
}

// GetOrder fetches one order by venue order id from /v5/order/realtime and,
// when the order has already reached a terminal state there, falls back to
// /v5/order/history (terminal orders leave the realtime set).
//
// ASSUMPTION: /v5/order/realtime holds working and very recent orders while
// filled/cancelled orders migrate to /v5/order/history; a 110001 "order does
// not exist" from realtime is therefore retried against exactly one history
// query before the pair is reported as exchanges.ErrOrderNotFound.
func (b *Bybit) GetOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	order, err := b.fetchOrderFrom(ctx, "/v5/order/realtime", symbol, exchangeOrderID)
	if err == nil {
		return order, nil
	}
	if !errors.Is(err, exchanges.ErrOrderNotFound) {
		return execution.NormalizedOrder{}, err
	}
	return b.fetchOrderFrom(ctx, "/v5/order/history", symbol, exchangeOrderID)
}

// GetOpenOrders lists the account's open orders on symbol via
// /v5/order/realtime (the working-order set).
func (b *Bybit) GetOpenOrders(ctx context.Context, symbol string) ([]execution.NormalizedOrder, error) {
	venueSymbol, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeBybit)
	if err != nil {
		return nil, fmt.Errorf("get open orders: %w", err)
	}
	q := url.Values{}
	q.Set("category", b.category())
	q.Set("symbol", venueSymbol)
	var result json.RawMessage
	if err := b.do(ctx, http.MethodGet, "/v5/order/realtime", q, nil, &result); err != nil {
		return nil, fmt.Errorf("get open orders: %w", err)
	}
	rows, err := parseOrders(result)
	if err != nil {
		return nil, fmt.Errorf("parse open orders: %w", err)
	}
	orders := make([]execution.NormalizedOrder, 0, len(rows))
	for _, row := range rows {
		orders = append(orders, b.normalizeOrder(row, symbol))
	}
	return orders, nil
}

// GetFills lists recent fills on symbol via GET /v5/execution/list. Fill rows
// keep the venue's exact decimal strings; the quote quantity is computed
// exactly (decimal.Mul) because the venue reports only price × qty pieces.
//
// ASSUMPTION: execution rows report execId/orderId/price/execQty/execFee/
// execTime and optionally feeCurrency and orderLinkId; the fee is normalized
// to its magnitude (bybit reports paid fees with a leading '-') and a missing
// feeCurrency falls back to "USDT" — the fee asset of the USDT-settled
// contracts this adapter trades (parity with exchange.ts getFills).
func (b *Bybit) GetFills(ctx context.Context, symbol string) ([]execution.Fill, error) {
	venueSymbol, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeBybit)
	if err != nil {
		return nil, fmt.Errorf("get fills: %w", err)
	}
	q := url.Values{}
	q.Set("category", b.category())
	q.Set("symbol", venueSymbol)
	var result json.RawMessage
	if err := b.do(ctx, http.MethodGet, "/v5/execution/list", q, nil, &result); err != nil {
		return nil, fmt.Errorf("get fills: %w", err)
	}
	rows, err := parseExecutions(result)
	if err != nil {
		return nil, fmt.Errorf("parse fills: %w", err)
	}
	fills := make([]execution.Fill, 0, len(rows))
	for _, row := range rows {
		quote, err := decimal.Mul(row.Price, row.ExecQty)
		if err != nil {
			return nil, exchanges.NewVenueError(execution.ExchangeBybit, "", 0, "bybit: execution row has non-decimal figures")
		}
		feeAsset := row.FeeCurrency
		if feeAsset == "" {
			feeAsset = "USDT"
		}
		fills = append(fills, execution.Fill{
			ExchangeTradeID: row.ExecID,
			ClientOrderID:   row.OrderLinkID,
			Price:           row.Price,
			Quantity:        row.ExecQty,
			QuoteQuantity:   quote,
			Fee:             strings.TrimPrefix(row.ExecFee, "-"),
			FeeAsset:        feeAsset,
			Timestamp:       parseMillis(row.ExecTime, b.clock.Now()),
		})
	}
	return fills, nil
}

// fetchOrderFrom runs one order query against path and normalizes the single
// row. A venue "order does not exist" (retCode 110001) becomes
// exchanges.ErrOrderNotFound, joined with the venue error so both errors.Is
// and errors.As (*exchanges.VenueError) keep working.
func (b *Bybit) fetchOrderFrom(ctx context.Context, path, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	venueSymbol, err := exchanges.ToVenueSymbol(symbol, execution.ExchangeBybit)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	if exchangeOrderID == "" {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: order id is required", exchanges.ErrInvalidOrder)
	}
	q := url.Values{}
	q.Set("category", b.category())
	q.Set("symbol", venueSymbol)
	q.Set("orderId", exchangeOrderID)
	var result json.RawMessage
	if err := b.do(ctx, http.MethodGet, path, q, nil, &result); err != nil {
		return execution.NormalizedOrder{}, mapOrderLookupFailure(err)
	}
	rows, err := parseOrders(result)
	if err != nil {
		return execution.NormalizedOrder{}, err
	}
	if len(rows) == 0 {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: venue returned no order rows", exchanges.ErrOrderNotFound)
	}
	return b.normalizeOrder(rows[0], symbol), nil
}

// normalizeOrder converts one venue order row into the canonical shape.
func (b *Bybit) normalizeOrder(row orderRow, symbol string) execution.NormalizedOrder {
	now := b.clock.Now()
	order := execution.NormalizedOrder{
		ExchangeOrderID: row.OrderID,
		ClientOrderID:   row.OrderLinkID,
		Symbol:          symbol,
		Side:            mapSide(row.Side),
		Type:            mapOrderTypeIn(row.OrderType),
		Quantity:        row.Qty,
		FilledQuantity:  firstNonEmpty(row.CumExecQty, "0"),
		Status:          mapOrderStatus(row.OrderStatus),
		IsExit:          bool(row.ReduceOnly),
		SubmittedAt:     parseMillis(row.CreatedTime, now),
		UpdatedAt:       parseMillis(row.UpdatedTime, now),
	}
	if canonical, err := exchanges.FromVenueSymbol(row.Symbol, execution.ExchangeBybit); err == nil && canonical != "" {
		order.Symbol = canonical
	}
	if row.Price != "" {
		price := row.Price
		order.Price = &price
	}
	return order
}

// mapOrderLookupFailure turns "the venue does not know this order id"
// (retCode 110001) into exchanges.ErrOrderNotFound while preserving the venue
// error for classification; everything else passes through untouched.
func mapOrderLookupFailure(err error) error {
	var ve *exchanges.VenueError
	if errors.As(err, &ve) && ve.Code == codeOrderNotExist {
		return fmt.Errorf("%w: %w", exchanges.ErrOrderNotFound, err)
	}
	return fmt.Errorf("look up order: %w", err)
}

// signedQuantity renders the signed one-way quantity: Buy → +size, Sell → -size.
func signedQuantity(side, size string) string {
	if side == "Sell" {
		return "-" + size
	}
	return size
}

// emptyToNil renders an empty venue decimal as an honest null.
func emptyToNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// strPtr returns a pointer to s (nullable contract fields).
func strPtr(s string) *string { return &s }

// firstNonEmpty returns the first non-empty candidate.
func firstNonEmpty(candidates ...string) string {
	for _, c := range candidates {
		if c != "" {
			return c
		}
	}
	return ""
}

// GetMarkets is NOT implemented for this adapter yet: the venue's instrument
// list (precision, min notional, leverage brackets) is not parsed here, and the
// executor API's planner path refuses a venue it cannot read a grid for rather
// than fabricating one. Returning a named refusal keeps the failure honest and
// fail-closed; implementing it means porting exchange.ts getMarkets for this
// venue. See the executor API's planContext.
func (b *Bybit) GetMarkets(context.Context) ([]exchanges.Market, error) {
	return nil, exchanges.ErrMarketsUnavailable
}

// GetFees is NOT implemented for this adapter yet (same reason as GetMarkets):
// the per-symbol fee schedule is not parsed. See the executor API's planContext.
func (b *Bybit) GetFees(context.Context, string) (exchanges.FeeModel, error) {
	return exchanges.FeeModel{}, exchanges.ErrFeesUnavailable
}
