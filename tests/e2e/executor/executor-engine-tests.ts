/**
 * Execution-engine unit tests (PRD §25–§35, §37, §58, §67, §107, §115): OFFLINE,
 * no venue, no clock — every tick carries an explicit `ctx.now`.
 *
 * Contract under test — engine.ts's promises:
 *  - the over-order invariant (§107/§128.15): Σ planned child quantities never
 *    exceeds the target, whatever the fill/partial-fill sequence is;
 *  - the hard risk constraint (§36/§37): when the remaining budget cannot fund
 *    another unit the engine resizes, and when not even one unit fits it stops
 *    (or pauses, per policy) instead of placing;
 *  - recovery passes plan NOTHING (§114) — a child the venue never saw must not
 *    silently consume the plan;
 *  - SL invalidation (§115) cancels entry legs and stops, never places again;
 *  - the child-order lifecycle table (§58) refuses illegal transitions.
 *
 * Usage: cd frontend/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStrategy,
  defaultSlices,
  executionEngine,
  strategyOnFill,
  strategyProgress,
  strategyStep,
  transitionChildOrder,
} from '@/platform/executor/engine';
import {
  type ChildOrderView,
  type ExecutionConstraints,
  type ExecutionDefinition,
  type ExecutionPlan,
  type FillView,
  type MarketSnapshot,
  type StrategyContext,
} from '@/platform/executor/types';

const INSTRUMENT = {
  symbol: 'BTC/USDT',
  marketType: 'linear_perp' as const,
  exchange: 'binance' as const,
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  settlementAsset: 'USDT',
  tickSize: 0.01,
  stepSize: 0.0001,
  minQuantity: 0.0001,
  maxQuantity: null,
  minNotional: 5,
  maxNotional: null,
  contractMultiplier: 1,
  maxLeverage: 100,
  maintenanceMarginRate: 0.004,
  leverageBrackets: [],
};

const SNAPSHOT: MarketSnapshot = {
  symbol: 'BTC/USDT',
  bid: 99_995,
  ask: 100_005,
  mid: 100_000,
  spreadBps: 1,
  last: 100_000,
  timestamp: 0,
};

function plan(over: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    venueKey: 'binance:linear_perp:BTC/USDT',
    symbol: 'BTC/USDT',
    marketType: 'linear_perp',
    side: 'buy',
    intent: 'open',
    quantity: 0.01,
    notional: 1_000,
    estimatedEntry: 100_000,
    stopLoss: 98_000,
    takeProfits: [],
    risk: { budget: 20, estimatedTotalRisk: 20, priceRisk: 20, estimatedFees: 0, slippageBudget: 0, safetyReserve: 0 },
    leverage: { mode: 'manual', selected: 5 },
    margin: { estimatedInitial: 200, mode: 'isolated' },
    liquidation: { priceApprox: null, stopToLiquidationBuffer: null, safe: null },
    execution: { strategy: 'market', durationMs: null, estimatedSlices: null, urgency: null },
    instrument: INSTRUMENT,
    feeModel: { makerBps: 0, takerBps: 0 },
    slippageModel: { slippageBps: 0, safetyReservePct: 0 },
    balanceSnapshot: null,
    marketSnapshot: null,
    sizingMode: 'risk_usd',
    sizingValue: 20,
    riskBasis: null,
    constraints: {},
    ...over,
  } as unknown as ExecutionPlan;
}

function ctx(over: Partial<StrategyContext> = {}): StrategyContext {
  return {
    now: 1_000,
    snapshot: SNAPSHOT,
    filledQuantity: 0,
    averageEntry: null,
    projectedRisk: null,
    remainingRiskBudget: null,
    openChildOrders: [],
    openPositionQuantity: 0,
    constraints: {},
    placementEnabled: true,
    ...over,
  };
}

/** A ChildOrderView the way the worker reports a live venue order. */
function child(over: Partial<ChildOrderView> = {}): ChildOrderView {
  return {
    clientOrderId: 'fud_e1_1',
    exchangeOrderId: 'x1',
    status: 'OPEN',
    side: 'buy',
    price: 100_000,
    quantity: 0.01,
    filledQuantity: 0,
    isExit: false,
    updatedAt: 1_000,
    ...over,
  };
}

