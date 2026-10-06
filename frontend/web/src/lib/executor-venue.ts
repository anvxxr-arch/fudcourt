/**
 * executor-venue.ts — VENUE half of the FUDCourt CEX Executor response
 * contract (PRD §25–§37, §48). Split from `./executor-response`: this module
 * owns the engine (deterministic strategy planning + lifecycle) and the
 * exchange-adapter surfaces plus `ExecutorError`.
 *
 * Request-side shapes are imported as types from `./executor-request` (one
 * direction only — request never imports response). Consumers import
 * `@/lib/executor` (the barrel), never this path directly.
 */
import type {
  ChildOrderStatus,
  CredentialHealth,
  ErrorCategory,
  ExchangeId,
  ExecutionConstraints,
  ExecutionDefinition,
  ExecutionPlan,
  ExecutionStrategy,
  FeeSchedule,
  LeverageBracket,
  MarginMode,
  Market,
  MarketSnapshot,
  MarketType,
  OrderBook,
  RiskBreakdown,
  Side,
  Ticker,
  TimeInForce,
} from './executor-request';

// ---------------------------------------------------------------------------
// Engine contract (PRD §25–§37) — `backend/workers/executor/internal/engine` exports this surface.
// ---------------------------------------------------------------------------

/** A child order the strategy wants on the venue. */
export interface PlannedChildOrder {
  /** Idempotency id: `fud_{executionId}_{sequence}` (PRD §66). Assigned by the engine. */
  clientOrderId: string;
  side: Side;
  /** `stop_market` is the protective-stop leg (§39-40); entries use market/limit. */
  type: 'market' | 'limit' | 'stop_market';
  price: number | null;
  /** Trigger price for `stop_market` legs (the stop-loss price). */
  stopPrice: number | null;
  quantity: number;
  timeInForce: TimeInForce;
  postOnly: boolean;
  reduceOnly: boolean;
  /** True for protective exits (SL/TP) that must survive entry cancellation. */
  isExit: boolean;
}

export type EngineAction =
  | { type: 'place'; order: PlannedChildOrder }
  | { type: 'cancel'; clientOrderId: string; reason: string }
  | { type: 'replace'; clientOrderId: string; order: PlannedChildOrder; reason: string }
  | { type: 'wait'; untilMs: number }
  | { type: 'pause'; reason: string }
  | { type: 'stop'; reason: string; riskStopped: boolean }
  | { type: 'complete' };

export interface ChildOrderView {
  clientOrderId: string;
  exchangeOrderId: string | null;
  status: ChildOrderStatus;
  side: Side;
  price: number | null;
  quantity: number;
  filledQuantity: number;
  isExit: boolean;
  updatedAt: number;
}

export interface FillView {
  tradeId: string;
  clientOrderId: string | null;
  price: number;
  quantity: number;
  quoteQuantity: number;
  fee: number;
  feeAsset: string;
  timestamp: number;
}

export interface StrategyContext {
  now: number;
  snapshot: MarketSnapshot;
  /** Already-filled quantity of the entry side. */
  filledQuantity: number;
  averageEntry: number | null;
  /** Risk of the filled position (PRD §36). Null only when the plan has no stop. */
  projectedRisk: RiskBreakdown | null;
  /**
   * Risk budget minus projectedRisk.totalRisk. Null = NO risk budget exists
   * (capital/outcome mode without maxRisk): the engine must then skip
   * risk-driven resizing — hard risk clamping applies only when non-null.
   */
  remainingRiskBudget: number | null;
  openChildOrders: ChildOrderView[];
  /** Open position on the venue for reduce-only clamping (PRD §107). */
  openPositionQuantity: number;
  constraints: ExecutionConstraints;
  /**
   * False during recovery/reconcile passes (PRD §114): the engine must plan NO
   * new placements then — the worker drops them, and a planned-but-dropped child
   * would look live to the engine. Cancels and stops stay legal.
   */
  placementEnabled: boolean;
}

export interface StrategyProgress {
  strategy: ExecutionStrategy;
  /** 0..1 of planned entry quantity. */
  completionPct: number;
  elapsedPct: number;
  plannedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  /** Null before the first fill. */
  averageEntry: number | null;
  /** Null when the plan has no stop (stop-based figure; never fake 0). */
  plannedRisk: number | null;
  /** Null when the plan has no stop. */
  projectedRisk: number | null;
  /** Null when there is no risk budget (capital/outcome modes without maxRisk). */
  remainingRiskBudget: number | null;
}

/** `backend/workers/executor/internal/engine` — deterministic strategy planning + lifecycle. */
export interface ExecutionEngineApi {
  /** Build initial state for a planned execution (pure). */
  createStrategy(args: {
    executionId: string;
    plan: ExecutionPlan;
    execution: ExecutionDefinition;
    constraints: ExecutionConstraints;
    /** Random seed for jitter; fixed in tests (PRD §28). */
    seed?: number;
  }): unknown;
  /** One deterministic tick: state + context → new state + actions (PRD §67). */
  strategyStep(state: unknown, ctx: StrategyContext): { state: unknown; actions: EngineAction[] };
  /** Apply a fill: recompute average entry and RESIZE remaining execution (PRD §36, §37). */
  strategyOnFill(state: unknown, fill: FillView): { state: unknown; actions: EngineAction[] };
  /** Progress projection for the active execution screen (PRD §85, §86). */
  strategyProgress(state: unknown, ctx: StrategyContext): StrategyProgress;
  /** Child order lifecycle transition (PRD §58); throws on illegal transitions. */
  transitionChildOrder(current: ChildOrderStatus, event: ChildOrderEvent): ChildOrderStatus;
}

