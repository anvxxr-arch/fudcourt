package api

// Conversions between the executor's storage/domain shapes and the wire shapes.
// The storage layer carries money/quantity as DECIMAL STRINGS (exact); the wire
// contract carries JSON NUMBERS, so every numeric field is emitted as a
// json.Number built from the stored decimal text (never a float64 round trip).

import (
	"encoding/json"

	"github.com/anvxxr-arch/fudcourt/backend/workers/executor/internal/core/execution"
)

// num maps a non-nullable decimal string to a wire number. An empty string is
// "0" (the storage convention: a field that exists but carries zero).
func num(s string) json.Number {
	if s == "" {
		return json.Number("0")
	}
	return json.Number(s)
}

// numPtr maps an optional decimal string, nil staying nil (honest absence).
func numPtr(s *string) *json.Number {
	if s == nil {
		return nil
	}
	n := num(*s)
	return &n
}

// timePtr maps the domain's zero-means-absent timestamp onto null.
func timePtr(ms int64) *int64 {
	if ms == 0 {
		return nil
	}
	return &ms
}

// jsonAny renders a domain value as wire JSON (round-tripped through
// encoding/json so the shape matches the TS literal).
func jsonAny(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil
	}
	return out
}

// toWireExecution maps one stored execution record onto the wire shape.
func toWireExecution(rec execution.ExecutionRecord) ExecutionRecord {
	tps := make([]any, 0, len(rec.TakeProfit))
	for _, tp := range rec.TakeProfit {
		tps = append(tps, jsonAny(tp))
	}
	var stop any
	if rec.StopDefinition != nil {
		stop = jsonAny(*rec.StopDefinition)
	}
	return ExecutionRecord{
		ID:                rec.ID,
		UserID:            rec.UserID,
		AccountID:         rec.AccountID,
		Exchange:          rec.Exchange,
		Symbol:            rec.Symbol,
		MarketType:        rec.MarketType,
		Side:              rec.Side,
		Intent:            rec.Intent,
		Status:            rec.Status,
		Mode:              rec.Mode,
		SizingMode:        rec.SizingMode,
		SizingValue:       num(rec.SizingValue),
		RiskBudget:        numPtr(rec.RiskBudget),
		RiskBasis:         rec.RiskBasis,
		EntryDefinition:   jsonAny(rec.EntryDefinition),
		StopDefinition:    stop,
		TakeProfit:        tps,
		ExecutionStrategy: rec.ExecutionStrategy,
		ExecutionConfig:   jsonAny(rec.ExecutionConfig),
		Constraints:       jsonAny(rec.Constraints),
		PlannedQuantity:   num(rec.PlannedQuantity),
		PlannedNotional:   num(rec.PlannedNotional),
		ActualQuantity:    num(rec.ActualQuantity),
		ActualNotional:    num(rec.ActualNotional),
		AverageFillPrice:  numPtr(rec.AverageFillPrice),
		EstimatedFees:     numPtr(rec.EstimatedFees),
		ActualFees:        num(rec.ActualFees),
		PlannedRisk:       numPtr(rec.PlannedRisk),
		CurrentRisk:       numPtr(rec.CurrentRisk),
		StrategyState:     rec.EngineState,
		CreatedAt:         rec.CreatedAt,
		StartedAt:         timePtr(rec.StartedAt),
		CompletedAt:       timePtr(rec.CompletedAt),
		CancelledAt:       timePtr(rec.CancelledAt),
	}
}

// toWireChild maps one child order record onto the wire shape.
func toWireChild(c execution.ChildOrderRecord) ChildOrderRecord {
	return ChildOrderRecord{
		ID:              c.ID,
		ExecutionID:     c.ExecutionID,
		ExchangeOrderID: c.ExchangeOrderID,
		ClientOrderID:   c.ClientOrderID,
		Symbol:          c.Symbol,
		Side:            c.Side,
		Type:            c.Type,
		Price:           numPtr(c.Price),
		Quantity:        num(c.Quantity),
		FilledQuantity:  num(c.FilledQuantity),
		Status:          c.Status,
		IsExit:          c.IsExit,
		SubmittedAt:     c.SubmittedAt,
		UpdatedAt:       c.UpdatedAt,
		FilledAt:        c.FilledAt,
	}
}

// toWireFill maps one fill record onto the wire shape.
func toWireFill(f execution.FillRecord) FillRecord {
	return FillRecord{
		ID:              f.ID,
		ExecutionID:     f.ExecutionID,
		ChildOrderID:    f.ChildOrderID,
		ExchangeTradeID: f.ExchangeTradeID,
		Price:           num(f.Price),
		Quantity:        num(f.Quantity),
		QuoteQuantity:   num(f.QuoteQuantity),
		Fee:             num(f.Fee),
		FeeAsset:        f.FeeAsset,
		Timestamp:       f.Timestamp,
	}
}

// toWireProfile maps the domain risk profile onto the wire shape.
func toWireProfile(p execution.RiskProfile) RiskProfile {
	return RiskProfile{
		DefaultRiskMode:         p.DefaultRiskMode,
		DefaultRisk:             p.DefaultRisk,
		MaxRiskPerTradePct:      p.MaxRiskPerTradePct,
		MaxOpenRiskPct:          p.MaxOpenRiskPct,
		MaxDailyLossPct:         p.MaxDailyLossPct,
		MaxLeverage:             p.MaxLeverage,
		DefaultMarginMode:       string(p.DefaultMarginMode),
		DefaultExecutionUrgency: string(p.DefaultExecutionUrgency),
	}
}

// profileFromWire maps the wire profile back onto the domain shape.
func profileFromWire(p RiskProfile) execution.RiskProfile {
	return execution.RiskProfile{
		DefaultRiskMode:         p.DefaultRiskMode,
		DefaultRisk:             p.DefaultRisk,
		MaxRiskPerTradePct:      p.MaxRiskPerTradePct,
		MaxOpenRiskPct:          p.MaxOpenRiskPct,
		MaxDailyLossPct:         p.MaxDailyLossPct,
		MaxLeverage:             p.MaxLeverage,
		DefaultMarginMode:       execution.MarginMode(p.DefaultMarginMode),
		DefaultExecutionUrgency: execution.ExecutionUrgency(p.DefaultExecutionUrgency),
	}
}
