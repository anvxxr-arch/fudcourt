// Package paper is the deterministic in-memory venue the executor tests run
// against (PRD §118, §127): a first-class exchanges.Exchange with simulated
// matching, settlement, latency and failures. It needs no live credentials,
// never touches the network and never sleeps — simulated time lives on the
// injected exchanges.Clock.
//
// All money and quantity math goes through internal/platform/decimal exact decimal
// strings (objective §36: never float64 in financial paths). Venue
// differences stay inside this package per the exchange boundary rule.
package paper

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/platform/decimal"
)

// venuePaper is the synthetic venue id carried on paper VenueErrors. The
// paper simulator is not one of the live venues, so its errors are attributed
// to "paper" and classified explicitly (the live-venue code tables never
// apply here).
const venuePaper execution.ExchangeID = "paper"

// Named construction/input refusals: callers refuse invalid input by name
// instead of sniffing error text (house rule).
var (
	// ErrInvalidFillRate is returned by NewPaper when PaperConfig.FillRate is
	// not a decimal fraction in (0, 1].
	ErrInvalidFillRate = fmt.Errorf("paper: invalid fill rate")
	// ErrInvalidMark is returned by NewPaper when PaperConfig.Marks holds a
	// non-canonical symbol or a non-positive price.
	ErrInvalidMark = fmt.Errorf("paper: invalid mark")
	// ErrInvalidBalances is returned by NewPaper when PaperConfig.Balances
	// holds an empty/duplicate asset or a negative amount.
	ErrInvalidBalances = fmt.Errorf("paper: invalid balances")
	// ErrIllegalTransition guards the child-order lifecycle: the simulator
	// refuses an illegal status transition instead of silently advancing
	// (PRD §58). It is unreachable through the exported methods (they only
	// perform legal moves) and exists for the lifecycle invariant to be
	// enforced by one shared guard.
	ErrIllegalTransition = fmt.Errorf("paper: illegal child order status transition")
)

// orderState is one paper venue order plus its matching remainder (the TS
// PaperOrderState).
type orderState struct {
	order     execution.NormalizedOrder
	remaining string // unfilled quantity (decimal string)
}

// paperFill is one recorded trade plus the scoping data exchanges.Fill omits
// (the canonical symbol for GetFills filtering and the order id for internal
// bookkeeping).
type paperFill struct {
	fill    execution.Fill
	orderID string
	symbol  string
}

// balanceState is one asset's wallet row in exact decimal strings.
type balanceState struct {
	free string
	used string
}

// positionState is one symbol's one-way signed position (positive long) with
// its average entry price — the TS Position fields the simulator derives.
type positionState struct {
	qty        string
	entryPrice string
}

// Paper is the deterministic in-memory exchanges.Exchange simulator.
//
// DETERMINISM: every observable value — order ids, trade ids, timestamps,
// fill quantities, fees — is a pure function of the PaperConfig, the injected
// clock and the sequence of calls. The only randomness knob (Seed) feeds a
// seeded xorshift32 stream that reproduces the TS rand() contract; with the
// default seed of 0 there is no randomness at all.
//
// Paper is safe for concurrent use: all state lives behind one mutex, so a
// shared instance behaves like one venue account. The Advance/SetMark/
// MoveMarkBps/Match driving methods are first-class: they hold the same lock
// the interface calls do, and are intended for single-threaded test driving.
type Paper struct {
	mu sync.Mutex

	venue     execution.ExchangeID
	market    execution.MarketType
	clock     exchanges.Clock
	offsetMs  int64 // simulated time advance beyond clock.Now()
	latencyMs int64

	fillRate    string
	slippageBps int64
	spreadBps   int64
	makerFee    string // decimal fraction, e.g. "0.0002"
	takerFee    string

	timeoutLeft  int
	networkLeft  int
	overloadLeft int
	rejectLeft   int
	rejectCode   string
	rejectCat    execution.ErrorCategory

	balances  map[string]balanceState
	marks     map[string]string
	// source is the optional live market-data delegate; nil is the hermetic
	// simulator. Guarded by mu like every other field.
	source MarketSource
	orders    map[string]*orderState
	byClient  map[string]string // ClientOrderID -> order id (idempotency, objective §23)
	orderSeq  []string          // acceptance order for stable iteration
	fills     []paperFill
	positions map[string]*positionState
	// instruments are the simulator's reported tradable set (GetMarkets) and
	// makerBps/takerBps the raw bps of its fee schedule (GetFees); the decimal
	// fractions makerFee/takerFee above are the matching fill-time rates.
	instruments  map[string]exchanges.Instrument
	makerBps     string
	takerBps     string
	withdrawPerm bool

	seq      uint32 // deterministic order-id sequence (also the xorshift32 state)
	tradeSeq uint64 // deterministic trade-id sequence
	rngOn    bool
	rngState uint32
}

