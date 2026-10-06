package mexc

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
)

// Wire-shape parsing for the two MEXC request forms. Every uncertain wire
// name is marked ASSUMPTION next to its alias list; nothing here guesses a
// field that is absent — unreported figures stay honest nulls / empty
// literals, and unparseable shapes surface as the short malformed-venue
// error, never as fabricated values.

// rawJSON is one decoded venue object (or array element) kept as a field map
// so the spot form and the contract form — which spell the same concepts
// differently — can be read through one documented alias table.
type rawJSON = map[string]json.RawMessage

// unwrapData returns the response payload: the `data` member of the
// contract-form envelope ({"success":…, "code":…, "data":…}), or the body
// itself for spot-form responses (bare object / bare array).
//
// ASSUMPTION: the contract form wraps payloads in a `data` member; the spot
// form answers with the payload directly.
func unwrapData(body []byte) json.RawMessage {
	if obj, ok := asObject(body); ok {
		if data, has := obj["data"]; has {
			return data
		}
	}
	return json.RawMessage(bytes.TrimSpace(body))
}

// asObject decodes a JSON object into a raw field map.
func asObject(raw []byte) (rawJSON, bool) {
	var obj rawJSON
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&obj); err != nil || obj == nil {
		return nil, false
	}
	return obj, true
}

// asArray decodes a JSON array into its raw elements.
func asArray(raw []byte) ([]json.RawMessage, bool) {
	var arr []json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&arr); err != nil {
		return nil, false
	}
	return arr, true
}

// pick returns the first present field among keys (documented wire aliases).
func pick(obj rawJSON, keys ...string) (json.RawMessage, bool) {
	for _, k := range keys {
		if v, ok := obj[k]; ok {
			return v, true
		}
	}
	return nil, false
}

// rawStr renders a JSON string or number as its EXACT literal text — a
// numeric venue value never round-trips through float64 (objective §36).
// Booleans and objects render as "" (not a scalar).
func rawStr(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err == nil {
		return n.String()
	}
	return ""
}

// fieldStr returns the first present alias as a scalar literal ("" when
// absent or not a scalar).
func fieldStr(obj rawJSON, keys ...string) (string, bool) {
	raw, ok := pick(obj, keys...)
	if !ok {
		return "", false
	}
	return rawStr(raw), true
}

// fieldVal is fieldStr without the found flag (first alias literal, "" when
// none matches).
func fieldVal(obj rawJSON, keys ...string) string {
	s, _ := fieldStr(obj, keys...)
	return s
}

