/**
 * executor-request.ts — REQUEST/PREVIEW half of the FUDCourt CEX Executor wire
 * contract (PRD §48–§56, §57–§63). Split from `@/lib/executor` (DR-043 note
 * carried over): this module owns client intent → plan → preview — enums,
 * balance/instrument/market shapes, sizing, entry/exit definitions,
 * `ExecutionRequest`, the risk-engine surface, and `ExecutionPlan`/`PreviewResult`.
 *
 * The Go service `backend/workers/executor` owns the runtime; field renames on
 * either side are coupled by `parity-matrix.md` row 1. Money math (PRD §71):
 * NO float arithmetic on quantities/prices in the engines — `decimal.js` is the
 * required arithmetic; `number` here is the WIRE type.
 *
 * Every consumer imports `@/lib/executor` (the barrel) and nothing else across
 * slice boundaries. Single-source rule: shared constants defined here
 * (`EXECUTION_TRANSITIONS`, `canTransition`, `isTerminalExecution`) are defined
 * ONLY here — `executor-response.ts` and the barrel re-export, never redefine.
 */

// ---------------------------------------------------------------------------
// Enumerations (PRD §25, §35, §47, §49, §57, §58, §63, §78, §91, §92)
// ---------------------------------------------------------------------------

/** Normalized market type. MVP = spot + USDT-margined linear perpetual only. */
export type MarketType = 'spot' | 'linear_perp';

/** Order side. Spot sell-open is refused outside explicit margin support (PRD §89). */
export type Side = 'buy' | 'sell';

/** What the user wants the order to do to the position. */
export type Intent = 'open' | 'close' | 'reduce';

/** Exchange identity. Keys in `exchange:*:*` venue keys (PRD §49). */
export type ExchangeId = 'binance' | 'bybit' | 'mexc';

/** Internal unique key: `${exchange}:${marketType}:${symbol}` (PRD §49). */
export type VenueKey = string;

/** Normalized time-in-force (PRD §27). The adapter maps to venue support. */
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

/** Execution urgency (PRD §35). Maps to internal strategy aggressiveness. */
export type ExecutionUrgency = 'passive' | 'balanced' | 'aggressive' | 'immediate';

/** Leverage selection policy (PRD §19). MVP ships AUTO_SAFE only. */
export type LeverageMode = 'manual' | 'auto_safe';

/** Margin mode (PRD §92). Product default recommendation is ISOLATED. */
export type MarginMode = 'isolated' | 'cross';

/** Position mode (PRD §91). */
export type PositionMode = 'one_way' | 'hedge';

/** Execution lifecycle (PRD §57). */
export type ExecutionStatus =
  | 'DRAFT'
  | 'CALCULATED'
  | 'VALIDATED'
  | 'READY'
  | 'RUNNING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'PAUSED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'FAILED'
  | 'RISK_STOPPED'
  | 'EXPIRED'
  | 'RECONCILING'
  | 'STOPPED';

/**
 * Execution lifecycle table (PRD §57) — ONE truth for API intents and worker
 * transitions alike. Terminal states accept nothing.
 */
