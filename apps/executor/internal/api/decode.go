package api

// Request decoding: the wire JSON of an ExecutionRequest (and the supporting
// envelopes) mapped onto the planner's core types. The wire is CLOSED
// (additionalProperties: false in the contract); a field the request does not
// carry is an honest nil, never a fabricated default. Numbers arrive as
// JSON numbers and are converted to the planner's decimal strings EXACTLY (via
// the JSON token text, not float64).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/planner"
	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/sizing"
)

// decodeNum renders a JSON number token as a decimal string, exactly as
// written. A non-number token is refused rather than coerced.
func decodeNum(raw json.RawMessage) (string, error) {
	s := strings.TrimSpace(string(raw))
	if _, err := strconv.ParseFloat(s, 64); err != nil {
		return "", fmt.Errorf("not a JSON number: %q", s)
	}
	return s, nil
}

// decNumPtr renders an optional JSON number; absent/null is nil.
func decNumPtr(raw json.RawMessage) (*string, error) {
	if isNullish(raw) {
		return nil, nil
	}
	v, err := decodeNum(raw)
	if err != nil {
		return nil, fmt.Errorf("decode number: %w", err)
	}
	return &v, nil
}

func decBoolPtr(raw json.RawMessage) (*bool, error) {
	if isNullish(raw) {
		return nil, nil
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, fmt.Errorf("decode boolean: %w", err)
	}
	return &b, nil
}

func decIntPtr(raw json.RawMessage) (*int64, error) {
	if isNullish(raw) {
		return nil, nil
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, fmt.Errorf("decode integer: %w", err)
	}
	return &n, nil
}

func decStringPtr(raw json.RawMessage) (*string, error) {
	if isNullish(raw) {
		return nil, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("decode string: %w", err)
	}
	return &s, nil
}

func isNullish(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s == "" || s == "null"
}

// obj is a decoded JSON object with raw values, so each field's token text
// survives (needed for exact numbers).
type obj map[string]json.RawMessage

func decodeObj(raw json.RawMessage) (obj, error) {
	var o obj
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, fmt.Errorf("decode object: %w", err)
	}
	return o, nil
}

// decodeRequest maps the wire ExecutionRequest onto planner.ExecutionRequest.
// Shape errors (empty accountId, unknown market/side/intent/mode) are the
// locally-checkable subset of validateRequestShape in runtime.ts; the planner is
// strict about everything else.
func decodeRequest(body json.RawMessage) (planner.ExecutionRequest, []string, error) {
	var req planner.ExecutionRequest
	o, err := decodeObj(body)
	if err != nil {
		return req, nil, err
	}
	var shape []string
	req.AccountID = rawString(o["accountId"])
	if req.AccountID == "" {
		shape = append(shape, "accountId: must be a non-empty string")
	}
	req.Symbol = rawString(o["symbol"])
	market := rawString(o["marketType"])
	req.MarketType = execution.MarketType(market)
	if market != string(execution.MarketSpot) && market != string(execution.MarketLinearPerp) {
		shape = append(shape, "marketType: must be spot or linear_perp")
	}
	side := rawString(o["side"])
	req.Side = execution.Side(side)
	if side != string(execution.SideBuy) && side != string(execution.SideSell) {
		shape = append(shape, "side: must be buy or sell")
	}
	intent := rawString(o["intent"])
	req.Intent = execution.Intent(intent)
	if intent != string(execution.IntentOpen) && intent != string(execution.IntentClose) && intent != string(execution.IntentReduce) {
		shape = append(shape, "intent: must be open, close or reduce")
	}
	if raw := o["mode"]; !isNullish(raw) {
		mode := execution.ExecutionMode(rawString(raw))
		if mode != execution.ModePreview && mode != execution.ModePaper && mode != execution.ModeLive {
			shape = append(shape, "mode: must be preview, paper or live")
		} else {
			req.Mode = &mode
		}
	}
	entry, err := decodeEntry(o["entry"])
	if err != nil {
		shape = append(shape, "entry: "+err.Error())
	} else {
		req.Entry = entry
	}
	if raw := o["stopLoss"]; !isNullish(raw) {
		stop, err := decodePrice(raw)
		if err != nil {
			shape = append(shape, "stopLoss: "+err.Error())
		} else {
			req.StopLoss = stop
		}
	}
	if raw := o["takeProfits"]; !isNullish(raw) {
		tps, err := decodeTakeProfits(raw)
		if err != nil {
			shape = append(shape, "takeProfits: "+err.Error())
		} else {
			req.TakeProfits = tps
		}
	}
	if raw := o["sizing"]; !isNullish(raw) {
		sd, err := decodeSizing(raw)
		if err != nil {
			shape = append(shape, "sizing: "+err.Error())
		} else {
			req.Sizing = sd
		}
	}
	if raw := o["leverage"]; !isNullish(raw) {
		lev, err := decodeLeverage(raw)
		if err != nil {
			shape = append(shape, "leverage: "+err.Error())
		} else {
			req.Leverage = lev
		}
	}
	if raw := o["marginMode"]; !isNullish(raw) {
		m := execution.MarginMode(rawString(raw))
		req.MarginMode = &m
	}
	if raw := o["execution"]; !isNullish(raw) {
		spec, err := decodeExecutionSpec(raw)
		if err != nil {
			shape = append(shape, "execution: "+err.Error())
		} else {
			req.Execution = spec
		}
	}
	if raw := o["constraints"]; !isNullish(raw) {
		c, err := decodeConstraints(raw)
		if err != nil {
			shape = append(shape, "constraints: "+err.Error())
		} else {
			req.Constraints = c
		}
	}
	if raw := o["riskPolicy"]; !isNullish(raw) {
		p := execution.RiskBreachPolicy(rawString(raw))
		req.RiskPolicy = &p
	}
	if raw := o["existingPositionPolicy"]; !isNullish(raw) {
		p := execution.ExistingPositionPolicy(rawString(raw))
		req.ExistingPositionPolicy = &p
	}
	if raw := o["targetProfit"]; !isNullish(raw) {
		v, err := decodeNum(raw)
		if err != nil {
			shape = append(shape, "targetProfit: must be a number")
		} else {
			req.TargetProfit = &v
		}
	}
	if raw := o["maxRisk"]; !isNullish(raw) {
		v, err := decodeNum(raw)
		if err != nil {
			shape = append(shape, "maxRisk: must be a number")
		} else {
			req.MaxRisk = &v
		}
	}
	return req, shape, nil
}

