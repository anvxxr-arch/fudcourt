package paper

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/exchanges"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/platform/decimal"
)

// Defaults mirror the TS PaperExchangeAdapter knobs. They exist so a zero
// PaperConfig still behaves like the TS simulator with its documented
// defaults, while tests can override any single dimension in isolation.
const (
	defaultFillRate    = "1" // full fill per pass: the Go tests' zero config
	defaultSlippageBps = 5   // TS PAPER_SLIPPAGE_BPS default
	defaultMakerFeeBps = 2   // TS PAPER_MAKER_FEE_BPS
	defaultTakerFeeBps = 5   // TS PAPER_TAKER_FEE_BPS
	defaultRejectCode  = "paper_reject"
	dustQty            = "0.000000000001" // 1e-12: TS matcher's remainder threshold
	oneBps             = "0.0001"         // 1 bps as a decimal fraction
)

// PaperConfig is the complete knob surface of the simulator (PRD §118, §127).
// WHY: every scenario an executor test needs — partial fills, slippage,
// spreads, simulated latency, transport failures, venue rejections, price
// moves — is expressible as data here, so runs are reproducible from the
// config alone: no network, no credentials, no real sleeping.
//
// Zero-value semantics cannot distinguish "unset" from "none" for the integer
// knobs (Go zero values), so 0 selects the documented default for
// SlippageBps/MakerFeeBps/TakerFeeBps and those exact-zero settings are NOT
// configurable; SpreadBps and Latency are the exception: their documented
// semantics ARE "0 means none". Negative values are refused, never clamped.
type PaperConfig struct {
	// Source is the optional LIVE market-data source (a live venue adapter).
	// Nil keeps the hermetic simulator: prices come from Marks and no network
	// is touched. Non-nil makes this the production paper venue whose tape is
	// live while matching and settlement stay paper-owned — the faithful
	// mirror of the TS PaperExchangeAdapter. When Source is set, Marks is used
	// only as an initial seed and is superseded by the live ticker.
	Source MarketSource
	// MarketType selects the settlement model ("" defaults to
	// execution.MarketSpot): spot moves base vs quote, linear_perp settles
	// quote with realized PnL (see settleLocked).
	MarketType execution.MarketType
	// Clock is the injected time source (default exchanges.SystemClock). Tests
	// pin exchanges.FixedClock so timestamps and simulated latency are exact;
	// Paper never mutates the clock (the interface is read-only) — simulated
	// time is Clock.Now() plus an internal offset that Latency and Advance
	// move forward.
	Clock exchanges.Clock
	// Balances are the initial balance rows. Total is recomputed as
	// free+used so the row can never contradict itself. Rows with an empty
	// asset, a duplicate asset or a negative amount are refused.
	Balances []execution.Balance
	// Marks maps canonical symbol ("BTC/USDT") to its last price. Keys must be
	// canonical and prices positive decimals; the mark is the ONLY price source
	// (the paper venue has no order book) and drives limit crosses, market
	// fills and GetTicker.Last.
	Marks map[string]string
	// FillRate is the fraction of an order quantity filled per matching pass
	// ("" defaults to "1" = full fill; "0.4" reproduces the TS fillRate
	// pacing where an order fills across 2-3 passes). Must be a decimal
	// fraction in (0, 1].
	FillRate string
	// SlippageBps is the market-order slippage applied away from the mark
	// (buys fill above, sells below). 0 selects the TS default of 5 bps.
	SlippageBps int64
	// SpreadBps derives bid/ask around the mark (symmetric). 0 means Bid/Ask
	// are honestly nil in GetTicker — a last-only ticker must never be turned
	// into fabricated touch prices (house rule).
	SpreadBps int64
	// MakerFeeBps is the fee on limit fills, charged in the quote asset.
	// 0 selects the TS PAPER_MAKER_FEE_BPS default of 2.
	MakerFeeBps int64
	// TakerFeeBps is the fee on market fills, charged in the quote asset.
	// 0 selects the TS PAPER_TAKER_FEE_BPS default of 5.
	TakerFeeBps int64
	// Latency is simulated per-call latency: every exchanges.Exchange call
	// advances the simulated clock by this duration before stamping its
	// effects. It NEVER sleeps — tests set it to 0 and keep full speed while
	// still proving time advanced via a fixed clock. Sub-millisecond amounts
	// truncate (timestamps are unix millis per the executor convention).
	Latency time.Duration
	// Seed is the ONLY randomness knob. 0 (default) means there is no
	// randomness at all — slippage is exactly SlippageBps. A non-zero seed
	// feeds the seeded xorshift32 stream (the TS rand() contract) that jitters
	// each market fill's slippage uniformly over 0..SlippageBps bps; identical
	// seeds replay identical fills. Limit fills never slip: they fill at the
	// limit price.
	Seed int64
	// TimeoutCalls makes the next N exchanges.Exchange calls fail as a
	// simulated request timeout, classified network_retryable and wrapping
	// context.DeadlineExceeded. One slot is consumed per call.
	TimeoutCalls int
	// NetworkErrorCalls makes the next N exchanges.Exchange calls fail as a
	// simulated transport failure, classified network_retryable. One slot is
	// consumed per call.
	NetworkErrorCalls int
	// OverloadCalls makes the next N exchanges.Exchange calls fail as a
	// simulated venue overload, classified exchange_overload. One slot is
	// consumed per call.
	OverloadCalls int
	// RejectOrders makes the next N CreateOrder calls land as simulated venue
	// rejections (a *exchanges.VenueError carrying RejectCode/RejectCategory)
	// AFTER input validation and BEFORE any state is created, so a retry with
	// the same ClientOrderID can still place the order.
	RejectOrders int
	// RejectCode is the venue code reported on simulated rejections
	// (default "paper_reject").
	RejectCode string
	// RejectCategory is the error category of simulated rejections
	// (default execution.ErrInvalidOrder).
	RejectCategory execution.ErrorCategory
	// WithdrawPermission is the withdrawal flag GetAccount reports. The zero
	// value (false) mirrors a key WITHOUT withdrawal — the only kind FUDCourt
	// supports (PRD §43) — so a test that needs the refusal sets it true.
	WithdrawPermission bool
	// Instruments are the tradable instruments this simulator reports from
	// GetMarkets, keyed by canonical symbol. The paper venue has no wire
	// instrument list, so the caller supplies one; a symbol that clears
	// GetTicker but has no instrument here is refused by the planner, never
	// rounded against a fabricated grid.
	Instruments map[string]exchanges.Instrument
}

