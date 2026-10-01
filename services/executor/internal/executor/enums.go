package executor

// ExecutionEventName is the immutable append-only event vocabulary
// (types.ts; PRD §63). The canonical alias map lives in
// packages/contracts/events/catalog.json.
type ExecutionEventName string

const (
	EventExecutionCreated       ExecutionEventName = "EXECUTION_CREATED"
	EventRiskCalculated         ExecutionEventName = "RISK_CALCULATED"
	EventPlanCreated            ExecutionEventName = "PLAN_CREATED"
	EventExecutionStarted       ExecutionEventName = "EXECUTION_STARTED"
	EventOrderPlanned           ExecutionEventName = "ORDER_PLANNED"
	EventOrderSubmitted         ExecutionEventName = "ORDER_SUBMITTED"
	EventOrderAccepted          ExecutionEventName = "ORDER_ACCEPTED"
	EventOrderPartiallyFilled   ExecutionEventName = "ORDER_PARTIALLY_FILLED"
	EventOrderFilled            ExecutionEventName = "ORDER_FILLED"
	EventOrderCancelled         ExecutionEventName = "ORDER_CANCELLED"
	EventOrderRejected          ExecutionEventName = "ORDER_REJECTED"
	EventPositionUpdated        ExecutionEventName = "POSITION_UPDATED"
	EventBalanceUpdated         ExecutionEventName = "BALANCE_UPDATED"
	EventRiskRecalculated       ExecutionEventName = "RISK_RECALCULATED"
	EventPlanResized            ExecutionEventName = "PLAN_RESIZED"
	EventExecutionPaused        ExecutionEventName = "EXECUTION_PAUSED"
	EventExecutionResumed       ExecutionEventName = "EXECUTION_RESUMED"
	EventExecutionCompleted     ExecutionEventName = "EXECUTION_COMPLETED"
	EventExecutionFailed        ExecutionEventName = "EXECUTION_FAILED"
	EventExecutionRiskStopped   ExecutionEventName = "EXECUTION_RISK_STOPPED"
	EventExecutionCancelled     ExecutionEventName = "EXECUTION_CANCELLED"
	EventReconciliationMismatch ExecutionEventName = "RECONCILIATION_MISMATCH"
	EventExternalStateChange    ExecutionEventName = "EXTERNAL_STATE_CHANGE"
)

// ExecutionEventNames lists every event name in contract order (used by the
// contract drift gate in packages/contracts).
var ExecutionEventNames = []ExecutionEventName{
	EventExecutionCreated, EventRiskCalculated, EventPlanCreated,
	EventExecutionStarted, EventOrderPlanned, EventOrderSubmitted,
	EventOrderAccepted, EventOrderPartiallyFilled,
	EventOrderFilled, EventOrderCancelled, EventOrderRejected,
	EventPositionUpdated, EventBalanceUpdated,
	EventRiskRecalculated, EventPlanResized, EventExecutionPaused,
	EventExecutionResumed, EventExecutionCompleted, EventExecutionFailed,
	EventExecutionRiskStopped, EventExecutionCancelled,
	EventReconciliationMismatch, EventExternalStateChange,
}

// BalanceBasis names the exact balance source a percentage sizing used
// (types.ts; PRD §10) — a percentage MUST name its basis explicitly.
type BalanceBasis string

const (
	BasisSpotAvailable    BalanceBasis = "spot_available"
	BasisSpotEquity       BalanceBasis = "spot_equity"
	BasisFuturesAvailable BalanceBasis = "futures_available"
	BasisFuturesEquity    BalanceBasis = "futures_equity"
	BasisTotalExchange    BalanceBasis = "total_exchange_equity"
	BasisAssetEquity      BalanceBasis = "asset_equity"
	BasisCustom           BalanceBasis = "custom"
)

// ExecutionStrategy names a strategy implementation (types.ts).
type ExecutionStrategy string