function fill(over: Partial<FillView> = {}): FillView {
  return {
    tradeId: 't1',
    clientOrderId: 'fud_e1_1',
    price: 100_000,
    quantity: 0.005,
    quoteQuantity: 500,
    fee: 0,
    feeAsset: 'USDT',
    timestamp: 1_000,
    ...over,
  };
}

function marketState(execution: ExecutionDefinition, p = plan(), constraints: ExecutionConstraints = {}): unknown {
  return createStrategy({ executionId: 'e1', plan: p, execution, constraints, seed: 7 });
}

test('createStrategy seeds a deterministic, JSON-serializable state', () => {
  const a = marketState({ type: 'twap', durationMs: 1_800_000 });
  const b = marketState({ type: 'twap', durationMs: 1_800_000 });
  assert.deepEqual(a, b); // same seed ⇒ same slice plan (PRD §28 reproducibility)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a); // must survive a restart
  assert.equal((a as { version: number }).version, 1);
});

test('§28: defaultSlices is the documented 150s cadence, clamped to [1, 40]', () => {
  assert.equal(defaultSlices(1_800_000), 12); // 30 min → 12 slices (PRD §56)
  assert.equal(defaultSlices(1_000), 1);
  assert.equal(defaultSlices(10 ** 12), 40);
});

test('§107: Σ planned entry quantities never exceeds the target, across fills', () => {
  const p = plan({ quantity: 0.01 });
  let state = marketState({ type: 'limit', price: 100_000 }, p);
  let placed = 0;
  // Three ticks, each after the venue reports a partial fill of the previous leg.
  for (let tick = 0; tick < 3; tick++) {
    const stepped = strategyStep(state, ctx({
      now: 1_000 + tick * 1_000,
      filledQuantity: placed,
      openChildOrders: [child({ quantity: p.quantity, filledQuantity: placed })],
    }));
    state = stepped.state;
    const places = stepped.actions.filter((a) => a.type === 'place');
    if (places.length === 1) placed += (places[0] as { order: { quantity: number } }).order.quantity;
  }
  assert.ok(placed <= p.quantity + 1e-9, `planned ${placed} must never exceed ${p.quantity}`);
});

test('§36: a fill updates the average entry and the remaining plan shrinks', () => {
  const p = plan({ quantity: 0.01 });
  let state = marketState({ type: 'limit', price: 100_000 }, p);
  const first = strategyOnFill(state, fill({ price: 100_000, quantity: 0.004 }));
  state = first.state;
  assert.equal((state as { filledQuantity: number }).filledQuantity, 0.004);
  assert.equal((state as { averageEntry: number }).averageEntry, 100_000);

  const second = strategyOnFill(state, fill({ tradeId: 't2', price: 101_000, quantity: 0.004 }));
  const st = second.state as { filledQuantity: number; averageEntry: number };
  assert.equal(st.filledQuantity, 0.008);
  // Weighted, not last-price: (100000·0.004 + 101000·0.004) / 0.008.
  assert.ok(Math.abs(st.averageEntry - 100_500) < 1e-6);
});

test('§37: with a risk budget that cannot fund one unit, the engine stops (never places)', () => {
  const p = plan({ quantity: 0.01, risk: { budget: 20, estimatedTotalRisk: 20, priceRisk: 20, estimatedFees: 0, slippageBudget: 0, safetyReserve: 0 } });
  const state = marketState({ type: 'market' }, p);
  const stepped = strategyStep(state, ctx({
    projectedRisk: { priceRisk: 20, entryFee: 0, exitFee: 0, estimatedSlippage: 0, safetyReserve: 0, totalRisk: 20 },
    remainingRiskBudget: 0.0000001, // below one unit of risk
  }));
  const stop = stepped.actions.find((a) => a.type === 'stop');
  assert.ok(stop, 'a budget smaller than one unit must stop the execution');
  assert.equal((stop as { riskStopped: boolean }).riskStopped, true);
  assert.equal(stepped.actions.filter((a) => a.type === 'place').length, 0);
});

