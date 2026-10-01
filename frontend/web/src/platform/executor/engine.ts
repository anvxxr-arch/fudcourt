/**
 * engine.ts — deterministic execution strategies + lifecycle (PRD §25–§37, §57–§58, §107).
 *
 * Purity contract: all time comes from `ctx.now`, all randomness from a seeded
 * mulberry32 stream created in `createStrategy` and persisted inside the state,
 * so the worker can persist the opaque JSON state across restarts and every
 * run is reproducible (PRD §28, §114).
 *
 * Risk clamp approximation (PRD §36–§37): the WORKER's `riskEngine.maxSafeQuantity`
 * is authoritative and arrives in the next `ctx`. Between ticks the engine clamps
 * conservatively with a per-unit risk rate: `ctx.projectedRisk.totalRisk /
 * ctx.filledQuantity` when fills exist, else the closed-form per-unit rate at the
 * reference entry (taker fees + entry slippage ALWAYS charged — a deliberately
 * pessimistic rate so the clamp can only under-order, never over-order). When
 * `ctx.remainingRiskBudget` is null no risk budget exists and risk resizing is
 * skipped entirely (over-order protection and SL-invalidation still apply).
 */
import Decimal from 'decimal.js';
import { clientOrderId as makeClientOrderId } from '@/platform/executor/types';
import type {
  ChildOrderEvent,
  ChildOrderStatus,
  ChildOrderView,
  EngineAction,
  ExecutionConstraints,
  ExecutionDefinition,
  ExecutionEngineApi,
  ExecutionPlan,
  ExecutionStrategy,
  FillView,
  MarketSnapshot,
  PlannedChildOrder,
  RiskBreakdown,
  ScaleLevel,
  Side,
  StrategyContext,
  StrategyProgress,
  TakeProfitDefinition,
} from '@/platform/executor/types';

/** Slice-size arithmetic is plain decimal here; the worker owns step-size rounding. */
const QTY_EPS = 1e-9;
/** Remainders of the jitter distribution are floored to this grid (PRD §28). */
const QTY_GRID = 1e-8;
const DEFAULT_SEED = 0x9e3779b9;
const DEFAULT_MAX_REPLACEMENTS = 100;

/**
 * TWAP/adaptive slice default (contract): a nominal 150s slice interval,
 * clamped to [1, 40] slices. This is the ONLY default the planner reports as
 * `estimatedSlices` (30min → 12 slices) and the default every strategy uses.
 */
export function defaultSlices(durationMs: number): number {
  return Math.min(40, Math.max(1, Math.ceil(durationMs / 150_000)));
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). State is a plain uint32 carried in the
// strategy state — no closures, so the state stays JSON-serializable.
// ---------------------------------------------------------------------------
function prngNext(state: number): { state: number; value: number } {
  let t = (state + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: t >>> 0, value };
}

type Rng = { state: number };

function rand01(rng: Rng): number {
  const r = prngNext(rng.state);
  rng.state = r.state;
  return r.value;
}

// Quantity/price arithmetic is Decimal-backed (house contract: no raw float
// money math in shipped code); float only at the ctx/wire boundary.
function round8(x: number): number {
  return new Decimal(x).div(QTY_GRID).round().times(QTY_GRID).toNumber();
}

function floor8(x: number): number {
  return new Decimal(x).div(QTY_GRID).floor().times(QTY_GRID).toNumber();
}

// ---------------------------------------------------------------------------
// Opaque (JSON-serializable) strategy state
// ---------------------------------------------------------------------------
type ChildKind = 'entry' | 'sl' | 'tp' | 'scale_out';

interface LedgerEntry {
  clientOrderId: string;
  kind: ChildKind;
  quantity: number;
  filled: number;
  live: boolean;
  seen: boolean;
  /** Tick the entry was planned in — lets reconciliation expire phantom legs. */
  createdAt: number;
}

interface SlicePlan {
  quantity: number;
  atOffsetMs: number;
}

type Phase = 'active' | 'paused' | 'completed' | 'stopped' | 'invalidated';

interface StrategyState {
  version: 1;
  executionId: string;
  strategy: ExecutionStrategy;
  side: Side;
  /** Entry target (close target for scale_out). */
  targetQuantity: number;
  planPrice: number | null;
  postOnly: boolean;
  stopLoss: number | null;
  takeProfits: TakeProfitDefinition[];
  tickSize: number;
  stepSize: number;
  contractMultiplier: number;
  estimatedEntry: number;
  /** Fallback per-unit risk rate (taker+slippage pessimistic approximation). */
  fallbackUnitRisk: number | null;
  plannedRisk: number | null;
  constraints: ExecutionConstraints;
  durationMs: number | null;
  urgency: 'passive' | 'balanced' | 'aggressive' | 'immediate' | null;
  startedAt: number | null;
  sequence: number;
  rng: number;
  phase: Phase;
  riskStopped: boolean;
  pauseEmitted: boolean;
  stopReason: string | null;
  // Fill tracking (entry side; scale_out tracks its own fills in exitFilled).
  filledQuantity: number;
  averageEntry: number | null;
  exitFilled: number;
  // Ledger (over-order accounting, PRD §107/§128.15).
  ledger: LedgerEntry[];
  seenInCtx: Record<string, boolean>;
  // Risk reconciliation cache (PRD §36).
  riskBudgetTotal: number | null;
  unitRiskRate: number | null;
  // TWAP / adaptive.
  slices: SlicePlan[];
  sliceIdx: number;
  carry: number;
  refMid: number | null;
  // Iceberg.
  visibleQuantity: number | null;
  nextRefillAt: number;
  // Chase limit.
  activeChildId: string | null;
  lastRepriceAt: number;
  lastBest: number | null;
  replacements: number;
  maxReplacements: number;
  /** Furthest the peg may travel from the arrival price before the chase stops. */
  maxChaseDistance: number | null;
  /** Minimum gap between two cancel/replace cycles (PRD §32). */
  minReplacementIntervalMs: number;
  // Scale.
  levels: ScaleLevel[];
  levelQty: number[];
  levelDone: boolean[];
}

