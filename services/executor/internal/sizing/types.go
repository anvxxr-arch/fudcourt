package sizing

import (
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/executor"
	"github.com/anvxxr-arch/fudcourt/services/executor/internal/risk"
)

// LeverageSpec is the leverage request half of the TS LeverageDefinition
// (types.ts): manual picks a user leverage; auto_safe delegates the
// minimum-feasible selection to risk.AutoSafeLeverage (PRD §18–§20).
type LeverageSpec struct {
	Mode                 executor.LeverageMode
	Leverage             string  // manual mode
	MaxLeverage          *string // auto_safe cap
	LiquidationBufferPct *string
	MaxMarginPct         *string
}

// SizeInputs carries everything one sizing resolution needs. ReferenceEntry is
// the plan's entry reference (a limit's own price or the market touch);
// Levels non-empty marks a scale-in ladder and routes §33 sizing. MaxRisk, when
// set, is the §37/§117 hard bound used to re-solve a ladder tighter than the
// sizing budget.
type SizeInputs struct {
	Sizing         executor.SizingDefinition
	Symbol         string
	MarketType     executor.MarketType
	Side           executor.Side
	EntryType      risk.EntryType
	ReferenceEntry string
	Stop           *string
	TakeProfits    []executor.TakeProfitLevel
	Levels         []executor.ScaleLevel
	FeeModel       risk.FeeModel
	SlippageModel  risk.SlippageModel
	Instrument     risk.InstrumentMetadata
	Balances       *risk.BalanceSnapshot
	RiskProfile    *executor.RiskProfile
	Leverage       LeverageSpec
	MaxRisk        *string
}

// SizedPosition is the sizing result (objective §8.13's named shape, plus the
// risk-figure fields the planner's ExecutionPlanRisk block carries downstream —
// sizing stays the single owner of the cost math). Nullable fields are honest
// nulls: no stop means the stop-based figures are nil, never "0".
type SizedPosition struct {
	Quantity         string
	Notional         string
	RequiredMargin   *string
	RequiredLeverage *string
	EstimatedEntry   string
	LiquidationPrice *string
	Warnings         []string

	UnroundedQuantity string
	Budget            *string
	RiskBasis         *executor.BalanceBasis
	BalanceReference  *string
	PriceRisk         *string
	EntryFee          string
	ExitFee           string
	SlippageBudget    string
	SafetyReserve     *string
	TotalRisk         *string
	Errors            []FieldError
}

// MarginResolution is the leverage/margin/liquidation policy output (PRD
// §17–§21): spot carries no leverage — its margin figure IS the required
// capital (§16).
type MarginResolution struct {
	Leverage                *string
	Margin                  *string
	LiquidationPrice        *string
	StopToLiquidationBuffer *string
	LiquidationSafe         *bool
	Warnings                []string
}
