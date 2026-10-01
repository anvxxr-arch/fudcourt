package exchange

import (
	"context"
	"errors"
	"net"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
)

// Classify maps a Go error to the normalized taxonomy, mirroring
// apps/web/src/platform/executor/exchange.ts mapError exactly in precedence
// and outcome:
//
//	RateLimitExceeded      → rate_limited      (retryable)
//	DDoSProtection         → exchange_overload (retryable)
//	ExchangeNotAvailable,
//	RequestTimeout,
//	NetworkError           → network_retryable (retryable)
//	InsufficientFunds      → insufficient_balance (not retryable)
//	AuthenticationError,
//	PermissionDenied       → permission_error  (not retryable)
//	InvalidOrder,
//	ArgumentsRequired,
//	BadRequest             → invalid_order     (not retryable)
//	anything else          → unknown           (not retryable)
//
// The TS classifier matches ccxt class names; the Go equivalents are
// structural, in the same order: a *VenueError already carries its
// classification (adapters computed it from the venue code/status tables
// below), a timeout (context deadline / net timeouts) is RequestTimeout, and
// an error declaring Retryable() true is the retryable family (network or
// rate-limit signal from a limiter). Everything else falls through to unknown,
// exactly like mapError's default — an unrecognized failure is never guessed
// into a retryable class.
func Classify(err error) ErrorClassification {
	if err == nil {
		// Classify(nil) is "no signal": unknown, not retryable. Callers that
		// expect an error must check err first; fabricating a class for "no
		// error" would be a lie.
		return ClassificationFor(executor.ErrUnknown)
	}

	var ve *VenueError
	if errors.As(err, &ve) {
		return ve.Class
	}

	// Explicit retry declaration (rate limiters, simulators): a rate-limit
	// signal is rate_limited, any other retryable signal is network_retryable
	// (TS: RateLimitExceeded first, then the network family).
	var rr interface{ Retryable() bool }
	if errors.As(err, &rr) {
		if rr.Retryable() {
			var rl interface{ RateLimited() bool }
			if errors.As(err, &rl) && rl.RateLimited() {
				return ClassificationFor(executor.ErrRateLimited)
			}
			return ClassificationFor(executor.ErrNetworkRetryable)
		}
	}

	// RequestTimeout / ExchangeNotAvailable family: deadlines and net timeouts.
	if errors.Is(err, context.DeadlineExceeded) {
		return ClassificationFor(executor.ErrNetworkRetryable)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return ClassificationFor(executor.ErrNetworkRetryable)
	}

	return ClassificationFor(executor.ErrUnknown)
}

// ClassifyCode maps a bare venue error code to the taxonomy using the per-code
// tables below. An unknown or empty code classifies as unknown — never guessed
// into a retryable class (TS mapError default).
func ClassifyCode(venue executor.ExchangeID, code string) ErrorClassification {
	if cat, ok := venueCodeCategories[codeKey{venue: venue, code: code}]; ok {
		return ClassificationFor(cat)
	}
	return ClassificationFor(executor.ErrUnknown)
}

// ClassifyVenueFailure classifies a venue failure from its code and HTTP
// status: a known venue code wins; otherwise the HTTP status family applies
// (HTTPStatusCategory); otherwise unknown.
func ClassifyVenueFailure(venue executor.ExchangeID, code string, httpStatus int) ErrorClassification {
	if code != "" {
		if cat, ok := venueCodeCategories[codeKey{venue: venue, code: code}]; ok {
			return ClassificationFor(cat)
		}
	}
	if httpStatus != 0 {
		return ClassificationFor(HTTPStatusCategory(httpStatus))
	}
	return ClassificationFor(executor.ErrUnknown)
}

// HTTPStatusCategory maps an HTTP status to the taxonomy, mirroring how
// exchange.ts's ccxt layer surfaces transport failures: 429 is
// RateLimitExceeded → rate_limited, 418 is DDoSProtection → exchange_overload,
// 408 and 5xx are RequestTimeout/ExchangeNotAvailable → network_retryable,
// 400 is BadRequest → invalid_order, 401/403 are AuthenticationError/
// PermissionDenied → permission_error, everything else → unknown.
func HTTPStatusCategory(status int) executor.ErrorCategory {
	switch {
	case status == 429:
		return executor.ErrRateLimited
	case status == 418:
		return executor.ErrExchangeOverload
	case status == 408 || status >= 500:
		return executor.ErrNetworkRetryable
	case status == 400:
		return executor.ErrInvalidOrder
	case status == 401 || status == 403:
		return executor.ErrPermissionError
	default:
		return executor.ErrUnknown
	}
}

type codeKey struct {
	venue executor.ExchangeID
	code  string
}