function asState(state: unknown): StrategyState {
  if (typeof state !== 'object' || state === null || (state as StrategyState).version !== 1) {
    throw new Error('invalid strategy state');
  }
  return state as StrategyState;
}

// ---------------------------------------------------------------------------
// child order lifecycle (PRD §58) — full legal-transition table
// ---------------------------------------------------------------------------
const TRANSITIONS: Record<ChildOrderStatus, Partial<Record<ChildOrderEvent, ChildOrderStatus>>> = {
  PLANNED: { submit: 'SUBMITTING' },
  SUBMITTING: {
    accept: 'OPEN',
    partial_fill: 'PARTIAL',
    fill: 'FILLED',
    reject: 'REJECTED',
    unknown: 'UNKNOWN',
  },
  OPEN: {
    partial_fill: 'PARTIAL',
    fill: 'FILLED',
    cancel_request: 'CANCELLING',
    expire: 'EXPIRED',
    unknown: 'UNKNOWN',
  },
  PARTIAL: {
    partial_fill: 'PARTIAL',
    fill: 'FILLED',
    cancel_request: 'CANCELLING',
    unknown: 'UNKNOWN',
  },
  CANCELLING: {
    cancel: 'CANCELLED',
    partial_fill: 'PARTIAL',
    fill: 'FILLED',
    unknown: 'UNKNOWN',
  },
  // Terminal states accept nothing (PRD §58).
  FILLED: {},
  CANCELLED: {},
  REJECTED: {},
  EXPIRED: {},
  // UNKNOWN is not terminal but only self-heals through a fresh unknown report;
  // every definite event from UNKNOWN is illegal (the worker must reconcile).
  UNKNOWN: { unknown: 'UNKNOWN' },
};

