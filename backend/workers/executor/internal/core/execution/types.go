// Package execution holds the canonical CEX executor domain types (objective
// §8.9–§8.16): the Go port of the frozen TypeScript contract in
// frontend/web/src/platform/executor/types.ts. Where the two disagree, the TS
// contract and its tests are the parity oracle until cutover (docs/architecture/
// executor.md).
//
// Money and quantity are DECIMAL STRINGS end to end (the TS side computes with
// decimal.js; float64 cannot represent these values exactly). Timestamps are
// unix milliseconds (database/schema/executor-schema.sql convention).
package execution

// MarketType distinguishes spot from linear perpetuals (types.ts MarketType).
type MarketType string

const (
	MarketSpot       MarketType = "spot"
	MarketLinearPerp MarketType = "linear_perp"
)

// Side of an order/position (types.ts Side).
type Side string

const (
	SideBuy  Side = "buy"
	SideSell Side = "sell"
)

// Intent expresses whether an execution opens, closes or reduces a position
// (types.ts Intent). Exits are never gated by risk ceilings (PRD §93).
type Intent string

const (
	IntentOpen   Intent = "open"
	IntentClose  Intent = "close"
	IntentReduce Intent = "reduce"
)

// ExchangeID names a supported venue (types.ts ExchangeId).
type ExchangeID string

const (
	ExchangeBinance ExchangeID = "binance"
	ExchangeBybit   ExchangeID = "bybit"
	ExchangeMEXC    ExchangeID = "mexc"
)

// Valid reports whether the venue id is one this build supports.
func (e ExchangeID) Valid() bool {
	switch e {
	case ExchangeBinance, ExchangeBybit, ExchangeMEXC:
		return true
	}
	return false
}

// TimeInForce mirrors the venue TIF vocabulary (types.ts TimeInForce).
type TimeInForce string

const (
	TIFGTC TimeInForce = "GTC"
	TIFIOC TimeInForce = "IOC"
	TIFFOK TimeInForce = "FOK"
)

// ExecutionUrgency biases the strategy's aggressiveness (types.ts).
type ExecutionUrgency string

const (
	UrgencyPassive    ExecutionUrgency = "passive"
	UrgencyBalanced   ExecutionUrgency = "balanced"
	UrgencyAggressive ExecutionUrgency = "aggressive"
	UrgencyImmediate  ExecutionUrgency = "immediate"
)

// LeverageMode distinguishes a user-chosen leverage from the engine's
// minimum-feasible selection (types.ts; PRD §18–§20).
type LeverageMode string

const (
	LeverageManual   LeverageMode = "manual"
	LeverageAutoSafe LeverageMode = "auto_safe"
)

// MarginMode mirrors venue margin modes (types.ts).
type MarginMode string

const (
	MarginIsolated MarginMode = "isolated"
	MarginCross    MarginMode = "cross"
)

// PositionMode mirrors one-way vs hedge (types.ts).
type PositionMode string

const (
	PositionOneWay PositionMode = "one_way"
	PositionHedge  PositionMode = "hedge"
)
