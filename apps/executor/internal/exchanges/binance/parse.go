package binance

// This file holds the wire→canonical PARSING and input-validation layer: the
// Binance response payload shapes and every mapping into the executor
// contract types (order, status, side, margin mode, nullable decimals).

import (
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
)

// wire payloads --------------------------------------------------------------

// orderWire is the Binance order payload (spot /api/v3/order shape; the
// /fapi/v2 shape carries the same field names for these columns).
type orderWire struct {
	Symbol        string `json:"symbol"`
	OrderID       int64  `json:"orderId"`
	ClientOrderID string `json:"clientOrderId"`
	Side          string `json:"side"`
	Type          string `json:"type"`
	Price         string `json:"price"`
	OrigQty       string `json:"origQty"`
	ExecutedQty   string `json:"executedQty"`
	Status        string `json:"status"`
	TimeInForce   string `json:"timeInForce"`
	Time          int64  `json:"time"`
	UpdateTime    int64  `json:"updateTime"`
	WorkingTime   int64  `json:"workingTime"`
}

// tradeWire is one /api/v3/myTrades row.
//
// ASSUMPTION: the classic /api/v3/myTrades row carries no client order id;
// ClientOrderID is kept in the struct and left EMPTY unless the venue supplies
// one — it is never reconstructed from the order id or guessed.
type tradeWire struct {
	ID              int64  `json:"id"`
	OrderID         int64  `json:"orderId"`
	ClientOrderID   string `json:"clientOrderId"`
	Price           string `json:"price"`
	Qty             string `json:"qty"`
	QuoteQty        string `json:"quoteQty"`
	Commission      string `json:"commission"`
	CommissionAsset string `json:"commissionAsset"`
	Time            int64  `json:"time"`
}

// positionRiskRow is one /fapi/v2/positionRisk row (the columns this adapter
// reads).
type positionRiskRow struct {
	Symbol           string `json:"symbol"`
	PositionAmt      string `json:"positionAmt"`
	EntryPrice       string `json:"entryPrice"`
	MarkPrice        string `json:"markPrice"`
	UnRealizedProfit string `json:"unRealizedProfit"`
	LiquidationPrice string `json:"liquidationPrice"`
	Leverage         string `json:"leverage"`
	MarginType       string `json:"marginType"`
	PositionSide     string `json:"positionSide"`
}

// normalize maps one wire order to the canonical NormalizedOrder. symbol is
// the CANONICAL symbol supplied by the caller; the wire symbol is accepted as
// a self-check and mapped back via exchanges.FromVenueSymbol. request is
// non-nil only on the CreateOrder path (for IsExit/ReduceOnly intent that the
// order payload does not echo).
//
// Type mapping: LIMIT → "limit", MARKET → "market", anything else is passed
// through lowercased (never guessed). Timestamps: SubmittedAt is the wire
// `time` (or workingTime when time is absent), UpdatedAt is `updateTime` (or
// time) — both 0 when the venue reports none, never Clock.Now() fabricated.
func (b *Binance) normalize(o orderWire, symbol string, request *execution.OrderRequest) execution.NormalizedOrder {
	side := execution.SideBuy
	if strings.EqualFold(o.Side, "SELL") {
		side = execution.SideSell
	}
	typ := strings.ToLower(o.Type)
	price := nullableStr(o.Price) // market orders echo 0.00000000 → nil
	submitted := o.Time
	if submitted == 0 {
		submitted = o.WorkingTime
	}
	updated := o.UpdateTime
	if updated == 0 {
		updated = submitted
	}
	qty := o.OrigQty
	if qty == "" {
		qty = "0"
	}
	filled := o.ExecutedQty
	if filled == "" {
		filled = "0"
	}
	isExit := false
	if request != nil {
		isExit = request.ReduceOnly || request.Intent == execution.IntentClose
	}
	sym := symbol
	if mapped, err := exchanges.FromVenueSymbol(o.Symbol, venueID); err == nil && mapped != "" {
		sym = mapped
	}
	return execution.NormalizedOrder{
		ExchangeOrderID: strconv.FormatInt(o.OrderID, 10),
		ClientOrderID:   o.ClientOrderID,
		Symbol:          sym,
		Side:            side,
		Type:            typ,
		Price:           price,
		Quantity:        qty,
		FilledQuantity:  filled,
		Status:          mapOrderStatus(o.Status),
		IsExit:          isExit,
		SubmittedAt:     submitted,
		UpdatedAt:       updated,
	}
}

