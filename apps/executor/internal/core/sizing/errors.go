// Package sizing is the canonical owner of sizing-mode resolution (objective
// §8.13): the Go port of plan.ts `sizePosition` and its §33 scale-in ladder
// math. Every one of the nine SizingMode values of execution.SizingDefinition
// produces a SizedPosition; percentage modes REQUIRE an explicit balance basis
// (PRD §10) and an unresolved basis is an error naming it — never a fabricated
// 0. Quantities floor DOWN to the instrument grid (PRD §71); prices tick-round
// half-up; minimum-notional refusals print both figures (PRD §70).
//
// Money/quantity in, money/quantity out — all decimal strings via
// internal/platform/decimal; no float64 touches a financial value.
package sizing

import "fmt"

// FieldError is a stable, field-named refusal (house rule: bad input is a 400
// with the field named — never a clamp, never a silent default). Code is a
// stable SCREAMING_SNAKE identifier; Error() renders "field: message" exactly
// as the TS `errors: string[]` entries read.
type FieldError struct {
	Code    string
	Field   string
	Message string
}

func (e FieldError) Error() string {
	if e.Field == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// Stable validation error codes (SCREAMING_SNAKE, matching the TS
// ErrorCategory semantics: every one of these is a non-retryable
// invalid-order-class refusal).
const (
	CodeValidationFailed      = "VALIDATION_FAILED"
	CodeSizingBasisMissing    = "SIZING_BASIS_MISSING"
	CodeSizingBasisUnresolved = "SIZING_BASIS_UNRESOLVED"
	CodeSizingBudgetExceeded  = "SIZING_BUDGET_EXCEEDED"
	CodeUnboundedRisk         = "UNBOUNDED_RISK"
	CodeInvalidSizing         = "INVALID_SIZING"
)

func fieldErr(code, field, format string, args ...any) FieldError {
	return FieldError{Code: code, Field: field, Message: fmt.Sprintf(format, args...)}
}
