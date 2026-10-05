/**
 * types.ts — THE SHARED CONTRACT of the FUDCourt CEX Executor (PRD §48–§56, §57–§63).
 *
 * Path note (DR-043, 2026-10-05): this module lives at
 * `@/platform/executor/types`. The TS executor runtime that used to live
 * beside it was retired in DR-043; the Go service
 * `backend/workers/executor` owns the risk/engine/exchange/store/worker
 * surfaces, and this file is the FROZEN WIRE CONTRACT the web tier and
 * the Go surface both speak. The Go side has its own canonical
 * enum/struct definitions (`internal/api/types.go` and the
 * per-package `*_test.go` fixtures); renames on either side are coupled
 * by the parity matrix `parity-matrix.md` row 1.
 *
 * Every consumer of the executor wire contract imports THIS module and
 * nothing else across slice boundaries. As of 2026-10-05 (DR-043) the
 * runtime is no longer in this tree: the Go service
 * `backend/workers/executor` owns the risk / engine / exchange / store /
 * worker surfaces, and this file is the FROZEN contract the web tier
 * types against. The Go side's own canonical enums and structs live in
 * `internal/api/types.go` and the per-package `*_test.go` fixtures; field
 * renames on either side are coupled by `parity-matrix.md` row 1.
 *
 *   @/platform/executor/types     ← this file: web-side wire contract
 *   backend/workers/executor         ← the runtime: risk, engine, exchange,
 *                                      store, worker, api (per Go package)
 *   src/features/executor/           ← UI slice (client + shapers + panel)
 *                                      imports only from this file
 *   src/app/(frontend)/api/executor/ ← API routes — one-line forwarders to
 *                                      the Go /api/executor/* surface via
 *                                      _proxy.ts; no executor logic
 *
 * Layer rules (DR-018, scripts/checks/check-structure.py): features never
 * import from app; features import the wire contract from platform/executor.
 * platform never imports features or app. The structure gate enforces a
 * CLOSED layer set, so PRD §101's `packages/*` layout is adapted to one
 * app (see DR-020).
 *
 * Naming: TypeScript/wire names are camelCase exactly as PRD §51–§55 declare
 * them; the Postgres columns are snake_case (PRD §60–§62). Repositories map
 * between the two — never leak row shapes into the API.
 *
 * Money math (PRD §71): NO float arithmetic on quantities/prices in the engines.
 * `decimal.js` is the required arithmetic; `number` here is the WIRE type, and
 * every value that leaves a calculation has already been rounded to instrument
 * constraints (PRD §70) with the risk-safe direction (quantity DOWN).
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

// ---------------------------------------------------------------------------
// Persistence shapes (PRD §59–§63) — snake_case columns, camelCase domain objects.
// ---------------------------------------------------------------------------

export interface CredentialRecord {
  id: string;
  userId: string;
  exchange: ExchangeId;
  label: string;
  /** Masked `abc...xyz` only — never the full key (PRD §109). */
  apiKeyMasked: string;
  permissions: AccountPermissions;
  health: CredentialHealth;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** Decrypted secrets — NEVER leaves `backend/workers/executor/internal/store` (PRD §44, §108). */
export interface DecryptedCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string | null;
}

export interface ExecutionRecord {
  id: string;
  userId: string;
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  marketType: MarketType;
  side: Side;
  intent: Intent;
  status: ExecutionStatus;
  mode: ExecutionMode;
  sizingMode: SizingMode;
  sizingValue: number;
  riskBudget: number | null;
  riskBasis: BalanceBasis | null;
  entryDefinition: EntryDefinition;
  stopDefinition: PriceDefinition | null;
  takeProfitDefinition: TakeProfitDefinition[];
  executionStrategy: ExecutionStrategy;
  executionConfig: ExecutionDefinition;
  constraints: ExecutionConstraints;
  plannedQuantity: number;
  plannedNotional: number;
  actualQuantity: number;
  actualNotional: number;
  averageFillPrice: number | null;
  estimatedFees: number | null;
  actualFees: number;
  plannedRisk: number | null;
  currentRisk: number | null;
  /**
   * Opaque engine state (JSON round-trippable). NOT authoritative across a
   * lost write — the exchange is (PRD §95/§114) — but authoritative enough to
   * resume a strategy without re-deriving its schedule from process memory
   * (PRD §130: process memory must never be the only copy).
   */
  strategyState: unknown;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
}

export interface ChildOrderRecord {
  id: string;
  executionId: string;
  exchangeOrderId: string | null;
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: string;
  price: number | null;
  quantity: number;
  filledQuantity: number;
  status: ChildOrderStatus;
  isExit: boolean;
  submittedAt: number | null;
  updatedAt: number;
  filledAt: number | null;
}