const (
	StrategyMarket       ExecutionStrategy = "market"
	StrategyLimit        ExecutionStrategy = "limit"
	StrategyTWAP         ExecutionStrategy = "twap"
	StrategyAdaptiveTWAP ExecutionStrategy = "adaptive_twap"
	StrategyIceberg      ExecutionStrategy = "iceberg"
	StrategyChaseLimit   ExecutionStrategy = "chase_limit"
	StrategyScaleIn      ExecutionStrategy = "scale_in"
	StrategyScaleOut     ExecutionStrategy = "scale_out"
)

// SizingMode names one of the nine sizing definitions (types.ts; PRD §8–§16).
type SizingMode string

const (
	SizingRiskUSD             SizingMode = "risk_usd"
	SizingRiskPercent         SizingMode = "risk_percent"
	SizingAllocationUSD       SizingMode = "allocation_usd"
	SizingAllocationPercent   SizingMode = "allocation_percent"
	SizingNotionalUSD         SizingMode = "notional_usd"
	SizingFixedQuantity       SizingMode = "fixed_quantity"
	SizingFixedMargin         SizingMode = "fixed_margin"
	SizingTargetProfitUSD     SizingMode = "target_profit_usd"
	SizingTargetProfitPercent SizingMode = "target_profit_percent"
)

// SizingModes lists every sizing mode (contract drift gate + validation).
var SizingModes = []SizingMode{
	SizingRiskUSD, SizingRiskPercent, SizingAllocationUSD, SizingAllocationPercent,
	SizingNotionalUSD, SizingFixedQuantity, SizingFixedMargin,
	SizingTargetProfitUSD, SizingTargetProfitPercent,
}

// SizingDefinition is the discriminated sizing input (types.ts). Exactly one
// mode is set; money fields are decimal strings. Risk-based modes require a
// stop (PRD §38); capital modes are legitimate but must never be presented as
// risk sizing (DR-021 §1a).
type SizingDefinition struct {
	Mode SizingMode `json:"mode"`
	// Amount is the risk/profit budget (risk_usd / target_profit_usd family).
	Amount string `json:"amount,omitempty"`
	// Percent for the percentage family; Basis is REQUIRED with it (PRD §10).
	Percent string `json:"percent,omitempty"`
	Basis   BalanceBasis `json:"basis,omitempty"`
	// Quantity (fixed_quantity) and margin (fixed_margin).
	Quantity string `json:"quantity,omitempty"`
	Margin   string `json:"margin,omitempty"`
}

// PriceDefinition is an entry/stop/target price level (types.ts).
type PriceDefinition struct {
	Kind  string `json:"kind"`  // "limit" | "market" | "stop" | "take_profit"
	Price string `json:"price"` // decimal string; empty for market
}

// ScaleLevel is one level of a scale-in/out ladder (types.ts; PRD §33).
type ScaleLevel struct {
	Price    string `json:"price"`
	Fraction string `json:"fraction"` // decimal fraction of the position at this level
}

// TwapConfig carries the opt-in randomization knobs (types.ts; PRD §28–§29).
// Absent config means the naive deterministic schedule — jitter is never
// silent (DR-021 §2g).
type TwapConfig struct {
	Slices            int    `json:"slices,omitempty"`
	DurationMs        int64  `json:"durationMs,omitempty"`
	QuantityJitterBps int    `json:"quantityJitterBps,omitempty"`
	IntervalJitterBps int    `json:"intervalJitterBps,omitempty"`
}

// ExecutionConstraints bound the strategy (types.ts).
type ExecutionConstraints struct {
	MaxDurationMs            int64  `json:"maxDurationMs,omitempty"`
	MaxReplacements          int    `json:"maxReplacements,omitempty"` // 0 = none permitted once a peg exists
	MaxChaseDistance         string `json:"maxChaseDistance,omitempty"`
	MinReplacementIntervalMs int64  `json:"minReplacementIntervalMs,omitempty"`
}
