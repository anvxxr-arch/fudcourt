// Package errs is the normalized error model of the Go API (docs/architecture/
// target.md "Error model"): every refusal carries a category, a stable code and
// a client-safe message — never a stack trace or upstream internals.
//
// Two levels deliberately: Category is the machine class shared by every domain
// (the HTTP status is a pure function of it, so no handler invents its own);
// Code is the specific stable SCREAMING_SNAKE identifier clients branch on.
package errs

import "fmt"

// Category is the machine class of a refusal (objective §43).
type Category string

const (
	CategoryValidation          Category = "validation"
	CategoryUnauthenticated     Category = "unauthenticated"
	CategoryAuthorization       Category = "authorization"
	CategoryCredential          Category = "credential"
	CategoryExchange            Category = "exchange"
	CategoryInsufficientBalance Category = "insufficient_balance"
	CategoryRiskLimit           Category = "risk_limit"
	CategoryRateLimit           Category = "rate_limit"
	CategoryTimeout             Category = "timeout"
	CategoryNetwork             Category = "network"
	CategoryConflict            Category = "conflict"
	CategoryNotFound            Category = "not_found"
	CategoryInternal            Category = "internal"
)

// Error is the canonical API error. Message MUST be safe to show a user; Err is
// for logs and is never serialized (the wire envelope excludes it).
type Error struct {
	Category Category
	Code     string
	Message  string
	Err      error
}

// Error implements the error interface and includes the cause for operator logs.
func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s/%s: %s: %v", e.Category, e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s/%s: %s", e.Category, e.Code, e.Message)
}

// Unwrap exposes the cause to errors.Is/As in log paths.
func (e *Error) Unwrap() error { return e.Err }

// New builds an error with no wrapped cause.
func New(category Category, code, message string) *Error {
	return &Error{Category: category, Code: code, Message: message}
}

// Wrap attaches a cause that stays out of the wire payload.
func Wrap(category Category, code, message string, err error) *Error {
	return &Error{Category: category, Code: code, Message: message, Err: err}
}

// statusByCategory is the one HTTP mapping (objective §44). risk_limit and
// conflict are 409 refusals against committed state (matching the executor's
// existing contract); insufficient_balance is 422 (well-formed request, account
// state forbids it); credential is 500 because OUR vault failed — a venue
// rejecting a key is exchange class; network/exchange are 502 with no detail.
var statusByCategory = map[Category]int{
	CategoryValidation:          400,
	CategoryUnauthenticated:     401,
	CategoryAuthorization:       403,
	CategoryCredential:          500,
	CategoryExchange:            502,
	CategoryInsufficientBalance: 422,
	CategoryRiskLimit:           409,
	CategoryRateLimit:           429,
	CategoryTimeout:             504,
	CategoryNetwork:             502,
	CategoryConflict:            409,
	CategoryNotFound:            404,
	CategoryInternal:            500,
}

// Status returns the HTTP status for a category. An unknown category is 500:
// an unmodelled failure must not look client-shaped.
func Status(category Category) int {
	if s, ok := statusByCategory[category]; ok {
		return s
	}
	return 500
}

// EnvelopeBody is the wire shape (contracts/schemas/error-envelope.json).
type EnvelopeBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

// Envelope is the consistent API error response: {"error": {...}}.
type Envelope struct {
	Error EnvelopeBody `json:"error"`
}

// From classifies any error into the canonical model. A non-errs error is
// internal with a generic message: arbitrary error text may carry DSNs or
// signed payloads and must never reach a caller.
func From(err error) *Error {
	if err == nil {
		return nil
	}
	if e, ok := err.(*Error); ok {
		return e
	}
	return Wrap(CategoryInternal, "INTERNAL", "internal error", err)
}
