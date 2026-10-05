package exchanges

import (
	"context"
	"errors"
	"net"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
)

// Classify maps a Go error to the normalized taxonomy, mirroring
// the retired TS exchange module's mapError exactly in precedence
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
		return ClassificationFor(execution.ErrUnknown)
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
				return ClassificationFor(execution.ErrRateLimited)
			}
			return ClassificationFor(execution.ErrNetworkRetryable)
		}
	}

	// RequestTimeout / ExchangeNotAvailable family: deadlines and net timeouts.
	if errors.Is(err, context.DeadlineExceeded) {
		return ClassificationFor(execution.ErrNetworkRetryable)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return ClassificationFor(execution.ErrNetworkRetryable)
	}

	return ClassificationFor(execution.ErrUnknown)
}

// ClassifyCode maps a bare venue error code to the taxonomy using the per-code
// tables below. An unknown or empty code classifies as unknown — never guessed
// into a retryable class (TS mapError default).
func ClassifyCode(venue execution.ExchangeID, code string) ErrorClassification {
	if cat, ok := venueCodeCategories[codeKey{venue: venue, code: code}]; ok {
		return ClassificationFor(cat)
	}
	return ClassificationFor(execution.ErrUnknown)
}

// ClassifyVenueFailure classifies a venue failure from its code and HTTP
// status: a known venue code wins; otherwise the HTTP status family applies
// (HTTPStatusCategory); otherwise unknown.
func ClassifyVenueFailure(venue execution.ExchangeID, code string, httpStatus int) ErrorClassification {
	if code != "" {
		if cat, ok := venueCodeCategories[codeKey{venue: venue, code: code}]; ok {
			return ClassificationFor(cat)
		}
	}
	if httpStatus != 0 {
		return ClassificationFor(HTTPStatusCategory(httpStatus))
	}
	return ClassificationFor(execution.ErrUnknown)
}

// HTTPStatusCategory maps an HTTP status to the taxonomy, mirroring how
// exchange.ts's ccxt layer surfaces transport failures: 429 is
// RateLimitExceeded → rate_limited, 418 is DDoSProtection → exchange_overload,
// 408 and 5xx are RequestTimeout/ExchangeNotAvailable → network_retryable,
// 400 is BadRequest → invalid_order, 401/403 are AuthenticationError/
// PermissionDenied → permission_error, everything else → unknown.
func HTTPStatusCategory(status int) execution.ErrorCategory {
	switch {
	case status == 429:
		return execution.ErrRateLimited
	case status == 418:
		return execution.ErrExchangeOverload
	case status == 408 || status >= 500:
		return execution.ErrNetworkRetryable
	case status == 400:
		return execution.ErrInvalidOrder
	case status == 401 || status == 403:
		return execution.ErrPermissionError
	default:
		return execution.ErrUnknown
	}
}

type codeKey struct {
	venue execution.ExchangeID
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
var venueCodeCategories = map[codeKey]execution.ErrorCategory{
	// --- Binance (spot + USD-M) ---
	// -1001 DISCONNECTED / internal error: transient transport state.
	{execution.ExchangeBinance, "-1001"}: execution.ErrNetworkRetryable,
	// -1003 Too many requests (IP/account weight ban warning).
	{execution.ExchangeBinance, "-1003"}: execution.ErrRateLimited,
	// -1007 Timeout waiting for response from backend server.
	{execution.ExchangeBinance, "-1007"}: execution.ErrNetworkRetryable,
	// -1015 Too many orders; slow down (order-rate limit).
	{execution.ExchangeBinance, "-1015"}: execution.ErrRateLimited,
	// -1021 Timestamp outside recvWindow — a retryable request-window failure.
	{execution.ExchangeBinance, "-1021"}: execution.ErrInvalidOrder,
	// -1022 Signature for this request is not valid → credential-level refusal.
	{execution.ExchangeBinance, "-1022"}: execution.ErrPermissionError,
	// -2010 Account has insufficient balance for requested action (this code
	// also carries generic NEW_ORDER_REJECTED — same bucket as TS
	// InsufficientFunds for the insufficient case).
	{execution.ExchangeBinance, "-2010"}: execution.ErrInsufficientBalance,
	// -2011 Unknown order sent.
	{execution.ExchangeBinance, "-2011"}: execution.ErrInvalidOrder,
	// -2013 Order does not exist.
	{execution.ExchangeBinance, "-2013"}: execution.ErrInvalidOrder,
	// -2014 API-key format invalid.
	{execution.ExchangeBinance, "-2014"}: execution.ErrPermissionError,
	// -2015 Invalid API-key, IP, or permissions for action.
	{execution.ExchangeBinance, "-2015"}: execution.ErrPermissionError,

	// --- Bybit v5 ---
	// 10001 params error (request validation failure).
	{execution.ExchangeBybit, "10001"}: execution.ErrInvalidOrder,
	// 10002 INVALID_REQUEST (timestamp/recv_window/order-id issues) — ASSUMPTION.
	{execution.ExchangeBybit, "10002"}: execution.ErrInvalidOrder,
	// 10004 invalid sign → credential-level refusal.
	{execution.ExchangeBybit, "10004"}: execution.ErrPermissionError,
	// 10005 permission denied (key lacks the required scope).
	{execution.ExchangeBybit, "10005"}: execution.ErrPermissionError,
	// 10006 too many visits (rate limit).
	{execution.ExchangeBybit, "10006"}: execution.ErrRateLimited,
	// 10016 service unavailable / system busy — ASSUMPTION (mapped overload,
	// not retryable-as-network, because the message is "system busy").
	{execution.ExchangeBybit, "10016"}: execution.ErrExchangeOverload,
	// 110001 order does not exist.
	{execution.ExchangeBybit, "110001"}: execution.ErrInvalidOrder,
	// 110004 wallet has insufficient balance.
	{execution.ExchangeBybit, "110004"}: execution.ErrInsufficientBalance,
	// 110007 reduce-only order would increase the position (order rejection).
	{execution.ExchangeBybit, "110007"}: execution.ErrInvalidOrder,
	// 110012 reduce-only order would cross to reduce-only-unsafe size (order
	// rejection) — ASSUMPTION.
	{execution.ExchangeBybit, "110012"}: execution.ErrInvalidOrder,

	// --- MEXC spot ---
	// MEXC's global codes mirror HTTP semantics; the numeric codes below are
	// the documented global ones (ASSUMPTION on exact numeric values).
	{execution.ExchangeMEXC, "400"}: execution.ErrInvalidOrder,
	{execution.ExchangeMEXC, "401"}: execution.ErrPermissionError,
	{execution.ExchangeMEXC, "403"}: execution.ErrPermissionError,
	{execution.ExchangeMEXC, "429"}: execution.ErrRateLimited,
	{execution.ExchangeMEXC, "500"}: execution.ErrNetworkRetryable,
	{execution.ExchangeMEXC, "503"}: execution.ErrNetworkRetryable,
	// 10007 balance insufficient — ASSUMPTION (MEXC business error code).
	{execution.ExchangeMEXC, "10007"}: execution.ErrInsufficientBalance,
	// 10211 invalid order/parameter rejection — ASSUMPTION (MEXC business
	// order-rejection family).
	{execution.ExchangeMEXC, "10211"}: execution.ErrInvalidOrder,
}