func rawString(raw json.RawMessage) string {
	if isNullish(raw) {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

// decodeEntry maps the discriminated EntryDefinition ({type:'market'} |
// {type:'limit', price, postOnly}).
func decodeEntry(raw json.RawMessage) (execution.EntryDefinition, error) {
	if isNullish(raw) {
		return execution.EntryDefinition{}, nil
	}
	o, err := decodeObj(raw)
	if err != nil {
		return execution.EntryDefinition{}, fmt.Errorf("must be an object")
	}
	kind := rawString(o["type"])
	switch kind {
	case "market":
		return execution.EntryDefinition{Kind: "market"}, nil
	case "limit":
		price, err := decodeNum(o["price"])
		if err != nil {
			return execution.EntryDefinition{}, fmt.Errorf("limit entry requires a numeric price")
		}
		postOnly := false
		if raw := o["postOnly"]; !isNullish(raw) {
			_ = json.Unmarshal(raw, &postOnly)
		}
		return execution.EntryDefinition{Kind: "limit", Price: price, PostOnly: postOnly}, nil
	default:
		return execution.EntryDefinition{}, fmt.Errorf("type must be market or limit")
	}
}

func decodePrice(raw json.RawMessage) (*execution.PriceDefinition, error) {
	o, err := decodeObj(raw)
	if err != nil {
		return nil, fmt.Errorf("must be an object")
	}
	price, err := decodeNum(o["price"])
	if err != nil {
		return nil, fmt.Errorf("price must be a number")
	}
	kind := "stop"
	if k := rawString(o["kind"]); k != "" {
		kind = k
	}
	return &execution.PriceDefinition{Kind: kind, Price: price}, nil
}

func decodeTakeProfits(raw json.RawMessage) ([]execution.TakeProfitLevel, error) {
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("must be an array")
	}
	out := make([]execution.TakeProfitLevel, 0, len(list))
	for _, item := range list {
		o, err := decodeObj(item)
		if err != nil {
			return nil, fmt.Errorf("each level must be an object")
		}
		price, err := decodeNum(o["price"])
		if err != nil {
			return nil, fmt.Errorf("level price must be a number")
		}
		fraction := ""
		if f, err := decNumPtr(o["fraction"]); err != nil {
			return nil, fmt.Errorf("level fraction must be a number")
		} else if f != nil {
			fraction = *f
		}
		out = append(out, execution.TakeProfitLevel{Price: price, Fraction: fraction})
	}
	return out, nil
}

func decodeSizing(raw json.RawMessage) (execution.SizingDefinition, error) {
	var sd execution.SizingDefinition
	o, err := decodeObj(raw)
	if err != nil {
		return sd, fmt.Errorf("must be an object")
	}
	mode := execution.SizingMode(rawString(o["mode"]))
	sd.Mode = mode
	if v, err := decNumPtr(o["value"]); err != nil {
		return sd, fmt.Errorf("value must be a number")
	} else if v != nil {
		sd.Amount = *v
	}
	// Percentage modes carry `balanceBasis`; the contract uses one `value` for
	// every mode, so percent/allocation-percent read `value` into Percent.
	switch mode {
	case execution.SizingRiskPercent, execution.SizingAllocationPercent, execution.SizingTargetProfitPercent:
		sd.Percent = sd.Amount
		sd.Amount = ""
	}
	if raw := o["balanceBasis"]; !isNullish(raw) {
		sd.Basis = execution.BalanceBasis(rawString(raw))
	}
	if raw := o["quantity"]; !isNullish(raw) {
		if v, err := decodeNum(raw); err == nil {
			sd.Quantity = v
		}
	}
	if raw := o["margin"]; !isNullish(raw) {
		if v, err := decodeNum(raw); err == nil {
			sd.Margin = v
		}
	}
	if raw := o["amount"]; !isNullish(raw) && sd.Amount == "" && sd.Percent == "" {
		if v, err := decodeNum(raw); err == nil {
			sd.Amount = v
		}
	}
	return sd, nil
}

func decodeLeverage(raw json.RawMessage) (*sizing.LeverageSpec, error) {
	o, err := decodeObj(raw)
	if err != nil {
		return nil, fmt.Errorf("must be an object")
	}
	mode := execution.LeverageMode(rawString(o["mode"]))
	spec := &sizing.LeverageSpec{Mode: mode}
	if v, err := decNumPtr(o["leverage"]); err != nil {
		return nil, fmt.Errorf("leverage must be a number")
	} else if v != nil {
		spec.Leverage = *v
	}
	if v, err := decNumPtr(o["maxLeverage"]); err != nil {
		return nil, fmt.Errorf("maxLeverage must be a number")
	} else {
		spec.MaxLeverage = v
	}
	if v, err := decNumPtr(o["liquidationBufferPct"]); err != nil {
		return nil, fmt.Errorf("liquidationBufferPct must be a number")
	} else {
		spec.LiquidationBufferPct = v
	}
	if v, err := decNumPtr(o["maxMarginPct"]); err != nil {
		return nil, fmt.Errorf("maxMarginPct must be a number")
	} else {
		spec.MaxMarginPct = v
	}
	return spec, nil
}

// decodeExecutionSpec maps the discriminated ExecutionDefinition.
func decodeExecutionSpec(raw json.RawMessage) (planner.ExecutionSpec, error) {
	var spec planner.ExecutionSpec
	o, err := decodeObj(raw)
	if err != nil {
		return spec, fmt.Errorf("must be an object")
	}
	spec.Type = execution.ExecutionStrategy(rawString(o["type"]))
	spec.Price = rawStringOrNum(o["price"])
	spec.PostOnly, _ = decBoolPtr(o["postOnly"])
	spec.DurationMs, _ = decIntPtr(o["durationMs"])
	if n, err := decIntPtr(o["slices"]); err == nil && n != nil {
		v := int(*n)
		spec.Slices = &v
	}
	spec.IntervalMs, _ = decIntPtr(o["intervalMs"])
	if u := execution.ExecutionUrgency(rawString(o["urgency"])); u != "" {
		spec.Urgency = u
	}
	spec.VisibleQuantity = rawStringOrNum(o["visibleQuantity"])
	spec.MaxReplacements = intPtrOf(o["maxReplacements"])
	spec.MaxChaseDistance, _ = decNumPtr(o["maxChaseDistance"])
	spec.MinReplacementIntervalMs, _ = decIntPtr(o["minReplacementIntervalMs"])
	if raw := o["levels"]; !isNullish(raw) {
		levels, err := decodeScaleLevels(raw)
		if err != nil {
			return spec, err
		}
		spec.Levels = levels
	}
	if raw := o["config"]; !isNullish(raw) {
		cfg, err := decodeTwapSpec(raw)
		if err != nil {
			return spec, err
		}
		spec.Config = cfg
	}
	return spec, nil
}

func rawStringOrNum(raw json.RawMessage) string {
	if isNullish(raw) {
		return ""
	}
	if s := strings.TrimSpace(string(raw)); strings.HasPrefix(s, "\"") {
		return rawString(raw)
	}
	v, err := decodeNum(raw)
	if err != nil {
		return ""
	}
	return v
}

func intPtrOf(raw json.RawMessage) *int {
	if isNullish(raw) {
		return nil
	}
	n, err := decIntPtr(raw)
	if err != nil || n == nil {
		return nil
	}
	v := int(*n)
	return &v
}

func decodeScaleLevels(raw json.RawMessage) ([]execution.ScaleLevel, error) {
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("levels must be an array")
	}
	out := make([]execution.ScaleLevel, 0, len(list))
	for _, item := range list {
		o, err := decodeObj(item)
		if err != nil {
			return nil, fmt.Errorf("each level must be an object")
		}
		price, err := decodeNum(o["price"])
		if err != nil {
			return nil, fmt.Errorf("level price must be a number")
		}
		fraction, err := decodeNum(o["fraction"])
		if err != nil {
			return nil, fmt.Errorf("level fraction must be a number")
		}
		out = append(out, execution.ScaleLevel{Price: price, Fraction: fraction})
	}
	return out, nil
}