test('§37: a budget smaller than the target but larger than one unit RESIZES (no stop)', () => {
  const p = plan({ quantity: 0.01 });
  const state = marketState({ type: 'market' }, p);
  // Unit risk ≈ $2,000/unit at 2,000 points; budget funds ~2 units of the 10.
  const stepped = strategyStep(state, ctx({
    projectedRisk: { priceRisk: 2000, entryFee: 0, exitFee: 0, estimatedSlippage: 0, safetyReserve: 0, totalRisk: 2000 },
    remainingRiskBudget: 4000,
  }));
  const place = stepped.actions.find((a) => a.type === 'place');
  assert.ok(place, 'the affordable remainder must still be placed');
  const qty = (place as { order: { quantity: number } }).order.quantity;
  assert.ok(qty <= 0.01 + 1e-9);
  assert.ok(qty > 0);
  assert.equal(stepped.actions.some((a) => a.type === 'stop'), false);
});

test('§114: a recovery pass (placementEnabled=false) plans NO placements', () => {
  const state = marketState({ type: 'market' });
  const stepped = strategyStep(state, ctx({ placementEnabled: false }));
  assert.equal(stepped.actions.filter((a) => a.type === 'place').length, 0);
  // ...and the state stays resumable: a later permitted tick places normally.
  const resumed = strategyStep(stepped.state, ctx({ now: 2_000, placementEnabled: true }));
  assert.equal(resumed.actions.filter((a) => a.type === 'place').length, 1);
});

test('§107: a leg the venue never acknowledged frees the room on a later tick', () => {
  const p = plan({ quantity: 0.01 });
  // Tick 1 plans 0.01 but the worker drops it (no venue row).
  const first = strategyStep(marketState({ type: 'market' }, p), ctx({ now: 1_000 }));
  const orphan = first.state;
  // Tick 2: the venue shows nothing, so the phantom must not block re-planning.
  const second = strategyStep(orphan, ctx({ now: 2_000 }));
  assert.equal(second.actions.filter((a) => a.type === 'place').length, 1);
});

test('§115: SL invalidated mid-entry → entry cancelled, stop emitted, never placed again', () => {
  const p = plan({ quantity: 0.01, stopLoss: 98_000 });
  const state = marketState({ type: 'twap', durationMs: 600_000, slices: 4 }, p);
  const stepped = strategyStep(state, ctx({ now: 1_000 }));
  const ledger = (stepped.state as { ledger: { clientOrderId: string; quantity: number }[] }).ledger;
  assert.ok(ledger.length > 0);
  const invalidated = strategyStep(stepped.state, ctx({
    now: 2_000,
    // Market crashed through the stop: last ≤ stop for a long.
    snapshot: { ...SNAPSHOT, last: 97_000, bid: 96_995, ask: 97_005, mid: 97_000 },
    // The venue confirms that exact leg is live (ids are stable, §66).
    openChildOrders: [child({ clientOrderId: ledger[0].clientOrderId, quantity: ledger[0].quantity, filledQuantity: 0 })],
  }));
  assert.ok(invalidated.actions.some((a) => a.type === 'cancel'), 'entry children must be cancelled');
  assert.ok(invalidated.actions.some((a) => a.type === 'stop'));
  assert.equal(invalidated.actions.filter((a) => a.type === 'place').length, 0);
  // ...and it is terminal: later ticks do nothing at all (§115 "no additional
  // entry may occur after invalidation").
  const after = strategyStep(invalidated.state, ctx({ now: 3_000 }));
  assert.deepEqual(after.actions, []);

});

test('a user-paused execution places nothing and never self-resumes (§37 pause policy)', () => {
  const state = marketState({ type: 'market' });
  const paused = { ...(state as Record<string, unknown>), phase: 'paused', pauseEmitted: true };
  const stepped = strategyStep(paused, ctx({ now: 5_000 }));
  assert.deepEqual(stepped.actions, []);
  assert.equal((stepped.state as { phase: string }).phase, 'paused');
});

