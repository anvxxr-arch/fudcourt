package exchanges

import (
	"errors"
	"fmt"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/core/execution"
)

// Sentinel refusals returned by this package. Each is a NAMED error so callers
// can refuse invalid input instead of guessing (house rule).
var (
	// ErrNoPosition is returned by GetPosition when the account is flat on the
	// symbol: flat is an answer, a failed fetch is an error — never conflated
	// (interface.go interface contract).
	ErrNoPosition = errors.New("exchange: no position for symbol")
	// ErrUnknownVenue is returned when a venue id is not one this build speaks.
	ErrUnknownVenue = errors.New("exchange: unknown venue")
	// ErrUnknownQuote is returned when a venue symbol's quote-asset suffix is
	// not in the known quote set; the suffix is NEVER guessed (symbols.go).
	ErrUnknownQuote = errors.New("exchange: venue symbol has unknown quote-asset suffix")
	// ErrInvalidSymbol is returned for symbols that are not canonical
	// BASE/QUOTE or otherwise malformed.
	ErrInvalidSymbol = errors.New("exchange: symbol is not canonical BASE/QUOTE")
	// ErrInvalidOrder is returned when an order request is malformed
	// (bad quantity, missing limit price, unknown side/type).
	ErrInvalidOrder = errors.New("exchange: invalid order request")
	// ErrOrderNotFound is returned when the venue does not know the order id.
	ErrOrderNotFound = errors.New("exchange: order not found")
)

// ErrorClassification is the normalized view of one venue failure (TS
// ExecutorError minus the raw payload): which taxonomy bucket it lands in,
// whether the retry policy may retry it, and what it implies about credential
// health. Retryable is always Category.Retryable() — the retry set is strictly
// network_retryable / rate_limited / exchange_overload (PRD §78) and is
// computed, never asserted by hand.
type ErrorClassification struct {
	// Category is the retry taxonomy bucket (execution.ErrorCategory).
	Category execution.ErrorCategory
	// Retryable reports whether the retry policy may retry (Category.Retryable()).
	Retryable bool
	// Health is the credential-health IMPLICATION of the failure only —
	// e.g. a permission refusal implies PERMISSION_ERROR. It never fabricates
	// a venue-reported health state the venue did not report (honest nulls).
	Health execution.CredentialHealth
}

// ClassificationFor builds a classification for a category with Retryable and
// Health derived from single sources of truth (the category's Retryable() and
// the health-implication table).
func ClassificationFor(category execution.ErrorCategory) ErrorClassification {
	return ErrorClassification{
		Category:  category,
		Retryable: category.Retryable(),
		Health:    healthImplication(category),
	}
}

// healthImplication is the credential-health implication of a failure
// category. Failures that say nothing about the credential (network blips,
// bad orders, balance shortfalls) imply UNKNOWN — an honest "no signal" —
// never a fabricated ACTIVE/INVALID verdict.
func healthImplication(category execution.ErrorCategory) execution.CredentialHealth {
	switch category {
	case execution.ErrPermissionError:
		return execution.HealthPermissionError
	case execution.ErrRateLimited:
		return execution.HealthRateLimited
	case execution.ErrFatal:
		// A fatal refusal of the credential itself (e.g. signature-level auth
		// failure) invalidates the credential view.
		return execution.HealthInvalid
	default:
		return execution.HealthUnknown
	}
}

// CredentialHealthForValidation mirrors exchange.ts validateCredentials'
// failure mapping exactly: permission_error → PERMISSION_ERROR,
// rate_limited → RATE_LIMITED, anything else → INVALID. It is the health
// verdict when a credential PROBE fails (the probe succeeded or the key is
// not usable), and is intentionally stricter than the general
// healthImplication table.
func CredentialHealthForValidation(c ErrorClassification) execution.CredentialHealth {
	switch c.Category {
	case execution.ErrPermissionError:
		return execution.HealthPermissionError
	case execution.ErrRateLimited:
		return execution.HealthRateLimited
	default:
		return execution.HealthInvalid
	}
}

// VenueError is one adapter failure carrying the venue code and its
// classification (TS ExecutorError's exchangeCode + category).
//
// SECRET HYGIENE (PRD §109): Error() reports ONLY the venue id, the short
// venue code, the HTTP status, the category and the sanitized Message. Raw
// venue response bodies, request queries, headers, signatures and credentials
// MUST NEVER reach Message or Code — adapters pass a short sanitized reason
// (often the venue's own short error text, never the raw envelope) and may
// keep an opaque Cause for errors.Is plumbing only.
type VenueError struct {
	// Venue is the venue the failure came from.
	Venue execution.ExchangeID
	// Code is the venue's short error code when it supplied one ("" if none).
	Code string
	// HTTPStatus is the transport status when the request got a response
	// (0 when it failed before/without one).
	HTTPStatus int
	// Class is the normalized classification of the failure.
	Class ErrorClassification
	// Message is a SANITIZED short reason: no raw body, no query, no secret.
	Message string
	// Cause is the wrapped lower-level error (transport errors only), usable
	// with errors.Is/As and never rendered with secret material.
	Cause error
}

// Error renders the safe, loggable form. It intentionally omits everything
// that could carry secret material (bodies, queries, headers).
func (e *VenueError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "exchange %s: category=%s", e.Venue, e.Class.Category)
	if e.Code != "" {
		fmt.Fprintf(&b, " code=%s", e.Code)
	}
	if e.HTTPStatus != 0 {
		fmt.Fprintf(&b, " http=%d", e.HTTPStatus)
	}
	if e.Message != "" {
		fmt.Fprintf(&b, ": %s", e.Message)
	}
	return b.String()
}

// Unwrap exposes the wrapped transport error to errors.Is/As.
func (e *VenueError) Unwrap() error { return e.Cause }

// NewVenueError classifies a venue failure from its code and/or HTTP status
// (code wins when the venue supplied one) and wraps it as a VenueError.
// message MUST already be sanitized (see VenueError).
func NewVenueError(venue execution.ExchangeID, code string, httpStatus int, message string) *VenueError {
	return &VenueError{
		Venue:      venue,
		Code:       code,
		HTTPStatus: httpStatus,
		Class:      ClassifyVenueFailure(venue, code, httpStatus),
		Message:    message,
	}
}

// WrapTransport wraps a transport-level failure (dial error, timeout, TLS
// failure) as a VenueError with the given classification — adapters classify
// transport failures as network_retryable via Classify before wrapping.
// message MUST be sanitized (e.g. the operation name, not the request URL's
// query string).
func WrapTransport(venue execution.ExchangeID, class ErrorClassification, message string, cause error) *VenueError {
	return &VenueError{
		Venue:   venue,
		Class:   class,
		Message: message,
		Cause:   cause,
	}
}