// NewPaper validates PaperConfig and returns a fresh simulator instance.
// Invalid configuration is refused with a named error (ErrInvalidFillRate,
// ErrInvalidMark, ErrInvalidBalances, exchanges.ErrInvalidSymbol,
// exchanges.ErrInvalidOrder) — never repaired or clamped.
func NewPaper(cfg PaperConfig) (*Paper, error) {
	market := cfg.MarketType
	if market == "" {
		market = execution.MarketSpot
	}
	if market != execution.MarketSpot && market != execution.MarketLinearPerp {
		return nil, fmt.Errorf("%w: market type %q is not spot or linear_perp", exchanges.ErrInvalidOrder, cfg.MarketType)
	}
	clock := cfg.Clock
	if clock == nil {
		clock = exchanges.SystemClock{}
	}
	fillRate, err := validateFillRate(cfg.FillRate)
	if err != nil {
		return nil, err
	}
	marks, err := validateMarks(cfg.Marks)
	if err != nil {
		return nil, err
	}
	balances, err := validateBalances(cfg.Balances)
	if err != nil {
		return nil, err
	}
	if cfg.SlippageBps < 0 || cfg.SpreadBps < 0 || cfg.MakerFeeBps < 0 || cfg.TakerFeeBps < 0 {
		return nil, fmt.Errorf("%w: bps knobs must not be negative", exchanges.ErrInvalidOrder)
	}
	if cfg.Latency < 0 {
		return nil, fmt.Errorf("%w: latency must not be negative", exchanges.ErrInvalidOrder)
	}
	if cfg.TimeoutCalls < 0 || cfg.NetworkErrorCalls < 0 || cfg.OverloadCalls < 0 || cfg.RejectOrders < 0 {
		return nil, fmt.Errorf("%w: failure knob counts must not be negative", exchanges.ErrInvalidOrder)
	}
	rejectCat := cfg.RejectCategory
	if rejectCat == "" {
		rejectCat = execution.ErrInvalidOrder
	}
	if !validRejectCategory(rejectCat) {
		return nil, fmt.Errorf("%w: reject category %q is not in the error taxonomy", exchanges.ErrInvalidOrder, string(rejectCat))
	}
	rejectCode := cfg.RejectCode
	if rejectCode == "" {
		rejectCode = defaultRejectCode
	}
	slippage := cfg.SlippageBps
	if slippage == 0 {
		slippage = defaultSlippageBps
	}
	maker := cfg.MakerFeeBps
	if maker == 0 {
		maker = defaultMakerFeeBps
	}
	taker := cfg.TakerFeeBps
	if taker == 0 {
		taker = defaultTakerFeeBps
	}
	makerRate, err := bpsRate(maker)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", exchanges.ErrInvalidOrder, err)
	}
	takerRate, err := bpsRate(taker)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", exchanges.ErrInvalidOrder, err)
	}

	p := &Paper{
		venue:        venuePaper,
		market:       market,
		clock:        clock,
		latencyMs:    cfg.Latency.Milliseconds(),
		fillRate:     fillRate,
		slippageBps:  slippage,
		spreadBps:    cfg.SpreadBps,
		makerFee:     makerRate,
		takerFee:     takerRate,
		timeoutLeft:  cfg.TimeoutCalls,
		networkLeft:  cfg.NetworkErrorCalls,
		overloadLeft: cfg.OverloadCalls,
		rejectLeft:   cfg.RejectOrders,
		rejectCode:   rejectCode,
		rejectCat:    rejectCat,
		balances:     balances,
		marks:        marks,
		source:       cfg.Source,
		instruments:  cfg.Instruments,
		makerBps:     strconv.FormatInt(maker, 10),
		takerBps:     strconv.FormatInt(taker, 10),
		withdrawPerm: cfg.WithdrawPermission,
		orders:       map[string]*orderState{},
		byClient:     map[string]string{},
		positions:    map[string]*positionState{},
	}
	p.initRand(cfg.Seed)
	return p, nil
}

