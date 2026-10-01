// Package risk is the ONE canonical owner of the position-risk formulas
// (objective §8.12; PRD §102/§103). It is the Go port of
// apps/web/src/platform/executor/risk.ts — pure math, no HTTP, no DB, no
// exchange API. Money and quantity are decimal strings computed with
// internal/decimal (never float64); every exposure quantity is rounded DOWN to
// the step grid so a rounded position can never exceed the unrounded budget
// (PRD §106).
//
// Cost model (PRD §22–§23): with mult = contractMultiplier,
//
//	priceRisk     = Q·mult·|E−S|
//	entryFee      = Q·mult·E·(entryType=="limit" ? makerBps : takerBps)/1e4
//	exitFee       = Q·mult·S·takerBps/1e4      (risk figures exit at the stop)
//	slippageRisk  = Q·mult·E·slippageBps/1e4   (market entries only; ONCE)
//	safetyReserve = priceRisk·safetyReservePct (fraction of PRICE RISK)
//	totalRisk     = Σ = Q·unitRisk             — exactly linear in Q.
//
// Profit figures exit at the target instead of the stop and are NET of the same
// costs (PRD §13). Results carry warnings for numeric edge cases (clamped
// values, rounding-down notices, instrument bound rejections); structurally
// invalid input (missing instrument, unusable step grid) is a returned error.
package risk

import (
	"math/big"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/executor"
)

// EntryType names how the entry leg fills (types.ts 'market' | 'limit'); the
// empty value behaves like market, mirroring the TS `entryType?:` default.
type EntryType string

const (
	EntryMarket EntryType = "market"
	EntryLimit  EntryType = "limit"
)

// FeeModel is the venue fee schedule in bps of notional (types.ts FeeModel).
type FeeModel struct {
	MakerBps string `json:"makerBps"`
	TakerBps string `json:"takerBps"`
}

// SlippageModel prices slippage + safety reserve into every risk figure
// (types.ts SlippageModel). SafetyReservePct is a fraction of PRICE RISK — not
// of the budget — so sizing stays linear in quantity (PRD §22).
type SlippageModel struct {
	SlippageBps      string `json:"slippageBps"`
	SafetyReservePct string `json:"safetyReservePct"`
}

// InstrumentMetadata is everything a calculated order must round against
// (types.ts InstrumentMetadata; PRD §70). Money/quantity fields are decimal
// strings; nullable bounds are *string so an unknown bound is honestly absent.
type InstrumentMetadata struct {
	Symbol                string              `json:"symbol"`
	MarketType            executor.MarketType `json:"marketType"`
	Exchange              executor.ExchangeID `json:"exchange"`
	BaseAsset             string              `json:"baseAsset"`
	QuoteAsset            string              `json:"quoteAsset"`
	SettlementAsset       string              `json:"settlementAsset"`
	TickSize              string              `json:"tickSize"`
	StepSize              string              `json:"stepSize"`
	MinQuantity           *string             `json:"minQuantity"`
	MaxQuantity           *string             `json:"maxQuantity"`
	MinNotional           *string             `json:"minNotional"`
	MaxNotional           *string             `json:"maxNotional"`
	ContractMultiplier    string              `json:"contractMultiplier"`
	MaxLeverage           *string             `json:"maxLeverage"`
	MaintenanceMarginRate *string             `json:"maintenanceMarginRate"`
	LeverageBrackets      []LeverageBracket   `json:"leverageBrackets"`
}

// LeverageBracket is one leverage tier, ascending by notional (PRD §18).
type LeverageBracket struct {
	MaxNotional           *string `json:"maxNotional"`
	MaxLeverage           string  `json:"maxLeverage"`
	MaintenanceMarginRate string  `json:"maintenanceMarginRate"`
}

// BalanceSnapshot is a resolved balance view (types.ts BalanceSnapshot). Every
// figure is nullable: a missing balance is NOT a zero balance (house rule).
type BalanceSnapshot struct {
	SpotAvailable       *string `json:"spotAvailable"`
	SpotEquity          *string `json:"spotEquity"`
	FuturesAvailable    *string `json:"futuresAvailable"`
	FuturesEquity       *string `json:"futuresEquity"`
	TotalExchangeEquity *string `json:"totalExchangeEquity"`
	AssetEquity         *string `json:"assetEquity"`
	Custom              *string `json:"custom"`
}

// RiskBreakdown splits the per-position cost model by leg (types.ts
// RiskBreakdown; PRD §22–§23). All values in quote currency.
type RiskBreakdown struct {
	PriceRisk     string `json:"priceRisk"`
	EntryFee      string `json:"entryFee"`
	ExitFee       string `json:"exitFee"`
	SlippageRisk  string `json:"slippageRisk"`
	SafetyReserve string `json:"safetyReserve"`
	TotalRisk     string `json:"totalRisk"`
}

// SizedPosition is the risk-engine sizing result (types.ts SizedPosition).
type SizedPosition struct {
	Quantity          string        `json:"quantity"`
	UnroundedQuantity string        `json:"unroundedQuantity"`
	Notional          string        `json:"notional"`
	Risk              RiskBreakdown `json:"risk"`
	Warnings          []string      `json:"warnings"`
}

// ProfitPositionResult is outcome sizing (types.ts ProfitPositionResult).
type ProfitPositionResult struct {
	Quantity          string         `json:"quantity"`
	UnroundedQuantity string         `json:"unroundedQuantity"`
	Notional          string         `json:"notional"`
	EstimatedProfit   string         `json:"estimatedProfit"`
	Risk              *RiskBreakdown `json:"risk"`
	Warnings          []string       `json:"warnings"`
}

