/**
 * worker.ts — the Execution Worker (PRD §64-68, §93-96, §113-115, §127).
 *
 * The runtime orchestrator: it owns every RUNNING execution through a Valkey
 * lease (§65), drives the strategy engine one deterministic tick at a time,
 * treats the EXCHANGE as monetary truth (§41/§95) by reconciling before acting,
 * and enforces the hard safety rules of the product:
 *
 *  1. Over-order protection (§107/§128.15): no combination of engine actions,
 *     partial fills, or retry races may place more than the risk-approved
 *     quantity. The clamp lives HERE on top of the engine's own — belt and
 *     braces, because a duplicated order is real money.
 *  2. Hard risk constraint (§37/§117): when projected risk would exceed the
 *     budget the worker resizes (RESIZE_THEN_STOP default) and stops with
 *     RISK_STOPPED — it never silently violates the user's bound.
 *
 * Lifecycle ownership: the API writes intents (status + start/cancel flags);
 * the worker performs them. A tick NEVER trusts local state over the venue: it
 * reconciles orders/fills/positions first. Crash recovery (§114) is the same
 * code path with placements disabled: `recover()` = reconcile-everything once,
 * then let ticks resume — never blindly continue from stale local state.
 *
 * Protective exits (§39-40): native reduce-only stops preferred (SYNTHETIC OCO
 * on top: TP fill cancels SL, SL fill cancels TP, remaining exit quantity ==
 * remaining open position). Exit child ids are STABLE (derived from leg kind +
 * level), so re-syncing after a crash can never spawn a second protective stop.
 *
 * All risk figures come from the execution's immutable plan snapshot (§56/§99):
 * its instrument grid, fee model and slippage model. Nothing here invents
 * defaults — a missing plan is a FAILED execution, not a guessed one.
 *
 * The kill switch (§108): LIVE placement requires `FUDCOURT_EXECUTOR_LIVE=1`.
 * Off ⇒ live executions PAUSE at the placement boundary (recoverable by the
 * operator flipping the switch and resuming) — fail-closed, never fail-open.
 */
import {
  canTransition,
  clientOrderId as makeClientOrderId,
  type ChildOrderEvent,
  type ChildOrderRecord,
  type ChildOrderStatus,
  type ChildOrderView,
  type EngineAction,
  type ExecutionEventName,
  type ExecutionLock,
  type ExecutionPlan,
  type ExecutionRecord,
  type ExecutionStatus,
  type ExecutorStore,
  type ExecutorWorkerApi,
  type ExchangeAdapter,
  type FillRecord,
  type FillView,
  type MarketSnapshot,
  type NormalizedOrder,
  type Order,
  type PlannedChildOrder,
  type Position,
  type RiskBreakdown,
  type StrategyContext,
  type Ticker,
} from '@/platform/executor/types';
import { projectedRisk } from '@/platform/executor/risk';
import { createStrategy, strategyOnFill, strategyProgress, strategyStep, transitionChildOrder } from '@/platform/executor/engine';
import { mapError, PaperExchangeAdapter } from '@/platform/executor/exchange';

/** Lease and cadence defaults (§65/§67). */
const LOCK_TTL_MS = 30_000;
const TICK_INTERVAL_MS = 2_000;

/** Execution statuses the worker actively drives (§57). */
const ACTIVE_STATUSES: readonly ExecutionStatus[] = ['RUNNING', 'PARTIALLY_FILLED', 'RECONCILING'];

const TERMINAL_STATUSES: readonly ExecutionStatus[] = ['FILLED', 'CANCELLED', 'FAILED', 'RISK_STOPPED', 'EXPIRED', 'STOPPED'];

/**
 * Stable sequence numbers for protective exit legs (§39-40, §66). Derived from
 * the leg kind and TP index ONLY — never from a timestamp or counter — so a
 * crash/re-sync recomputes the same `fud_{executionId}_{sequence}` and the
 * existence check below can never place a duplicate protective order.
 */
const EXIT_SEQ_STOP = 900;
const EXIT_SEQ_TP_BASE = 910;

export interface WorkerDeps {
  store: ExecutorStore;
  lock: ExecutionLock;
  workerId: string;
  /** Test seam: a fixed clock makes every tick deterministic. */
  now?: () => number;
  /** Test seam: false = tests drive `tick()` directly, no setInterval. */
  autoTick?: boolean;
  tickIntervalMs?: number;
}

