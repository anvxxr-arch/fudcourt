package execution

// ExecutionStatus is the execution lifecycle state (types.ts). Transitions are
// table-driven (ExecutionTransitions); terminal states accept nothing (PRD §57).
type ExecutionStatus string

const (
	StatusDraft           ExecutionStatus = "DRAFT"
	StatusCalculated      ExecutionStatus = "CALCULATED"
	StatusValidated       ExecutionStatus = "VALIDATED"
	StatusReady           ExecutionStatus = "READY"
	StatusRunning         ExecutionStatus = "RUNNING"
	StatusPartiallyFilled ExecutionStatus = "PARTIALLY_FILLED"
	StatusFilled          ExecutionStatus = "FILLED"
	StatusPaused          ExecutionStatus = "PAUSED"
	StatusCancelRequested ExecutionStatus = "CANCEL_REQUESTED"
	StatusCancelled       ExecutionStatus = "CANCELLED"
	StatusFailed          ExecutionStatus = "FAILED"
	StatusRiskStopped     ExecutionStatus = "RISK_STOPPED"
	StatusExpired         ExecutionStatus = "EXPIRED"
	StatusReconciling     ExecutionStatus = "RECONCILING"
	StatusStopped         ExecutionStatus = "STOPPED"
)

// ExecutionTransitions is the ONE lifecycle truth for API intents and worker
// transitions alike (PRD §57). Terminal states map to empty slices.
var ExecutionTransitions = map[ExecutionStatus][]ExecutionStatus{
	StatusDraft:           {StatusCalculated, StatusCancelled, StatusFailed},
	StatusCalculated:      {StatusValidated, StatusFailed, StatusCancelled},
	StatusValidated:       {StatusReady, StatusFailed, StatusCancelled},
	StatusReady:           {StatusRunning, StatusCancelled, StatusFailed},
	StatusRunning:         {StatusPartiallyFilled, StatusFilled, StatusPaused, StatusCancelRequested, StatusCancelled, StatusFailed, StatusRiskStopped, StatusExpired, StatusReconciling, StatusStopped},
	StatusPartiallyFilled: {StatusRunning, StatusFilled, StatusPaused, StatusCancelRequested, StatusCancelled, StatusFailed, StatusRiskStopped, StatusExpired, StatusReconciling, StatusStopped},
	StatusPaused:          {StatusRunning, StatusCancelRequested, StatusCancelled, StatusFailed, StatusRiskStopped, StatusStopped},
	StatusCancelRequested: {StatusCancelled, StatusFailed, StatusPartiallyFilled},
	StatusReconciling:     {StatusRunning, StatusPartiallyFilled, StatusPaused, StatusCancelled, StatusFailed, StatusRiskStopped, StatusStopped},
	StatusFilled:          {},
	StatusCancelled:       {},
	StatusFailed:          {},
	StatusRiskStopped:     {},
	StatusExpired:         {},
	StatusStopped:         {},
}

