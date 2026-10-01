package bybit

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/exchange"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
)

// Bybit v5 response envelope: every call — success or failure — is wrapped in
// {retCode, retMsg, result}. retCode 0 is success; anything else is a venue
// refusal classified through the shared code table (exchange.ClassifyCode).
type envelope struct {
	RetCode int             `json:"retCode"`
	RetMsg  string          `json:"retMsg"`
	Result  json.RawMessage `json:"result"`
}

// Venue error codes this adapter branches on. Classification of every code
// lives in the shared exchange table (exchange.ClassifyCode) — this constant
// exists only for the order-lookup → ErrOrderNotFound contract.
const codeOrderNotExist = "110001"

// venueError renders one envelope failure as a classified *exchange.VenueError.
// retMsg is sanitized to a short single line and the credential halves are
// redacted out of it: raw envelopes, queries, headers and secrets never reach
// the message (PRD §109).
func venueError(retCode int, retMsg string, httpStatus int, creds exchange.Credentials) *exchange.VenueError {
	msg := sanitizeRetMsg(retMsg)
	msg = redactAll(msg, creds.APIKey, creds.APISecret)
	return exchange.NewVenueError(executor.ExchangeBybit, strconv.Itoa(retCode), httpStatus, msg)
}

// redactAll removes every occurrence of the secret material from s (defense in
// depth: a venue message must never be able to echo a credential back into our
// logs). Empty needles are skipped.
func redactAll(s string, needles ...string) string {
	for _, n := range needles {
		if n != "" {
			s = strings.ReplaceAll(s, n, "[redacted]")
		}
	}
	return s
}

// sanitizeRetMsg flattens a venue message to one bounded, control-free line so
// it is safe to render in errors and logs: no bodies smuggle through, no
// terminal escapes, no unbounded text.
func sanitizeRetMsg(msg string) string {
	var b strings.Builder
	for _, r := range msg {
		if r < 0x20 || r == 0x7f {
			r = ' '
		}
		b.WriteRune(r)
		if b.Len() >= 120 {
			break
		}
	}
	return strings.TrimSpace(b.String())
}

// keyInfo is the /v5/user/query-api-key result.
//
// ASSUMPTION: the result reports `readOnly` as 0/1, `note` as the key label and
// `permissions` as a list of scope strings (e.g. "Spot.Order", "Contract.*",
// "Wallet.Withdraw"); a fixture without a permissions list leaves the
// trade/withdraw flags nil — honest null, never inferred.
type keyInfo struct {
	Note        string    `json:"note"`
	ReadOnly    *int      `json:"readOnly"`
	Permissions *[]string `json:"permissions"`
}

// parseKeyInfo decodes one key-info result.
func parseKeyInfo(result json.RawMessage) (keyInfo, error) {
	var info keyInfo
	if err := json.Unmarshal(result, &info); err != nil {
		return keyInfo{}, exchange.NewVenueError(executor.ExchangeBybit, "", 0, "bybit: unparseable key info result")
	}
	return info, nil
}

// mapPermissions derives the contract's trade/withdraw flags from the venue's
// reported scope list. Each flag is non-nil ONLY when the venue supplied a
// permissions list: true where a scope grants the capability, false where the
// list grants it nowhere. Scope prefixes "Spot." and "Contract." name spot vs
// derivatives trading rights; "Wallet.Withdraw" names withdrawal rights.
func mapPermissions(scopes []string) (spot, futures, withdraw *bool) {
	s, f, w := false, false, false
	for _, scope := range scopes {
		switch {
		case strings.HasPrefix(scope, "Spot."):
			s = true
		case strings.HasPrefix(scope, "Contract."):
			f = true
		case scope == "Wallet.Withdraw":
			w = true
		}
	}
	return &s, &f, &w
}

// walletCoin is one coin balance in /v5/account/wallet-balance.
//
// ASSUMPTION: rows report `coin`, `walletBalance` (total) and
// `availableToWithdraw` (the free figure); used is derived exactly as
// total-free (objective §36: decimal.Sub, never float64).
type walletCoin struct {
	Coin                string `json:"coin"`
	WalletBalance       string `json:"walletBalance"`
	AvailableToWithdraw string `json:"availableToWithdraw"`
}

// walletAccount is one account block in /v5/account/wallet-balance; this
// adapter queries a single accountType so list[0] is the queried book.
type walletAccount struct {
	AccountType string       `json:"accountType"`
	TotalEquity string       `json:"totalEquity"`
	Coins       []walletCoin `json:"coin"`
}

// parseWallet decodes the wallet-balance result.
func parseWallet(result json.RawMessage) (walletAccount, error) {
	var wrap struct {
		List []walletAccount `json:"list"`
	}
	if err := json.Unmarshal(result, &wrap); err != nil || len(wrap.List) == 0 {
		return walletAccount{}, exchange.NewVenueError(executor.ExchangeBybit, "", 0, "bybit: unparseable wallet balance result")
	}
	return wrap.List[0], nil
}

