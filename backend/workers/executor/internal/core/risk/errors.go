package risk

import "fmt"

// CodedError is a structural math error with a stable SCREAMING_SNAKE code (the
// Go port of the TS plain-Error throws in risk.ts, upgraded to typed errors per
// house rules). Numeric edge cases never surface here — they clamp with
// warnings in the result; codes are reserved for structurally invalid input.
type CodedError struct {
	Code  string // stable SCREAMING_SNAKE identifier
	Field string // the offending field, when one exists
	Msg   string
}

func (e *CodedError) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("%s: %s: %s", e.Code, e.Field, e.Msg)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Msg)
}

// Stable error codes for the risk engine's structural refusals.
const (
	CodeInvalidInstrument = "INVALID_INSTRUMENT"
	CodeInvalidNumber     = "INVALID_NUMBER"
	CodeInvalidStepSize   = "INVALID_STEP_SIZE"
	CodeInvalidTickSize   = "INVALID_TICK_SIZE"
	CodeInvalidPrice      = "INVALID_PRICE"
	CodeInvalidStop       = "INVALID_STOP"
	CodeInvalidLeverage   = "INVALID_LEVERAGE"
)

func errCode(code, field, format string, args ...any) *CodedError {
	return &CodedError{Code: code, Field: field, Msg: fmt.Sprintf(format, args...)}
}