func decodeTwapSpec(raw json.RawMessage) (*planner.TwapSpec, error) {
	o, err := decodeObj(raw)
	if err != nil {
		return nil, fmt.Errorf("config must be an object")
	}
	spec := &planner.TwapSpec{OrderType: rawString(o["orderType"])}
	spec.DurationMs, _ = decIntPtr(o["durationMs"])
	if n, err := decIntPtr(o["slices"]); err == nil && n != nil {
		v := int(*n)
		spec.Slices = &v
	}
	spec.IntervalMs, _ = decIntPtr(o["intervalMs"])
	spec.QuantityJitterPct, _ = decNumPtr(o["quantityJitterPct"])
	spec.IntervalJitterPct, _ = decNumPtr(o["intervalJitterPct"])
	spec.PriceLimit, _ = decNumPtr(o["priceLimit"])
	spec.MaxSlippageBps, _ = decNumPtr(o["maxSlippageBps"])
	spec.MaxSpreadBps, _ = decNumPtr(o["maxSpreadBps"])
	return spec, nil
}

func decodeConstraints(raw json.RawMessage) (*planner.ConstraintSpec, error) {
	o, err := decodeObj(raw)
	if err != nil {
		return nil, fmt.Errorf("must be an object")
	}
	c := &planner.ConstraintSpec{}
	c.MaxSlippageBps, _ = decNumPtr(o["maxSlippageBps"])
	c.MaxSpreadBps, _ = decNumPtr(o["maxSpreadBps"])
	c.MaxPrice, _ = decNumPtr(o["maxPrice"])
	c.MinPrice, _ = decNumPtr(o["minPrice"])
	c.MaxDurationMs, _ = decIntPtr(o["maxDurationMs"])
	if b, err := decBoolPtr(o["makerOnly"]); err == nil && b != nil {
		c.MakerOnly = *b
	}
	c.AllowMarketFallback, _ = decBoolPtr(o["allowMarketFallback"])
	c.CancelIfRiskExceeded, _ = decBoolPtr(o["cancelIfRiskExceeded"])
	c.StopIfDisconnected, _ = decBoolPtr(o["stopIfDisconnected"])
	return c, nil
}

// decodeSettingsPatch decodes the RiskProfilePatch body: only the eight known
// keys are read, each as a raw token so a string can be validated without
// coercion.
func decodeSettingsPatch(body json.RawMessage) (map[string]json.RawMessage, error) {
	var o map[string]json.RawMessage
	if err := json.Unmarshal(body, &o); err != nil {
		return nil, fmt.Errorf("decode settings patch: %w", err)
	}
	return o, nil
}

// canonicalJSON re-marshals a decoded object so a persisted value never carries
// whitespace or duplicate keys.
func canonicalJSON(raw json.RawMessage) json.RawMessage {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return raw
	}
	return json.RawMessage(buf.Bytes())
}