// fieldInt parses the first present alias as a unix-millis integer literal
// (0 when absent or not an integer — never guessed).
func fieldInt(obj rawJSON, keys ...string) int64 {
	s := fieldVal(obj, keys...)
	if s == "" {
		return 0
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// fieldBool reads the first present alias as a JSON boolean (false when
// absent).
func fieldBool(obj rawJSON, keys ...string) bool {
	raw, ok := pick(obj, keys...)
	if !ok {
		return false
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err == nil {
		return b
	}
	return false
}

// --- order status mapping -------------------------------------------------

// wireOrderStatuses maps MEXC wire order-status names to the canonical
// child-order lifecycle.
//
// ASSUMPTION: the exact wire names are the MEXC spot-documentation names
// (matched case-insensitively; both CANCELED and CANCELLED are accepted). The
// contract form is assumed to report the same names in its `status`/`state`
// field; a numeric state code or any name outside this table maps to
// ChildUnknown — unknown statuses are NEVER guessed into a lifecycle bucket.
var wireOrderStatuses = map[string]execution.ChildOrderStatus{
	"NEW":              execution.ChildOpen,
	"PARTIALLY_FILLED": execution.ChildPartial,
	"FILLED":           execution.ChildFilled,
	"CANCELED":         execution.ChildCancelled,
	"CANCELLED":        execution.ChildCancelled,
	"REJECTED":         execution.ChildRejected,
	"EXPIRED":          execution.ChildExpired,
}

// mapWireStatus maps one wire status name (any case) to the canonical status;
// anything unrecognized — including empty and numeric states — is
// ChildUnknown.
func mapWireStatus(name string) execution.ChildOrderStatus {
	if st, ok := wireOrderStatuses[strings.ToUpper(strings.TrimSpace(name))]; ok {
		return st
	}
	return execution.ChildUnknown
}

// --- contract request-form codes ------------------------------------------

// The assumed contract submit-form numeric codes.
//
// ASSUMPTION: the exact numeric values per the MEXC contract request form as
// best known — they are not verifiable from this repository.
const (
	// side codes: 1 open long, 2 close short, 3 open short, 4 close long.
	contractSideOpenLong   = 1
	contractSideCloseShort = 2
	contractSideOpenShort  = 3
	contractSideCloseLong  = 4
	// order-type codes: 5 limit, 6 market.
	contractTypeLimit  = 5
	contractTypeMarket = 6
	// openType (the "category 1/2" margin field): 1 isolated, 2 cross. This
	// adapter sends category 2 (cross) — see CreateOrder.
	contractOpenTypeIsolated = 1
	contractOpenTypeCross    = 2
	// positionType: 1 long, 2 short (one-way mode; the TS contract encodes
	// that MEXC contract accounts are one-way only).
	contractPositionLong  = 1
	contractPositionShort = 2
	// marginMode: 1 isolated, 2 cross.
	contractMarginIsolated = 1
	contractMarginCross    = 2
)

// wireSpotOrderFields returns the spot-form side/type/timeInForce names.
// ASSUMPTION: spot side names "BUY"/"SELL" and type names "LIMIT"/"MARKET".
// An empty TimeInForce omits the field entirely (venue default applies).
func wireSpotOrderFields(req execution.OrderRequest) (side, orderType, tif string) {
	side = "BUY"
	if req.Side == execution.SideSell {
		side = "SELL"
	}
	orderType = "MARKET"
	if req.OrderType == "limit" {
		orderType = "LIMIT"
	}
	return side, orderType, string(req.TimeInForce)
}

// wireContractSide maps (side, reduce-only) to the assumed contract side
// code: a reduce-only order MUST use the close codes (2/4) so the venue
// rejects it if it would increase the position.
func wireContractSide(req execution.OrderRequest) int {
	switch req.Side {
	case execution.SideBuy:
		if req.ReduceOnly {
			return contractSideCloseShort
		}
		return contractSideOpenLong
	default:
		if req.ReduceOnly {
			return contractSideCloseLong
		}
		return contractSideOpenShort
	}
}

// wireContractOrderType maps the canonical order type to the assumed contract
// type code (5 limit, 6 market).
func wireContractOrderType(req execution.OrderRequest) int {
	if req.OrderType == "limit" {
		return contractTypeLimit
	}
	return contractTypeMarket
}

// --- order parsing --------------------------------------------------------

// orderFallback carries OUR requested values used to complete an order view
// when the venue answers with a placement ack that echoes only ids. The
// values are our own request echoes — never venue claims — and a venue
// payload field always wins over the fallback.
type orderFallback struct {
	symbol        string
	side          execution.Side
	orderType     string
	quantity      string
	price         string
	clientOrderID string
	isExit        bool
}

// parseOrder normalizes one venue order payload (spot form or contract form)
// into the canonical execution.NormalizedOrder. A payload without a venue
// order id fails with errNoOrderID so each caller can decide honestly (an
// unknown order vs a malformed placement ack).
//
// ASSUMPTION (wire aliases): orderId∈{orderId,id}, clientOrderId∈{
// clientOrderId}, symbol∈{symbol}, price∈{price}, quantity∈{origQty (spot),
// vol (contract)}, filled∈{executedQty (spot), dealVol (contract)},
// status∈{status,state}, type∈{type,orderType}, side∈{side}, submittedAt∈{
// time,createDate,createTime}, updatedAt∈{updateTime,updateDate}. Numeric
// side codes are the assumed contract 1..4 set; numeric type codes are the
// assumed 5/6 set.
func parseOrder(raw json.RawMessage, fb orderFallback) (execution.NormalizedOrder, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		// The venue answered "no such order" — callers map this to
		// exchanges.ErrOrderNotFound (or a malformed ack on placement).
		return execution.NormalizedOrder{}, errNoOrderID
	}
	obj, ok := asObject(trimmed)
	if !ok {
		return execution.NormalizedOrder{}, errMalformedPayload
	}
	id := fieldVal(obj, "orderId", "id")
	if id == "" {
		return execution.NormalizedOrder{}, errNoOrderID
	}
	order := execution.NormalizedOrder{
		ExchangeOrderID: id,
		ClientOrderID:   firstNonEmpty(fieldVal(obj, "clientOrderId"), fb.clientOrderID),
		Symbol:          fb.symbol,
		IsExit:          fb.isExit,
		SubmittedAt:     fieldInt(obj, "time", "createDate", "createTime"),
		UpdatedAt:       fieldInt(obj, "updateTime", "updateDate"),
	}
	// An order view with no update timestamp is last changed when it was
	// created — updated falls back to created (TS mapOrder parity:
	// num(o.lastTradeTimestamp) ?? created).
	if order.UpdatedAt == 0 {
		order.UpdatedAt = order.SubmittedAt
	}
	if venueSym := fieldVal(obj, "symbol"); venueSym != "" {
		canonical, err := exchanges.FromVenueSymbol(venueSym, execution.ExchangeMEXC)
		if err != nil {
			return execution.NormalizedOrder{}, err
		}
		order.Symbol = canonical
	}
	// Quantity: the venue echo wins; otherwise our own requested quantity.
	qty := firstNonEmpty(fieldVal(obj, "origQty", "vol", "quantity"), fb.quantity)
	if qty == "" {
		return execution.NormalizedOrder{}, errMalformedPayload
	}
	order.Quantity = qty
	// Filled quantity defaults to "0" (TS NormalizedOrder parity:
	// num(o.filled) ?? 0) — an ack-only response reports no fill yet.
	order.FilledQuantity = firstNonEmpty(fieldVal(obj, "executedQty", "dealVol", "filledQty"), "0")
	// Price: "0"/""/absent is the venue's "no limit price" marker for market
	// orders (ASSUMPTION) → honest nil, never a fabricated "0" price.
	if p := firstNonEmpty(fieldVal(obj, "price"), fb.price); p != "" && p != "0" {
		order.Price = &p
	}
	side, hasSide := parseOrderSide(obj)
	if hasSide {
		order.Side = side
	} else if fb.side != "" {
		order.Side = fb.side
	} else {
		return execution.NormalizedOrder{}, errMalformedPayload
	}
	order.Type = parseOrderType(obj, fb.orderType)
	order.Status = mapWireStatus(fieldVal(obj, "status", "state"))
	if fieldBool(obj, "reduceOnly") {
		order.IsExit = true
	}
	return order, nil
}

// parseOrderSide reads the order side: the spot-form name ("BUY"/"SELL", any
// case) or the assumed contract numeric code (1/2 buy, 3/4 sell).
func parseOrderSide(obj rawJSON) (execution.Side, bool) {
	switch strings.ToUpper(strings.TrimSpace(fieldVal(obj, "side"))) {
	case "BUY", "1", "2":
		return execution.SideBuy, true
	case "SELL", "3", "4":
		return execution.SideSell, true
	}
	return "", false
}

// parseOrderType reads the order type: spot-form names fold to the canonical
// "market"/"limit" pair (the limit-maker family folds to "limit"); assumed
// contract numeric codes map 5→limit, 6→market; anything else falls back to
// the requested type (an ack that reports no type is completed with our own
// request, never invented).
func parseOrderType(obj rawJSON, fallback string) string {
	s, ok := fieldStr(obj, "type", "orderType")
	if !ok {
		return fallback
	}
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "LIMIT", "LIMIT_MAKER", "5":
		return "limit"
	case "MARKET", "6":
		return "market"
	}
	return fallback
}

// parseOrderList normalizes a venue order list (or a single object) into
// canonical orders; symbol is the canonical fallback for payloads that omit
// it.
func parseOrderList(raw json.RawMessage, symbol string) ([]execution.NormalizedOrder, error) {
	objs, err := objectList(raw)
	if err != nil {
		return nil, fmt.Errorf("parse open orders: %w", err)
	}
	orders := make([]execution.NormalizedOrder, 0, len(objs))
	for _, obj := range objs {
		order, err := parseOrder(obj, orderFallback{symbol: symbol})
		if err != nil {
			return nil, fmt.Errorf("parse open orders: %w", err)
		}
		orders = append(orders, order)
	}
	return orders, nil
}

// objectList accepts a JSON array of objects, a single object, or null
// (empty list — the venue answered "nothing").
func objectList(raw json.RawMessage) ([]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}
	if arr, ok := asArray(trimmed); ok {
		return arr, nil
	}
	if _, ok := asObject(trimmed); ok {
		return []json.RawMessage{json.RawMessage(trimmed)}, nil
	}
	return nil, errMalformedPayload
}

