package executor

// The persistence shapes below mirror apps/web/src/platform/executor/types.ts
// field-for-field (ExecutionRecord, ChildOrderRecord, FillRecord,
// ExecutionEventRecord, RiskProfile) and database/schema/executor-schema.sql.
// Money and quantity are decimal strings; nullable decimals are *string so an
// unknown figure is honestly absent, never a fabricated 0 (house rule).

// ExecutionRecord is one execution aggregate row. EngineState is opaque,
// JSON-round-trippable state: NOT authoritative across a lost write — the
// exchange is (PRD §95/§114) — but authoritative enough to resume a strategy
// without re-deriving its schedule from process memory (PRD §130).
type ExecutionRecord struct {
	ID                  string             `json:"id"`
	UserID              string             `json:"userId"`
	AccountID           string             `json:"accountId"`
	Exchange            ExchangeID         `json:"exchange"`
	Symbol              string             `json:"symbol"`
	MarketType          MarketType         `json:"marketType"`
	Side                Side               `json:"side"`
	Intent              Intent             `json:"intent"`
	Status              ExecutionStatus    `json:"status"`
	Mode                ExecutionMode      `json:"mode"`
	SizingMode          SizingMode         `json:"sizingMode"`
	SizingValue         string             `json:"sizingValue"`
	RiskBudget          *string            `json:"riskBudget"`
	RiskBasis           *BalanceBasis      `json:"riskBasis"`
	EntryDefinition     EntryDefinition    `json:"entryDefinition"`
	StopDefinition      *PriceDefinition   `json:"stopDefinition"`
	TakeProfit          []TakeProfitLevel  `json:"takeProfitDefinition"`
	ExecutionStrategy   ExecutionStrategy  `json:"executionStrategy"`
	ExecutionConfig     ExecutionConfig    `json:"executionConfig"`
	Constraints         ExecutionConstraints `json:"constraints"`
	PlannedQuantity     string             `json:"plannedQuantity"`
	PlannedNotional     string             `json:"plannedNotional"`
	ActualQuantity      string             `json:"actualQuantity"`
	ActualNotional      string             `json:"actualNotional"`
	AverageFillPrice    *string            `json:"averageFillPrice"`
	EstimatedFees       *string            `json:"estimatedFees"`
	ActualFees          string             `json:"actualFees"`
	PlannedRisk         *string            `json:"plannedRisk"`
	CurrentRisk         *string            `json:"currentRisk"`
	EngineState         any                `json:"strategyState"`
	CreatedAt           int64              `json:"createdAt"`
	StartedAt           int64              `json:"startedAt"`
	CompletedAt         int64              `json:"completedAt"`
	CancelledAt         int64              `json:"cancelledAt"`
}

// EntryDefinition describes how the entry is placed (types.ts EntryDefinition).
type EntryDefinition struct {
	Kind     string `json:"kind"`  // "market" | "limit"
	Price    string `json:"price"` // decimal string; empty for market
	PostOnly bool   `json:"postOnly"`
}

// TakeProfitLevel is one take-profit rung (types.ts TakeProfitDefinition).
type TakeProfitLevel struct {
	Price    string `json:"price"`
	Fraction string `json:"fraction"` // decimal fraction of the position
}

// ExecutionConfig is the strategy-specific configuration (types.ts
// ExecutionDefinition): TWAP knobs, iceberg display, scale ladders.
type ExecutionConfig struct {
	Slices       int          `json:"slices,omitempty"`
	DurationMs   int64        `json:"durationMs,omitempty"`
	DisplayQty   string       `json:"displayQuantity,omitempty"`
	ScaleLevels  []ScaleLevel `json:"scaleLevels,omitempty"`
	Twap         *TwapConfig  `json:"twap,omitempty"`
}

