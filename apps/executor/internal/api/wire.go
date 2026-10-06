// Package api implements the executor's HTTP surface: the 15 `/api/executor/*`
// paths of contracts/openapi/fudcourt.yaml, served by the executor
// process itself (cmd/executor mounts this mux on its loopback listener).
//
// # WHY IT LIVES IN THE EXECUTOR MODULE
//
// The public executor surface needs the session/identity plane, the sealed
// credential vault, the planner (one canonical risk engine + sizing) and the
// `executor.*` store — all of which the executor already owns. backend/api is a
// stdlib-only module forbidden from reaching into `executor.*` tables or this
// module's internals, so placing the handlers there would add a pass-through hop
// with the logic still living here. The runtime path is therefore
// `web → executor` (the web tier thin-proxies with the browser cookie); see
// internal/platform/session for the session-verification note and its recorded
// consequence.
//
// # ENVELOPE FIDELITY
//
// Every response is a behaviour-faithful port of the route handler it shadows
// (frontend/web/src/app/(frontend)/api/executor/**) and of runtime.ts, and must
// stay byte-shape-compatible: same status codes, same `{error, detail}` /
// `{error, errors[]}` / `{error, detail, category}` / `{error, detail, ...fields}`
// bodies. The TS handlers remain authoritative until the cutover; the tests in
// this package pin each envelope against the TS source.
package api

import (
	"encoding/json"

	"github.com/anvxxr-arch/fudcourt/apps/executor/internal/execution"
)

// --- account envelopes -----------------------------------------------------

// Permissions is the wire AccountPermissions (frozen contract). Read is a
// bool; the other three are honestly nullable — nil means the venue does not
// report the flag, never an inferred false.
type Permissions struct {
	Read         bool  `json:"read"`
	SpotTrade    *bool `json:"spotTrade"`
	FuturesTrade *bool `json:"futuresTrade"`
	Withdraw     *bool `json:"withdraw"`
}

// AccountMetadata is the wire AccountMetadata (venue probe result). apiKeyMasked
// is a partial key display only (PRD §109) — never plaintext.
type AccountMetadata struct {
	Exchange     execution.ExchangeID       `json:"exchange"`
	Label        *string                    `json:"label"`
	AccountType  *string                    `json:"accountType"`
	Permissions  Permissions                `json:"permissions"`
	Health       execution.CredentialHealth `json:"health"`
	APIKeyMasked *string                    `json:"apiKeyMasked"`
	Raw          any                        `json:"raw,omitempty"`
}

// CredentialRecord is the wire CredentialRecord (frozen contract) — masked only,
// no secret material. Field order matches the contract's required order.
type CredentialRecord struct {
	ID           string                     `json:"id"`
	UserID       string                     `json:"userId"`
	Exchange     execution.ExchangeID       `json:"exchange"`
	Label        string                     `json:"label"`
	APIKeyMasked string                     `json:"apiKeyMasked"`
	Permissions  Permissions                `json:"permissions"`
	Health       execution.CredentialHealth `json:"health"`
	CreatedAt    int64                      `json:"createdAt"`
	UpdatedAt    int64                      `json:"updatedAt"`
	LastUsedAt   *int64                     `json:"lastUsedAt"`
	RevokedAt    *int64                     `json:"revokedAt"`
}

// AccountResponse is `{ account, metadata }` (POST /accounts,
// POST /accounts/{id}/test).
type AccountResponse struct {
	Account  CredentialRecord `json:"account"`
	Metadata AccountMetadata  `json:"metadata"`
}

// ListAccountsResponse is `{ accounts }`.
type ListAccountsResponse struct {
	Accounts []CredentialRecord `json:"accounts"`
}

// AccountEnvelope is `{ account }` (GET /accounts/{id}).
type AccountEnvelope struct {
	Account CredentialRecord `json:"account"`
}

// DeleteAccountResponse is `{ ok: true }`.
type DeleteAccountResponse struct {
	OK bool `json:"ok"`
}