export function createWorker(deps: WorkerDeps): ExecutorWorkerApi {
  const { store, lock, workerId } = deps;
  const now = deps.now ?? (() => Date.now());
  const tickIntervalMs = deps.tickIntervalMs ?? TICK_INTERVAL_MS;
  let stopTicker: (() => void) | null = null;
  let ticking = false;

  async function runPass(placementEnabled: boolean): Promise<void> {
    if (ticking) return; // never overlap passes — a slow venue call must not double-drive.
    ticking = true;
    try {
      const running = await store.listRunningExecutions();
      for (const execution of running) {
        if (!ACTIVE_STATUSES.includes(execution.status)) continue;
        const acquired = await lock.acquire(execution.id, workerId, LOCK_TTL_MS);
        if (!acquired) continue; // another worker owns it (§65) — never race.
        try {
          await driveExecution(execution, placementEnabled);
        } catch (err) {
          // A tick failure must never lose the venue-truth obligation: record it
          // and leave the execution to the next pass (reconcile-first is safe).
          await safeEvent(execution.id, 'EXECUTION_FAILED', {
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await lock.release(execution.id, workerId);
        }
      }
    } finally {
      ticking = false;
    }
  }

  async function driveExecution(execution: ExecutionRecord, placementEnabled: boolean): Promise<void> {
    const t = now();
    if (TERMINAL_STATUSES.includes(execution.status)) return;

    const plan = await store.getExecutionPlan(execution.id);
    if (!plan) {
      // §99 made the plan immutable and mandatory: without it there is no
      // instrument grid, no fee model — nothing honest to size against.
      await transitionExecution(execution, 'FAILED', t);
      await safeEvent(execution.id, 'EXECUTION_FAILED', { reason: 'execution plan snapshot missing (PRD §99)' });
      return;
    }
    const adapter = await adapterFor(execution);

    // ---- 1. venue truth first (§41/§95) -----------------------------------
    const venueOrders = await safeCall(store, () => adapter.getOpenOrders(execution.symbol), execution, 'getOpenOrders');
    if (venueOrders === null) return; // degraded: no new children this pass (§76).
    const venueFills = (await safeCall(store, () => adapter.getFills?.(execution.symbol) ?? Promise.resolve([]), execution, 'getFills')) ?? [];
    const venuePositions = (await safeCall(store, () => adapter.getPositions(), execution, 'getPositions')) ?? [];

    const children = await store.listChildOrders(execution.id);
    await reconcileOrders(execution, children, venueOrders, t);
    const ingested = await ingestFills(execution, venueFills, t);
    const openPosition = openPositionQuantity(venuePositions, execution);

    // ---- 2. risk recalculation (§36) --------------------------------------
    const fills = await store.listFills(execution.id);
    const { filledQuantity, averageEntry, actualFees } = summarizeFills(fills);
    const stop = plan.stopLoss;
    let currentRisk: RiskBreakdown | null = null;
    if (stop !== null && filledQuantity > 0 && averageEntry !== null) {
      currentRisk = projectedRisk({
        side: execution.side,
        averageEntry,
        quantity: filledQuantity,
        stop,
        feeModel: plan.feeModel,
        slippageModel: plan.slippageModel,
        instrument: plan.instrument,
      });
    }
    const budget = plan.risk.budget;
    const remainingRiskBudget = budget === null ? null : Math.max(0, budget - (currentRisk?.totalRisk ?? 0));

    await store.updateExecutionProgress(execution.id, {
      actualQuantity: filledQuantity,
      actualNotional: filledQuantity * (averageEntry ?? 0),
      averageFillPrice: averageEntry,
      actualFees,
      currentRisk: currentRisk?.totalRisk ?? null,
    });
    if (ingested.length > 0) {
      await safeEvent(execution.id, 'RISK_RECALCULATED', {
        filledQuantity,
        averageEntry,
        projectedRisk: currentRisk?.totalRisk ?? null,
        remainingRiskBudget,
      });
    }

    // ---- 3. strategy context ---------------------------------------------
    const snapshot = await fetchSnapshot(adapter, execution.symbol, t);
    const openChildren = await store.listChildOrders(execution.id);
    const ctx: StrategyContext = {
      now: t,
      snapshot,
      filledQuantity,
      averageEntry,
      projectedRisk: currentRisk,
      remainingRiskBudget,
      openChildOrders: openChildren.map(toChildView),
      openPositionQuantity: openPosition,
      constraints: execution.constraints,
      // The engine must not PLAN a child the worker would drop: a planned leg
      // the venue never saw would keep the over-order clamp room busy forever.
      placementEnabled,
    };

    // ---- 4. fill-driven resize, then one deterministic step (§36-37) ------
    let state = execution.strategyState ?? createStrategy({
      executionId: execution.id,
      plan,
      execution: execution.executionConfig,
      constraints: execution.constraints,
    });

    for (const view of ingested) {
      const stepped = strategyOnFill(state, view);
      state = stepped.state;
      if (!(await runActions(execution, stepped.actions, t, plan, placementEnabled))) return;
    }

    if (execution.status === 'CANCEL_REQUESTED') {
      await cancelEntryAndFinish(execution, adapter, t);
      return;
    }

    const stepped = strategyStep(state, ctx);
    state = stepped.state;
    if (!(await runActions(execution, stepped.actions, t, plan, placementEnabled))) return;

    // ---- 5. protective exits (§39-40) ------------------------------------
    await syncProtectiveExits(execution, adapter, plan, ctx, t, placementEnabled);

    // ---- 6. persist state (§130) -----------------------------------------
    await store.updateExecutionStrategyState(execution.id, state);
    const progress = strategyProgress(state, ctx);
    const after = await store.listChildOrders(execution.id);
    const anyFilled = after.some((c) => c.filledQuantity > 0);
    const entryDone = after.filter((c) => !c.isExit).every((c) => isTerminalChild(c.status));
    if (anyFilled && !entryDone && execution.status === 'RUNNING') {
      await transitionExecution(execution, 'PARTIALLY_FILLED', t);
    }
    if (progress.completionPct >= 1 && !entryDone) {
      // Engine believes it is done but children linger: nothing more to place.
      await cancelEntryAndFinish(execution, adapter, t, 'FILLED');
    }
  }

  /**
   * Execute engine actions against the venue with the hard clamps (§107).
   * Returns false when the execution reached a terminal/paused state and the
   * caller must stop this pass immediately.
   */
  async function runActions(
    execution: ExecutionRecord,
    actions: EngineAction[],
    t: number,
    plan: ExecutionPlan,
    placementEnabled: boolean,
  ): Promise<boolean> {
    const adapter = await adapterFor(execution);
    for (const action of actions) {
      switch (action.type) {
        case 'place': {
          if (!placementEnabled) break; // recovery reconciles first; resume places next tick (§114).
          const children = await store.listChildOrders(execution.id);
          const fills = await store.listFills(execution.id);
          const { filledQuantity } = summarizeFills(fills);
          const planned = clampChild(execution, action.order, children, filledQuantity, plan.instrument);
          if (planned === null) break; // clamp removed it: nothing legal left to send.
          if (planned.quantity < action.order.quantity) {
            await safeEvent(execution.id, 'PLAN_RESIZED', {
              clientOrderId: planned.clientOrderId,
              requested: action.order.quantity,
              clamped: planned.quantity,
            });
          }
          if (liveBlocked(execution)) {
            await transitionExecution(execution, 'PAUSED', t);
            await safeEvent(execution.id, 'EXECUTION_PAUSED', {
              reason: 'live trading disabled: FUDCOURT_EXECUTOR_LIVE is not 1 (kill switch, PRD §108)',
            });
            return false;
          }
          await store.insertChildOrder({
            executionId: execution.id,
            exchangeOrderId: null,
            clientOrderId: planned.clientOrderId,
            symbol: execution.symbol,
            side: planned.side,
            type: planned.type === 'stop_market' ? 'stop_market' : planned.type,
            price: planned.price,
            quantity: planned.quantity,
            filledQuantity: 0,
            status: 'SUBMITTING',
            isExit: planned.isExit,
            submittedAt: t,
            updatedAt: t,
            filledAt: null,
          });
          try {
            const result = await adapter.placeOrder(toNormalizedOrder(execution, planned));
            await store.updateChildOrder(execution.id, planned.clientOrderId, {
              exchangeOrderId: result.orderId,
              status: result.status === 'FILLED' ? 'FILLED' : result.filledQuantity > 0 ? 'PARTIAL' : 'OPEN',
              filledQuantity: result.filledQuantity,
              updatedAt: t,
            });
            await safeEvent(execution.id, 'ORDER_SUBMITTED', {
              clientOrderId: planned.clientOrderId,
              orderId: result.orderId,
              quantity: planned.quantity,
              price: planned.price,
              stopPrice: planned.stopPrice,
            });
          } catch (err) {
            const mapped = mapError(err);
            if (mapped.retryable) {
              // The venue may have taken the order before the network broke: the
              // client order id makes the retry idempotent (§66); reconcile owns
              // the truth. Leave it SUBMITTING and let the next pass adopt/correct.
              await safeEvent(execution.id, 'ORDER_SUBMITTED', {
                clientOrderId: planned.clientOrderId,
                deferred: true,
                category: mapped.category,
              });
            } else {
              await store.updateChildOrder(execution.id, planned.clientOrderId, {
                status: 'REJECTED',
                updatedAt: t,
              });
              await safeEvent(execution.id, 'ORDER_REJECTED', {
                clientOrderId: planned.clientOrderId,
                category: mapped.category,
                message: mapped.message,
              });
              if (mapped.category === 'insufficient_balance' || mapped.category === 'permission_error') {
                await transitionExecution(execution, 'PAUSED', t);
                await safeEvent(execution.id, 'EXECUTION_PAUSED', { reason: mapped.message });
                return false;
              }
            }
          }
          break;
        }
        case 'cancel': {
          const children = await store.listChildOrders(execution.id);
          const target = children.find((c) => c.clientOrderId === action.clientOrderId);
          if (target && !isTerminalChild(target.status)) await cancelChild(execution, adapter, target, t);
          break;
        }
        case 'replace': {
          const children = await store.listChildOrders(execution.id);
          const target = children.find((c) => c.clientOrderId === action.clientOrderId);
          if (target && !isTerminalChild(target.status)) await cancelChild(execution, adapter, target, t);
          if (!placementEnabled) break;
          const fills = await store.listFills(execution.id);
          const { filledQuantity } = summarizeFills(fills);
          const all = await store.listChildOrders(execution.id);
          const planned = clampChild(execution, action.order, all, filledQuantity, plan.instrument);
          if (planned === null || liveBlocked(execution)) break;
          await store.insertChildOrder({
            executionId: execution.id,
            exchangeOrderId: null,
            clientOrderId: planned.clientOrderId,
            symbol: execution.symbol,
            side: planned.side,
            type: planned.type === 'stop_market' ? 'stop_market' : planned.type,
            price: planned.price,
            quantity: planned.quantity,
            filledQuantity: 0,
            status: 'SUBMITTING',
            isExit: planned.isExit,
            submittedAt: t,
            updatedAt: t,
            filledAt: null,
          });
          try {
            const result = await adapter.placeOrder(toNormalizedOrder(execution, planned));
            await store.updateChildOrder(execution.id, planned.clientOrderId, {
              exchangeOrderId: result.orderId,
              status: 'OPEN',
              updatedAt: t,
            });
            await safeEvent(execution.id, 'ORDER_SUBMITTED', {
              clientOrderId: planned.clientOrderId,
              orderId: result.orderId,
              replaced: action.clientOrderId,
              reason: action.reason,
            });
          } catch (err) {
            const mapped = mapError(err);
            if (!mapped.retryable) {
              await store.updateChildOrder(execution.id, planned.clientOrderId, { status: 'REJECTED', updatedAt: t });
            }
          }
          break;
        }
        case 'wait':
          break; // cadence is the engine's; the next tick provides the time base.
        case 'pause':
          await transitionExecution(execution, 'PAUSED', t);
          await safeEvent(execution.id, 'EXECUTION_PAUSED', { reason: action.reason });
          return false;
        case 'stop': {
          await cancelEntryAndFinish(execution, adapter, t, action.riskStopped ? 'RISK_STOPPED' : 'STOPPED', action.reason);
          return false;
        }
        case 'complete': {
          await cancelEntryAndFinish(execution, adapter, t, 'FILLED', 'target quantity filled');
          return false;
        }
      }
    }
    return true;
  }

  // ---- venue reconciliation (§41, §114) ----------------------------------

  async function reconcileOrders(
    execution: ExecutionRecord,
    children: ChildOrderRecord[],
    venueOrders: Order[],
    t: number,
  ): Promise<void> {
    for (const child of children) {
      const venue = venueOrders.find((o) => o.orderId === child.exchangeOrderId)
        ?? venueOrders.find((o) => o.clientOrderId === child.clientOrderId);
      if (!venue) {
        // SUBMITTING with no venue row can still be in flight — leave it; anything
        // else vanished (externally cancelled or filled+aged out) → UNKNOWN + the
        // external-change event, and fill ingestion decides the truth (§94).
        if (!isTerminalChild(child.status) && child.status !== 'SUBMITTING') {
          await store.updateChildOrder(execution.id, child.clientOrderId, {
            status: safeChildTransition(child.status, 'unknown'),
            updatedAt: t,
          });
          await safeEvent(execution.id, 'EXTERNAL_STATE_CHANGE', {
            clientOrderId: child.clientOrderId,
            detail: 'child order no longer open on the venue',
          });
        }
        continue;
      }
      if (venue.status !== child.status || venue.filledQuantity !== child.filledQuantity) {
        await store.updateChildOrder(execution.id, child.clientOrderId, {
          status: safeChildTransition(child.status, childEventFor(venue.status)),
          filledQuantity: Math.max(child.filledQuantity, venue.filledQuantity),
          exchangeOrderId: venue.orderId,
          updatedAt: t,
        });
      }
    }
    // Crash-window adoption (§114): venue orders WE placed (our client id
    // prefix) but never recorded locally. Same stable id space, so a retry
    // that DID reach the venue is adopted here instead of re-placed.
    for (const o of venueOrders) {
      if (!o.clientOrderId?.startsWith(`fud_${execution.id}_`)) continue;
      if (children.some((c) => c.clientOrderId === o.clientOrderId)) continue;
      await store.insertChildOrder({
        executionId: execution.id,
        exchangeOrderId: o.orderId,
        clientOrderId: o.clientOrderId,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        price: o.price,
        quantity: o.quantity,
        filledQuantity: o.filledQuantity,
        status: o.status,
        isExit: o.reduceOnly,
        submittedAt: o.createdAt,
        updatedAt: t,
        filledAt: o.status === 'FILLED' ? o.updatedAt : null,
      });
      await safeEvent(execution.id, 'ORDER_SUBMITTED', {
        clientOrderId: o.clientOrderId,
        adopted: true,
        orderId: o.orderId,
      });
    }
  }

  /** Idempotent fill ingestion (§62): (account, exchange_trade_id) is the key. */
  async function ingestFills(
    execution: ExecutionRecord,
    venueFills: { tradeId: string; orderId: string; clientOrderId: string | null; price: number; quantity: number; quoteQuantity: number; fee: number; feeAsset: string; timestamp: number }[],
    t: number,
  ): Promise<FillView[]> {
    const fresh: FillView[] = [];
    for (const f of venueFills) {
      const child = (await store.listChildOrders(execution.id)).find(
        (c) => c.clientOrderId === f.clientOrderId || c.exchangeOrderId === f.orderId,
      );
      const inserted = await store.insertFill({
        executionId: execution.id,
        childOrderId: child?.id ?? null,
        exchangeTradeId: f.tradeId,
        price: f.price,
        quantity: f.quantity,
        quoteQuantity: f.quoteQuantity,
        fee: f.fee,
        feeAsset: f.feeAsset,
        timestamp: f.timestamp,
      });
      if (inserted === null) continue; // duplicate event (§113) — never double-count.
      fresh.push({
        tradeId: f.tradeId,
        clientOrderId: f.clientOrderId,
        price: f.price,
        quantity: f.quantity,
        quoteQuantity: f.quoteQuantity,
        fee: f.fee,
        feeAsset: f.feeAsset,
        timestamp: f.timestamp,
      });
      if (child) {
        const filled = child.filledQuantity + f.quantity;
        await store.updateChildOrder(execution.id, child.clientOrderId, {
          filledQuantity: filled,
          status: filled >= child.quantity ? 'FILLED' : 'PARTIAL',
          filledAt: filled >= child.quantity ? t : null,
          updatedAt: t,
        });
        await safeEvent(execution.id, filled >= child.quantity ? 'ORDER_FILLED' : 'ORDER_PARTIALLY_FILLED', {
          tradeId: f.tradeId,
          clientOrderId: child.clientOrderId,
          price: f.price,
          quantity: f.quantity,
        });
      }
    }
    return fresh;
  }

  /**
   * Synthetic OCO + protective stops (§39-40).
   *
   * Exit quantity invariant (§40, "remaining exit quantity == remaining open
   * position") is enforced WHERE IT IS ENFORCEABLE — at the venue, by placing
   * every protective leg `reduceOnly` with quantity covering the FULL planned
   * entry: a reduce-only order can never close more than the position actually
   * open, in either direction (this is exactly what the flag means). That gives
   * the invariant for free through entry growth, partial TPs and manual closes
   * without a cancel/replace storm — every replace is a duplicate-order window
   * (§66), which is the dangerous thing this design avoids.
   *
   * Synthetic OCO (§40): the losing legs' remainders are cancelled once the
   * position is flat — a TP that closed it cancels the SL, an SL that closed it
   * cancels the TPs. A PARTIAL TP fill deliberately keeps the SL: it still
   * protects the remainder (stricter than the literal rule, and the safe read
   * of it). Leg ids are stable (kind + TP index), so re-sync after a crash can
   * never spawn a second protective stop; a leg the user or emergency stop
   * cancelled STAYS cancelled until the execution is resumed from a fresh state.
   */
  async function syncProtectiveExits(
    execution: ExecutionRecord,
    adapter: ExchangeAdapter,
    plan: ExecutionPlan,
    ctx: StrategyContext,
    t: number,
    placementEnabled: boolean,
  ): Promise<void> {
    if (execution.intent !== 'open') return;
    const stop = plan.stopLoss;
    const tps = plan.takeProfits ?? [];
    if (stop === null && tps.length === 0) return;

    const children = await store.listChildOrders(execution.id);
    const openExits = children.filter((c) => c.isExit && !isTerminalChild(c.status));

    if (ctx.openPositionQuantity <= 0) {
      // Position flat (TP closed it, SL closed it, or closed manually): the OCO
      // cleanup half — every exit leg remainder is cancelled so no reduce-only
      // order lingers to be rejected later (§40).
      for (const exit of openExits) await cancelChild(execution, adapter, exit, t);
      return;
    }

    const exitSide = execution.side === 'buy' ? 'sell' : 'buy';
    const legs: PlannedChildOrder[] = [];
    if (stop !== null) {
      legs.push({
        clientOrderId: makeClientOrderId(execution.id, EXIT_SEQ_STOP),
        side: exitSide,
        type: 'stop_market',
        price: null,
        stopPrice: stop,
        quantity: plan.quantity,
        timeInForce: 'GTC',
        postOnly: false,
        reduceOnly: true,
        isExit: true,
      });
    }
    tps.forEach((tp, i) => {
      legs.push({
        clientOrderId: makeClientOrderId(execution.id, EXIT_SEQ_TP_BASE + i),
        side: exitSide,
        type: 'limit',
        price: tp.price,
        stopPrice: null,
        quantity: plan.quantity * (tp.fraction ?? 1),
        timeInForce: 'GTC',
        postOnly: false,
        reduceOnly: true,
        isExit: true,
      });
    });

    for (const leg of legs) {
      if (children.some((c) => c.clientOrderId === leg.clientOrderId)) continue; // stable id: exists ⇒ handled.
      if (liveBlocked(execution)) return; // paused state is already the message.
      await store.insertChildOrder({
        executionId: execution.id,
        exchangeOrderId: null,
        clientOrderId: leg.clientOrderId,
        symbol: execution.symbol,
        side: leg.side,
        type: leg.type,
        price: leg.price,
        quantity: leg.quantity,
        filledQuantity: 0,
        status: 'SUBMITTING',
        isExit: true,
        submittedAt: t,
        updatedAt: t,
        filledAt: null,
      });
      try {
        const result = await adapter.placeOrder(toNormalizedOrder(execution, leg));
        await store.updateChildOrder(execution.id, leg.clientOrderId, {
          exchangeOrderId: result.orderId,
          status: 'OPEN',
          updatedAt: t,
        });
        await safeEvent(execution.id, 'ORDER_SUBMITTED', {
          clientOrderId: leg.clientOrderId,
          protective: true,
          quantity: leg.quantity,
          stopPrice: leg.stopPrice,
          price: leg.price,
        });
      } catch (err) {
        const mapped = mapError(err);
        await store.updateChildOrder(execution.id, leg.clientOrderId, {
          status: mapped.retryable ? 'SUBMITTING' : 'REJECTED',
          updatedAt: t,
        });
        await safeEvent(execution.id, 'ORDER_REJECTED', {
          clientOrderId: leg.clientOrderId,
          protective: true,
          category: mapped.category,
          message: mapped.message,
        });
        // A position without its protective stop is the dangerous state (§39
        // prefers native stops for exactly this): pause rather than run naked.
        if (!mapped.retryable && leg.type === 'stop_market') {
          await transitionExecution(execution, 'PAUSED', t);
          await safeEvent(execution.id, 'EXECUTION_PAUSED', {
            reason: `protective stop could not be placed: ${mapped.message}`,
          });
          return;
        }
      }
    }
  }

  // ---- small orchestration helpers ---------------------------------------

  /** Cancel entry children and land the execution in `to` (§57/§115). */
  async function cancelEntryAndFinish(
    execution: ExecutionRecord,
    adapter: ExchangeAdapter,
    t: number,
    to: ExecutionStatus = 'CANCELLED',
    reason?: string,
  ): Promise<void> {
    const children = await store.listChildOrders(execution.id);
    for (const child of children) {
      if (!child.isExit && !isTerminalChild(child.status)) await cancelChild(execution, adapter, child, t);
    }
    await transitionExecution(execution, to, t);
    await safeEvent(execution.id, to === 'CANCELLED' ? 'EXECUTION_CANCELLED' : to === 'RISK_STOPPED' ? 'EXECUTION_RISK_STOPPED' : 'EXECUTION_COMPLETED', {
      status: to,
      reason: reason ?? to.toLowerCase(),
    });
  }

  async function cancelChild(
    execution: ExecutionRecord,
    adapter: ExchangeAdapter,
    child: ChildOrderRecord,
    t: number,
  ): Promise<void> {
    try {
      if (child.exchangeOrderId) await adapter.cancelOrder(child.exchangeOrderId, child.symbol);
      await store.updateChildOrder(execution.id, child.clientOrderId, {
        status: child.status === 'SUBMITTING' ? 'CANCELLED' : safeChildTransition(child.status, 'cancel'),
        updatedAt: t,
      });
      await safeEvent(execution.id, 'ORDER_CANCELLED', { clientOrderId: child.clientOrderId });
    } catch (err) {
      const mapped = mapError(err);
      if (!mapped.retryable) {
        await store.updateChildOrder(execution.id, child.clientOrderId, { status: 'UNKNOWN', updatedAt: t });
        await safeEvent(execution.id, 'EXTERNAL_STATE_CHANGE', {
          clientOrderId: child.clientOrderId,
          detail: `cancel failed: ${mapped.message}`,
        });
      }
    }
  }

  async function transitionExecution(
    execution: ExecutionRecord,
    to: ExecutionStatus,
    t: number,
  ): Promise<void> {
    if (execution.status === to) return;
    if (!canTransition(execution.status, to)) return; // illegal transition: never corrupt the lifecycle.
    await store.updateExecutionStatus(execution.id, to, t);
    execution.status = to;
  }

  async function safeEvent(
    executionId: string,
    name: ExecutionEventName,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await store.appendEvent(executionId, name, payload, now());
    } catch {
      // Event logging must never break execution control; a store failure is
      // visible on the next read and in the store's own error surface.
    }
  }

  async function fetchSnapshot(adapter: ExchangeAdapter, symbol: string, t: number): Promise<MarketSnapshot> {
    return tickerToSnapshot(await adapter.getTicker(symbol), t);
  }

  return {
    async start() {
      await runPass(false); // startup == recovery pass (§114): reconcile, don't place.
      if (deps.autoTick !== false) {
        const handle = setInterval(() => void runPass(true), tickIntervalMs);
        stopTicker = () => clearInterval(handle);
      }
    },
    async stop() {
      stopTicker?.();
      stopTicker = null;
    },
    async tick() {
      await runPass(true);
    },
    async recover() {
      await runPass(false);
    },
    async emergencyStop(args) {
      return emergencyStop(store, args, workerId);
    },
  };
}

// ---------------------------------------------------------------------------
// pure helpers (unit-testable without a venue)
// ---------------------------------------------------------------------------

export function isTerminalChild(status: ChildOrderStatus): boolean {
  return status === 'FILLED' || status === 'CANCELLED' || status === 'REJECTED' || status === 'EXPIRED';
}

/**
 * Over-order clamp (§107/§128.15): the quantity that may legally be sent now,
 * or null when nothing may. Entry children are bounded by the plan quantity
 * minus everything filled or still open on the entry side. Exit children carry
 * their planned quantity VERBATIM: they are reduce-only and cover the full
 * planned entry by design (§40 — the venue clamps their fill to the position
 * actually open, which is the one place that clamp can hold continuously).
 */
export function clampChild(
  execution: Pick<ExecutionRecord, 'plannedQuantity'>,
  order: PlannedChildOrder,
  children: Pick<ChildOrderRecord, 'quantity' | 'filledQuantity' | 'isExit' | 'status'>[],
  filledQuantity: number,
  instrument: { stepSize: number },
): PlannedChildOrder | null {
  const openRemaining = (isExit: boolean): number =>
    children
      .filter((c) => c.isExit === isExit && !isTerminalChild(c.status))
      .reduce((sum, c) => sum + Math.max(0, c.quantity - c.filledQuantity), 0);
  // Both the request AND the room are floored to the instrument grid (§71): a
  // quantity the venue cannot represent is rejected outright, and flooring a
  // room never authorizes rounding an order UP into extra exposure.
  const roundDown = (q: number): number => {
    const steps = Math.floor(q / instrument.stepSize + 1e-9);
    return Number((steps * instrument.stepSize).toPrecision(12));
  };
  if (order.isExit) {
    const room = roundDown(order.quantity);
    return room > 0 ? { ...order, quantity: room } : null;
  }
  const room = roundDown(Math.max(0, execution.plannedQuantity - filledQuantity - openRemaining(false)));
  if (room <= 0) return null;
  const quantity = Math.min(roundDown(order.quantity), room);
  return quantity > 0 ? { ...order, quantity } : null;
}

function toNormalizedOrder(execution: ExecutionRecord, planned: PlannedChildOrder): NormalizedOrder {
  return {
    clientOrderId: planned.clientOrderId,
    symbol: execution.symbol,
    marketType: execution.marketType,
    side: planned.side,
    type: planned.type,
    quantity: planned.quantity,
    price: planned.price ?? undefined,
    stopPrice: planned.stopPrice ?? undefined,
    timeInForce: planned.timeInForce,
    postOnly: planned.postOnly,
    reduceOnly: planned.reduceOnly,
  };
}

function toChildView(c: ChildOrderRecord): ChildOrderView {
  return {
    clientOrderId: c.clientOrderId,
    exchangeOrderId: c.exchangeOrderId,
    status: c.status,
    side: c.side,
    price: c.price,
    quantity: c.quantity,
    filledQuantity: c.filledQuantity,
    isExit: c.isExit,
    updatedAt: c.updatedAt,
  };
}

export function summarizeFills(fills: Pick<FillRecord, 'price' | 'quantity' | 'fee'>[]): {
  filledQuantity: number;
  averageEntry: number | null;
  actualFees: number;
} {
  let qty = 0;
  let notional = 0;
  let fees = 0;
  for (const f of fills) {
    qty += f.quantity;
    notional += f.price * f.quantity;
    fees += f.fee;
  }
  return { filledQuantity: qty, averageEntry: qty > 0 ? notional / qty : null, actualFees: fees };
}

function openPositionQuantity(positions: Pick<Position, 'symbol' | 'quantity'>[], execution: ExecutionRecord): number {
  const match = positions.find((p) => p.symbol === execution.symbol);
  return match ? Math.abs(match.quantity) : 0;
}

function childEventFor(status: ChildOrderStatus): ChildOrderEvent {
  const eventByStatus: Readonly<Record<ChildOrderStatus, ChildOrderEvent>> = {
    PLANNED: 'submit',
    SUBMITTING: 'accept',
    OPEN: 'accept',
    PARTIAL: 'partial_fill',
    FILLED: 'fill',
    CANCELLING: 'cancel_request',
    CANCELLED: 'cancel',
    REJECTED: 'reject',
    EXPIRED: 'expire',
    UNKNOWN: 'unknown',
  };
  return eventByStatus[status];
}

function safeChildTransition(from: ChildOrderStatus, event: ChildOrderEvent): ChildOrderStatus {
  try {
    return transitionChildOrder(from, event);
  } catch {
    return from; // venue disagrees with our table: keep the row, fix the table.
  }
}

function liveBlocked(execution: Pick<ExecutionRecord, 'mode'>): boolean {
  return execution.mode === 'live' && process.env.FUDCOURT_EXECUTOR_LIVE !== '1';
}

/** A venue call that degrades loudly-but-safely: null means "skip this pass". */
async function safeCall<T>(
  store: ExecutorStore,
  call: () => Promise<T>,
  execution: ExecutionRecord,
  what: string,
): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    const mapped = mapError(err);
    await store.appendEvent(execution.id, 'EXTERNAL_STATE_CHANGE', {
      detail: `${what} failed: ${mapped.message}`,
      category: mapped.category,
      retryable: mapped.retryable,
    }, Date.now()).catch(() => undefined);
    return null;
  }
}