test('§40: scale_out never counts the entry side, and reduce-only ≤ open position', () => {
  const p = plan({ side: 'sell', intent: 'close', quantity: 0.02, stopLoss: null });
  const state = createStrategy({
    executionId: 'e1',
    plan: p,
    execution: { type: 'scale_out', levels: [{ price: 105_000, fraction: 0.5 }, { price: 110_000, fraction: 0.5 }] },
    constraints: {},
    seed: 1,
  });
  // The venue reports a big entry-side fill; a close must ignore it.
  const stepped = strategyStep(state, ctx({
    filledQuantity: 5,
    openPositionQuantity: 0.02,
    snapshot: { ...SNAPSHOT, bid: 105_010, ask: 105_020, mid: 105_015, last: 105_015 },
  }));
  const place = stepped.actions.find((a) => a.type === 'place') as { order: { quantity: number; reduceOnly: boolean; isExit: boolean } } | undefined;
  assert.ok(place, 'a marketable scale-out level must be placed');
  assert.equal(place.order.reduceOnly, true);
  assert.ok(place.order.quantity <= 0.02 + 1e-9, 'reduce-only may never exceed the open position');
});

test('§85/§86: progress reports completion, average, and honest nulls', () => {
  const p = plan({ quantity: 0.02 });
  let state = marketState({ type: 'twap', durationMs: 600_000, slices: 4 }, p);
  state = strategyOnFill(state, fill({ quantity: 0.005 })).state;
  const progress = strategyProgress(state, ctx({
    now: 300_000,
    filledQuantity: 0.005,
    averageEntry: 100_000,
    projectedRisk: { priceRisk: 10, entryFee: 0, exitFee: 0, estimatedSlippage: 0, safetyReserve: 0, totalRisk: 10 },
    remainingRiskBudget: 10,
  }));
  assert.equal(progress.completionPct, 0.25);
  assert.equal(progress.filledQuantity, 0.005);
  assert.equal(progress.remainingQuantity, 0.015);
  // `startedAt` is stamped on the first STEP, so a state that only took fills
  // has not started its clock yet — reported honestly as 0, never as 1.
  assert.equal(progress.elapsedPct, 0);
  assert.equal(progress.averageEntry, 100_000);
  assert.equal(progress.projectedRisk, 10);
  assert.equal(progress.remainingRiskBudget, 10);
  // No plan stop ⇒ stop-based figures are null, never 0 (§38/§116).
  const bare = strategyProgress(marketState({ type: 'market' }, plan({ stopLoss: null, quantity: 0.02 })), ctx());
  assert.equal(bare.plannedRisk, null);
  assert.equal(bare.projectedRisk, null);
  assert.equal(bare.averageEntry, null);
});

// ---------------------------------------------------------------------------
// §28/§29 TWAP jitter and §32 chase-limit controls. Both were declared in the
// contract but never wired: the engine hard-wired each jitter to 0 and the
// replacement budget to a constant, so no user could randomize a schedule or
// bound a chase. These pin the behaviour the controls promise.
// ---------------------------------------------------------------------------
type Slice = { quantity: number; atOffsetMs: number };
function slicesOf(state: unknown): Slice[] {
  return (state as unknown as { slices: Slice[] }).slices;
}
function sumQty(xs: Slice[]): number {
  return Math.round(xs.reduce((a, s) => a + s.quantity, 0) * 1e8) / 1e8;
}

