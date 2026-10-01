// Package planner is the execution planner (objective §8.11; PRD §24, §56,
// §79-80, §98): the Go port of plan.ts. Pure request → plan transformation —
// it resolves the entry reference, validates the intent with strict FIELD-NAMED
// errors (never clamped, never silently fixed), sizes through package sizing,
// applies the leverage/margin/liquidation policy, and reports risk-vs-profit
// CONFLICTS (PRD §14/§117) with the printed figures. The risk bound is hard:
// an over-budget plan is RESIZED to the safe quantity and BLOCKED from creation
// by a blocking conflict. Deterministic — no clock, no randomness (TWAP jitter
// is never invented here).
package planner

import (
	"fmt"

	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/risk"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/sizing"
)

// Conflict is the frozen PRD §14 conflict shape (risk.ConstraintConflict):
// machine code, printed figures in the message, backing numbers in Detail.
type Conflict = risk.ConstraintConflict

// TwapSpec is the request-level TWAP configuration (types.ts TwapConfig — the
// request knob set, NOT the record-level executor.TwapConfig which carries the
// opt-in jitter in bps for persistence).
type TwapSpec struct {
	DurationMs        *int64
	Slices            *int
	IntervalMs        *int64
	QuantityJitterPct *string
	IntervalJitterPct *string
	PriceLimit        *string
	OrderType         string // "market" | "limit" | "maker"
	MaxSlippageBps    *string
	MaxSpreadBps      *string
}

// ExecutionSpec is the discriminated execution method (types.ts
// ExecutionDefinition). Only the fields of the named variant are meaningful.
type ExecutionSpec struct {
	Type                     executor.ExecutionStrategy
	Price                    string // limit: price level
	PostOnly                 *bool
	DurationMs               *int64 // twap / adaptive_twap
	Slices                   *int
	IntervalMs               *int64
	Urgency                  executor.ExecutionUrgency // adaptive_twap / chase_limit
	Config                   *TwapSpec
	VisibleQuantity          string // iceberg
	MaxReplacements          *int   // chase_limit
	MaxChaseDistance         *string
	MinReplacementIntervalMs *int64
	Levels                   []executor.ScaleLevel // scale_in / scale_out
}

// ConstraintSpec bounds the execution (types.ts ExecutionConstraints). Every
// bound is optional; a self-contradicting request is refused, never clamped.
type ConstraintSpec struct {
	MaxSlippageBps       *string
	MaxSpreadBps         *string
	MaxPrice             *string
	MinPrice             *string
	MaxDurationMs        *int64
	MakerOnly            bool
	AllowMarketFallback  *bool
	CancelIfRiskExceeded *bool
	StopIfDisconnected   *bool
}

// ExecutionRequest is the normalized client intent (types.ts ExecutionRequest;
// PRD §51). Money/quantity fields are decimal strings; absent optional fields
// are honest nils.
type ExecutionRequest struct {
	AccountID              string
	Symbol                 string
	MarketType             executor.MarketType
	Side                   executor.Side
	Intent                 executor.Intent
	Entry                  executor.EntryDefinition // Kind: "market" | "limit"
	StopLoss               *executor.PriceDefinition
	TakeProfits            []executor.TakeProfitLevel // must be a present array ([] for none)
	Sizing                 executor.SizingDefinition
	Leverage               *sizing.LeverageSpec
	MarginMode             *executor.MarginMode
	Execution              ExecutionSpec
	Constraints            *ConstraintSpec
	RiskPolicy             *executor.RiskBreachPolicy
	ExistingPositionPolicy *executor.ExistingPositionPolicy
	Mode                   *executor.ExecutionMode
	TargetProfit           *string
	MaxRisk                *string
}

// MarketSnapshot is the market data a plan is priced from (types.ts
// MarketSnapshot). Bid/Ask are honest nullable strings: a missing touch is an
// unpriced entry, never a fabricated one (house rule).
type MarketSnapshot struct {
	Symbol    string
	Bid       *string
	Ask       *string
	Mid       string
	SpreadBps string
	Last      string
	Timestamp int64
}