// nowLocked returns the simulated unix-millis time: the injected clock plus
// the accumulated latency/Advance offset. Paper never mutates the clock (its
// interface is read-only); the offset IS the simulated time move.
func (p *Paper) nowLocked() int64 { return p.clock.Now() + p.offsetMs }

// advanceLatencyLocked charges one simulated call to the clock.
func (p *Paper) advanceLatencyLocked() {
	if p.latencyMs > 0 {
		p.offsetMs += p.latencyMs
	}
}

// beginCall consumes one failure-knob slot, if any, after charging the
// simulated latency. Slot precedence is timeout → network → overload: the
// knobs are consumed in that order when several are armed at once.
func (p *Paper) beginCall() error {
	p.advanceLatencyLocked()
	switch {
	case p.timeoutLeft > 0:
		p.timeoutLeft--
		return timeoutErr()
	case p.networkLeft > 0:
		p.networkLeft--
		return networkErr("simulated network failure")
	case p.overloadLeft > 0:
		p.overloadLeft--
		return overloadErr()
	}
	return nil
}

// timeoutErr builds the simulated request timeout. It wraps
// context.DeadlineExceeded so exchanges.Classify maps it to network_retryable
// both through the carried classification and through the generic timeout
// rules (TS RequestTimeout).
func timeoutErr() error {
	return &exchanges.VenueError{
		Venue:      venuePaper,
		Code:       "paper_timeout",
		HTTPStatus: 408,
		Class:      exchanges.ClassificationFor(execution.ErrNetworkRetryable),
		Message:    "simulated request timeout",
		Cause:      context.DeadlineExceeded,
	}
}

// networkErr builds a simulated transport failure classified
// network_retryable (TS NetworkError).
func networkErr(op string) error {
	return &exchanges.VenueError{
		Venue:   venuePaper,
		Code:    "paper_network",
		Class:   exchanges.ClassificationFor(execution.ErrNetworkRetryable),
		Message: op,
	}
}

// overloadErr builds a simulated venue overload classified exchange_overload
// (TS DDoSProtection).
func overloadErr() error {
	return &exchanges.VenueError{
		Venue:      venuePaper,
		Code:       "paper_overload",
		HTTPStatus: 418,
		Class:      exchanges.ClassificationFor(execution.ErrExchangeOverload),
		Message:    "simulated venue overload",
	}
}

// rejectErr builds a simulated venue order rejection carrying the configured
// code and category (a *exchanges.VenueError per PaperConfig.RejectOrders).
func (p *Paper) rejectErr() error {
	return &exchanges.VenueError{
		Venue:      venuePaper,
		Code:       p.rejectCode,
		HTTPStatus: 400,
		Class:      exchanges.ClassificationFor(p.rejectCat),
		Message:    "simulated venue order rejection",
	}
}

// transitionLocked moves an order to to, refusing illegal lifecycle moves
// (PRD §58: illegal transitions are rejected, never silently absorbed). The
// guard is shared with Match so every status change is table-checked.
func (p *Paper) transitionLocked(o *orderState, to execution.ChildOrderStatus) error {
	if o.order.Status == to {
		return nil
	}
	if !execution.CanTransitionChild(o.order.Status, to) {
		return fmt.Errorf("%w: %s -> %s", ErrIllegalTransition, o.order.Status, to)
	}
	o.order.Status = to
	o.order.UpdatedAt = p.nowLocked()
	return nil
}