// ChildOrderRecord is one venue child order (types.ts ChildOrderRecord).
// ExchangeOrderID is venue-assigned and recorded, never generated here;
// ClientOrderId is ours: fud_<execution>_<sequence> (objective §23).
type ChildOrderRecord struct {
	ID             string           `json:"id"`
	ExecutionID    string           `json:"executionId"`
	ExchangeOrderID *string         `json:"exchangeOrderId"`
	ClientOrderID  string           `json:"clientOrderId"`
	Symbol         string           `json:"symbol"`
	Side           Side             `json:"side"`
	Type           string           `json:"type"`
	Price          *string          `json:"price"`
	Quantity       string           `json:"quantity"`
	FilledQuantity string           `json:"filledQuantity"`
	Status         ChildOrderStatus `json:"status"`
	IsExit         bool             `json:"isExit"`
	SubmittedAt    int64            `json:"submittedAt"`
	UpdatedAt      int64            `json:"updatedAt"`
	FilledAt       int64            `json:"filledAt"`
}

// FillRecord is one venue trade (types.ts FillRecord). The dedup key is
// (account, exchangeTradeId) — the ACCOUNT scopes it (DR-021 §62).
type FillRecord struct {
	ID              string `json:"id"`
	ExecutionID     string `json:"executionId"`
	ChildOrderID    string `json:"childOrderId"`
	ExchangeTradeID string `json:"exchangeTradeId"`
	Price           string `json:"price"`
	Quantity        string `json:"quantity"`
	QuoteQuantity   string `json:"quoteQuantity"`
	Fee             string `json:"fee"`
	FeeAsset        string `json:"feeAsset"`
	Timestamp       int64  `json:"timestamp"`
}

// ExecutionEventRecord is one append-only event (types.ts). Events are
// immutable: corrections are new events (PRD §63).
type ExecutionEventRecord struct {
	ID          string            `json:"id"`
	ExecutionID string            `json:"executionId"`
	Name        ExecutionEventName `json:"name"`
	Payload     map[string]any    `json:"payload"`
	CreatedAt   int64             `json:"createdAt"`
}

// RiskProfile is the account-level safety rules (PRD §72, §88, §119). The
// percentage fields are decimal strings.
type RiskProfile struct {
	DefaultRiskMode   string        `json:"defaultRiskMode"` // "risk_usd" | "risk_percent"
	DefaultRisk       string        `json:"defaultRisk"`
	MaxRiskPerTradePct string       `json:"maxRiskPerTradePct"`
	// MaxOpenRiskPct is a portfolio ceiling on COMMITTED risk (PRD §73): a
	// breach at creation is REFUSED, never resized.
	MaxOpenRiskPct string `json:"maxOpenRiskPct"`
	// MaxDailyLossPct is the daily realized-loss ceiling (PRD §74). Once the
	// day's realized P&L reaches -this% of equity, new OPENINGS are blocked;
	// closing and reducing stay allowed, so the guard can never trap a user in
	// the risk it exists to bound.
	MaxDailyLossPct        string             `json:"maxDailyLossPct"`
	MaxLeverage            string             `json:"maxLeverage"`
	DefaultMarginMode      MarginMode         `json:"defaultMarginMode"`
	DefaultExecutionUrgency ExecutionUrgency   `json:"defaultExecutionUrgency"`
}

// AccountPermissions reports what a credential may do (types.ts). The trade and
// withdraw flags are REPORTED by the venue's key-restriction endpoint where one
// exists; null = the venue does not report it — never inferred, never faked.
// Withdraw MUST be false or null in effect: FUDCourt NEVER requests or uses
// withdrawal capability (PRD §43); true would mean the USER granted it on the
// key and the UI must render that as a warning.
type AccountPermissions struct {
	Read         bool  `json:"read"`
	SpotTrade    *bool `json:"spotTrade"`
	FuturesTrade *bool `json:"futuresTrade"`
	Withdraw     *bool `json:"withdraw"`
}