export function transitionChildOrder(current: ChildOrderStatus, event: ChildOrderEvent): ChildOrderStatus {
  const next = TRANSITIONS[current][event];
  if (next === undefined) {
    throw new Error(`illegal child order transition: ${current} -> ? on ${event}`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function entryKind(st: StrategyState): ChildKind {
  return st.strategy === 'scale_out' ? 'scale_out' : 'entry';
}
function isEntryKind(kind: ChildKind): boolean {
  return kind === 'entry' || kind === 'scale_out';
}

function remainingToPlace(st: StrategyState): number {
  const done = st.strategy === 'scale_out' ? st.exitFilled : st.filledQuantity;
  const live = st.ledger.reduce(
    (acc, e) => acc + (isEntryKind(e.kind) && e.live ? Math.max(0, e.quantity - e.filled) : 0),
    0,
  );
  return Math.max(0, round8(st.targetQuantity - done - live));
}

function makeOrder(st: StrategyState, args: {
  kind: ChildKind;
  type: PlannedChildOrder['type'];
  price: number | null;
  quantity: number;
  stopPrice?: number;
  timeInForce?: PlannedChildOrder['timeInForce'];
  postOnly?: boolean;
}): PlannedChildOrder {
  const id = makeClientOrderId(st.executionId, st.sequence);
  st.sequence += 1;
  const kindExit = args.kind === 'sl' || args.kind === 'tp' || args.kind === 'scale_out';
  return {
    clientOrderId: id,
    side: st.side,
    type: args.type,
    price: args.price,
    stopPrice: args.stopPrice ?? null,
    quantity: args.quantity,
    timeInForce: args.timeInForce ?? 'GTC',
    postOnly: args.postOnly ?? false,
    reduceOnly: kindExit,
    isExit: kindExit,
  };
}

function recordPlace(st: StrategyState, order: PlannedChildOrder, kind: ChildKind, now: number): void {
  st.ledger.push({
    clientOrderId: order.clientOrderId,
    kind,
    quantity: order.quantity,
    filled: 0,
    live: true,
    seen: false,
    createdAt: now,
  });
}
function placeAction(st: StrategyState, args: {
  kind: ChildKind;
  type: PlannedChildOrder['type'];
  price: number | null;
  quantity: number;
  stopPrice?: number;
  timeInForce?: PlannedChildOrder['timeInForce'];
  postOnly?: boolean;
}, now: number): EngineAction {
  const order = makeOrder(st, args);
  recordPlace(st, order, args.kind, now);
  return { type: 'place', order };
}

/** Committed = filled + live-unfilled on the primary side (PRD §107 Σ ≤ target). */
function outstandingEntryQty(st: StrategyState): number {
  return st.ledger.reduce(
    (acc, e) => acc + (isEntryKind(e.kind) && e.live ? Math.max(0, e.quantity - e.filled) : 0),
    0,
  );
}

/** Per-unit risk rate: worker's projected rate when available, else the pessimistic fallback. */
function unitRiskRate(st: StrategyState, ctx: StrategyContext | null): number | null {
  if (ctx && ctx.projectedRisk && ctx.filledQuantity > QTY_EPS) {
    return ctx.projectedRisk.totalRisk / ctx.filledQuantity;
  }
  return st.unitRiskRate ?? st.fallbackUnitRisk;
}

/**
 * Conservative max additional quantity from the remaining risk budget (PRD §37).
 * Null = no risk budget exists → no risk clamp. Outstanding children are charged
 * against the budget too: their fills are future exposure.
 */
function riskMaxAdditional(st: StrategyState, ctx: StrategyContext): number | null {
  if (ctx.remainingRiskBudget === null) return null;
  const rate = unitRiskRate(st, ctx);
  if (rate === null || rate <= 0) return null;
  const outstanding = outstandingEntryQty(st);
  return Math.max(0, round8(ctx.remainingRiskBudget / rate - outstanding));
}

function reduceOnlyCap(st: StrategyState, ctx: StrategyContext): number {
  const placedReduceOnly = st.ledger.reduce(
    (acc, e) => acc + (e.kind === 'scale_out' && e.live ? Math.max(0, e.quantity - e.filled) : 0),
    0,
  );
  return Math.max(0, round8(ctx.openPositionQuantity - placedReduceOnly));
}

/**
 * The single choke point every placement flows through (PRD §107):
 * over-order cap → reduce-only cap → risk cap. Returns 0 when the risk budget
 * cannot even afford one plan unit while quantity remains (caller decides stop).
 */
function clampPlace(st: StrategyState, ctx: StrategyContext, qty: number, kind: ChildKind): number {
  let q = Math.min(qty, remainingToPlace(st));
  if (kind === 'scale_out') q = Math.min(q, reduceOnlyCap(st, ctx));
  const riskMax = riskMaxAdditional(st, ctx);
  if (riskMax !== null) q = Math.min(q, riskMax);
  return Math.max(0, round8(q));
}

function syncLedger(st: StrategyState, ctx: StrategyContext): void {
  const byId = new Map<string, ChildOrderView>();
  for (const v of ctx.openChildOrders) byId.set(v.clientOrderId, v);
  for (const e of st.ledger) {
    const v = byId.get(e.clientOrderId);
    if (v) {
      st.seenInCtx[e.clientOrderId] = true;
      e.filled = Math.max(e.filled, v.filledQuantity);
      e.live = v.status !== 'CANCELLED' && v.status !== 'REJECTED' && v.status !== 'EXPIRED' && v.status !== 'FILLED';
    } else if (st.seenInCtx[e.clientOrderId] || e.createdAt < ctx.now) {
      // Either the venue showed it and it is gone (cancelled/filled externally),
      // or we planned it and the worker never sent it: a leg the exchange has
      // never acknowledged must not keep consuming the over-order room (§107).
      e.live = false;
    }
  }
  // scale_out closes an existing position, so venue `filledQuantity` is the
  // ENTRY side's figure and must never leak into this execution's close tally.
  if (st.strategy !== 'scale_out') {
    st.filledQuantity = Math.max(st.filledQuantity, ctx.filledQuantity);
  }
  if (ctx.averageEntry !== null) st.averageEntry = ctx.averageEntry;
}

/** SL invalidation (PRD §115): the market crossed the plan stop on the losing side. */
function slInvalidated(st: StrategyState, ctx: StrategyContext): boolean {
  if (st.stopLoss === null) return false;
  const last = ctx.snapshot.last;
  return st.side === 'buy' ? last <= st.stopLoss : last >= st.stopLoss;
}

/**
 * SL-invalidation actions (PRD §115, synthetic-OCO): cancel every entry child and
 * emit `stop{riskStopped:true}`. The SL exit is KEPT while a position remains open
 * (it performs the close); TP exits are cancelled exactly then — once the stop has
 * handled the close a TP fill would open inverse exposure. With no position open
 * nothing is left to close and exits stay untouched (worker reconciles).
 */
function invalidationActions(st: StrategyState): EngineAction[] {
  st.phase = 'invalidated';
  st.riskStopped = true;
  st.stopReason = 'stop_loss_invalidated';
  const actions: EngineAction[] = [];
  const positionOpen = st.filledQuantity > QTY_EPS;
  for (const e of st.ledger) {
    if (!e.live) continue;
    if (isEntryKind(e.kind)) {
      actions.push({ type: 'cancel', clientOrderId: e.clientOrderId, reason: 'stop_loss_invalidated' });
      e.live = false;
    } else if (e.kind === 'tp' && positionOpen) {
      actions.push({ type: 'cancel', clientOrderId: e.clientOrderId, reason: 'stop_loss_handled_close' });
      e.live = false;
    }
  }
  actions.push({ type: 'stop', reason: 'stop_loss_invalidated', riskStopped: true });
  return actions;
}

function expiryActions(st: StrategyState, ctx: StrategyContext): EngineAction[] {
  const actions: EngineAction[] = [];
  for (const e of st.ledger) {
    if (e.live && isEntryKind(e.kind)) {
      actions.push({ type: 'cancel', clientOrderId: e.clientOrderId, reason: 'max_duration_elapsed' });
      e.live = false;
    }
  }
  const remaining = remainingToPlace(st);
  if (remaining > QTY_EPS && st.constraints.allowMarketFallback === true) {
    const q = clampPlace(st, ctx, remaining, entryKind(st));
    if (q > QTY_EPS && ctx.placementEnabled) actions.push(placeAction(st, { kind: entryKind(st), type: 'market', price: null, quantity: q }, ctx.now));
    return actions;
  }
  st.phase = 'stopped';
  st.stopReason = 'max_duration_elapsed';
  actions.push({ type: 'stop', reason: 'max_duration_elapsed', riskStopped: false });
  return actions;
}

/** Risk breach policy (PRD §37): pause when the constraint says so, else resize-then-stop. */
function riskBreachActions(st: StrategyState, ctx: StrategyContext): EngineAction[] {
  const actions: EngineAction[] = [];
  const remaining = remainingToPlace(st);
  if (remaining <= QTY_EPS) return actions;
  const riskMax = riskMaxAdditional(st, ctx);
  if (riskMax === null || riskMax >= Math.min(remaining, st.stepSize)) return actions;
  if (st.constraints.cancelIfRiskExceeded === true) {
    if (!st.pauseEmitted) {
      actions.push({ type: 'pause', reason: 'risk_budget_exceeded' });
      st.pauseEmitted = true;
      st.phase = 'paused';
    }
    return actions;
  }
  st.phase = 'stopped';
  st.riskStopped = true;
  st.stopReason = 'risk_budget_exceeded';
  actions.push({ type: 'stop', reason: 'risk_budget_exceeded', riskStopped: true });
  return actions;
}

// ---------------------------------------------------------------------------
// Price guards (TWAP skip/refuse + chase sanity, PRD §28/§32)
// ---------------------------------------------------------------------------
function priceBreach(st: StrategyState, snap: MarketSnapshot): boolean {
  const c = st.constraints;
  const ref = st.side === 'buy' ? snap.ask : snap.bid;
  if (c.maxPrice !== undefined && ref > c.maxPrice) return true;
  if (c.minPrice !== undefined && ref < c.minPrice) return true;
  if (c.maxSpreadBps !== undefined && snap.spreadBps > c.maxSpreadBps) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Slice planning (TWAP / adaptive): jitter distributed then NORMALIZED so the
// floored slices + remainder-to-final sum EXACTLY to the target (PRD §28, §107).
// ---------------------------------------------------------------------------
/**
 * Plans `count` slices over `intervalMs`, with bounded jitter on the quantity
 * and (after the first slice) the interval, per PRD §28/§29.
 *
 * Two properties make this safe, and both are load-bearing:
 * - The jittered quantities are NORMALIZED back to the target before flooring,
 *   so `Σ floor8(slice) + remainder-to-final` still equals the target exactly.
 *   Randomizing without normalizing would drift the total (§107).
 * - Offsets are kept strictly increasing and clamped to the duration, so jitter
 *   can never make a slice land before the previous one or past the deadline.
 */
function planSlices(st: StrategyState, rng: Rng, count: number, intervalMs: number, qJit: number, iJit: number): SlicePlan[] {
  const base = st.targetQuantity / count;
  const raw: number[] = [];
  for (let i = 0; i < count; i++) {
    raw.push(base * (qJit > 0 ? 1 + (rand01(rng) * 2 - 1) * qJit : 1));
  }
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const norm = rawSum > 0 ? st.targetQuantity / rawSum : 1;
  const deadline = st.durationMs ?? Number.MAX_SAFE_INTEGER;
  const out: SlicePlan[] = [];
  const target = new Decimal(st.targetQuantity);
  // The remainder is computed in DECIMAL, not float. `target - acc` in binary
  // floating point lands a hair below the true remainder, and floor8 then drops
  // a whole 1e-8 step — so the last slice came up short and the strategy never
  // reached its planned quantity. Exact decimal arithmetic makes the final slice
  // absorb the rounding residue, which is what the §107 equality requires.
  let placed = new Decimal(0);
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const offsetMs = i === 0
      ? 0
      : Math.min(
          deadline,
          // The jittered offset may land before its predecessor; clamping up to
          // `previous` keeps the schedule monotonic instead of reordering it.
          Math.max(previous, i * intervalMs * (1 + (rand01(rng) * 2 - 1) * iJit)),
        );
    previous = offsetMs;
    const q = i === count - 1
      ? new Decimal(target.minus(placed)).div(QTY_GRID).floor().times(QTY_GRID).toNumber()
      : floor8(raw[i] * norm);
    placed = placed.plus(new Decimal(q));
    out.push({ quantity: q, atOffsetMs: offsetMs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// createStrategy
// ---------------------------------------------------------------------------
export function createStrategy(args: {
  executionId: string;
  plan: ExecutionPlan;
  execution: ExecutionDefinition;
  constraints: ExecutionConstraints;
  seed?: number;
}): unknown {
  const { plan, execution, constraints } = args;
  const rngState = ((args.seed ?? DEFAULT_SEED) >>> 0) || DEFAULT_SEED;
  const rng: Rng = { state: rngState };
  const st: StrategyState = {
    version: 1,
    executionId: args.executionId,
    strategy: execution.type === 'twap' || execution.type === 'adaptive_twap' ? execution.type : execution.type,
    side: plan.side,
    targetQuantity: plan.quantity,
    planPrice: execution.type === 'limit' ? execution.price : null,
    postOnly: execution.type === 'limit' ? execution.postOnly === true : false,
    stopLoss: plan.stopLoss,
    takeProfits: plan.takeProfits,
    tickSize: plan.instrument.tickSize,
    stepSize: plan.instrument.stepSize,
    contractMultiplier: plan.instrument.contractMultiplier,
    estimatedEntry: plan.estimatedEntry,
    fallbackUnitRisk: null,
    plannedRisk: plan.stopLoss !== null ? plan.risk.estimatedTotalRisk : null,
    constraints,
    durationMs: null,
    urgency: null,
    startedAt: null,
    sequence: 0,
    rng: rngState,
    phase: 'active',
    riskStopped: false,
    pauseEmitted: false,
    stopReason: null,
    filledQuantity: 0,
    averageEntry: null,
    exitFilled: 0,
    ledger: [],
    seenInCtx: {},
    riskBudgetTotal: null,
    unitRiskRate: null,
    slices: [],
    sliceIdx: 0,
    carry: 0,
    refMid: null,
    visibleQuantity: null,
    nextRefillAt: 0,
    activeChildId: null,
    lastRepriceAt: 0,
    lastBest: null,
    replacements: 0,
    maxReplacements: DEFAULT_MAX_REPLACEMENTS,
    maxChaseDistance: null,
    minReplacementIntervalMs: REPRICE_INTERVAL_MS,
    levels: [],
    levelQty: [],
    levelDone: [],
  };

  // Pessimistic per-unit risk fallback (taker + entry slippage ALWAYS charged):
  // the clamp can only under-order until the worker's authoritative rate arrives.
  if (plan.stopLoss !== null) {
    const fee = plan.feeModel.takerBps / 1e4;
    const exitFee = plan.feeModel.takerBps / 1e4;
    const slip = plan.slippageModel.slippageBps / 1e4;
    const e = plan.estimatedEntry;
    const s = plan.stopLoss;
    st.fallbackUnitRisk =
      plan.instrument.contractMultiplier *
      (Math.abs(e - s) * (1 + plan.slippageModel.safetyReservePct) + e * fee + s * exitFee + e * slip);
  }

  switch (execution.type) {
    case 'market':
      break;
    case 'limit':
      break;
    case 'twap': {
      const slices = execution.slices ?? defaultSlices(execution.durationMs);
      const interval = execution.intervalMs ?? (execution.slices !== undefined
        ? execution.durationMs / execution.slices
        : execution.durationMs / defaultSlices(execution.durationMs));
      st.durationMs = execution.durationMs;
      // Jitter comes from the user's TwapConfig (PRD §29). No config ⇒ no jitter,
      // which is the naive equal-slice schedule — never a silently random one.
      st.slices = planSlices(st, rng, slices, interval, execution.config?.quantityJitterPct ?? 0, execution.config?.intervalJitterPct ?? 0);
      break;
    }
    case 'adaptive_twap': {
      const slices = execution.slices ?? defaultSlices(execution.durationMs);
      const interval = execution.durationMs / slices;
      st.durationMs = execution.durationMs;
      st.urgency = execution.urgency;
      st.slices = planSlices(st, rng, slices, interval, execution.config?.quantityJitterPct ?? 0, execution.config?.intervalJitterPct ?? 0);
      break;
    }
    case 'iceberg':
      st.visibleQuantity = execution.visibleQuantity;
      break;
    case 'chase_limit':
      st.urgency = execution.urgency;
      st.maxReplacements = execution.maxReplacements ?? DEFAULT_MAX_REPLACEMENTS;
      st.maxChaseDistance = execution.maxChaseDistance ?? null;
      st.minReplacementIntervalMs = execution.minReplacementIntervalMs ?? REPRICE_INTERVAL_MS;
      break;
    case 'scale_in':
    case 'scale_out': {
      const levels = execution.levels;
      const sum = levels.reduce((a, l) => a + l.fraction, 0);
      if (Math.abs(sum - 1) > 1e-9) {
        st.phase = 'stopped';
        st.stopReason = 'scale_fractions_sum_not_one';
      }
      st.levels = levels;
      st.levelQty = levels.map((l) => st.targetQuantity * l.fraction);
      st.levelDone = levels.map(() => false);
      break;
    }
  }
  return st;
}
// ---------------------------------------------------------------------------
// strategyStep — one deterministic tick (PRD §67)
// ---------------------------------------------------------------------------
/**
 * Order of business. Every branch is a SAFETY gate before any placement, and
 * the gates are evaluated in severity order, not convenience order:
 *
 *  1. reconcile against the venue (the exchange is monetary truth, §41/§95);
 *  2. SL invalidation — no new entry may be planned after the stop is crossed
 *     (§115). Protective exits are worker-placed, so cancelling the TPs here is
 *     not possible; the worker's `stop` handler owns that cleanup.
 *  3. budget expiry — the last legal moment to finish the remaining quantity;
 *  4. risk breach (§36-§37) — resizing is baked into `clampPlace`, this catches
 *     the case where NO further unit fits and decides pause vs stop;
 *  5. placement for the active strategy, every quantity through `clampPlace`
 *     (§107: Σ child quantities ≤ target, reduce-only ≤ open position, and the
 *     risk-approved quantity is a hard ceiling).
 */
export function strategyStep(state: unknown, ctx: StrategyContext): { state: unknown; actions: EngineAction[] } {
  const st = asState(state);
  const actions: EngineAction[] = [];
  if (st.phase === 'completed' || st.phase === 'stopped' || st.phase === 'invalidated') {
    return { state: st, actions };
  }
  syncLedger(st, ctx);
  if (st.startedAt === null) st.startedAt = ctx.now;
  if (st.strategy === 'twap' || st.strategy === 'adaptive_twap') {
    st.refMid = ctx.snapshot.mid;
  }
  if (slInvalidated(st, ctx)) {
    return { state: st, actions: invalidationActions(st) };
  }
  // A user-paused execution stays paused: only the API's resume clears the flag
  // (st.pauseEmitted), so the engine can never auto-resume a deliberate hold.
  if (st.phase === 'paused' && st.pauseEmitted) {
    return { state: st, actions };
  }
  st.phase = 'active';
  const remaining = remainingToPlace(st);
  // A chase and an iceberg are not FINISHED while their working order is live:
  // the whole point is to keep repricing/replenishing it. Counting a fully
  // covered working order as "nothing left" completed the strategy on the very
  // next tick, so a chase could never follow the market at all. Both keep running
  // until the working order is gone, at which point `remaining` decides.
  const working = st.strategy === 'chase_limit' || st.strategy === 'iceberg';
  if (remaining <= QTY_EPS && !(working && liveEntryChild(st))) {
    st.phase = 'completed';
    actions.push({ type: 'complete' });
    return { state: st, actions };
  }
  const elapsed = ctx.now - st.startedAt;
  if (st.durationMs !== null && elapsed >= st.durationMs) {
    return { state: st, actions: expiryActions(st, ctx) };
  }
  const breach = riskBreachActions(st, ctx);
  if (breach.length > 0) {
    return { state: st, actions: breach };
  }
  if (!ctx.placementEnabled) {
    return { state: st, actions };
  }
  const rng: Rng = { state: st.rng };
  const placements = placeEntry(st, ctx, rng);
  st.rng = rng.state;
  return { state: st, actions: [...actions, ...placements] };
}
/** One strategy's placement decision for this tick, always via `clampPlace`. */
function placeEntry(st: StrategyState, ctx: StrategyContext, rng: Rng): EngineAction[] {
  const actions: EngineAction[] = [];
  const remaining = remainingToPlace(st);
  // A chase and an iceberg still have work to do with NOTHING left to place: they
  // manage a working order (reprice / replenish). Bailing out here on
  // `remaining <= 0` meant the strategy could never act on its own live child, so
  // a chase never followed the market. Only the quantity-placing strategies are
  // gated on a positive remaining.
  const managesWorkingOrder = st.strategy === 'chase_limit' || st.strategy === 'iceberg';
  if (remaining <= QTY_EPS && !managesWorkingOrder) return actions;
  switch (st.strategy) {
    case 'market': {
      const q = clampPlace(st, ctx, remaining, 'entry');
      if (q > QTY_EPS) {
        actions.push(placeAction(st, { kind: 'entry', type: 'market', price: null, quantity: q }, ctx.now));
      }
      break;
    }
    case 'limit': {
      if (st.planPrice === null || liveEntryChild(st)) break;
      const q = clampPlace(st, ctx, remaining, 'entry');
      if (q > QTY_EPS) {
        actions.push(placeAction(st, {
          kind: 'entry',
          type: 'limit',
          price: st.planPrice,
          quantity: q,
          postOnly: st.postOnly,
        }, ctx.now));
      }
      break;
    }
    case 'twap':
    case 'adaptive_twap': {
      const slice = dueSlice(st, ctx);
      if (slice === null) break;
      const qty = st.strategy === 'adaptive_twap' ? adaptSliceQty(st, ctx, slice.quantity) : slice.quantity;
      const q = clampPlace(st, ctx, qty, 'entry');
      if (q <= QTY_EPS) break;
      st.sliceIdx += 1;
      actions.push(placeAction(st, twapOrder(st, ctx, q), ctx.now));
      break;
    }
    case 'iceberg': {
      if (liveEntryChild(st)) break;
      const visible = st.visibleQuantity === null ? remaining : Math.min(st.visibleQuantity, remaining);
      const jitter = st.visibleQuantity === null ? 0 : 0.2;
      const sized = jitter > 0
        ? floor8(Math.max(st.stepSize, visible * (1 + (rand01(rng) * 2 - 1) * jitter)))
        : floor8(visible);
      const q = clampPlace(st, ctx, sized, 'entry');
      if (q > QTY_EPS) {
        st.nextRefillAt = ctx.now;
        actions.push(placeAction(st, makerOrder(st, ctx, q), ctx.now));
      }
      break;
    }
    case 'chase_limit': {
      const best = chasePrice(st, ctx);
      // The budget is spent only when it is actually EXHAUSTED: the guard must not
      // fire on the first tick (nothing has been replaced yet), or `max: 0` would
      // refuse to place the initial order outright. `lastRepriceAt !== 0` means a
      // first peg already exists, so only then does the budget apply.
      if (st.lastRepriceAt !== 0 && st.replacements >= st.maxReplacements) {
        if (st.constraints.allowMarketFallback === true) {
          const q = clampPlace(st, ctx, remaining, 'entry');
          if (q > QTY_EPS) {
            actions.push(placeAction(st, { kind: 'entry', type: 'market', price: null, quantity: q }, ctx.now));
          }
        } else {
          st.phase = 'stopped';
          st.stopReason = 'chase_replacement_budget_exhausted';
          actions.push({ type: 'stop', reason: 'chase_replacement_budget_exhausted', riskStopped: false });
        }
        break;
      }
      if (priceBreach(st, ctx.snapshot)) {
        break; // refuse to chase outside the user's price band (§32 controls)
      }
      // Reprice when the touch has MOVED away from our peg (PRD §32). Comparing
      // against the peg we last used — not against a plan price — is what makes
      // "bid 100 → 100.2 ⇒ cancel/replace" work, and stopping after the
      // replacement budget stops the strategy burning fees on a runaway market.
      if (liveEntryChild(st)) {
        if (
          best !== null
          && st.lastBest !== null
          && Math.abs(best - st.lastBest) >= st.tickSize
          && ctx.now - st.lastRepriceAt >= st.minReplacementIntervalMs
        ) {
          // PRD §32 is cancel-then-replace. Placing the replacement WITHOUT first
          // cancelling the live child left BOTH orders working the same position —
          // a silent over-order path that §107 and §128.15 forbid. The cancel is
          // emitted first and the replacement waits for the next tick, once the
          // venue has acknowledged the cancel.
          const live = liveEntryOrder(st);
          if (live !== null) {
            actions.push({ type: 'cancel', clientOrderId: live.clientOrderId, reason: 'chase_reprice' });
          }
        }
        break;
      }
      if (st.lastRepriceAt !== 0 && ctx.now - st.lastRepriceAt < st.minReplacementIntervalMs) break;
      const q = clampPlace(st, ctx, remaining, 'entry');
      if (q > QTY_EPS) {
        actions.push(placeAction(st, makerOrder(st, ctx, q), ctx.now));
        // The FIRST order is not a replacement. Counting it made `maxReplacements:
        // 1` yield zero repricings, so the budget the user set was off by one and
        // a max of 0 refused to trade at all. `replacements` counts only the
        // cancel/replace cycles PRD §32 describes.
        if (st.lastRepriceAt !== 0) st.replacements += 1;
        st.lastRepriceAt = ctx.now;
        st.lastBest = best;
      }
      break;
    }
    case 'scale_in':
    case 'scale_out': {
      for (let i = 0; i < st.levels.length; i++) {
        if (st.levelDone[i]) continue;
        const level = st.levels[i];
        const price = roundTick(st, level.price);
        const marketable = st.side === 'buy' ? price >= ctx.snapshot.ask : price <= ctx.snapshot.bid;
        if (!marketable) continue;
        st.levelDone[i] = true;
        const q = clampPlace(st, ctx, st.levelQty[i], entryKind(st));
        if (q > QTY_EPS) {
          actions.push(placeAction(st, {
            kind: entryKind(st),
            type: 'limit',
            price,
            quantity: q,
            timeInForce: 'IOC',
          }, ctx.now));
        }
        break; // one level per tick keeps the pace predictable
      }
      break;
    }
  }
  return actions;
}
/** Minimum spacing between chase replacements (§32): no fee-burning hot loop. */
const REPRICE_INTERVAL_MS = 1_000;
/** A live, unfilled child on the primary side blocks stacking more of the same. */
function liveEntryChild(st: StrategyState): boolean {
  return st.ledger.some((e) => e.live && isEntryKind(e.kind) && e.quantity - e.filled > QTY_EPS);
}

/** The live entry child a reprice must cancel first, or `null` if none is working. */
function liveEntryOrder(st: StrategyState): { clientOrderId: string } | null {
  const live = st.ledger.find((e) => e.live && isEntryKind(e.kind) && e.quantity - e.filled > QTY_EPS);
  return live === undefined ? null : { clientOrderId: live.clientOrderId };
}
/**
 * Chase peg: passive rests on the touch, aggressive crosses it (§32/§35).
 *
 * `maxChaseDistance` bounds how far the peg may travel from the ARRIVAL price
 * (the plan's reference). A runaway market must not drag the order with it: past
 * the limit the peg is held, so the strategy keeps working the original level
 * instead of chasing a price the user never agreed to.
 */
function chasePrice(st: StrategyState, ctx: StrategyContext): number | null {
  const passive = st.urgency === 'passive' || st.constraints.makerOnly === true;
  const ref = passive
    ? (st.side === 'buy' ? ctx.snapshot.bid : ctx.snapshot.ask)
    : (st.side === 'buy' ? ctx.snapshot.ask : ctx.snapshot.bid);
  const pegged = roundTick(st, ref);
  if (st.maxChaseDistance === null) return pegged;
  const limit = st.estimatedEntry;
  // A buy may not travel more than the limit above arrival, a sell no more below.
  const capped = st.side === 'buy'
    ? Math.min(pegged, limit + st.maxChaseDistance)
    : Math.max(pegged, limit - st.maxChaseDistance);
  return roundTick(st, capped);
}
function makerOrder(st: StrategyState, ctx: StrategyContext, quantity: number): {
  kind: ChildKind;
  type: PlannedChildOrder['type'];
  price: number | null;
  quantity: number;
  postOnly: boolean;
} {
  const price = chasePrice(st, ctx);
  const passive = st.urgency === 'passive' || st.constraints.makerOnly === true;
  return { kind: 'entry', type: 'limit', price, quantity, postOnly: passive };
}
function twapOrder(st: StrategyState, ctx: StrategyContext, quantity: number): {
  kind: ChildKind;
  type: PlannedChildOrder['type'];
  price: number | null;
  quantity: number;
  postOnly: boolean;
} {
  const c = st.constraints;
  const aggressive = st.strategy === 'adaptive_twap' && st.urgency !== null && st.urgency !== 'passive';
  if (c.makerOnly === true || (st.urgency === 'passive' && aggressive === false)) {
    return makerOrder(st, ctx, quantity);
  }
  if (st.urgency === 'aggressive' || st.urgency === 'immediate') {
    return { kind: 'entry', type: 'market', price: null, quantity, postOnly: false };
  }
  const ref = st.side === 'buy' ? ctx.snapshot.ask : ctx.snapshot.bid;
  return { kind: 'entry', type: 'limit', price: roundTick(st, ref), quantity, postOnly: false };
}
/** The next slice whose scheduled offset has arrived (PRD §28). */
function dueSlice(st: StrategyState, ctx: StrategyContext): SlicePlan | null {
  const start = st.startedAt ?? ctx.now;
  if (st.sliceIdx < st.slices.length && start + st.slices[st.sliceIdx].atOffsetMs <= ctx.now) {
    return st.slices[st.sliceIdx];
  }
  return null;
}
/**
 * Adaptive sizing (PRD §30): a wide spread or an adverse price drift makes the
 * slice SMALLER, favourable momentum or a schedule deficit makes it LARGER —
 * and `clampPlace` still has the final say on risk, so a bigger slice can never
 * breach the budget.
 */
function adaptSliceQty(st: StrategyState, ctx: StrategyContext, base: number): number {
  let factor = 1;
  const refSpreadBps = 5;
  if (ctx.snapshot.spreadBps > refSpreadBps) {
    factor *= Math.max(0.25, 1 - (ctx.snapshot.spreadBps - refSpreadBps) / 100);
  }
  const drift = st.refMid === null || st.refMid <= 0
    ? 0
    : ((ctx.snapshot.mid - st.refMid) / st.refMid) * (st.side === 'buy' ? 1 : -1);
  if (drift > 0) factor *= Math.min(1.5, 1 + drift * 10);
  else if (drift < 0) factor *= Math.max(0.5, 1 + drift * 5);
  const start = st.startedAt ?? ctx.now;
  if (st.durationMs !== null && st.durationMs > 0) {
    const scheduled = st.sliceIdx / Math.max(1, st.slices.length);
    const actual = Math.min(1, (ctx.now - start) / st.durationMs);
    if (actual > scheduled) factor *= Math.min(1.5, 1 + (actual - scheduled));
  }
  return floor8(base * factor);
}
function roundTick(st: StrategyState, price: number): number {
  if (!(st.tickSize > 0)) return price;
  return new Decimal(price).div(st.tickSize).round().times(st.tickSize).toNumber();
}
// ---------------------------------------------------------------------------
// strategyOnFill — dynamic risk reconciliation (PRD §36)
// ---------------------------------------------------------------------------
/**
 * A fill changes the truth: the average entry moves, the projected risk moves,
 * and the remaining execution is resized. The worker's authoritative
 * `maxSafeQuantity` arrives in the NEXT context, so this call only does what a
 * fill alone can prove: re-weight the average, keep the ledger exact, and
 * recompute the pessimistic per-unit risk rate the clamp uses. Placement happens
 * in the following `strategyStep` (the worker always steps after ingesting).
 */
export function strategyOnFill(state: unknown, fill: FillView): { state: unknown; actions: EngineAction[] } {
  const st = asState(state);
  const entry = fill.clientOrderId === null
    ? undefined
    : st.ledger.find((e) => e.clientOrderId === fill.clientOrderId);
  if (entry !== undefined) {
    entry.filled = round8(Math.min(entry.quantity, entry.filled + fill.quantity));
    if (entry.filled >= entry.quantity - QTY_EPS) entry.live = false;
  }
  if (entry === undefined || isEntryKind(entry.kind)) {
    const qty = round8(st.filledQuantity + fill.quantity);
    st.filledQuantity = Math.min(st.targetQuantity, qty);
    st.averageEntry = st.averageEntry === null
      ? fill.price
      : round8((st.averageEntry * (qty - fill.quantity) + fill.price * fill.quantity) / (qty || 1));
  } else {
    st.exitFilled = round8(st.exitFilled + fill.quantity);
  }
  if (st.strategy === 'scale_out' && st.exitFilled >= st.targetQuantity - QTY_EPS) {
    st.phase = 'completed';
    return { state: st, actions: [{ type: 'complete' }] };
  }
  return { state: st, actions: [] };
}
// ---------------------------------------------------------------------------
// strategyProgress — the active-execution screen (PRD §85-§86)
// ---------------------------------------------------------------------------
export function strategyProgress(state: unknown, ctx: StrategyContext): StrategyProgress {
  const st = asState(state);
  const filled = st.strategy === 'scale_out' ? st.exitFilled : st.filledQuantity;
  const remainingQuantity = round8(Math.max(0, st.targetQuantity - filled));
  const start = st.startedAt ?? ctx.now;
  const elapsedPct = st.durationMs === null || st.durationMs <= 0
    ? (filled >= st.targetQuantity - QTY_EPS ? 1 : 0)
    : Math.min(1, Math.max(0, (ctx.now - start) / st.durationMs));
  return {
    strategy: st.strategy,
    completionPct: st.targetQuantity <= 0 ? 1 : Math.min(1, Math.max(0, filled / st.targetQuantity)),
    elapsedPct,
    plannedQuantity: st.targetQuantity,
    filledQuantity: filled,
    remainingQuantity,
    averageEntry: st.averageEntry,
    plannedRisk: st.plannedRisk,
    projectedRisk: ctx.projectedRisk === null ? null : ctx.projectedRisk.totalRisk,
    remainingRiskBudget: ctx.remainingRiskBudget,
  };
}


export const executionEngine: ExecutionEngineApi = {
  createStrategy,
  strategyStep,
  strategyOnFill,
  strategyProgress,
  transitionChildOrder,
};