// Advance moves simulated time forward by d (d < 0 is refused) and runs one
// matching pass. It is the clock-driving counterpart of the injected
// exchanges.Clock, which Paper cannot mutate.
func (p *Paper) Advance(d time.Duration) error {
	if d < 0 {
		return fmt.Errorf("paper: cannot advance time backwards")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.offsetMs += d.Milliseconds()
	return p.matchLocked()
}

// SetMark sets the last price for a canonical symbol (decimal string). The
// mark is the simulator's only price source. Invalid symbols or non-positive
// prices are refused.
func (p *Paper) SetMark(symbol, price string) error {
	if err := validateSymbol(symbol); err != nil {
		return err
	}
	norm, err := parsePositive(price)
	if err != nil {
		return fmt.Errorf("%w: %s", ErrInvalidMark, err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.marks[symbol] = norm
	return nil
}

// MoveMarkBps multiplies the current mark of symbol by (1 + bps/10000),
// exactly (up and down). It refuses an unknown symbol — a price move is never
// applied to a guessed mark.
func (p *Paper) MoveMarkBps(symbol string, bps int64) error {
	if err := validateSymbol(symbol); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	mark, ok := p.marks[symbol]
	if !ok {
		return fmt.Errorf("%w: no mark for %s", ErrInvalidMark, symbol)
	}
	moved, err := bpsMove(mark, bps)
	if err != nil {
		return err
	}
	p.marks[symbol] = moved
	return nil
}

// bpsMove returns price * (1 + bps/10000) as an exact decimal string.
func bpsMove(price string, bps int64) (string, error) {
	delta, err := decimal.Mul(strconv.FormatInt(bps, 10), oneBps)
	if err != nil {
		return "", err
	}
	factor, err := decimal.Add("1", delta)
	if err != nil {
		return "", err
	}
	moved, err := decimal.Mul(price, factor)
	if err != nil {
		return "", err
	}
	c, err := decimal.Cmp(moved, "0")
	if err != nil {
		return "", err
	}
	if c <= 0 {
		return "", fmt.Errorf("%w: price move to %s is not positive", ErrInvalidMark, moved)
	}
	return moved, nil
}

// Match runs one matching pass over the open orders. Orders are considered in
// acceptance order so partial-fill pacing is deterministic.
func (p *Paper) Match() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.matchLocked()
}

// ---------------------------------------------------------------------------
// exchanges.Exchange — the full canonical venue interface.
// ---------------------------------------------------------------------------

// Exchange asserts at compile time that Paper implements the full venue
// contract.
var _ exchanges.Exchange = (*Paper)(nil)

// GetAccount returns the paper account metadata: label/accountType "paper",
// full read+trade permissions, no withdraw capability (paper models exactly
// this — PRD §43), health ACTIVE and no masked API key (there is no key).
func (p *Paper) GetAccount(ctx context.Context) (execution.AccountMetadata, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return execution.AccountMetadata{}, err
	}
	spot, futures, withdraw := true, true, p.withdrawPerm
	label, accountType := "paper", "paper"
	return execution.AccountMetadata{
		Exchange:    p.venue,
		Label:       &label,
		AccountType: &accountType,
		Permissions: execution.AccountPermissions{
			Read:         true,
			SpotTrade:    &spot,
			FuturesTrade: &futures,
			Withdraw:     &withdraw,
		},
		Health:       execution.HealthActive,
		APIKeyMasked: nil,
	}, nil
}

// GetBalance returns the account equity snapshot. SpotEquity is set for spot
// and FuturesEquity for linear_perp; the OTHER side is honestly nil (the
// simulator reports exactly the basis it models). TotalEquity is the sum of
// balance totals (cross-asset aggregation is nominal, as in the TS
// simulator). Balances are stably sorted by asset.
func (p *Paper) GetBalance(ctx context.Context) (execution.AccountEquity, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return execution.AccountEquity{}, err
	}
	balances := p.balanceRowsLocked()
	var total *string
	acc := "0"
	for _, b := range balances {
		acc, _ = decimal.Add(acc, b.Total)
	}
	total = &acc
	equity := execution.AccountEquity{
		Balances:  balances,
		Timestamp: p.nowLocked(),
	}
	if p.market == execution.MarketSpot {
		equity.SpotEquity = total
		equity.FuturesEquity = nil
	} else {
		equity.SpotEquity = nil
		equity.FuturesEquity = total
	}
	return equity, nil
}