// ---------------------------------------------------------------------------
// adapter wiring (composition root: scripts/executor/worker.ts)
// ---------------------------------------------------------------------------

type LiveAdapterFactory = (execution: ExecutionRecord) => Promise<ExchangeAdapter>;
let liveAdapterFactory: LiveAdapterFactory | null = null;

/** Composition hook: the entry point wires credential reveal + createAdapter here. */
export function setLiveAdapterFactory(factory: LiveAdapterFactory): void {
  liveAdapterFactory = factory;
}

const adapterCache = new Map<string, Promise<ExchangeAdapter>>();

/** Test seam: drop cached venue connections (one per account × mode). */
export function resetAdapterCache(): void {
  adapterCache.clear();
}

/**
 * Shared by the API's preview path so preview and execution price the spread
 * identically (buy → ask, sell → bid is the planning side; mid for display).
 */
export function tickerToSnapshot(ticker: Ticker, at: number): MarketSnapshot {
  const bid = ticker.bid ?? ticker.last ?? 0;
  const ask = ticker.ask ?? ticker.last ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ticker.last ?? 0);
  return {
    symbol: ticker.symbol,
    bid,
    ask,
    mid,
    spreadBps: mid > 0 && ask > bid ? ((ask - bid) / mid) * 10_000 : 0,
    last: ticker.last ?? mid,
    timestamp: at,
  };
}