// bpsRate converts basis points to a decimal fraction ("5" -> "0.0005") so
// every fee/slippage/spread computation stays in exact decimal strings.
func bpsRate(bps int64) (string, error) {
	rate, err := decimal.Mul(strconv.FormatInt(bps, 10), oneBps)
	if err != nil {
		return "", fmt.Errorf("paper: bps rate %d: %w", bps, err)
	}
	return rate, nil
}

// splitSymbol splits a canonical BASE/QUOTE symbol. The paper venue has no
// wire symbol form — exchanges.ToVenueSymbol refuses the synthetic venue id
// and its known-quote table models live-venue concatenation — so the plain
// canonical split is validated here and refused with exchanges.ErrInvalidSymbol
// rather than guessed.
func splitSymbol(symbol string) (base, quote string, err error) {
	base, quote, ok := strings.Cut(symbol, "/")
	if !ok || base == "" || quote == "" || strings.Contains(quote, "/") {
		return "", "", exchanges.ErrInvalidSymbol
	}
	return base, quote, nil
}

// validateSymbol reports whether symbol is canonical BASE/QUOTE.
func validateSymbol(symbol string) error {
	_, _, err := splitSymbol(symbol)
	return err
}

// parseNonNegative validates and normalizes a non-negative decimal string
// ("1.2300" -> "1.23"). Malformed or negative values are refused, never
// clamped (house rule).
func parseNonNegative(s string) (string, error) {
	r, err := decimal.Parse(s)
	if err != nil {
		return "", fmt.Errorf("%q is not a decimal: %v", s, err)
	}
	if r.Sign() < 0 {
		return "", fmt.Errorf("%q must not be negative", s)
	}
	return decimal.Trim(r), nil
}