// balanceRowsLocked renders the wallet rows stably sorted by asset with
// total = free + used recomputed exactly.
func (p *Paper) balanceRowsLocked() []execution.Balance {
	assets := make([]string, 0, len(p.balances))
	for asset := range p.balances {
		assets = append(assets, asset)
	}
	sort.Strings(assets)
	rows := make([]execution.Balance, 0, len(assets))
	for _, asset := range assets {
		b := p.balances[asset]
		total, _ := decimal.Add(b.free, b.used)
		rows = append(rows, execution.Balance{Asset: asset, Free: b.free, Used: b.used, Total: total})
	}
	return rows
}

// GetPosition returns the one-way position with its SIGNED quantity
// (positive long, negative short — records.go contract). Flat is
// exchanges.ErrNoPosition — an answer, never conflated with a failed fetch
// (interface contract).
func (p *Paper) GetPosition(ctx context.Context, symbol string) (execution.Position, error) {
	if err := validateSymbol(symbol); err != nil {
		return execution.Position{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return execution.Position{}, err
	}
	pos, ok := p.positions[symbol]
	if !ok || pos.qty == "0" {
		return execution.Position{}, exchanges.ErrNoPosition
	}
	// Quantity is SIGNED (positive long, negative short — records.go contract);
	// Side mirrors its sign for one-way mode.
	side := execution.SideBuy
	if strings.HasPrefix(pos.qty, "-") {
		side = execution.SideSell
	}
	return execution.Position{
		Symbol:           symbol,
		MarketType:       p.market,
		Side:             side,
		Quantity:         pos.qty,
		EntryPrice:       pos.entryPrice,
		Leverage:         nil, // paper does not model leverage (honest null)
		MarginMode:       nil, // paper does not model margin (honest null)
		LiquidationPrice: nil, // no liquidation engine exists (honest null)
		PositionSide:     "net",
	}, nil
}

// GetTicker returns the mark as Last. Bid/Ask are derived from the symmetric
// spread only when SpreadBps > 0; otherwise they are honestly nil — a
// last-only ticker is never turned into fabricated touch prices.
func (p *Paper) GetTicker(ctx context.Context, symbol string) (execution.Ticker, error) {
	if err := validateSymbol(symbol); err != nil {
		return execution.Ticker{}, err
	}
	// Live source: delegate the quote (the faithful TS mirror — the paper
	// venue owns matching, the source owns the tape).
	if src := p.sourceRef(); src != nil {
		return src.GetTicker(ctx, symbol)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return execution.Ticker{}, err
	}
	mark, ok := p.marks[symbol]
	if !ok {
		return execution.Ticker{}, fmt.Errorf("%w: no mark for %s", ErrInvalidMark, symbol)
	}
	last := mark
	ticker := execution.Ticker{
		Symbol: symbol,
		Last:   &last,
		Ts:     p.nowLocked(),
	}
	if p.spreadBps > 0 {
		bid, err := bpsMove(mark, -p.spreadBps/2)
		if err != nil {
			return execution.Ticker{}, err
		}
		ask, err := bpsMove(mark, p.spreadBps/2)
		if err != nil {
			return execution.Ticker{}, err
		}
		ticker.Bid = &bid
		ticker.Ask = &ask
	}
	return ticker, nil
}

// CreateOrder validates and places one order idempotently by ClientOrderID
// (objective §23): a resubmission returns the SAME order and creates nothing
// new. Invalid requests are refused with exchanges.ErrInvalidOrder; a
// simulated venue rejection (RejectOrders) fires after validation and before
// any state is created. Acceptance creates the order and runs one matching
// pass.
func (p *Paper) CreateOrder(ctx context.Context, req execution.OrderRequest) (execution.NormalizedOrder, error) {
	if req.ClientOrderID == "" {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: missing client order id", exchanges.ErrInvalidOrder)
	}
	if err := validateSymbol(req.Symbol); err != nil {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: %v", exchanges.ErrInvalidOrder, err)
	}
	if req.Side != execution.SideBuy && req.Side != execution.SideSell {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: side %q is not buy or sell", exchanges.ErrInvalidOrder, string(req.Side))
	}
	if req.OrderType != "market" && req.OrderType != "limit" {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: type %q is not market or limit", exchanges.ErrInvalidOrder, req.OrderType)
	}
	// TimeInForce is validated but NOT simulated: the paper matcher has no
	// order book or queue, so IOC/FOK behave like GTC. Refusing the unknown
	// vocabulary keeps garbage out without pretending to model TIF semantics.
	switch req.TimeInForce {
	case "", execution.TIFGTC, execution.TIFIOC, execution.TIFFOK:
	default:
		return execution.NormalizedOrder{}, fmt.Errorf("%w: time in force %q is not GTC, IOC or FOK", exchanges.ErrInvalidOrder, string(req.TimeInForce))
	}
	qty, err := parsePositive(req.Quantity)
	if err != nil {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: quantity: %v", exchanges.ErrInvalidOrder, err)
	}
	var price string
	if req.OrderType == "limit" {
		price, err = parsePositive(req.Price)
		if err != nil {
			return execution.NormalizedOrder{}, fmt.Errorf("%w: limit price: %v", exchanges.ErrInvalidOrder, err)
		}
	} else if req.Price != "" {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: market order must not carry a price", exchanges.ErrInvalidOrder)
	}
	if req.Intent != execution.IntentOpen && req.Intent != execution.IntentClose && req.Intent != execution.IntentReduce {
		return execution.NormalizedOrder{}, fmt.Errorf("%w: intent %q is not open, close or reduce", exchanges.ErrInvalidOrder, string(req.Intent))
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if id, ok := p.byClient[req.ClientOrderID]; ok {
		return p.orders[id].order, nil // idempotent replay: same order, nothing new
	}
	if err := p.beginCall(); err != nil {
		return execution.NormalizedOrder{}, err
	}
	if p.rejectLeft > 0 {
		p.rejectLeft--
		return execution.NormalizedOrder{}, p.rejectErr()
	}

	now := p.nowLocked()
	p.seq++
	id := fmt.Sprintf("paper_order_%d", p.seq)
	var pricePtr *string
	if price != "" {
		pricePtr = &price
	}
	o := &orderState{
		order: execution.NormalizedOrder{
			ExchangeOrderID: id,
			ClientOrderID:   req.ClientOrderID,
			Symbol:          req.Symbol,
			Side:            req.Side,
			Type:            req.OrderType,
			Price:           pricePtr,
			Quantity:        qty,
			FilledQuantity:  "0",
			Status:          execution.ChildOpen,
			IsExit:          req.Intent != execution.IntentOpen,
			SubmittedAt:     now,
			UpdatedAt:       now,
		},
		remaining: qty,
	}
	p.orders[id] = o
	p.byClient[req.ClientOrderID] = id
	p.orderSeq = append(p.orderSeq, id)
	if err := p.matchLocked(); err != nil {
		return execution.NormalizedOrder{}, err
	}
	return o.order, nil
}

// CancelOrder cancels an open or partially filled order. Unknown ids are
// exchanges.ErrOrderNotFound; cancelling an already filled order is refused
// with a *exchanges.VenueError (invalid_order) — a filled order is gone, not
// cancellable. Cancelling an already cancelled order is an idempotent no-op
// that returns the order unchanged.
func (p *Paper) CancelOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	if err := validateSymbol(symbol); err != nil {
		return execution.NormalizedOrder{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return execution.NormalizedOrder{}, err
	}
	o, ok := p.orders[exchangeOrderID]
	if !ok || o.order.Symbol != symbol {
		return execution.NormalizedOrder{}, exchanges.ErrOrderNotFound
	}
	switch o.order.Status {
	case execution.ChildFilled:
		return execution.NormalizedOrder{}, &exchanges.VenueError{
			Venue:      venuePaper,
			Code:       "paper_reject",
			HTTPStatus: 400,
			Class:      exchanges.ClassificationFor(execution.ErrInvalidOrder),
			Message:    "order already filled",
		}
	case execution.ChildCancelled:
		return o.order, nil
	}
	if err := p.transitionLocked(o, execution.ChildCancelled); err != nil {
		return execution.NormalizedOrder{}, err
	}
	return o.order, nil
}

// GetOrder fetches one order by venue order id. Unknown ids are
// exchanges.ErrOrderNotFound; a mismatched symbol is likewise not found (the
// id is scoped per symbol, mirroring the cancel contract).
func (p *Paper) GetOrder(ctx context.Context, symbol, exchangeOrderID string) (execution.NormalizedOrder, error) {
	if err := validateSymbol(symbol); err != nil {
		return execution.NormalizedOrder{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return execution.NormalizedOrder{}, err
	}
	o, ok := p.orders[exchangeOrderID]
	if !ok || o.order.Symbol != symbol {
		return execution.NormalizedOrder{}, exchanges.ErrOrderNotFound
	}
	return o.order, nil
}

// GetOpenOrders lists the open/partial orders on symbol in acceptance order
// (deterministic). Unknown symbols are refused; a symbol with no open orders
// is an empty slice, not an error.
func (p *Paper) GetOpenOrders(ctx context.Context, symbol string) ([]execution.NormalizedOrder, error) {
	if err := validateSymbol(symbol); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return nil, err
	}
	var out []execution.NormalizedOrder
	for _, id := range p.orderSeq {
		o := p.orders[id]
		if o.order.Symbol != symbol {
			continue
		}
		if o.order.Status == execution.ChildOpen || o.order.Status == execution.ChildPartial {
			out = append(out, o.order)
		}
	}
	return out, nil
}

// GetFills returns only fills THIS exchange made (the in-memory store is
// per-instance, never shared with other venues), filtered by the requested
// symbol in chronological order.
func (p *Paper) GetFills(ctx context.Context, symbol string) ([]execution.Fill, error) {
	if err := validateSymbol(symbol); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return nil, err
	}
	var out []execution.Fill
	for _, f := range p.fills {
		if f.symbol == symbol {
			out = append(out, f.fill)
		}
	}
	return out, nil
}

// GetMarkets returns the simulator's configured instruments, one canonical
// Market per symbol, sorted by symbol so the result is deterministic. A paper
// venue with no configured instruments returns an EMPTY list (not an error):
// the simulator genuinely has no tradable set, and the planner's missing-symbol
// refusal — not a fabricated grid — is the honest outcome.
func (p *Paper) GetMarkets(ctx context.Context) ([]exchanges.Market, error) {
	if src := p.sourceRef(); src != nil {
		return src.GetMarkets(ctx)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return nil, err
	}
	markets := make([]exchanges.Market, 0, len(p.instruments))
	for symbol, instr := range p.instruments {
		markets = append(markets, exchanges.Market{
			Symbol:     symbol,
			MarketType: instr.MarketType,
			Metadata:   instr,
		})
	}
	sort.Slice(markets, func(i, j int) bool { return markets[i].Symbol < markets[j].Symbol })
	return markets, nil
}

// GetFees returns the simulator's fee schedule for symbol in bps, matching the
// maker/taker rates it charges at fill time (GetFees and settlement can never
// disagree). An unknown symbol is refused — the planner priced an entry the
// venue does not list.
func (p *Paper) GetFees(ctx context.Context, symbol string) (exchanges.FeeModel, error) {
	if err := validateSymbol(symbol); err != nil {
		return exchanges.FeeModel{}, err
	}
	if src := p.sourceRef(); src != nil {
		return src.GetFees(ctx, symbol)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.beginCall(); err != nil {
		return exchanges.FeeModel{}, err
	}
	if _, ok := p.instruments[symbol]; !ok {
		return exchanges.FeeModel{}, fmt.Errorf("%w: %s", exchanges.ErrFeesUnavailable, symbol)
	}
	return exchanges.FeeModel{MakerBps: p.makerBps, TakerBps: p.takerBps}, nil
}