// --- balance / equity parsing --------------------------------------------

// parseBalances normalizes the venue balance rows and returns the EXACT
// decimal sum of the row totals as a nullable decimal string (nil when the
// venue reported no rows — an empty list is "nothing reported", never a
// fabricated zero).
//
// ASSUMPTION (wire aliases): spot form rows live in a `balances` member with
// {asset, free, locked}; contract form rows come as a top-level array with
// {currency, available, frozen}. Used = locked/frozen; Total = free+used
// computed exactly (internal/platform/decimal, never float64). Rows that are zero
// everywhere are skipped (TS getBalances parity).
func parseBalances(payload json.RawMessage, market execution.MarketType) ([]execution.Balance, *string, error) {
	var rowsRaw []json.RawMessage
	if market == execution.MarketSpot {
		obj, ok := asObject(payload)
		if !ok {
			return nil, nil, errMalformedPayload
		}
		raw, has := pick(obj, "balances")
		if !has {
			return nil, nil, errMalformedPayload
		}
		arr, ok := asArray(raw)
		if !ok {
			return nil, nil, errMalformedPayload
		}
		rowsRaw = arr
	} else {
		arr, ok := asArray(payload)
		if !ok {
			return nil, nil, errMalformedPayload
		}
		rowsRaw = arr
	}
	assetKeys := []string{"asset", "currency"}
	freeKeys := []string{"free", "available"}
	usedKeys := []string{"locked", "frozen"}
	if market != execution.MarketSpot {
		freeKeys = []string{"available", "free"}
		usedKeys = []string{"frozen", "locked"}
	}
	balances := make([]execution.Balance, 0, len(rowsRaw))
	var sum string
	for _, rowRaw := range rowsRaw {
		obj, ok := asObject(rowRaw)
		if !ok {
			return nil, nil, errMalformedPayload
		}
		asset := fieldVal(obj, assetKeys...)
		if asset == "" {
			return nil, nil, errMalformedPayload
		}
		free := firstNonEmpty(fieldVal(obj, freeKeys...), "0")
		used := firstNonEmpty(fieldVal(obj, usedKeys...), "0")
		total, err := decimal.Add(free, used)
		if err != nil {
			return nil, nil, errMalformedPayload
		}
		if isZeroDecimal(free) && isZeroDecimal(used) {
			continue // zero row: nothing held, nothing to add (TS parity)
		}
		balances = append(balances, execution.Balance{Asset: asset, Free: free, Used: used, Total: total})
		if sum == "" {
			sum = total
		} else if sum, err = decimal.Add(sum, total); err != nil {
			return nil, nil, errMalformedPayload
		}
	}
	if sum == "" {
		return balances, nil, nil
	}
	return balances, &sum, nil
}