// --- execution envelopes ---------------------------------------------------

// ExecutionRecord is the wire ExecutionRecord (frozen contract). The storage
// shapes use decimal strings internally; the wire uses JSON numbers, so this
// is a separate type whose marshalling emits numbers (parity with the TS
// records).
type ExecutionRecord struct {
	ID                string                      `json:"id"`
	UserID            string                      `json:"userId"`
	AccountID         string                      `json:"accountId"`
	Exchange          execution.ExchangeID        `json:"exchange"`
	Symbol            string                      `json:"symbol"`
	MarketType        execution.MarketType        `json:"marketType"`
	Side              execution.Side              `json:"side"`
	Intent            execution.Intent            `json:"intent"`
	Status            execution.ExecutionStatus   `json:"status"`
	Mode              execution.ExecutionMode     `json:"mode"`
	SizingMode        execution.SizingMode        `json:"sizingMode"`
	SizingValue       json.Number                 `json:"sizingValue"`
	RiskBudget        *json.Number                `json:"riskBudget"`
	RiskBasis         *execution.BalanceBasis     `json:"riskBasis"`
	EntryDefinition   any                         `json:"entryDefinition"`
	StopDefinition    any                         `json:"stopDefinition"`
	TakeProfit        []any                       `json:"takeProfitDefinition"`
	ExecutionStrategy execution.ExecutionStrategy `json:"executionStrategy"`
	ExecutionConfig   any                         `json:"executionConfig"`
	Constraints       any                         `json:"constraints"`
	PlannedQuantity   json.Number                 `json:"plannedQuantity"`
	PlannedNotional   json.Number                 `json:"plannedNotional"`
	ActualQuantity    json.Number                 `json:"actualQuantity"`
	ActualNotional    json.Number                 `json:"actualNotional"`
	AverageFillPrice  *json.Number                `json:"averageFillPrice"`
	EstimatedFees     *json.Number                `json:"estimatedFees"`
	ActualFees        json.Number                 `json:"actualFees"`
	PlannedRisk       *json.Number                `json:"plannedRisk"`
	CurrentRisk       *json.Number                `json:"currentRisk"`
	StrategyState     any                         `json:"strategyState"`
	CreatedAt         int64                       `json:"createdAt"`
	StartedAt         *int64                      `json:"startedAt"`
	CompletedAt       *int64                      `json:"completedAt"`
	CancelledAt       *int64                      `json:"cancelledAt"`
}

// ChildOrderRecord is the wire ChildOrderRecord (frozen contract).
type ChildOrderRecord struct {
	ID              string                     `json:"id"`
	ExecutionID     string                     `json:"executionId"`
	ExchangeOrderID *string                    `json:"exchangeOrderId"`
	ClientOrderID   string                     `json:"clientOrderId"`
	Symbol          string                     `json:"symbol"`
	Side            execution.Side             `json:"side"`
	Type            string                     `json:"type"`
	Price           *json.Number               `json:"price"`
	Quantity        json.Number                `json:"quantity"`
	FilledQuantity  json.Number                `json:"filledQuantity"`
	Status          execution.ChildOrderStatus `json:"status"`
	IsExit          bool                       `json:"isExit"`
	SubmittedAt     int64                      `json:"submittedAt"`
	UpdatedAt       int64                      `json:"updatedAt"`
	FilledAt        int64                      `json:"filledAt"`
}

// FillRecord is the wire FillRecord (frozen contract).
type FillRecord struct {
	ID              string      `json:"id"`
	ExecutionID     string      `json:"executionId"`
	ChildOrderID    string      `json:"childOrderId"`
	ExchangeTradeID string      `json:"exchangeTradeId"`
	Price           json.Number `json:"price"`
	Quantity        json.Number `json:"quantity"`
	QuoteQuantity   json.Number `json:"quoteQuantity"`
	Fee             json.Number `json:"fee"`
	FeeAsset        string      `json:"feeAsset"`
	Timestamp       int64       `json:"timestamp"`
}

