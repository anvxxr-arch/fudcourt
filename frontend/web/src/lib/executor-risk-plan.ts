/**
 * executor-risk-plan.ts — risk-engine contract (PRD §103–§106) plus execution
 * plan and preview (PRD §56, §80). Split from `./executor-request`:
 * everything here is defined ONLY here — `executor-request.ts` and the
 * `@/lib/executor` barrel re-export, never redefine.
 */
import type {
  BalanceBasis,
  BalanceSnapshot,
  FeeModel,
  SlippageModel,
  SizingMode,
} from './executor-sizing';
import type {
  ExecutionMode,
  ExecutionStrategy,
  ExecutionUrgency,
  InstrumentMetadata,
  Intent,
  LeverageMode,
  MarginMode,
  MarketSnapshot,
  MarketType,
  Side,
  TakeProfitDefinition,
  VenueKey,
} from './executor-request-defs';

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