test('§28/§29: quantity jitter randomizes slices, yet the total is still exactly the target', () => {
  const flat = slicesOf(marketState({ type: 'twap', durationMs: 1_800_000, slices: 8 }));
  const jittered = slicesOf(marketState({
    type: 'twap',
    durationMs: 1_800_000,
    slices: 8,
    config: { durationMs: 1_800_000, orderType: 'market', quantityJitterPct: 0.3, intervalJitterPct: 0.2 },
  }));
  assert.equal(sumQty(flat), 0.01, 'equal slices already sum to the target');
  assert.equal(sumQty(jittered), 0.01, 'randomized slices must still sum to the target (§107)');
  assert.notEqual(
    jittered.map((s) => s.quantity).join(','),
    flat.map((s) => s.quantity).join(','),
    'jitter must actually change the schedule, not be a silent no-op',
  );
  for (const s of jittered) {
    assert.ok(s.quantity > 0, 'jitter never produces a slice floored away to zero');
  }
});

test('§28/§29: interval jitter keeps the schedule monotonic and inside the duration', () => {
  const slices = slicesOf(marketState({
    type: 'twap',
    durationMs: 600_000,
    slices: 10,
    config: { durationMs: 600_000, orderType: 'market', intervalJitterPct: 0.45 },
  }));
  for (let i = 1; i < slices.length; i++) {
    assert.ok(slices[i].atOffsetMs >= slices[i - 1].atOffsetMs, `slice ${i} must not land before its predecessor`);
  }
  for (const s of slices) assert.ok(s.atOffsetMs <= 600_000, 'no slice lands past the duration');
  assert.equal(slices[0].atOffsetMs, 0, 'the first slice is immediate');
});

test('§28/§29: no config ⇒ the naive equal schedule — jitter is opt-in, never silent', () => {
  const a = slicesOf(marketState({ type: 'twap', durationMs: 300_000, slices: 4 }));
  assert.equal(sumQty(a), 0.01);
  // Every slice differs from its predecessor by at most one 8dp step: an equal
  // split modulo the floored remainder, which random jitter would break.
  const quantities = a.map((s) => s.quantity);
  const max = Math.max(...quantities);
  const min = Math.min(...quantities);
  assert.ok(max - min <= 0.00000001, `equal slices, got ${quantities.join(',')}`);
});

test('§32: maxChaseDistance holds the peg at the limit instead of chasing a runaway market', () => {
  const p = plan();
  const state = marketState({ type: 'chase_limit', urgency: 'passive', maxChaseDistance: 50 }, p);
  // The bid has run 400 above the 100,000 arrival; a passive buy may travel 50.
  const { actions } = executionEngine.strategyStep(state, ctx({
    now: 10_000,
    snapshot: { ...SNAPSHOT, bid: 100_400, ask: 100_410, mid: 100_405, last: 100_405 },
  }));
  const placed = actions.find((a) => a.type === 'place') as unknown as { order: { price: number | null } } | undefined;
  assert.ok(placed, 'the strategy still places — it holds its level rather than stopping');
  assert.ok(placed.order.price !== null, 'a chase places a limit order, not a market one');
  assert.ok(
    placed.order.price <= p.estimatedEntry + 50,
    `peg ${placed.order.price} must not travel beyond arrival + 50`,
  );
});

test('§32: a reprice CANCELS the working child before replacing it — never both at once', () => {
  const state = marketState({ type: 'chase_limit', urgency: 'passive' }, plan());
  const first = executionEngine.strategyStep(state, ctx({ now: 10_000, snapshot: SNAPSHOT }));
  const placed = first.actions.find((a) => a.type === 'place') as unknown as { order: { clientOrderId: string; price: number } };
  assert.ok(placed, 'the first order places');

  // The venue reports that order live, and the touch then moves away.
  const live = child({ clientOrderId: placed.order.clientOrderId, price: placed.order.price, quantity: 0.01 });
  const moved = { ...SNAPSHOT, bid: SNAPSHOT.bid - 20, ask: SNAPSHOT.ask - 20, mid: SNAPSHOT.mid - 20, last: SNAPSHOT.mid - 20 };
  const second = executionEngine.strategyStep(first.state, ctx({
    now: 1_000_000,
    snapshot: moved,
    openChildOrders: [live],
  }));
  const cancels = second.actions.filter((a) => a.type === 'cancel') as { clientOrderId: string }[];
  assert.equal(cancels.length, 1, 'the live child is cancelled');
  assert.equal(cancels[0].clientOrderId, placed.order.clientOrderId, 'the cancel targets the working order');
  assert.equal(
    second.actions.filter((a) => a.type === 'place').length,
    0,
    'the replacement waits for the cancel to be acknowledged — placing here would leave both live',
  );

  // Once the venue reports the cancel, the next tick places the replacement.
  const third = executionEngine.strategyStep(second.state, ctx({ now: 2_000_000, snapshot: moved }));
  const replacement = third.actions.find((a) => a.type === 'place') as unknown as { order: { price: number } } | undefined;
  assert.ok(replacement, 'after the cancel the peg is re-placed at the new touch');
  assert.equal(replacement.order.price, moved.bid, 'replaced at the moved touch');
});