// ExecutionEventRecord is the wire ExecutionEventRecord (frozen contract).
type ExecutionEventRecord struct {
	ID          string                       `json:"id"`
	ExecutionID string                       `json:"executionId"`
	Name        execution.ExecutionEventName `json:"name"`
	Payload     map[string]any               `json:"payload"`
	CreatedAt   int64                        `json:"createdAt"`
}

// ListExecutionsResponse is `{ executions }`.
type ListExecutionsResponse struct {
	Executions []ExecutionRecord `json:"executions"`
}

// ExecutionDetailResponse is `{ execution, plan }` — plan is null only when no
// plan row was persisted, never fabricated.
type ExecutionDetailResponse struct {
	Execution ExecutionRecord `json:"execution"`
	Plan      json.RawMessage `json:"plan"`
}

// LifecycleResponse is `{ execution }`.
type LifecycleResponse struct {
	Execution ExecutionRecord `json:"execution"`
}

// CreateExecutionResponse is `{ execution, plan }`.
type CreateExecutionResponse struct {
	Execution ExecutionRecord `json:"execution"`
	Plan      json.RawMessage `json:"plan"`
}

// ListOrdersResponse is `{ childOrders }`.
type ListOrdersResponse struct {
	ChildOrders []ChildOrderRecord `json:"childOrders"`
}

// ListFillsResponse is `{ fills }`.
type ListFillsResponse struct {
	Fills []FillRecord `json:"fills"`
}

// ListEventsResponse is `{ events }`.
type ListEventsResponse struct {
	Events []ExecutionEventRecord `json:"events"`
}

// --- settings --------------------------------------------------------------

// RiskProfile is the wire RiskProfile (frozen contract): the eight keys, in
// contract order.
type RiskProfile struct {
	DefaultRiskMode         string `json:"defaultRiskMode"`
	DefaultRisk             string `json:"defaultRisk"`
	MaxRiskPerTradePct      string `json:"maxRiskPerTradePct"`
	MaxOpenRiskPct          string `json:"maxOpenRiskPct"`
	MaxDailyLossPct         string `json:"maxDailyLossPct"`
	MaxLeverage             string `json:"maxLeverage"`
	DefaultMarginMode       string `json:"defaultMarginMode"`
	DefaultExecutionUrgency string `json:"defaultExecutionUrgency"`
}

// SettingsResponse is `{ profile }`.
type SettingsResponse struct {
	Profile RiskProfile `json:"profile"`
}

// --- preview / emergency ---------------------------------------------------

// PreviewResponse is `{ preview, liveEnabled }`.
type PreviewResponse struct {
	Preview     json.RawMessage `json:"preview"`
	LiveEnabled bool            `json:"liveEnabled"`
}

// EmergencyStopResponse is `{ stopped, cancelledOrders }`.
type EmergencyStopResponse struct {
	Stopped         int `json:"stopped"`
	CancelledOrders int `json:"cancelledOrders"`
}

// --- refusals --------------------------------------------------------------

// ErrorBasic is `{ error }` (e.g. `{ error: 'account not found' }`).
type ErrorBasic struct {
	Error string `json:"error"`
}

// ErrorDetail is `{ error, detail }`.
type ErrorDetail struct {
	Error  string `json:"error"`
	Detail string `json:"detail"`
}

// CategorizedError is `{ error, detail, category }` (the credential-check 502
// and the market-data 502).
type CategorizedError struct {
	Error    string                  `json:"error"`
	Detail   string                  `json:"detail"`
	Category execution.ErrorCategory `json:"category"`
}

// ValidationError is `{ error: 'validation', errors: [...] }`.
type ValidationError struct {
	Error  string   `json:"error"`
	Errors []string `json:"errors"`
}

// PlanConflictError is the 409 `{ error: 'conflict', conflicts, preview }`.
type PlanConflictError struct {
	Error     string          `json:"error"`
	Conflicts json.RawMessage `json:"conflicts"`
	Preview   json.RawMessage `json:"preview"`
}