/**
 * The adapter for one execution (cached per account × mode). Exposed for the
 * API's emergency-stop path, which must reach the SAME venue connection the
 * worker uses — never a second, disagreeing one.
 */
export async function getExecutionAdapter(execution: ExecutionRecord): Promise<ExchangeAdapter> {
  return adapterFor(execution);
}

async function adapterFor(execution: ExecutionRecord): Promise<ExchangeAdapter> {
  const key = `${execution.accountId}:${execution.exchange}:${execution.marketType}:${execution.mode}`;
  let pending = adapterCache.get(key);
  if (!pending) {
    pending = buildAdapter(execution);
    adapterCache.set(key, pending);
  }
  return pending;
}

async function buildAdapter(execution: ExecutionRecord): Promise<ExchangeAdapter> {
  if (!liveAdapterFactory) {
    throw new Error('live adapter factory not configured (setLiveAdapterFactory at startup)');
  }
  if (execution.mode === 'paper') {
    // Paper is a first-class adapter (§118/§127): real market data, simulated
    // matching. It reaches ONLY the injected adapter's market-data surface —
    // never placeOrder/cancelOrder (asserted in executor-exchange-tests).
    const live = await liveAdapterFactory(execution);
    return new PaperExchangeAdapter({ marketData: live });
  }
  return liveAdapterFactory(execution);
}