// ConstraintConflict is the PRD §14 response shape: machine code, printed
// figures in the message, and the numbers backing it (types.ts
// ConstraintConflict). Codes are the frozen TS identifiers; Detail values are
// decimal strings.
type ConstraintConflict struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Detail  map[string]string `json:"detail,omitempty"`
}

// RiskPositionInput sizes a position from a risk budget (types.ts
// RiskPositionInput). Market entries pay taker + entry slippage; limit entries
// pay maker and no entry slippage — slippage is charged exactly ONCE.
type RiskPositionInput struct {
	Side          executor.Side
	Entry         string
	Stop          string
	RiskBudget    string
	FeeModel      FeeModel
	SlippageModel SlippageModel
	Instrument    InstrumentMetadata
	EntryType     EntryType
}

// ProfitPositionInput sizes a position to a NET target profit (types.ts
// ProfitPositionInput).
type ProfitPositionInput struct {
	Side          executor.Side
	Entry         string
	Target        string
	DesiredProfit string
	FeeModel      FeeModel
	SlippageModel SlippageModel
	Instrument    InstrumentMetadata
	EntryType     EntryType
}

// EstimateNetProfitInput prices a take-profit plan as given (types.ts planner
// seam). Each level closes Quantity × Fraction; the unexited remainder earns no
// profit but still carries its share of the entry fee.
type EstimateNetProfitInput struct {
	Side          executor.Side
	Entry         string
	Quantity      string
	TakeProfits   []executor.TakeProfitLevel
	FeeModel      FeeModel
	SlippageModel SlippageModel
	Instrument    InstrumentMetadata
	EntryType     EntryType
}

// ProjectedRiskInput risks a filled position at its average entry (types.ts
// ProjectedRiskInput; PRD §36).
type ProjectedRiskInput struct {
	Side          executor.Side
	AverageEntry  string
	Quantity      string
	Stop          string
	FeeModel      FeeModel
	SlippageModel SlippageModel
	Instrument    InstrumentMetadata
}

// MaxSafeQuantityInput is the remaining-budget resize (types.ts
// MaxSafeQuantityInput; PRD §37).
type MaxSafeQuantityInput struct {
	Side            executor.Side
	ReferenceEntry  string
	Stop            string
	RemainingBudget string
	FilledQuantity  string
	FeeModel        FeeModel
	SlippageModel   SlippageModel
	Instrument      InstrumentMetadata
}

// MaxSafeQuantityResult is the largest ADDITIONAL quantity whose full-position
// risk stays inside the remaining budget (types.ts MaxSafeQuantityResult).
type MaxSafeQuantityResult struct {
	MaxAdditionalQuantity       string        `json:"maxAdditionalQuantity"`
	UnroundedAdditionalQuantity string        `json:"unroundedAdditionalQuantity"`
	ProjectedRiskAfter          RiskBreakdown `json:"projectedRiskAfter"`
	Warnings                    []string      `json:"warnings"`
}

// AutoLeverageInput drives AUTO_SAFE selection (types.ts AutoLeverageInput;
// PRD §18–§20).
type AutoLeverageInput struct {
	Side                  executor.Side
	Entry                 string
	Stop                  *string
	Notional              string
	AvailableBalance      string
	MaxLeverage           string
	ExchangeMaxLeverage   *string
	LiquidationBufferPct  string
	MaxMarginPct          string
	MaintenanceMarginRate *string
}

// AutoLeverageResult reports the minimum feasible leverage and what it means
// (types.ts AutoLeverageResult). LiquidationSafe is honest: it is never claimed
// without the §20 buffer check passing at the selected leverage.
type AutoLeverageResult struct {
	Selected         string   `json:"selected"`
	EstimatedMargin  string   `json:"estimatedMargin"`
	LiquidationPrice *string  `json:"liquidationPrice"`
	LiquidationSafe  bool     `json:"liquidationSafe"`
	Warnings         []string `json:"warnings"`
}

// SolveKey names one closed-form solver variable (types.ts SolveInput.known).
type SolveKey string

const (
	SolveEntry    SolveKey = "entry"
	SolveStop     SolveKey = "stop"
	SolveTarget   SolveKey = "target"
	SolveQuantity SolveKey = "quantity"
	SolveRisk     SolveKey = "risk"
	SolveProfit   SolveKey = "profit"
	SolveMargin   SolveKey = "margin"
	SolveNotional SolveKey = "notional"
	SolveLeverage SolveKey = "leverage"
)

// SolveKeys lists the solver variables in contract order (types.ts SOLVE_KEYS).
var SolveKeys = []SolveKey{
	SolveEntry, SolveStop, SolveTarget, SolveQuantity, SolveRisk,
	SolveProfit, SolveMargin, SolveNotional, SolveLeverage,
}

// SolveKnown is the known subset handed to the solver; absent values are
// honest unknowns and are listed in Unsatisfied, never guessed.
type SolveKnown struct {
	Entry    *string
	Stop     *string
	Target   *string
	Quantity *string
	Risk     *string
	Profit   *string
	Margin   *string
	Notional *string
	Leverage *string
}

// SolveInput drives the PRD §15 constraint solver (types.ts SolveInput).
type SolveInput struct {
	Side          executor.Side
	Instrument    InstrumentMetadata
	FeeModel      FeeModel
	SlippageModel SlippageModel
	Known         SolveKnown
}

// SolveResult reports the closed-form solution (types.ts SolveResult).
type SolveResult struct {
	Solved      map[string]string    `json:"solved"`
	Unsatisfied []SolveKey           `json:"unsatisfied"`
	Conflicts   []ConstraintConflict `json:"conflicts"`
	Warnings    []string             `json:"warnings"`
}

// bps is the bps→fraction denominator (decimal string, parsed once per call
// site via the helpers below).
var bpsDenom = big.NewRat(10000, 1)
