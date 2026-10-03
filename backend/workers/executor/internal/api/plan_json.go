package api

// The wire shape of an ExecutionPlan / PreviewResult (types.ts). These are
// STRUCTS, not maps, because JSON object key order is part of the byte-shape
// compatibility the web tier depends on and encoding/json would sort a map's
// keys alphabetically. Field order below is the TS literal order in
// plan.ts's plan assembly.

import (
	"encoding/json"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/planner"
	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/risk"
)

// WireInstrument is the wire InstrumentMetadata.
type WireInstrument struct {
	Symbol                string               `json:"symbol"`
	MarketType            execution.MarketType `json:"marketType"`
	Exchange              execution.ExchangeID `json:"exchange"`
	BaseAsset             string               `json:"baseAsset"`
	QuoteAsset            string               `json:"quoteAsset"`
	SettlementAsset       string               `json:"settlementAsset"`
	TickSize              string               `json:"tickSize"`
	StepSize              string               `json:"stepSize"`
	MinQuantity           *string              `json:"minQuantity"`
	MaxQuantity           *string              `json:"maxQuantity"`
	MinNotional           *string              `json:"minNotional"`
	MaxNotional           *string              `json:"maxNotional"`
	ContractMultiplier    string               `json:"contractMultiplier"`
	MaxLeverage           *string              `json:"maxLeverage"`
	MaintenanceMarginRate *string              `json:"maintenanceMarginRate"`
	LeverageBrackets      []WireBracket        `json:"leverageBrackets"`
}

// WireBracket is one wire leverage bracket.
type WireBracket struct {
	MaxNotional           *string `json:"maxNotional"`
	MaxLeverage           string  `json:"maxLeverage"`
	MaintenanceMarginRate string  `json:"maintenanceMarginRate"`
}

// WireMarketSnapshot is the wire MarketSnapshot (non-nullable numbers).
type WireMarketSnapshot struct {
	Symbol    string      `json:"symbol"`
	Bid       json.Number `json:"bid"`
	Ask       json.Number `json:"ask"`
	Mid       json.Number `json:"mid"`
	SpreadBps json.Number `json:"spreadBps"`
	Last      json.Number `json:"last"`
	Timestamp int64       `json:"timestamp"`
}

// WireBalanceSnapshot is the wire BalanceSnapshot (honest nulls).
type WireBalanceSnapshot struct {
	SpotAvailable       *json.Number `json:"spotAvailable"`
	SpotEquity          *json.Number `json:"spotEquity"`
	FuturesAvailable    *json.Number `json:"futuresAvailable"`
	FuturesEquity       *json.Number `json:"futuresEquity"`
	TotalExchangeEquity *json.Number `json:"totalExchangeEquity"`
}

// WirePlanRisk is the plan's risk block.
type WirePlanRisk struct {
	Budget             *json.Number `json:"budget"`
	EstimatedTotalRisk *json.Number `json:"estimatedTotalRisk"`
	PriceRisk          *json.Number `json:"priceRisk"`
	EstimatedFees      json.Number  `json:"estimatedFees"`
	SlippageBudget     json.Number  `json:"slippageBudget"`
	SafetyReserve      *json.Number `json:"safetyReserve"`
}

// WirePlanLeverage is the plan's leverage block.
type WirePlanLeverage struct {
	Mode     string       `json:"mode"`
	Selected *json.Number `json:"selected"`
}

// WirePlanMargin is the plan's margin block.
type WirePlanMargin struct {
	EstimatedInitial *json.Number `json:"estimatedInitial"`
	Mode             *string      `json:"mode"`
}

// WirePlanLiquidation is the plan's liquidation block.
type WirePlanLiquidation struct {
	PriceApprox             *json.Number `json:"priceApprox"`
	StopToLiquidationBuffer *json.Number `json:"stopToLiquidationBuffer"`
	Safe                    *bool        `json:"safe"`
}

// WirePlanExecution is the plan's execution block.
type WirePlanExecution struct {
	Strategy        execution.ExecutionStrategy `json:"strategy"`
	DurationMs      *json.Number                `json:"durationMs"`
	EstimatedSlices *json.Number                `json:"estimatedSlices"`
	Urgency         *execution.ExecutionUrgency `json:"urgency"`
}