// AccountMetadata is the credential health view (types.ts). APIKeyMasked is a
// partial key display only: abc...xyz (PRD §109) — no plaintext ever.
type AccountMetadata struct {
	Exchange      ExchangeID        `json:"exchange"`
	Label         *string           `json:"label"`
	AccountType   *string           `json:"accountType"`
	Permissions   AccountPermissions `json:"permissions"`
	Health        CredentialHealth  `json:"health"`
	APIKeyMasked  *string           `json:"apiKeyMasked"`
}

// Balance is one venue balance row (types.ts): free + used = total.
type Balance struct {
	Asset string `json:"asset"`
	Free  string `json:"free"`
	Used  string `json:"used"`
	Total string `json:"total"`
}

// AccountEquity is the venue account snapshot (types.ts). Each figure is a
// nullable decimal string: the venue may not report one basis (honest null).
type AccountEquity struct {
	SpotEquity    *string   `json:"spotEquity"`
	FuturesEquity *string   `json:"futuresEquity"`
	TotalEquity   *string   `json:"totalEquity"`
	Balances      []Balance `json:"balances"`
	Timestamp     int64     `json:"timestamp"`
}

// Position is one venue position (types.ts). Quantity is signed: positive long,
// negative short in one-way mode.
type Position struct {
	Symbol          string      `json:"symbol"`
	MarketType      MarketType  `json:"marketType"`
	Side            Side        `json:"side"`
	Quantity        string      `json:"quantity"`
	EntryPrice      string      `json:"entryPrice"`
	Leverage        *string     `json:"leverage"`
	MarginMode      *MarginMode `json:"marginMode"`
	LiquidationPrice *string    `json:"liquidationPrice"`
	PositionSide    string      `json:"positionSide"` // "long" | "short" | "net"
}

// Ticker is one venue ticker (types.ts). Bid/Ask are nullable: a last-only
// ticker must never be turned into a fabricated touch price (house rule).
type Ticker struct {
	Symbol string  `json:"symbol"`
	Bid    *string `json:"bid"`
	Ask    *string `json:"ask"`
	Last   *string `json:"last"`
	Ts     int64   `json:"ts"`
}

// NormalizedOrder is the canonical order view returned by an adapter
// (types.ts NormalizedOrder).
type NormalizedOrder struct {
	ExchangeOrderID string           `json:"exchangeOrderId"`
	ClientOrderID   string           `json:"clientOrderId"`
	Symbol          string           `json:"symbol"`
	Side            Side             `json:"side"`
	Type            string           `json:"type"`
	Price           *string          `json:"price"`
	Quantity        string           `json:"quantity"`
	FilledQuantity  string           `json:"filledQuantity"`
	Status          ChildOrderStatus `json:"status"`
	IsExit          bool             `json:"isExit"`
	SubmittedAt     int64            `json:"submittedAt"`
	UpdatedAt       int64            `json:"updatedAt"`
}

// OrderRequest is one order placement instruction (types.ts OrderRequest).
// ExecutionID is the owning execution for idempotency + audit correlation.
type OrderRequest struct {
	ClientOrderID string       `json:"clientOrderId"`
	Symbol        string       `json:"symbol"`
	Side          Side         `json:"side"`
	Quantity      string       `json:"quantity"`
	Price         string       `json:"price"` // empty for market
	OrderType     string       `json:"type"`  // "market" | "limit"
	TimeInForce   TimeInForce  `json:"timeInForce"`
	ReduceOnly    bool         `json:"reduceOnly"`
	Intent        Intent       `json:"intent"`
	ExecutionID   string       `json:"executionId"`
}

// Fill is one normalized venue trade (types.ts Fill).
type Fill struct {
	ExchangeTradeID string `json:"exchangeTradeId"`
	ClientOrderID   string `json:"clientOrderId"`
	Price           string `json:"price"`
	Quantity        string `json:"quantity"`
	QuoteQuantity   string `json:"quoteQuantity"`
	Fee             string `json:"fee"`
	FeeAsset        string `json:"feeAsset"`
	Timestamp       int64  `json:"timestamp"`
}