// venueCodeCategories is the per-venue error-code → category table. Codes not
// listed here classify via the HTTP status or as unknown.
//
// Code/meaning pairs marked ASSUMPTION are mapped from the venues' public
// error-code documentation as best known; the exact code↔meaning pairing is
// not verifiable from this repository (no live calls in CI), so the mapping is
// recorded here honestly rather than pretended to be oracle-verified. The
// category chosen errs toward "unknown" (not retryable) whenever the failure
// class is genuinely uncertain.
var venueCodeCategories = map[codeKey]executor.ErrorCategory{
	// --- Binance (spot + USD-M) ---
	// -1001 DISCONNECTED / internal error: transient transport state.
	{executor.ExchangeBinance, "-1001"}: executor.ErrNetworkRetryable,
	// -1003 Too many requests (IP/account weight ban warning).
	{executor.ExchangeBinance, "-1003"}: executor.ErrRateLimited,
	// -1007 Timeout waiting for response from backend server.
	{executor.ExchangeBinance, "-1007"}: executor.ErrNetworkRetryable,
	// -1015 Too many orders; slow down (order-rate limit).
	{executor.ExchangeBinance, "-1015"}: executor.ErrRateLimited,
	// -1021 Timestamp outside recvWindow — a retryable request-window failure.
	{executor.ExchangeBinance, "-1021"}: executor.ErrInvalidOrder,
	// -1022 Signature for this request is not valid → credential-level refusal.
	{executor.ExchangeBinance, "-1022"}: executor.ErrPermissionError,
	// -2010 Account has insufficient balance for requested action (this code
	// also carries generic NEW_ORDER_REJECTED — same bucket as TS
	// InsufficientFunds for the insufficient case).
	{executor.ExchangeBinance, "-2010"}: executor.ErrInsufficientBalance,
	// -2011 Unknown order sent.
	{executor.ExchangeBinance, "-2011"}: executor.ErrInvalidOrder,
	// -2013 Order does not exist.
	{executor.ExchangeBinance, "-2013"}: executor.ErrInvalidOrder,
	// -2014 API-key format invalid.
	{executor.ExchangeBinance, "-2014"}: executor.ErrPermissionError,
	// -2015 Invalid API-key, IP, or permissions for action.
	{executor.ExchangeBinance, "-2015"}: executor.ErrPermissionError,

	// --- Bybit v5 ---
	// 10001 params error (request validation failure).
	{executor.ExchangeBybit, "10001"}: executor.ErrInvalidOrder,
	// 10002 INVALID_REQUEST (timestamp/recv_window/order-id issues) — ASSUMPTION.
	{executor.ExchangeBybit, "10002"}: executor.ErrInvalidOrder,
	// 10004 invalid sign → credential-level refusal.
	{executor.ExchangeBybit, "10004"}: executor.ErrPermissionError,
	// 10005 permission denied (key lacks the required scope).
	{executor.ExchangeBybit, "10005"}: executor.ErrPermissionError,
	// 10006 too many visits (rate limit).
	{executor.ExchangeBybit, "10006"}: executor.ErrRateLimited,
	// 10016 service unavailable / system busy — ASSUMPTION (mapped overload,
	// not retryable-as-network, because the message is "system busy").
	{executor.ExchangeBybit, "10016"}: executor.ErrExchangeOverload,
	// 110001 order does not exist.
	{executor.ExchangeBybit, "110001"}: executor.ErrInvalidOrder,
	// 110004 wallet has insufficient balance.
	{executor.ExchangeBybit, "110004"}: executor.ErrInsufficientBalance,
	// 110007 reduce-only order would increase the position (order rejection).
	{executor.ExchangeBybit, "110007"}: executor.ErrInvalidOrder,
	// 110012 reduce-only order would cross to reduce-only-unsafe size (order
	// rejection) — ASSUMPTION.
	{executor.ExchangeBybit, "110012"}: executor.ErrInvalidOrder,

	// --- MEXC spot ---
	// MEXC's global codes mirror HTTP semantics; the numeric codes below are
	// the documented global ones (ASSUMPTION on exact numeric values).
	{executor.ExchangeMEXC, "400"}: executor.ErrInvalidOrder,
	{executor.ExchangeMEXC, "401"}: executor.ErrPermissionError,
	{executor.ExchangeMEXC, "403"}: executor.ErrPermissionError,
	{executor.ExchangeMEXC, "429"}: executor.ErrRateLimited,
	{executor.ExchangeMEXC, "500"}: executor.ErrNetworkRetryable,
	{executor.ExchangeMEXC, "503"}: executor.ErrNetworkRetryable,
	// 10007 balance insufficient — ASSUMPTION (MEXC business error code).
	{executor.ExchangeMEXC, "10007"}: executor.ErrInsufficientBalance,
	// 10211 invalid order/parameter rejection — ASSUMPTION (MEXC business
	// order-rejection family).
	{executor.ExchangeMEXC, "10211"}: executor.ErrInvalidOrder,
}