// WirePlan is the wire ExecutionPlan (field order = the TS literal order).
type WirePlan struct {
	VenueKey         string                      `json:"venueKey"`
	Symbol           string                      `json:"symbol"`
	MarketType       execution.MarketType        `json:"marketType"`
	Side             execution.Side              `json:"side"`
	Intent           execution.Intent            `json:"intent"`
	Quantity         json.Number                 `json:"quantity"`
	Notional         json.Number                 `json:"notional"`
	EstimatedEntry   json.Number                 `json:"estimatedEntry"`
	StopLoss         *json.Number                `json:"stopLoss"`
	TakeProfits      []execution.TakeProfitLevel `json:"takeProfits"`
	Risk             WirePlanRisk                `json:"risk"`
	Leverage         WirePlanLeverage            `json:"leverage"`
	Margin           WirePlanMargin              `json:"margin"`
	Liquidation      WirePlanLiquidation         `json:"liquidation"`
	Execution        WirePlanExecution           `json:"execution"`
	Instrument       WireInstrument              `json:"instrument"`
	FeeModel         WireFeeModel                `json:"feeModel"`
	SlippageModel    WireSlippageModel           `json:"slippageModel"`
	BalanceSnapshot  *WireBalanceSnapshot        `json:"balanceSnapshot"`
	MarketSnapshot   *WireMarketSnapshot         `json:"marketSnapshot"`
	SizingMode       execution.SizingMode        `json:"sizingMode"`
	SizingValue      json.Number                 `json:"sizingValue"`
	RiskBasis        *execution.BalanceBasis     `json:"riskBasis"`
	BalanceReference *json.Number                `json:"balanceReference"`
}

// WireFeeModel is the wire FeeModel.
type WireFeeModel struct {
	MakerBps string `json:"makerBps"`
	TakerBps string `json:"takerBps"`
}

// WireSlippageModel is the wire SlippageModel.
type WireSlippageModel struct {
	SlippageBps      string `json:"slippageBps"`
	SafetyReservePct string `json:"safetyReservePct"`
}

// WirePreview is the wire PreviewResult.
type WirePreview struct {
	Plan                   WirePlan                `json:"plan"`
	ExpectedLossAtStop     *json.Number            `json:"expectedLossAtStop"`
	ExpectedProfitAtTarget *json.Number            `json:"expectedProfitAtTarget"`
	TargetPrice            *json.Number            `json:"targetPrice"`
	RiskReward             *json.Number            `json:"riskReward"`
	Conflicts              json.RawMessage         `json:"conflicts"`
	Warnings               []string                `json:"warnings"`
	Mode                   execution.ExecutionMode `json:"mode"`
}

// planningPreviewValue builds the wire PreviewResult from the planner outcome.
func planningPreviewValue(outcome planner.PlanResult, inputs planner.PlanInputs, req planner.ExecutionRequest, mode execution.ExecutionMode) WirePreview {
	warnings := outcome.Warnings
	if warnings == nil {
		warnings = []string{}
	}
	tps := outcome.TakeProfits
	if tps == nil {
		tps = []execution.TakeProfitLevel{}
	}
	conflicts := jsonAny(outcome.Conflicts)
	return WirePreview{
		Plan:                   planningPlanValue(outcome, inputs, req),
		ExpectedLossAtStop:     numPtr(outcome.ExpectedLossAtStop),
		ExpectedProfitAtTarget: numPtr(outcome.ExpectedProfitAtTarget),
		TargetPrice:            numPtr(outcome.TargetPrice),
		RiskReward:             numPtr(outcome.RiskReward),
		Conflicts:              mustJSON(conflicts),
		Warnings:               warnings,
		Mode:                   mode,
	}
}