// parsePosition normalizes the contract position payload. A missing or
// non-object payload, or a zero holding, is flat — exchanges.ErrNoPosition
// (flat is an answer, a failed fetch is an error). A holding whose direction
// is neither reported (positionType 1/2) nor encoded in a negative magnitude
// is refused as malformed — the side of a position is NEVER guessed.
//
// ASSUMPTION (wire aliases): holdVol∈{holdVol,vol} (magnitude),
// positionType (1 long / 2 short — one-way mode, so the quantity is signed
// from it), openAvgPrice (entry), leverage, marginMode (1 isolated / 2
// cross), liquidationPrice∈{liquidationPrice,liquidatePrice} (nullable — nil
// when unreported, and "0" is the venue's unreported marker → nil).
func parsePosition(payload json.RawMessage, symbol string) (execution.Position, error) {
	obj, ok := asObject(payload)
	if !ok {
		// An empty/non-object payload honestly means no position.
		return execution.Position{}, exchanges.ErrNoPosition
	}
	vol := fieldVal(obj, "holdVol", "vol")
	if vol == "" {
		return execution.Position{}, exchanges.ErrNoPosition
	}
	r, err := decimal.Parse(vol)
	if err != nil {
		return execution.Position{}, errMalformedPayload
	}
	if r.Sign() == 0 {
		return execution.Position{}, exchanges.ErrNoPosition
	}
	magnitude := strings.TrimPrefix(vol, "-")
	side := execution.SideBuy
	switch fieldVal(obj, "positionType") {
	case strconv.Itoa(contractPositionLong):
		side = execution.SideBuy
	case strconv.Itoa(contractPositionShort):
		side = execution.SideSell
	case "", "0":
		// Direction not reported (absent or the zero code): only a signed
		// (negative) holding answers it; a bare positive magnitude is
		// refused, never guessed.
		if !strings.HasPrefix(vol, "-") {
			return execution.Position{}, errMalformedPayload
		}
		side = execution.SideSell
	default:
		return execution.Position{}, errMalformedPayload
	}
	signed := magnitude
	if side == execution.SideSell {
		signed = "-" + magnitude
	}
	pos := execution.Position{
		Symbol:       symbol,
		MarketType:   execution.MarketLinearPerp,
		Side:         side,
		Quantity:     signed,
		EntryPrice:   fieldVal(obj, "openAvgPrice"),
		PositionSide: "net", // one-way mode only (TS: mexc contract accounts are one-way)
	}
	if lev := fieldVal(obj, "leverage"); lev != "" {
		pos.Leverage = &lev
	}
	switch fieldVal(obj, "marginMode") {
	case strconv.Itoa(contractMarginIsolated):
		m := execution.MarginIsolated
		pos.MarginMode = &m
	case strconv.Itoa(contractMarginCross):
		m := execution.MarginCross
		pos.MarginMode = &m
	}
	if lp := fieldVal(obj, "liquidationPrice", "liquidatePrice"); lp != "" && lp != "0" {
		pos.LiquidationPrice = &lp
	}
	return pos, nil
}