// positionRow is one /v5/position/list row.
//
// ASSUMPTION: rows report `positionIdx` (0 one-way, 1/2 hedge long/short),
// `tradeMode` (0 cross, 1 isolated), `side` (Buy/Sell), `size`, `avgPrice`,
// `leverage` and `liqPrice` as decimal strings.
type positionRow struct {
	PositionIdx int    `json:"positionIdx"`
	TradeMode   int    `json:"tradeMode"`
	Symbol      string `json:"symbol"`
	Side        string `json:"side"`
	Size        string `json:"size"`
	EntryPrice  string `json:"avgPrice"`
	Leverage    string `json:"leverage"`
	LiqPrice    string `json:"liqPrice"`
}

// parsePositions decodes the position-list result.
func parsePositions(result json.RawMessage) ([]positionRow, error) {
	var wrap struct {
		List []positionRow `json:"list"`
	}
	if err := json.Unmarshal(result, &wrap); err != nil {
		return nil, exchange.NewVenueError(executor.ExchangeBybit, "", 0, "bybit: unparseable position result")
	}
	return wrap.List, nil
}

// tickerRow is one /v5/market/tickers row (bid1Price/ask1Price/lastPrice;
// empty fields become honest nils upstream).
type tickerRow struct {
	Symbol    string `json:"symbol"`
	Bid1Price string `json:"bid1Price"`
	Ask1Price string `json:"ask1Price"`
	LastPrice string `json:"lastPrice"`
}

// parseTickers decodes the market-tickers result.
func parseTickers(result json.RawMessage) ([]tickerRow, error) {
	var wrap struct {
		List []tickerRow `json:"list"`
	}
	if err := json.Unmarshal(result, &wrap); err != nil {
		return nil, exchange.NewVenueError(executor.ExchangeBybit, "", 0, "bybit: unparseable ticker result")
	}
	return wrap.List, nil
}

// orderRow is one Bybit v5 order object (order/create + order/cancel
// acknowledgements and /v5/order/{realtime,history} rows share this shape).
//
// ASSUMPTION: timestamps are decimal-millisecond STRINGS ("1672282648116"),
// reduceOnly is a JSON boolean, and the create acknowledgement reports only
// orderId + orderLinkId (no status) — an unreported status maps to
// ChildUnknown, never a fabricated one.
type orderRow struct {
	OrderID     string   `json:"orderId"`
	OrderLinkID string   `json:"orderLinkId"`
	Symbol      string   `json:"symbol"`
	Side        string   `json:"side"`
	OrderType   string   `json:"orderType"`
	Price       string   `json:"price"`
	Qty         string   `json:"qty"`
	CumExecQty  string   `json:"cumExecQty"`
	OrderStatus string   `json:"orderStatus"`
	ReduceOnly  flexBool `json:"reduceOnly"`
	CreatedTime string   `json:"createdTime"`
	UpdatedTime string   `json:"updatedTime"`
}

// flexBool accepts the boolean forms venues use for flags (JSON bool,
// "true"/"false", 1/0) without ever guessing: anything else stays false.
type flexBool bool

// UnmarshalJSON implements json.Unmarshaler for flexBool.
func (f *flexBool) UnmarshalJSON(data []byte) error {
	s := strings.Trim(strings.TrimSpace(string(data)), `"`)
	switch strings.ToLower(s) {
	case "true", "1":
		*f = true
	case "false", "0", "", "null":
		*f = false
	}
	return nil
}

// parseOrderAck decodes an order create/cancel acknowledgement result.
func parseOrderAck(result json.RawMessage) (orderRow, error) {
	var row orderRow
	if err := json.Unmarshal(result, &row); err != nil {
		return orderRow{}, exchange.NewVenueError(executor.ExchangeBybit, "", 0, "bybit: unparseable order acknowledgement")
	}
	return row, nil
}

// parseOrders decodes an order-list result (/v5/order/realtime or
// /v5/order/history: {category, list: [...]}).
func parseOrders(result json.RawMessage) ([]orderRow, error) {
	var wrap struct {
		List []orderRow `json:"list"`
	}
	if err := json.Unmarshal(result, &wrap); err != nil {
		return nil, exchange.NewVenueError(executor.ExchangeBybit, "", 0, "bybit: unparseable order list result")
	}
	return wrap.List, nil
}