export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  DRAFT: ['CALCULATED', 'CANCELLED', 'FAILED'],
  CALCULATED: ['VALIDATED', 'FAILED', 'CANCELLED'],
  VALIDATED: ['READY', 'FAILED', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['PARTIALLY_FILLED', 'FILLED', 'PAUSED', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'RISK_STOPPED', 'EXPIRED', 'RECONCILING', 'STOPPED'],
  PARTIALLY_FILLED: ['RUNNING', 'FILLED', 'PAUSED', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'RISK_STOPPED', 'EXPIRED', 'RECONCILING', 'STOPPED'],
  PAUSED: ['RUNNING', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'RISK_STOPPED', 'STOPPED'],
  CANCEL_REQUESTED: ['CANCELLED', 'FAILED', 'PARTIALLY_FILLED'],
  RECONCILING: ['RUNNING', 'PARTIALLY_FILLED', 'PAUSED', 'CANCELLED', 'FAILED', 'RISK_STOPPED', 'STOPPED'],
  FILLED: [],
  CANCELLED: [],
  FAILED: [],
  RISK_STOPPED: [],
  EXPIRED: [],
  STOPPED: [],
};

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return (EXECUTION_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalExecution(status: ExecutionStatus): boolean {
  return (EXECUTION_TRANSITIONS[status] ?? []).length === 0;
}

/** Child order lifecycle (PRD §58). */
export type ChildOrderStatus =
  | 'PLANNED'
  | 'SUBMITTING'
  | 'OPEN'
  | 'PARTIAL'
  | 'FILLED'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

/** Credential health (PRD §47). */
export type CredentialHealth =
  | 'ACTIVE'
  | 'INVALID'
  | 'EXPIRED'
  | 'PERMISSION_ERROR'
  | 'RATE_LIMITED'
  | 'REVOKED'
  | 'UNKNOWN';

/** Retry taxonomy (PRD §78). Only `network_retryable`/`rate_limited`/`exchange_overload` may retry. */
export type ErrorCategory =
  | 'network_retryable'
  | 'rate_limited'
  | 'exchange_overload'
  | 'invalid_order'
  | 'permission_error'
  | 'insufficient_balance'
  | 'fatal'
  | 'unknown';

/** When projected risk exceeds the budget (PRD §37). Default RESIZE_THEN_STOP. */
export type RiskBreachPolicy = 'resize_then_stop' | 'pause' | 'stop';

/** Existing-position policy at open time (PRD §93). MVP: ADD and REJECT. */
export type ExistingPositionPolicy = 'add' | 'reject';

/** Execution mode (PRD §118). LIVE is fail-closed behind the kill switch. */
export type ExecutionMode = 'preview' | 'paper' | 'live';

/** How a protective stop is managed (PRD §39). Native preferred. */
export type StopMode = 'native' | 'synthetic' | 'hybrid';

/** Immutable event names (PRD §63). */
export type ExecutionEventName =
  | 'EXECUTION_CREATED'
  | 'RISK_CALCULATED'
  | 'PLAN_CREATED'
  | 'EXECUTION_STARTED'
  | 'ORDER_SUBMITTED'
  | 'ORDER_PARTIALLY_FILLED'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELLED'
  | 'ORDER_REJECTED'
  | 'RISK_RECALCULATED'
  | 'PLAN_RESIZED'
  | 'EXECUTION_PAUSED'
  | 'EXECUTION_RESUMED'
  | 'EXECUTION_COMPLETED'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_RISK_STOPPED'
  | 'EXECUTION_CANCELLED'
  | 'RECONCILIATION_MISMATCH'
  | 'EXTERNAL_STATE_CHANGE';

// ---------------------------------------------------------------------------
// Balance basis (PRD §10) — percentage sizing MUST name its source explicitly.
// ---------------------------------------------------------------------------

export type BalanceBasis =
  | 'spot_available'
  | 'spot_equity'
  | 'futures_available'
  | 'futures_equity'
  | 'total_exchange_equity'
  | 'asset_equity'
  | 'custom';

/** A resolved balance view, as returned by `resolveBalanceBasis`. */
export interface BalanceSnapshot {
  spotAvailable: number | null;
  spotEquity: number | null;
  futuresAvailable: number | null;
  futuresEquity: number | null;
  totalExchangeEquity: number | null;
  /** Present only for `asset_equity`: the base-asset holding value in quote terms. */
  assetEquity?: number | null;
  /** Present only for `custom`: the caller-supplied reference balance. */
  custom?: number | null;
}

// ---------------------------------------------------------------------------
// Instrument metadata (PRD §70) — every calculated order is rounded to this.
// ---------------------------------------------------------------------------

export interface InstrumentMetadata {
  /** Normalized symbol, e.g. `BTC/USDT`. */
  symbol: string;
  marketType: MarketType;
  exchange: ExchangeId;
  baseAsset: string;
  quoteAsset: string;
  settlementAsset: string;
  /** Price tick, e.g. 0.01. */
  tickSize: number;
  /** Quantity step, e.g. 0.001. */
  stepSize: number;
  minQuantity: number | null;
  maxQuantity: number | null;
  minNotional: number | null;
  maxNotional: number | null;
  /** Contract multiplier (linear USDT-M is 1). */
  contractMultiplier: number;
  maxLeverage: number | null;
  /** Maintenance margin rate for the approximation (PRD §21); null = unknown. */
  maintenanceMarginRate: number | null;
  /** Leverage tiers, ascending by notional (PRD §18). Empty when unknown. */
  leverageBrackets: LeverageBracket[];
}

export interface LeverageBracket {
  /** Max notional for this tier (inclusive). */
  maxNotional: number | null;
  maxLeverage: number;
  maintenanceMarginRate: number;
}

// ---------------------------------------------------------------------------
// Market data (PRD §69)
// ---------------------------------------------------------------------------

export interface MarketSnapshot {
  /** Normalized symbol. */
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  last: number;
  /** Unix milliseconds. */
  timestamp: number;
}

export interface Ticker {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  timestamp: number;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface Market {
  symbol: string;
  marketType: MarketType;
  active: boolean;
  metadata: InstrumentMetadata;
}

// ---------------------------------------------------------------------------
// Fees / risk models (PRD §22)
// ---------------------------------------------------------------------------

export interface FeeModel {
  /** Basis points of notional, e.g. 5 = 0.05%. */
  makerBps: number;
  takerBps: number;
}

export interface FeeSchedule {
  symbol: string;
  makerBps: number;
  takerBps: number;
}

export interface SlippageModel {
  /** Estimated slippage in bps of notional, priced into the risk budget. */
  slippageBps: number;
  /**
   * Safety reserve as a fraction of PRICE RISK (0.01 = 1% of `priceRisk`).
   * Proportional to price risk — not to the budget — so every sizing formula
   * stays linear in quantity and closed-form solvable, and `projectedRisk` on
   * fills is computable without knowing the original budget.
   */
  safetyReservePct: number;
}

// ---------------------------------------------------------------------------
// Sizing (PRD §12, §52) — risk-oriented, capital-oriented, outcome-oriented.
// ---------------------------------------------------------------------------

export type SizingDefinition =
  | { mode: 'risk_usd'; value: number }
  | { mode: 'risk_percent'; value: number; balanceBasis: BalanceBasis }
  | { mode: 'allocation_usd'; value: number }
  | { mode: 'allocation_percent'; value: number; balanceBasis: BalanceBasis }
  | { mode: 'notional_usd'; value: number }
  | { mode: 'fixed_quantity'; value: number }
  | { mode: 'fixed_margin'; value: number }
  | { mode: 'target_profit_usd'; value: number }
  /** Desired profit as % of the named balance basis (interpretation recorded in DR-020). */
  | { mode: 'target_profit_percent'; value: number; balanceBasis: BalanceBasis };

export type SizingMode = SizingDefinition['mode'];

// ---------------------------------------------------------------------------
// Entry / exit definitions (PRD §51, §54)
// ---------------------------------------------------------------------------

export type EntryDefinition =
  | { type: 'market' }
  | { type: 'limit'; price: number; postOnly?: boolean };

export interface PriceDefinition {
  price: number;
}

export interface TakeProfitDefinition {
  price: number;
  /** Fraction of the position to close at this level (0..1). Absent = full close. */
  fraction?: number;
}

/** One scale level (PRD §33, §34). */
export interface ScaleLevel {
  price: number;
  /** Fraction of the total quantity (0..1). */
  fraction: number;
}

export type LeverageDefinition =
  | { mode: 'manual'; leverage: number }
  | {
      mode: 'auto_safe';
      /** Cap for the auto selection (PRD §19). */
      maxLeverage?: number;
      /** Required SL→liquidation buffer as fraction of stop distance (0.2 = 20%). */
      liquidationBufferPct?: number;
      /** Max fraction of available balance used as margin. */
      maxMarginPct?: number;
    };

/** TWAP configuration (PRD §29). */
export interface TwapConfig {
  durationMs: number;
  slices?: number;
  intervalMs?: number;
  quantityJitterPct?: number;
  intervalJitterPct?: number;
  priceLimit?: number;
  orderType: 'market' | 'limit' | 'maker';
  maxSlippageBps?: number;
  maxSpreadBps?: number;
}

export type ExecutionDefinition =
  | { type: 'market' }
  | { type: 'limit'; price: number; postOnly?: boolean }
  | { type: 'twap'; durationMs: number; slices?: number; intervalMs?: number; config?: TwapConfig }
  | { type: 'adaptive_twap'; durationMs: number; urgency: ExecutionUrgency; slices?: number; config?: TwapConfig }
  | { type: 'iceberg'; visibleQuantity: number }
  | {
      type: 'chase_limit';
      urgency: ExecutionUrgency;
      /** Cap on cancel/replace cycles before the strategy gives up (PRD §32). */
      maxReplacements?: number;
      /** Furthest the peg may travel from the arrival price before chasing stops. */
      maxChaseDistance?: number;
      /** Minimum gap between two cancel/replace cycles, so we do not thrash. */
      minReplacementIntervalMs?: number;
    }
  | { type: 'scale_in'; levels: ScaleLevel[] }
  | { type: 'scale_out'; levels: ScaleLevel[] };

export type ExecutionStrategy =
  | 'market'
  | 'limit'
  | 'twap'
  | 'adaptive_twap'
  | 'iceberg'
  | 'chase_limit'
  | 'scale_in'
  | 'scale_out';

export interface ExecutionConstraints {
  maxSlippageBps?: number;
  maxSpreadBps?: number;
  maxPrice?: number;
  minPrice?: number;
  maxDurationMs?: number;
  makerOnly?: boolean;
  allowMarketFallback?: boolean;
  cancelIfRiskExceeded?: boolean;
  stopIfDisconnected?: boolean;
}

// ---------------------------------------------------------------------------
// Execution request (PRD §51) — the normalized client intent.
// ---------------------------------------------------------------------------

export interface ExecutionRequest {
  accountId: string;
  /** Normalized symbol, e.g. `BTC/USDT`. */
  symbol: string;
  marketType: MarketType;
  side: Side;
  intent: Intent;
  entry: EntryDefinition;
  stopLoss?: PriceDefinition;
  takeProfits?: TakeProfitDefinition[];
  sizing: SizingDefinition;
  leverage?: LeverageDefinition;
  marginMode?: MarginMode;
  execution: ExecutionDefinition;
  constraints?: ExecutionConstraints;
  /** Risk breach behavior (PRD §37). Default `resize_then_stop`. */
  riskPolicy?: RiskBreachPolicy;
  /** Existing-position handling (PRD §93). Default `reject` on `open`. */
  existingPositionPolicy?: ExistingPositionPolicy;
  /** Execution mode (PRD §118). Default from server config, never trusted from the client alone. */
  mode?: ExecutionMode;
  /**
   * PRD §14 combined constraint: desired profit bound (quote currency) validated
   * TOGETHER with the risk bound. Optional — when present alongside risk sizing
   * the planner returns a `risk_vs_profit` conflict if both cannot hold.
   */
  targetProfit?: number;
  /**
   * PRD §14 combined constraint: maximum-loss bound (quote currency), validated
   * together with `targetProfit` or with outcome-oriented sizing.
   */
  maxRisk?: number;
}

// ---------------------------------------------------------------------------
// Risk engine contract (PRD §103–§106) — `backend/workers/executor/internal/risk` exports EXACTLY this.
// ---------------------------------------------------------------------------

/** Risk breakdown (PRD §22–§23). All values in quote currency. */
export interface RiskBreakdown {
  priceRisk: number;
  entryFee: number;
  exitFee: number;
  estimatedSlippage: number;
  safetyReserve: number;
  totalRisk: number;
}

export interface RiskPositionInput {
  side: Side;
  entry: number;
  stop: number;
  riskBudget: number;
  feeModel: FeeModel;
  slippageModel: SlippageModel;
  instrument: InstrumentMetadata;
  /** Market entries pay taker + entry slippage; limit entries pay maker and no entry slippage. */
  entryType?: 'market' | 'limit';
}

export interface SizedPosition {
  /** Instrument-rounded quantity (risk-safe: rounded DOWN). */
  quantity: number;
  /** Exact quantity before rounding — for invariant assertions only (PRD §106). */
  unroundedQuantity: number;
  notional: number;
  risk: RiskBreakdown;
  warnings: string[];
}

export interface ProfitPositionInput {
  side: Side;
  entry: number;
  target: number;
  desiredProfit: number;
  feeModel: FeeModel;
  slippageModel: SlippageModel;
  instrument: InstrumentMetadata;
  entryType?: 'market' | 'limit';
}

export interface ProfitPositionResult {
  quantity: number;
  unroundedQuantity: number;
  notional: number;
  /** Net profit at target after fees/slippage. */
  estimatedProfit: number;
  risk: RiskBreakdown | null;
  warnings: string[];
}

/** Known variables of the constraint solver (PRD §15, §105). */
export interface SolveInput {
  side: Side;
  instrument: InstrumentMetadata;
  feeModel: FeeModel;
  slippageModel: SlippageModel;
  known: {
    entry?: number;
    stop?: number;
    target?: number;
    quantity?: number;
    risk?: number;
    profit?: number;
    margin?: number;
    notional?: number;
    leverage?: number;
  };
}

export interface ConstraintConflict {
  /** Machine-readable conflict id, e.g. `risk_vs_profit`. */
  code: string;
  message: string;
  /** Human-facing numbers backing the conflict, per PRD §14's response shape. */
  detail?: Record<string, number>;
}

export interface SolveResult {
  solved: {
    entry?: number;
    stop?: number;
    target?: number;
    quantity?: number;
    risk?: number;
    profit?: number;
    margin?: number;
    notional?: number;
    leverage?: number;
  };
  unsatisfied: string[];
  conflicts: ConstraintConflict[];
  warnings: string[];
}

/** Risk of a position at its current average entry (PRD §36). */
export interface ProjectedRiskInput {
  side: Side;
  averageEntry: number;
  quantity: number;
  stop: number;
  feeModel: FeeModel;
  slippageModel: SlippageModel;
  instrument: InstrumentMetadata;
}

/** Remaining-budget resize (PRD §37). */
export interface MaxSafeQuantityInput {
  side: Side;
  /** Weighted average entry of what is already filled (or planned entry). */
  referenceEntry: number;
  stop: number;
  remainingBudget: number;
  /** Quantity already committed/filled — its risk is inside `remainingBudget` accounting. */
  filledQuantity: number;
  feeModel: FeeModel;
  slippageModel: SlippageModel;
  instrument: InstrumentMetadata;
}

export interface MaxSafeQuantityResult {
  /** Risk-safe additional quantity (rounded DOWN to step size). */
  maxAdditionalQuantity: number;
  unroundedAdditionalQuantity: number;
  projectedRiskAfter: RiskBreakdown;
}

/** Auto-safe leverage selection (PRD §19–§20). */
export interface AutoLeverageInput {
  side: Side;
  entry: number;
  stop: number | null;
  notional: number;
  availableBalance: number;
  maxLeverage: number;
  exchangeMaxLeverage: number | null;
  liquidationBufferPct: number;
  maxMarginPct: number;
  maintenanceMarginRate: number | null;
}

export interface AutoLeverageResult {
  selected: number;
  estimatedMargin: number;
  /** Approximate liquidation price at the selected leverage (PRD §21: preview-grade). */
  liquidationPrice: number | null;
  /** True when the liquidation price sits beyond SL + buffer. */
  liquidationSafe: boolean;
  warnings: string[];
}

/**
 * `backend/workers/executor/internal/risk` — the pure risk engine. Deterministic, decimal-backed,
 * zero I/O (PRD §102). Signatures are frozen here so every other slice can be
 * built against them in parallel.
 */
export interface RiskEngine {
  /** PRD §8, §22: risk-budget sizing with fee/slippage-aware total risk. */
  calculateRiskPosition(input: RiskPositionInput): SizedPosition;
  /** PRD §13: desired-profit sizing. */
  calculateProfitPosition(input: ProfitPositionInput): ProfitPositionResult;
  /** PRD §14, §15: constraint solver over any known subset. */
  solvePosition(input: SolveInput): SolveResult;
  /** PRD §36: current risk of a filled position at its average entry. */
  projectedRisk(input: ProjectedRiskInput): RiskBreakdown;
  /** PRD §37: how much MORE may be bought before the budget binds. */
  maxSafeQuantity(input: MaxSafeQuantityInput): MaxSafeQuantityResult;
  /** PRD §19, §20: AUTO_SAFE leverage selection with liquidation safety. */
  autoSafeLeverage(input: AutoLeverageInput): AutoLeverageResult;
  /** PRD §21: preview-grade liquidation approximation (exchange brackets when known). */
  liquidationPriceApprox(args: {
    side: Side;
    entry: number;
    leverage: number;
    maintenanceMarginRate: number | null;
  }): number;
  /** PRD §10: resolve a percentage sizing basis against the account snapshot. */
  resolveBalanceBasis(basis: BalanceBasis, balances: BalanceSnapshot, symbol?: string): number | null;
  /** PRD §70, §71: risk-safe quantity rounding (DOWN for exposure). */
  roundQuantityDown(quantity: number | string, instrument: InstrumentMetadata): number;
  /** Round a price to tick size. */
  roundPrice(price: number | string, instrument: InstrumentMetadata): number;
}

// ---------------------------------------------------------------------------
// Execution plan (PRD §56) + preview (PRD §80)
// ---------------------------------------------------------------------------

export interface ExecutionPlanRisk {
  /**
   * The user's risk bound. `null` for capital/outcome sizing modes with no
   * explicit `maxRisk` (PRD §12): there is no budget, so none is invented.
   */
  budget: number | null;
  /**
   * Stop-based figures. `null` when no stop is configured (PRD §38 only REQUIRES
   * a stop for risk-based sizing): without a stop the price risk is unbounded and
   * a 0 here would be a fabricated number — render `—` instead (house rule).
   */
  estimatedTotalRisk: number | null;
  priceRisk: number | null;
  /** Fees are computable regardless of the stop. */
  estimatedFees: number;
  /** Slippage allowance charged into the risk figures. 0 for a limit (maker) entry is a computed model value, not a guess. */
  slippageBudget: number;
  /** Proportional to price risk (PRD §22) — null when no stop. */
  safetyReserve: number | null;
}

export interface ExecutionPlan {
  /** Venue key (PRD §49). */
  venueKey: VenueKey;
  symbol: string;
  marketType: MarketType;
  side: Side;
  intent: Intent;
  quantity: number;
  notional: number;
  estimatedEntry: number;
  stopLoss: number | null;
  takeProfits: TakeProfitDefinition[];
  risk: ExecutionPlanRisk;
  leverage: { mode: LeverageMode; selected: number | null };
  margin: { estimatedInitial: number | null; mode: MarginMode | null };
  liquidation: {
    priceApprox: number | null;
    /** Distance from SL to the approximate liquidation price, in quote units. */
    stopToLiquidationBuffer: number | null;
    safe: boolean | null;
  };
  execution: {
    strategy: ExecutionStrategy;
    durationMs: number | null;
    estimatedSlices: number | null;
    urgency: ExecutionUrgency | null;
  };
  /** Instrument constraints captured at planning time (PRD §70, §99). */
  instrument: InstrumentMetadata;
  feeModel: FeeModel;
  slippageModel: SlippageModel;
  /**
   * Immutable creation-time context (PRD §99): the balance and market snapshots
   * the plan was computed from. Null only when the caller had none (e.g. a
   * fixed-quantity preview without account data) — never a fabricated snapshot.
   */
  balanceSnapshot: BalanceSnapshot | null;
  marketSnapshot: MarketSnapshot | null;
  sizingMode: SizingMode;
  sizingValue: number;
  riskBasis: BalanceBasis | null;
  balanceReference: number | null;
}

export interface PreviewResult {
  plan: ExecutionPlan;
  /** Loss at the configured stop including fees/slippage (PRD §80). Null = no stop configured. */
  expectedLossAtStop: number | null;
  /** Net profit at the first/primary TP. Null when no TP. */
  expectedProfitAtTarget: number | null;
  /** Profit target price used. Null when no TP. */
  targetPrice: number | null;
  /** Risk/reward ratio. Null when not computable. */
  riskReward: number | null;
  conflicts: ConstraintConflict[];
  warnings: string[];
  mode: ExecutionMode;
}