export interface FillRecord {
  id: string;
  executionId: string;
  childOrderId: string | null;
  /** Dedup key part 1 (PRD §62). */
  exchangeTradeId: string;
  price: number;
  quantity: number;
  quoteQuantity: number;
  fee: number;
  feeAsset: string;
  timestamp: number;
}

export interface ExecutionEventRecord {
  id: string;
  executionId: string;
  name: ExecutionEventName;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface AuditLogRecord {
  id: string;
  userId: string | null;
  action: string;
  target: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Risk profile (PRD §72, §88, §119) — account-level safety rules.
// ---------------------------------------------------------------------------

export interface RiskProfile {
  defaultRiskMode: 'risk_usd' | 'risk_percent';
  defaultRisk: number;
  /** Hard cap per trade (percent of the risk basis). Enforced at creation. */
  maxRiskPerTradePct: number;

  /**
   * Portfolio ceiling on COMMITTED risk (PRD §73): the sum of current risk over
   * live executions plus a new opening may not exceed this share of total
   * exchange equity. Enforced at creation — a breach is refused, never resized.
   */
  maxOpenRiskPct: number;
  /**
   * Daily realized-loss ceiling (PRD §74). Once the day's realized P&L reaches
   * -this% of equity, new OPENINGS are blocked; closing and reducing stay
   * allowed, so the guard can never trap a user in the risk it exists to bound.
   */
  maxDailyLossPct: number;
  maxLeverage: number;
  defaultMarginMode: MarginMode;
  defaultExecutionUrgency: ExecutionUrgency;
}

export const DEFAULT_RISK_PROFILE: RiskProfile = {
  defaultRiskMode: 'risk_percent',
  defaultRisk: 1,
  maxRiskPerTradePct: 2,
  maxOpenRiskPct: 5,
  maxDailyLossPct: 5,
  maxLeverage: 10,
  defaultMarginMode: 'isolated',
  defaultExecutionUrgency: 'balanced',
};

// ---------------------------------------------------------------------------
// Store contract (PRD §59) — `backend/workers/executor/internal/store` implements this.
// Every method is scoped by `userId`; ownership is checked server-side (PRD §108).
// ---------------------------------------------------------------------------
/**
 * Portfolio-level committed risk (PRD §73) and a realized result (PRD §74), both
 * already-committed numbers that a NEW execution must fit inside.
 */
export interface PortfolioRiskSummary {
  /**
   * Sum of `current_risk` over live executions, falling back to `planned_risk`
   * for one that has not filled yet (it is still committed risk). Stays `null`
   * when no live execution has a quantifiable risk — an unquantifiable position
   * is reported honestly, never counted as zero.
   */
  openRisk: number | null;
  /** Realized P&L of executions that closed in the window; negative is a loss. */
  realizedPnlToday: number;
  /** Count of live executions contributing to `openRisk`. */
  liveCount: number;
}


export interface ExecutorStore {
  // Credentials (PRD §45–§47)
  createCredential(args: {
    userId: string;
    exchange: ExchangeId;
    label: string;
    credentials: DecryptedCredentials;
    permissions: AccountPermissions;
  }): Promise<CredentialRecord>;
  listCredentials(userId: string): Promise<CredentialRecord[]>;
  getCredential(userId: string, id: string): Promise<CredentialRecord | null>;
  /** The ONLY path to plaintext secrets. Server-side only (PRD §100). */
  revealCredentials(userId: string, id: string): Promise<DecryptedCredentials | null>;
  updateCredentialHealth(userId: string, id: string, health: CredentialHealth): Promise<void>;
  touchCredential(userId: string, id: string, at: number): Promise<void>;
  revokeCredential(userId: string, id: string, at: number): Promise<void>;
  /** Key rotation (PRD §44): re-encrypt all secrets under a new master key. */
  rotateCredentialKeys(newMasterKey: string, oldMasterKey: string): Promise<number>;

  // Executions (PRD §60, §63)
  createExecution(rec: Omit<ExecutionRecord, 'id' | 'createdAt' | 'startedAt' | 'completedAt' | 'cancelledAt' | 'strategyState'> & { plan: ExecutionPlan; strategyState?: unknown }): Promise<ExecutionRecord>;
  /** The immutable creation-time plan (PRD §56/§99) — worker risk math source. */
  getExecutionPlan(executionId: string): Promise<ExecutionPlan | null>;
  getExecution(userId: string, id: string): Promise<ExecutionRecord | null>;
  /** Worker-side read WITHOUT user scoping — the worker is not a user (PRD §68). */
  getExecutionForWorker(id: string): Promise<ExecutionRecord | null>;
  listExecutions(userId: string, opts?: { limit?: number; status?: ExecutionStatus }): Promise<ExecutionRecord[]>;
  /**
   * Portfolio risk rollup for one user (PRD §73/§74): what is ALREADY committed
   * by their live executions, so a new one can be refused before it is created.
   * `openRisk` sums each live execution's CURRENT risk (recalculated after every
   * fill); `realizedLossToday` sums closed executions' realized outcome. Both are
   * derived in SQL so the check cannot race a partially-applied in-memory sum.
   */
  summarizePortfolioRisk(userId: string, sinceMs: number): Promise<PortfolioRiskSummary>;
  updateExecutionStatus(id: string, status: ExecutionStatus, at: number): Promise<void>;
  updateExecutionProgress(id: string, patch: {
    actualQuantity?: number;
    actualNotional?: number;
    averageFillPrice?: number | null;
    actualFees?: number;
    currentRisk?: number | null;
  }): Promise<void>;
  /** Persist the engine's strategy state after every tick (PRD §130). */
  updateExecutionStrategyState(id: string, state: unknown): Promise<void>;
  /** Periodic reconciliation snapshots (PRD §41, §59). */
  insertSnapshot(rec: {
    accountId: string;
    kind: 'balance' | 'position';
    payload: unknown;
    createdAt: number;
  }): Promise<void>;

  // Child orders (PRD §61)
  insertChildOrder(rec: Omit<ChildOrderRecord, 'id'>): Promise<ChildOrderRecord>;
  updateChildOrder(executionId: string, clientOrderId: string, patch: Partial<ChildOrderRecord>): Promise<void>;
  listChildOrders(executionId: string): Promise<ChildOrderRecord[]>;

  // Fills (PRD §62) — insert is idempotent on (accountId, exchangeTradeId).
  insertFill(rec: Omit<FillRecord, 'id'>): Promise<FillRecord | null>;
  listFills(executionId: string): Promise<FillRecord[]>;

  // Events (PRD §63) — immutable, append-only.
  appendEvent(executionId: string, name: ExecutionEventName, payload: Record<string, unknown>, at: number): Promise<ExecutionEventRecord>;
  listEvents(executionId: string): Promise<ExecutionEventRecord[]>;

  // Risk profiles (PRD §72, §119)
  getRiskProfile(userId: string): Promise<RiskProfile>;
  putRiskProfile(userId: string, profile: RiskProfile): Promise<RiskProfile>;

  // Audit (PRD §110)
  audit(rec: Omit<AuditLogRecord, 'id' | 'createdAt'> & { createdAt?: number }): Promise<void>;

  // Runtime scanning (PRD §114): executions a worker must own after restart.
  listRunningExecutions(): Promise<ExecutionRecord[]>;
}

// ---------------------------------------------------------------------------
// Worker contract (PRD §64–§68, §114) — `backend/workers/executor/internal/runtime` implements this.
// ---------------------------------------------------------------------------

export interface ExecutorWorkerApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One scheduler pass; exposed for deterministic tests. */
  tick(): Promise<void>;
  /** Crash recovery (PRD §114). */
  recover(): Promise<void>;
  /**
   * Emergency stop (PRD §75): stop all strategies and cancel managed open
   * orders; never closes positions on its own. Scope: everything when no
   * filter is given, otherwise one user's / one account's executions.
   */
  emergencyStop(args: { userId?: string; accountId?: string }): Promise<{ stopped: number; cancelledOrders: number }>;
}

/** Locking (PRD §65): one worker owns one execution at a time. */
export interface ExecutionLock {
  /** Try to take `execution:{id}:lock`. False when another worker holds it. */
  acquire(executionId: string, workerId: string, ttlMs: number): Promise<boolean>;
  /** Owner-token release: never unlocks someone else's lease. */
  release(executionId: string, workerId: string): Promise<void>;
  /** Extend the lease; false when the lease was lost. */
  heartbeat(executionId: string, workerId: string, ttlMs: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Store schema name + wire helpers
// ---------------------------------------------------------------------------

/** All executor tables live in this dedicated Postgres schema (DR-020). */
export const EXECUTOR_SCHEMA = 'executor';

/** Client order id format (PRD §66): `fud_{executionId}_{sequence}`. */
export function clientOrderId(executionId: string, sequence: number): string {
  return `fud_${executionId}_${sequence}`;
}

/** Mask an API key for display: `abc...xyz` (PRD §109). */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-3)}`;
}

/** Venue key (PRD §49). */
export function venueKey(exchange: ExchangeId, marketType: MarketType, symbol: string): VenueKey {
  return `${exchange}:${marketType}:${symbol}`;
}