// planningPlanValue builds the wire ExecutionPlan. The plan figures come from
// the planner result; the creation-time context (instrument, snapshots, fee and
// slippage models) comes from the plan inputs.
func planningPlanValue(outcome planner.PlanResult, inputs planner.PlanInputs, req planner.ExecutionRequest) WirePlan {
	plan := WirePlan{
		VenueKey:       venueKey(inputs.Exchange, req.MarketType, req.Symbol),
		Symbol:         req.Symbol,
		MarketType:     req.MarketType,
		Side:           req.Side,
		Intent:         req.Intent,
		Quantity:       num(outcome.Quantity),
		Notional:       num(outcome.Notional),
		EstimatedEntry: num(outcome.EstimatedEntry),
		StopLoss:       numPtr(outcome.StopLoss),
		Risk: WirePlanRisk{
			Budget:             numPtr(outcome.Risk.Budget),
			EstimatedTotalRisk: numPtr(outcome.Risk.EstimatedTotalRisk),
			PriceRisk:          numPtr(outcome.Risk.PriceRisk),
			EstimatedFees:      num(outcome.Risk.EstimatedFees),
			SlippageBudget:     num(outcome.Risk.SlippageBudget),
			SafetyReserve:      numPtr(outcome.Risk.SafetyReserve),
		},
		Leverage: WirePlanLeverage{Mode: string(outcome.Leverage.Mode), Selected: numPtr(outcome.Leverage.Selected)},
		Margin: WirePlanMargin{
			EstimatedInitial: numPtr(outcome.RequiredMargin),
			Mode:             marginMode(req),
		},
		Liquidation: WirePlanLiquidation{
			PriceApprox:             numPtr(outcome.LiquidationPrice),
			StopToLiquidationBuffer: numPtr(outcome.LiquidationBuffer),
			Safe:                    outcome.LiquidationSafe,
		},
		Execution: WirePlanExecution{
			Strategy:        req.Execution.Type,
			DurationMs:      int64NumPtr(outcome.DurationMs),
			EstimatedSlices: intNumPtr(outcome.EstimatedSlices),
			Urgency:         urgency(req),
		},
		Instrument:       toWireInstrument(inputs.Instrument),
		FeeModel:         WireFeeModel{MakerBps: inputs.FeeModel.MakerBps, TakerBps: inputs.FeeModel.TakerBps},
		SlippageModel:    WireSlippageModel{SlippageBps: inputs.SlippageModel.SlippageBps, SafetyReservePct: inputs.SlippageModel.SafetyReservePct},
		BalanceSnapshot:  toWireBalance(inputs.Balances),
		MarketSnapshot:   toWireMarket(inputs.Market),
		SizingMode:       req.Sizing.Mode,
		SizingValue:      num(sizingValue(req.Sizing)),
		RiskBasis:        outcome.RiskBasis,
		BalanceReference: numPtr(outcome.BalanceReference),
	}
	tps := outcome.TakeProfits
	if tps == nil {
		tps = []execution.TakeProfitLevel{}
	}
	plan.TakeProfits = tps
	return plan
}

// marginMode is the plan's margin mode: null for spot, else the request's
// choice falling back to the profile default (plan.ts).
func marginMode(req planner.ExecutionRequest) *string {
	if req.MarketType == execution.MarketSpot {
		return nil
	}
	if req.MarginMode != nil {
		m := string(*req.MarginMode)
		return &m
	}
	m := string(planner.DefaultRiskProfile.DefaultMarginMode)
	return &m
}

// urgency is the plan's urgency: only the chase/adaptive strategies carry one.
func urgency(req planner.ExecutionRequest) *execution.ExecutionUrgency {
	if req.Execution.Urgency == "" {
		return nil
	}
	u := req.Execution.Urgency
	return &u
}

func intNumPtr(v *int) *json.Number {
	if v == nil {
		return nil
	}
	n := json.Number(itoa(*v))
	return &n
}

func int64NumPtr(v *int64) *json.Number {
	if v == nil {
		return nil
	}
	n := json.Number(itoa64(*v))
	return &n
}

func toWireInstrument(in risk.InstrumentMetadata) WireInstrument {
	brackets := make([]WireBracket, 0, len(in.LeverageBrackets))
	for _, b := range in.LeverageBrackets {
		brackets = append(brackets, WireBracket{MaxNotional: b.MaxNotional, MaxLeverage: b.MaxLeverage, MaintenanceMarginRate: b.MaintenanceMarginRate})
	}
	return WireInstrument{
		Symbol: in.Symbol, MarketType: in.MarketType, Exchange: in.Exchange,
		BaseAsset: in.BaseAsset, QuoteAsset: in.QuoteAsset, SettlementAsset: in.SettlementAsset,
		TickSize: in.TickSize, StepSize: in.StepSize,
		MinQuantity: in.MinQuantity, MaxQuantity: in.MaxQuantity,
		MinNotional: in.MinNotional, MaxNotional: in.MaxNotional,
		ContractMultiplier: in.ContractMultiplier, MaxLeverage: in.MaxLeverage,
		MaintenanceMarginRate: in.MaintenanceMarginRate, LeverageBrackets: brackets,
	}
}

func toWireBalance(b *risk.BalanceSnapshot) *WireBalanceSnapshot {
	if b == nil {
		return nil
	}
	return &WireBalanceSnapshot{
		SpotAvailable:       numPtr(b.SpotAvailable),
		SpotEquity:          numPtr(b.SpotEquity),
		FuturesAvailable:    numPtr(b.FuturesAvailable),
		FuturesEquity:       numPtr(b.FuturesEquity),
		TotalExchangeEquity: numPtr(b.TotalExchangeEquity),
	}
}

func toWireMarket(m *planner.MarketSnapshot) *WireMarketSnapshot {
	if m == nil {
		return nil
	}
	return &WireMarketSnapshot{
		Symbol:    m.Symbol,
		Bid:       num(deref(m.Bid)),
		Ask:       num(deref(m.Ask)),
		Mid:       num(m.Mid),
		SpreadBps: num(m.SpreadBps),
		Last:      num(m.Last),
		Timestamp: m.Timestamp,
	}
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("[]")
	}
	return b
}