// PlanInputs are the deterministic planner inputs (plan.ts PlanInputs). The
// market snapshot is required for a market entry and optional for a limit.
type PlanInputs struct {
	Request       ExecutionRequest
	Market        *MarketSnapshot
	Exchange      executor.ExchangeID
	Instrument    risk.InstrumentMetadata
	FeeModel      risk.FeeModel
	SlippageModel risk.SlippageModel
	Balances      *risk.BalanceSnapshot
	RiskProfile   *executor.RiskProfile
}

// PlanRisk is the plan's risk block (types.ts ExecutionPlanRisk). Budget is the
// user's risk bound — nil when the sizing mode carries none. Every stop-based
// figure is nil without a stop (PRD §38/§116): render "—", never 0.
type PlanRisk struct {
	Budget             *string `json:"budget"`
	EstimatedTotalRisk *string `json:"estimatedTotalRisk"`
	PriceRisk          *string `json:"priceRisk"`
	EstimatedFees      string  `json:"estimatedFees"`
	SlippageBudget     string  `json:"slippageBudget"`
	SafetyReserve      *string `json:"safetyReserve"`
}

// PlanLeverage records how leverage was chosen (types.ts ExecutionPlan
// leverage block): manual is the user's number, auto_safe is the engine's
// minimum-feasible selection (PRD §18–§20).
type PlanLeverage struct {
	Mode     executor.LeverageMode `json:"mode"`
	Selected *string               `json:"selected"`
}

// PlanResult is the planner output (objective §8.11's named shape, carrying
// additionally the plan.ts ExecutionPlan/PreviewResult figures the parity
// vectors pin — honest nils throughout). Conflicts are non-nil ⇒ creation is
// blocked (PRD §117 default BLOCK); the result still shows Requested vs
// Possible.
type PlanResult struct {
	Quantity         string     `json:"quantity"`
	Notional         string     `json:"notional"`
	RequiredMargin   *string    `json:"requiredMargin"`
	EstimatedEntry   string     `json:"estimatedEntry"`
	LiquidationPrice *string    `json:"liquidationPrice"`
	Conflicts        []Conflict `json:"conflicts"`
	Warnings         []string   `json:"warnings"`

	UnroundedQuantity      string                     `json:"unroundedQuantity"`
	StopLoss               *string                    `json:"stopLoss"`
	TakeProfits            []executor.TakeProfitLevel `json:"takeProfits"`
	Risk                   PlanRisk                   `json:"risk"`
	Leverage               PlanLeverage               `json:"leverage"`
	LiquidationBuffer      *string                    `json:"liquidationBuffer"`
	LiquidationSafe        *bool                      `json:"liquidationSafe"`
	EstimatedSlices        *int                       `json:"estimatedSlices"`
	DurationMs             *int64                     `json:"durationMs"`
	TargetPrice            *string                    `json:"targetPrice"`
	ExpectedLossAtStop     *string                    `json:"expectedLossAtStop"`
	ExpectedProfitAtTarget *string                    `json:"expectedProfitAtTarget"`
	RiskReward             *string                    `json:"riskReward"`
	SizingMode             executor.SizingMode        `json:"sizingMode"`
	RiskBasis              *executor.BalanceBasis     `json:"riskBasis"`
	BalanceReference       *string                    `json:"balanceReference"`
}

// PlanError is a planner refusal. Validation failures carry EVERY field-named
// message (the API answers 400); the other codes are structural.
type PlanError struct {
	Code       string   // stable SCREAMING_SNAKE identifier
	Field      string   // primary field named, when one exists
	Message    string   // human-readable summary
	Validation []string // all field-named messages for CodeValidationFailed
}

func (e *PlanError) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("%s: %s: %s", e.Code, e.Field, e.Message)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Stable planner error codes (SCREAMING_SNAKE; TS ErrorCategory semantics — all
// non-retryable invalid-order-class refusals).
const (
	CodeValidationFailed = "VALIDATION_FAILED"
	CodeEntryUnpriced    = "ENTRY_UNPRICED"
)
