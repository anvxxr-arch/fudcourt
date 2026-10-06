/**
 * executor-engine.ts — ENGINE half of the FUDCourt CEX Executor response
 * contract (PRD §25–§37). Split from `./executor-venue`: everything here is
 * defined ONLY here — `executor-venue.ts` and the `@/lib/executor` barrel
 * re-export, never redefine.
 *
 * Request-side shapes are imported as types from `./executor-request` (one
 * direction only — request never imports response). Consumers import
 * `@/lib/executor` (the barrel), never this path directly.
 */
import type {
  ChildOrderStatus,
  ExecutionConstraints,
  ExecutionDefinition,
  ExecutionPlan,
  ExecutionStrategy,
  MarketSnapshot,
  RiskBreakdown,
  Side,
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