// parseTicker normalizes a ticker payload into honest touches: an empty or
// absent bid/ask/last is nil, and "0" is the venue's empty-book marker (also
// nil) — a last-only ticker must never be turned into a fabricated touch
// price (house rule).
//
// ASSUMPTION (wire aliases): spot form fields lastPrice/bidPrice/askPrice on
// a bare object; contract form fields lastPrice/bid1Price/ask1Price, either a
// single object or a list under `data`. With no ticker row at all the venue
// reported no quotes — every touch is nil, Ts is receipt time.
func parseTicker(payload json.RawMessage, symbol string, now int64) (execution.Ticker, error) {
	objs, err := objectList(payload)
	if err != nil {
		return execution.Ticker{}, err
	}
	if len(objs) == 0 {
		return execution.Ticker{Symbol: symbol, Ts: now}, nil
	}
	obj, ok := asObject(objs[0])
	if !ok {
		return execution.Ticker{}, errMalformedPayload
	}
	tick := execution.Ticker{Symbol: symbol, Ts: fieldInt(obj, "closeTime", "timestamp", "ts")}
	if tick.Ts == 0 {
		tick.Ts = now
	}
	tick.Bid = touchPtr(fieldVal(obj, "bidPrice", "bid1Price"))
	tick.Ask = touchPtr(fieldVal(obj, "askPrice", "ask1Price"))
	tick.Last = touchPtr(fieldVal(obj, "lastPrice", "last"))
	return tick, nil
}