// CanTransition reports whether from → to is a legal execution transition.
// Invalid transitions are REJECTED, never silently absorbed (PRD §57).
func CanTransition(from, to ExecutionStatus) bool {
	for _, next := range ExecutionTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// IsTerminalExecution reports whether the status accepts nothing further.
func IsTerminalExecution(status ExecutionStatus) bool {
	return len(ExecutionTransitions[status]) == 0
}

// ChildOrderStatus is the child-order lifecycle (types.ts; PRD §58).
type ChildOrderStatus string

const (
	ChildPlanned    ChildOrderStatus = "PLANNED"
	ChildSubmitting ChildOrderStatus = "SUBMITTING"
	ChildOpen       ChildOrderStatus = "OPEN"
	ChildPartial    ChildOrderStatus = "PARTIAL"
	ChildFilled     ChildOrderStatus = "FILLED"
	ChildCancelling ChildOrderStatus = "CANCELLING"
	ChildCancelled  ChildOrderStatus = "CANCELLED"
	ChildRejected   ChildOrderStatus = "REJECTED"
	ChildExpired    ChildOrderStatus = "EXPIRED"
	ChildUnknown    ChildOrderStatus = "UNKNOWN"
)

// ChildOrderTransitions is the child-order lifecycle table (PRD §58). Illegal
// transitions THROW rather than silently advancing.
var ChildOrderTransitions = map[ChildOrderStatus][]ChildOrderStatus{
	ChildPlanned:    {ChildSubmitting, ChildCancelled, ChildRejected},
	ChildSubmitting: {ChildOpen, ChildPartial, ChildFilled, ChildRejected, ChildCancelled, ChildUnknown},
	ChildOpen:       {ChildPartial, ChildFilled, ChildCancelling, ChildCancelled, ChildExpired, ChildUnknown},
	ChildPartial:    {ChildPartial, ChildFilled, ChildCancelling, ChildCancelled, ChildExpired, ChildUnknown},
	ChildCancelling: {ChildCancelled, ChildPartial, ChildFilled, ChildUnknown},
	ChildFilled:     {},
	ChildCancelled:  {},
	ChildRejected:   {},
	ChildExpired:    {},
	ChildUnknown:    {},
}

// CanTransitionChild reports whether from → to is a legal child-order transition.
func CanTransitionChild(from, to ChildOrderStatus) bool {
	for _, next := range ChildOrderTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// CredentialHealth is the venue-reported credential state (types.ts; PRD §47).
type CredentialHealth string

const (
	HealthActive          CredentialHealth = "ACTIVE"
	HealthInvalid         CredentialHealth = "INVALID"
	HealthExpired         CredentialHealth = "EXPIRED"
	HealthPermissionError CredentialHealth = "PERMISSION_ERROR"
	HealthRateLimited     CredentialHealth = "RATE_LIMITED"
	HealthRevoked         CredentialHealth = "REVOKED"
	HealthUnknown         CredentialHealth = "UNKNOWN"
)

// ErrorCategory is the retry taxonomy (types.ts; PRD §78). Only the three
// retryable classes may be retried.
type ErrorCategory string

const (
	ErrNetworkRetryable    ErrorCategory = "network_retryable"
	ErrRateLimited         ErrorCategory = "rate_limited"
	ErrExchangeOverload    ErrorCategory = "exchange_overload"
	ErrInvalidOrder        ErrorCategory = "invalid_order"
	ErrPermissionError     ErrorCategory = "permission_error"
	ErrInsufficientBalance ErrorCategory = "insufficient_balance"
	ErrFatal               ErrorCategory = "fatal"
	ErrUnknown             ErrorCategory = "unknown"
)

// Retryable reports whether the category permits retry (PRD §78).
func (c ErrorCategory) Retryable() bool {
	switch c {
	case ErrNetworkRetryable, ErrRateLimited, ErrExchangeOverload:
		return true
	}
	return false
}

// RiskBreachPolicy chooses the response when projected risk exceeds the budget
// (types.ts; PRD §37). Default is resize_then_stop.
type RiskBreachPolicy string

const (
	BreachResizeThenStop RiskBreachPolicy = "resize_then_stop"
	BreachPause          RiskBreachPolicy = "pause"
	BreachStop           RiskBreachPolicy = "stop"
)

// ExistingPositionPolicy governs opening against an existing position
// (types.ts; PRD §93). REJECT refuses a net-through-flat.
type ExistingPositionPolicy string

const (
	PositionAdd    ExistingPositionPolicy = "add"
	PositionReject ExistingPositionPolicy = "reject"
)

// ExecutionMode is preview/paper/live (types.ts; PRD §118). LIVE is fail-closed
// behind the FUDCOURT_EXECUTOR_LIVE kill switch.
type ExecutionMode string

const (
	ModePreview ExecutionMode = "preview"
	ModePaper   ExecutionMode = "paper"
	ModeLive    ExecutionMode = "live"
)

// StopMode chooses native vs synthetic protective stops (types.ts; PRD §39).
type StopMode string

const (
	StopNative    StopMode = "native"
	StopSynthetic StopMode = "synthetic"
	StopHybrid    StopMode = "hybrid"
)