test('§32: maxReplacements is honored — a spent budget ends the chase instead of looping', () => {
  const state = marketState({ type: 'chase_limit', urgency: 'passive', maxReplacements: 1 }, plan());
  let st = state;
  let now = 10_000;
  let live: ChildOrderView | null = null;
  let sawCancel = false;
  // Drive the chase through several repricing cycles, reporting each order back
  // to the engine the way the worker does. The budget of 1 must be spent exactly
  // once, after which the strategy must stop rather than keep cancelling.
  for (let i = 0; i < 6 && !sawCancel; i++) {
    const snapshot = { ...SNAPSHOT, bid: SNAPSHOT.bid - i * 5, ask: SNAPSHOT.ask - i * 5, mid: SNAPSHOT.mid - i * 5, last: SNAPSHOT.mid - i * 5 };
    const openChildOrders = live === null ? [] : [live];
    const r = executionEngine.strategyStep(st, ctx({ now, snapshot, openChildOrders }));
    const place = r.actions.find((a) => a.type === 'place') as unknown as { order: { clientOrderId: string; price: number; quantity: number } } | undefined;
    if (place !== undefined) {
      live = child({ clientOrderId: place.order.clientOrderId, price: place.order.price, quantity: place.order.quantity });
    }
    st = r.state;
    if (r.actions.some((a) => a.type === 'cancel')) {
      sawCancel = true;
      // The venue confirms the cancel, so the next tick may place the replacement.
      st = executionEngine.strategyStep(st, ctx({ now: now + 1_000, snapshot, openChildOrders: [] })).state;
    }
    now += 1_000_000;
  }
  assert.ok(sawCancel, 'one reprice happens within the budget');

  const snapshot = { ...SNAPSHOT, bid: SNAPSHOT.bid - 100, ask: SNAPSHOT.ask - 100, mid: SNAPSHOT.mid - 100, last: SNAPSHOT.mid - 100 };
  const exhausted = executionEngine.strategyStep(st, ctx({ now: now + 60_000_000, snapshot, openChildOrders: [] }));
  assert.ok(
    exhausted.actions.some((a) => a.type === 'stop'),
    'a spent replacement budget stops the chase instead of looping forever',
  );
});

test('§58: illegal child-order transitions throw instead of silently advancing', () => {
  assert.equal(transitionChildOrder('PLANNED', 'submit'), 'SUBMITTING');
  assert.equal(transitionChildOrder('SUBMITTING', 'accept'), 'OPEN');
  assert.equal(transitionChildOrder('OPEN', 'cancel_request'), 'CANCELLING');
  assert.equal(transitionChildOrder('CANCELLING', 'cancel'), 'CANCELLED');
  assert.throws(() => transitionChildOrder('FILLED', 'cancel'), /illegal child order transition/);
  assert.throws(() => transitionChildOrder('CANCELLED', 'accept'), /illegal child order transition/);
  assert.throws(() => transitionChildOrder('UNKNOWN', 'fill'), /illegal child order transition/);
});

test('the engine object exposes the frozen API surface (PRD §102/§48 seam)', () => {
  for (const fn of ['createStrategy', 'strategyStep', 'strategyOnFill', 'strategyProgress', 'transitionChildOrder']) {
    assert.equal(typeof (executionEngine as unknown as Record<string, unknown>)[fn], 'function');
  }
});