// --- fill parsing ---------------------------------------------------------

// parseFills normalizes the venue fill list into canonical Fill rows.
//
// ASSUMPTION (wire aliases): trade id∈{id,tradeId,dealId}, clientOrderId∈{
// clientOrderId} (the spot myTrades form does not echo it — the field stays
// "" honestly), price∈{price,dealPrice}, quantity∈{qty,vol,quantity},
// quoteQuantity∈{quoteQty,cost,quoteQuantity}, fee∈{commission,fee},
// feeAsset∈{commissionAsset,feeCurrency}, timestamp∈{time,createDate,
// createTime}. A missing quoteQuantity is computed exactly as price*quantity
// (TS getFills parity: cost ?? price*amount); a missing fee defaults to "0"
// (TS parity); a missing feeAsset stays "" (an asset code is never
// fabricated, honest nulls outrank the TS 'USDT' default). A missing
// timestamp falls back to receipt time nowMs (TS parity: timestamp ??
// Date.now()) and is receipt time, not a venue claim.
func parseFills(payload json.RawMessage, nowMs int64) ([]execution.Fill, error) {
	items, err := objectList(payload)
	if err != nil {
		return nil, fmt.Errorf("parse fills: %w", err)
	}
	fills := make([]execution.Fill, 0, len(items))
	for _, item := range items {
		obj, ok := asObject(item)
		if !ok {
			return nil, errMalformedPayload
		}
		price := fieldVal(obj, "price", "dealPrice")
		qty := fieldVal(obj, "qty", "vol", "quantity")
		if price == "" || qty == "" {
			return nil, errMalformedPayload
		}
		quote := fieldVal(obj, "quoteQty", "cost", "quoteQuantity")
		if quote == "" {
			computed, err := decimal.Mul(price, qty)
			if err != nil {
				return nil, errMalformedPayload
			}
			quote = computed
		}
		ts := fieldInt(obj, "time", "createDate", "createTime")
		if ts == 0 {
			ts = nowMs
		}
		fills = append(fills, execution.Fill{
			ExchangeTradeID: fieldVal(obj, "id", "tradeId", "dealId"),
			ClientOrderID:   fieldVal(obj, "clientOrderId"),
			Price:           price,
			Quantity:        qty,
			QuoteQuantity:   quote,
			Fee:             firstNonEmpty(fieldVal(obj, "commission", "fee"), "0"),
			FeeAsset:        fieldVal(obj, "commissionAsset", "feeCurrency"),
			Timestamp:       ts,
		})
	}
	return fills, nil
}

// --- tiny helpers ---------------------------------------------------------

// firstNonEmpty returns the first non-empty value — the wire echo wins over
// our request fallback ("0" is a real value, not empty).
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// touchPtr renders a nullable quote touch: "" and "0" are the venue's
// "no quote" markers → honest nil, never a fabricated "0" price.
func touchPtr(v string) *string {
	if v == "" || v == "0" {
		return nil
	}
	return &v
}

// isZeroDecimal reports whether an exact decimal literal is zero (it is only
// used on literals already validated by decimal.Add/decimal.Parse).
func isZeroDecimal(v string) bool {
	r, err := decimal.Parse(v)
	if err != nil {
		return false
	}
	return r.Sign() == 0
}