// executionRow is one /v5/execution/list row.
//
// ASSUMPTION: rows report `execId`, `orderId`, `orderLinkId`, `price`,
// `execQty`, `execFee` (reported negative when paid), `feeCurrency` and
// `execTime` (millisecond strings).
type executionRow struct {
	ExecID      string `json:"execId"`
	OrderID     string `json:"orderId"`
	OrderLinkID string `json:"orderLinkId"`
	Price       string `json:"price"`
	ExecQty     string `json:"execQty"`
	ExecFee     string `json:"execFee"`
	FeeCurrency string `json:"feeCurrency"`
	ExecTime    string `json:"execTime"`
}

// parseExecutions decodes the execution-list result.
func parseExecutions(result json.RawMessage) ([]executionRow, error) {
	var wrap struct {
		List []executionRow `json:"list"`
	}
	if err := json.Unmarshal(result, &wrap); err != nil {
		return nil, exchange.NewVenueError(executor.ExchangeBybit, "", 0, "bybit: unparseable execution list result")
	}
	return wrap.List, nil
}

// mapOrderStatus maps Bybit orderStatus names to the child-order lifecycle:
//
//	New            → ChildOpen
//	PartiallyFilled → ChildPartial
//	Filled         → ChildFilled
//	Cancelled,
//	Canceled       → ChildCancelled
//	Rejected       → ChildRejected
//	Deactivated    → ChildExpired
//	Untriggered,
//	Triggered,
//	Active         → ChildUnknown (trigger-order states this adapter does not
//	                 place: an honest unknown rather than a guessed lifecycle)
//	anything else  → ChildUnknown
//
// The table is the documented bybit→contract status bridge; names outside it
// are never guessed into a lifecycle state (parity with mapOrderStatus's
// UNKNOWN default in apps/web/src/platform/executor/exchange.ts).
func mapOrderStatus(status string) executor.ChildOrderStatus {
	switch status {
	case "New":
		return executor.ChildOpen
	case "PartiallyFilled":
		return executor.ChildPartial
	case "Filled":
		return executor.ChildFilled
	case "Cancelled", "Canceled":
		return executor.ChildCancelled
	case "Rejected":
		return executor.ChildRejected
	case "Deactivated":
		return executor.ChildExpired
	default:
		// Untriggered / Triggered / Active trigger states and unknowns.
		return executor.ChildUnknown
	}
}

// mapSide maps the venue side to the canonical side; anything not Buy/Sell is
// "" — never guessed into a direction.
func mapSide(side string) executor.Side {
	switch side {
	case "Buy":
		return executor.SideBuy
	case "Sell":
		return executor.SideSell
	default:
		return ""
	}
}

// mapSideOut maps the canonical side to the Bybit wire value ("Buy"/"Sell").
func mapSideOut(side executor.Side) (string, bool) {
	switch side {
	case executor.SideBuy:
		return "Buy", true
	case executor.SideSell:
		return "Sell", true
	default:
		return "", false
	}
}

// mapOrderTypeIn maps the venue order type to the canonical type ("market"/
// "limit"); unreported stays empty rather than defaulted.
func mapOrderTypeIn(orderType string) string {
	switch orderType {
	case "Market":
		return "market"
	case "Limit":
		return "limit"
	default:
		return ""
	}
}

// mapOrderTypeOut maps the canonical type to the Bybit wire value
// ("Market"/"Limit").
func mapOrderTypeOut(orderType string) (string, bool) {
	switch orderType {
	case "market":
		return "Market", true
	case "limit":
		return "Limit", true
	default:
		return "", false
	}
}

// mapTimeInForceOut reports whether the canonical TIF is one Bybit v5 speaks
// for this adapter (GTC/IOC/FOK — the wire spelling is identical).
func mapTimeInForceOut(t executor.TimeInForce) bool {
	switch t {
	case executor.TIFGTC, executor.TIFIOC, executor.TIFFOK:
		return true
	default:
		return false
	}
}

// mapPositionSide renders one-way vs hedge from positionIdx
// (0 → "net", 1 → "long", 2 → "short").
func mapPositionSide(idx int) string {
	switch idx {
	case 1:
		return "long"
	case 2:
		return "short"
	default:
		return "net"
	}
}

// mapMarginMode maps tradeMode to the contract margin mode
// (0 → cross, 1 → isolated); other values are honestly nil.
func mapMarginMode(tradeMode int) *executor.MarginMode {
	mm := executor.MarginMode("")
	switch tradeMode {
	case 0:
		mm = executor.MarginCross
	case 1:
		mm = executor.MarginIsolated
	default:
		return nil
	}
	return &mm
}

// parseMillis renders a venue millisecond string, falling back to `fallback`
// when the venue reports nothing (parity with exchange.ts mapOrder's
// `num(o.timestamp) ?? Date.now()`).
func parseMillis(s string, fallback int64) int64 {
	if s == "" {
		return fallback
	}
	ms, err := strconv.ParseInt(s, 10, 64)
	if err != nil || ms == 0 {
		return fallback
	}
	return ms
}