export type ChildOrderEvent =
  | 'submit'
  | 'accept'
  | 'partial_fill'
  | 'fill'
  | 'cancel_request'
  | 'cancel'
  | 'reject'
  | 'expire'
  | 'unknown';
// ---------------------------------------------------------------------------
// Exchange adapter contract (PRD §48) — implemented in `backend/workers/executor/internal/exchanges`.
// ---------------------------------------------------------------------------

export interface AccountPermissions {
  /** Verified by probe: the credential can read account state. */
  read: boolean;
  /**
   * Trading flags as REPORTED by the venue's key-restriction endpoint where one
   * exists (Binance apiRestrictions, Bybit query-api); `null` = the venue does
   * not report it (e.g. MEXC) — never inferred, never faked (house rule).
   */
  spotTrade: boolean | null;
  futuresTrade: boolean | null;
  /**
   * MUST be false or null in effect: FUDCourt NEVER requests or uses withdrawal
   * capability (PRD §43). `null` = unknown (venue silent); `true` would mean the
   * USER granted it on the key — the UI must render that as a warning.
   */
  withdraw: boolean | null;
}

export interface AccountMetadata {
  exchange: ExchangeId;
  label: string | null;
  accountType: string | null;
  permissions: AccountPermissions;
  health: CredentialHealth;
  /** Partial key display only: `abc...xyz` (PRD §109). */
  apiKeyMasked: string | null;
  raw?: unknown;
}

export interface Balance {
  asset: string;
  free: number;
  used: number;
  total: number;
}

export interface AccountEquity {
  spotEquity: number | null;
  futuresEquity: number | null;
  totalEquity: number | null;
  /** Per-asset free/used totals as returned by the venue. */
  balances: Balance[];
  timestamp: number;
}

export interface Position {
  symbol: string;
  marketType: MarketType;
  side: Side;
  /** Signed quantity: positive long, negative short in one-way mode. */
  quantity: number;
  entryPrice: number;
  leverage: number | null;
  marginMode: MarginMode | null;
  liquidationPrice: number | null;
  positionSide: 'long' | 'short' | 'net';
  timestamp: number;
}

export interface Order {
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: Side;
  type: string;
  price: number | null;
  stopPrice: number | null;
  quantity: number;
  filledQuantity: number;
  status: ChildOrderStatus;
  timeInForce: TimeInForce | null;
  reduceOnly: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NormalizedOrder {
  /** Idempotency id (PRD §66). The adapter MUST send this as the client order id. */
  clientOrderId: string;
  symbol: string;
  marketType: MarketType;
  side: Side;
  type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'stop_market';
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  postOnly?: boolean;
  reduceOnly?: boolean;
  positionSide?: 'long' | 'short' | 'net';
}

export interface OrderResult {
  orderId: string;
  clientOrderId: string;
  status: ChildOrderStatus;
  filledQuantity: number;
  averagePrice: number | null;
  raw?: unknown;
}

export interface AmendOrderRequest {
  orderId: string;
  symbol: string;
  price?: number;
  quantity?: number;
  clientOrderId?: string;
}

export interface Fill {
  tradeId: string;
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: Side;
  price: number;
  quantity: number;
  quoteQuantity: number;
  fee: number;
  feeAsset: string;
  timestamp: number;
}

export interface FundingRate {
  symbol: string;
  rate: number;
  nextFundingTime: number | null;
  timestamp: number;
}

export interface ExchangeCapabilities {
  spot: boolean;
  linearPerpetual: boolean;
  marginModes: { cross: boolean; isolated: boolean };
  hedgeMode: boolean;
  orderTypes: {
    market: boolean;
    limit: boolean;
    stop: boolean;
    stopLimit: boolean;
    trailing: boolean;
    postOnly: boolean;
  };
  nativeFeatures: { iceberg: boolean; twap: boolean; oco: boolean };
  /** True when `fetchLeverageBrackets` returns real tiers. */
  leverageBrackets: boolean;
}

/**
 * The normalized adapter interface (PRD §48). Live adapters are ccxt-backed
 * (DR-020: one unified translation layer per venue, raw REST escape hatch where
 * ccxt lacks a capability); `PaperExchangeAdapter` implements the SAME interface
 * with a simulated matcher so the worker drives paper and live identically.
 */
export interface ExchangeAdapter {
  validateCredentials(): Promise<AccountMetadata>;
  getBalances(): Promise<Balance[]>;
  getAccountEquity(): Promise<AccountEquity>;
  getMarkets(): Promise<Market[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
  getPositions(): Promise<Position[]>;
  getOpenOrders(symbol?: string): Promise<Order[]>;
  placeOrder(order: NormalizedOrder): Promise<OrderResult>;
  cancelOrder(orderId: string, symbol: string): Promise<void>;
  amendOrder?(order: AmendOrderRequest): Promise<OrderResult>;
  setLeverage?(symbol: string, leverage: number): Promise<void>;
  setMarginMode?(symbol: string, mode: MarginMode): Promise<void>;
  getLeverageBrackets?(symbol: string): Promise<LeverageBracket[]>;
  getFundingRate?(symbol: string): Promise<FundingRate>;
  getFees(symbol: string): Promise<FeeSchedule>;
  /** Fills for an order, or all recent fills when orderId is omitted (PRD §62). */
  getFills?(symbol: string, orderId?: string): Promise<Fill[]>;
  /** Normalized error taxonomy for the retry policy (PRD §78). */
  capabilities(): ExchangeCapabilities;
}

/** Error every adapter maps its failures into (PRD §78). */
export interface ExecutorError {
  category: ErrorCategory;
  message: string;
  /** Venue code when the exchange supplied one. */
  exchangeCode: string | null;
  retryable: boolean;
  raw?: unknown;
}