// mapOrderStatus maps the Binance wire status names to the canonical
// child-order lifecycle. The parity oracle (frontend/web exchange.ts mapOrderStatus)
// maps ccxt's lowercase states: open→OPEN, closed→FILLED,
// canceled/cancelled→CANCELLED, rejected→REJECTED, expired→EXPIRED,
// default→UNKNOWN. This adapter speaks the RAW Binance names and extends the
// table with the fully documented wire vocabulary:
//
//	NEW            → ChildOpen       (ccxt "open")
//	PARTIALLY_FILLED → ChildPartial   (ccxt "open" — kept distinct here)
//	FILLED         → ChildFilled     (ccxt "closed")
//	CANCELED       → ChildCancelled  (ccxt "canceled")
//	EXPIRED        → ChildExpired
//	REJECTED       → ChildRejected
//	open/closed/cancelled/rejected/expired lowercase aliases also accepted;
//	anything else → ChildUnknown (never guessed into a lifecycle state).
func mapOrderStatus(status string) execution.ChildOrderStatus {
	switch status {
	case "NEW", "open":
		return execution.ChildOpen
	case "PARTIALLY_FILLED", "partially_filled":
		return execution.ChildPartial
	case "FILLED", "closed":
		return execution.ChildFilled
	case "CANCELED", "CANCELLED", "canceled", "cancelled":
		return execution.ChildCancelled
	case "REJECTED", "rejected":
		return execution.ChildRejected
	case "EXPIRED", "expired":
		return execution.ChildExpired
	default:
		return execution.ChildUnknown
	}
}

// wireSide maps the canonical side to the Binance uppercase vocabulary.
func wireSide(s execution.Side) string {
	if s == execution.SideSell {
		return "SELL"
	}
	return "BUY"
}

// wireOrderType maps the canonical order type to the Binance vocabulary.
func wireOrderType(t string) string {
	if t == "market" {
		return "MARKET"
	}
	return "LIMIT"
}

// positionSideFromWire maps the hedge-mode positionSide column; "BOTH" is the
// one-way marker. Unrecognized values are kept VERBATIM (the venue's own
// column) rather than guessed into a canonical enum.
func positionSideFromWire(w string) string {
	switch w {
	case "BOTH":
		return "net"
	case "LONG":
		return "long"
	case "SHORT":
		return "short"
	default:
		return w
	}
}

// marginModeFromWire maps the venue marginType column to the canonical enum;
// unrecognized values are nil (honest null, never fabricated).
func marginModeFromWire(w string) *execution.MarginMode {
	switch w {
	case "isolated":
		m := execution.MarginIsolated
		return &m
	case "cross":
		m := execution.MarginCross
		return &m
	default:
		return nil
	}
}

// nullableStr renders a wire decimal as a canonical nullable decimal string:
// empty or venue "0.00000000"-style zero placeholders are treated as absent →
// nil; any other value is preserved VERBATIM (no float64, objective §36).
func nullableStr(v string) *string {
	if v == "" || isZeroDecimal(v) {
		return nil
	}
	s := v
	return &s
}

// isZeroDecimal reports whether a wire decimal string is exactly zero in any
// scale ("0", "0.0", "0.00000000").
func isZeroDecimal(v string) bool {
	for _, c := range v {
		if c != '0' && c != '.' {
			return false
		}
	}
	return v != ""
}

// validateOrder refuses malformed order requests with named errors before any
// request is built (house rule: no wire fields are guessed from bad input).
func validateOrder(req execution.OrderRequest) error {
	if req.ClientOrderID == "" {
		return exchanges.ErrInvalidOrder
	}
	if req.Side != execution.SideBuy && req.Side != execution.SideSell {
		return exchanges.ErrInvalidOrder
	}
	switch req.OrderType {
	case "limit":
		if req.TimeInForce != execution.TIFGTC && req.TimeInForce != execution.TIFIOC && req.TimeInForce != execution.TIFFOK {
			return exchanges.ErrInvalidOrder
		}
		price, err := decimal.Parse(req.Price)
		if err != nil || price.Sign() <= 0 {
			return exchanges.ErrInvalidOrder
		}
	case "market":
		if req.Price != "" {
			return exchanges.ErrInvalidOrder // market orders carry no price
		}
	default:
		return exchanges.ErrInvalidOrder
	}
	qty, err := decimal.Parse(req.Quantity)
	if err != nil {
		return exchanges.ErrInvalidOrder
	}
	if qty.Sign() <= 0 {
		return exchanges.ErrInvalidOrder
	}
	return nil
}