// parsePositive validates and normalizes a strictly positive decimal string.
func parsePositive(s string) (string, error) {
	norm, err := parseNonNegative(s)
	if err != nil {
		return "", err
	}
	c, err := decimal.Cmp(norm, "0")
	if err != nil {
		return "", err
	}
	if c <= 0 {
		return "", fmt.Errorf("%q must be positive", s)
	}
	return norm, nil
}

// validateFillRate normalizes the fill-rate fraction and refuses anything
// outside (0, 1]: a zero rate would stall every order forever and a rate
// above one would fill more than exists.
func validateFillRate(fillRate string) (string, error) {
	if fillRate == "" {
		fillRate = defaultFillRate
	}
	norm, err := parsePositive(fillRate)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidFillRate, err)
	}
	c, err := decimal.Cmp(norm, "1")
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidFillRate, err)
	}
	if c > 0 {
		return "", fmt.Errorf("%w: %q must be <= 1", ErrInvalidFillRate, fillRate)
	}
	return norm, nil
}

// validateMarks copies and normalizes the configured marks, refusing
// non-canonical symbols and non-positive prices (a mark is a traded price —
// zero or negative marks are garbage that would poison every cross check).
func validateMarks(marks map[string]string) (map[string]string, error) {
	out := make(map[string]string, len(marks))
	for symbol, price := range marks {
		if err := validateSymbol(symbol); err != nil {
			return nil, fmt.Errorf("%w: mark symbol %q: %w", ErrInvalidMark, symbol, err)
		}
		norm, err := parsePositive(price)
		if err != nil {
			return nil, fmt.Errorf("%w: %s = %v", ErrInvalidMark, symbol, err)
		}
		out[symbol] = norm
	}
	return out, nil
}

// validateBalances copies and normalizes the initial balances (total is
// recomputed as free+used) and refuses empty/duplicate assets or negative
// amounts: initial state is configuration, and garbage configuration is
// refused rather than silently repaired.
func validateBalances(rows []execution.Balance) (map[string]balanceState, error) {
	out := make(map[string]balanceState, len(rows))
	for _, row := range rows {
		if row.Asset == "" {
			return nil, fmt.Errorf("%w: balance row without an asset", ErrInvalidBalances)
		}
		if _, dup := out[row.Asset]; dup {
			return nil, fmt.Errorf("%w: duplicate balance row for %s", ErrInvalidBalances, row.Asset)
		}
		free, err := parseNonNegative(row.Free)
		if err != nil {
			return nil, fmt.Errorf("%w: %s free: %v", ErrInvalidBalances, row.Asset, err)
		}
		used, err := parseNonNegative(row.Used)
		if err != nil {
			return nil, fmt.Errorf("%w: %s used: %v", ErrInvalidBalances, row.Asset, err)
		}
		if _, err := decimal.Add(free, used); err != nil {
			return nil, fmt.Errorf("%w: %s total: %v", ErrInvalidBalances, row.Asset, err)
		}
		out[row.Asset] = balanceState{free: free, used: used}
	}
	return out, nil
}

// validRejectCategory reports whether c is one of the executor taxonomy
// categories; simulated rejections must classify into a real bucket, never a
// free-form string.
func validRejectCategory(c execution.ErrorCategory) bool {
	switch c {
	case execution.ErrNetworkRetryable, execution.ErrRateLimited, execution.ErrExchangeOverload,
		execution.ErrInvalidOrder, execution.ErrPermissionError, execution.ErrInsufficientBalance,
		execution.ErrFatal, execution.ErrUnknown:
		return true
	}
	return false
}