// ---------------------------------------------------------------------------
// emergency stop (§75): stop strategies, cancel managed orders, NEVER close
// positions — closing is a separate, explicit user action.
// ---------------------------------------------------------------------------

export async function emergencyStop(
  store: ExecutorStore,
  args: { userId?: string; accountId?: string },
  workerId: string,
): Promise<{ stopped: number; cancelledOrders: number }> {
  let stopped = 0;
  let cancelledOrders = 0;
  const running = await store.listRunningExecutions();
  for (const execution of running) {
    // Ownership is checked HERE too (§108): the worker can see every execution,
    // but a user's emergency stop must never reach another user's account.
    if (args.userId && execution.userId !== args.userId) continue;
    if (args.accountId && execution.accountId !== args.accountId) continue;
    const adapter = await adapterFor(execution).catch(() => null);
    const children = await store.listChildOrders(execution.id);
    for (const child of children) {
      if (isTerminalChild(child.status)) continue;
      try {
        if (adapter && child.exchangeOrderId) await adapter.cancelOrder(child.exchangeOrderId, child.symbol);
        await store.updateChildOrder(execution.id, child.clientOrderId, {
          status: 'CANCELLED',
          updatedAt: Date.now(),
        });
        cancelledOrders += 1;
      } catch {
        await store.updateChildOrder(execution.id, child.clientOrderId, { status: 'UNKNOWN', updatedAt: Date.now() });
      }
    }
    await store.updateExecutionStatus(execution.id, 'STOPPED', Date.now());
    await store.appendEvent(execution.id, 'EXECUTION_FAILED', {
      reason: 'emergency stop (PRD §75): managed orders cancelled, positions NOT closed',
      workerId,
    }, Date.now());
    stopped += 1;
  }
  return { stopped, cancelledOrders };
}
