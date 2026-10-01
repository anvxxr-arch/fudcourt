/**
 * Worker unit tests (PRD §40/§57/§75/§107/§113/§128.15): run OFFLINE, no venue.
 *
 * Contract under test — worker.ts's pure surface:
 *  - the over-order clamp (§107/§128.15): partial fills can NEVER over-place,
 *    and rounding never rounds a quantity UP into risk (§71);
 *  - fill summarization (§36): weighted average entry, honest null before fills;
 *  - child-order terminality + the shared execution lifecycle table (§57);
 *  - market snapshot mapping: no NaN, mid/spread from the touch (§69);
 *  - emergency stop (§75): owner-scoped, cancels managed orders, and NEVER
 *    closes a position (only cancelOrder may be called on the venue).
 *
 * Usage: cd frontend/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampChild,
  emergencyStop,
  isTerminalChild,
  resetAdapterCache,
  setLiveAdapterFactory,
  summarizeFills,
  tickerToSnapshot,
} from '../../src/platform/executor/worker';
import {
  canTransition,
  isTerminalExecution,
  type ChildOrderRecord,
  type ExecutorStore,
  type PlannedChildOrder,
} from '../../src/platform/executor/types';

const INSTRUMENT_GRID = { stepSize: 0.001 };

function child(partial: Partial<ChildOrderRecord> = {}): ChildOrderRecord {
  return {
    id: 'c1',
    executionId: 'e1',
    exchangeOrderId: 'x1',
    clientOrderId: 'fud_e1_1',
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    price: 100,
    quantity: 1,
    filledQuantity: 0,
    status: 'OPEN',
    isExit: false,
    submittedAt: 1,
    updatedAt: 1,
    filledAt: null,
    ...partial,
  };
}

function planned(partial: Partial<PlannedChildOrder> = {}): PlannedChildOrder {
  return {
    clientOrderId: 'fud_e1_2',
    side: 'buy',
    type: 'limit',
    price: 100,
    stopPrice: null,
    quantity: 1,
    timeInForce: 'GTC',
    postOnly: false,
    reduceOnly: false,
    isExit: false,
    ...partial,
  };
}

test('over-order clamp: planned − filled − open entry remainder, never negative (§107)', () => {
  const execution = { plannedQuantity: 10 };
  const children = [
    child({ quantity: 4, filledQuantity: 3, status: 'PARTIAL' }), // 1 open
    child({ quantity: 2, filledQuantity: 0, status: 'OPEN' }), // 2 open
  ];
  // room = 10 − 3 − 3 = 4
  const clamped = clampChild(execution, planned({ quantity: 6 }), children, 3, INSTRUMENT_GRID);
  assert.ok(clamped);
  assert.equal(clamped.quantity, 4);
});

test('over-order clamp: a fully consumed plan places nothing more (§128.15)', () => {
  const execution = { plannedQuantity: 10 };
  // `filledQuantity` is the venue's TOTAL for the entry side, so the filled
  // child must not be counted again as open room: room = 10 − 10 = 0.
  const filled = [child({ quantity: 7, filledQuantity: 7, status: 'FILLED' })];
  assert.equal(clampChild(execution, planned(), filled, 10, INSTRUMENT_GRID), null);
  // An open child rest of the plan is reserved: still nothing legal to add.
  const live = [child({ quantity: 10, filledQuantity: 7, status: 'PARTIAL' })];
  assert.equal(clampChild(execution, planned(), live, 7, INSTRUMENT_GRID), null);
});

test('over-order clamp: quantity rounds DOWN to step, never up into risk (§71)', () => {
  const execution = { plannedQuantity: 10 };
  const clamped = clampChild(
    execution,
    planned({ quantity: 0.012583 }),
    [],
    0,
    { stepSize: 0.001 },
  );
  assert.ok(clamped);
  assert.equal(clamped.quantity, 0.012); // 0.012583 → DOWN, never 0.013
  // Room itself rounds down: 0.012583 of room cannot become 0.013 of order.
  const tiny = clampChild({ plannedQuantity: 0.012583 }, planned({ quantity: 0.012583 }), [], 0, { stepSize: 0.001 });
  assert.ok(tiny);
  assert.ok(tiny.quantity <= 0.012);
});

test('exit children are floored to the instrument grid, never re-inflated', () => {
  const exitLeg = planned({ isExit: true, reduceOnly: true, quantity: 0.2504, type: 'limit', price: 110 });
  const clamped = clampChild({ plannedQuantity: 1 }, exitLeg, [], 0.5, INSTRUMENT_GRID);
  assert.ok(clamped);
  assert.equal(clamped.quantity, 0.25); // 0.2504 → 0.250, same floor as entries
  // Below one whole step there is nothing legal left to send (§70/§71).
  assert.equal(clampChild({ plannedQuantity: 1 }, planned({ isExit: true, quantity: 0.0004 }), [], 0.5, INSTRUMENT_GRID), null);
});

test('terminal children never consume room (cancelled entry frees capacity)', () => {
  const execution = { plannedQuantity: 10 };
  const children = [
    child({ quantity: 4, filledQuantity: 0, status: 'CANCELLED' }),
    child({ quantity: 2, filledQuantity: 0, status: 'REJECTED' }),
  ];
  const clamped = clampChild(execution, planned({ quantity: 10 }), children, 0, INSTRUMENT_GRID);
  assert.ok(clamped);
  assert.equal(clamped.quantity, 10);
});

test('summarizeFills: weighted average entry, fee sum, honest null before fills (§36)', () => {
  const summary = summarizeFills([
    { price: 100, quantity: 1, fee: 0.1 },
    { price: 110, quantity: 1, fee: 0.2 },
  ]);
  assert.equal(summary.filledQuantity, 2);
  assert.equal(summary.averageEntry, 105);
  // Fees are summed in the venue's own units; the value is a float, so this
  // asserts the sum, not a float-identical literal.
  assert.ok(Math.abs(summary.actualFees - 0.3) < 1e-9);
  const empty = summarizeFills([]);
  assert.equal(empty.filledQuantity, 0);
  assert.equal(empty.averageEntry, null);
});

test('child-order terminality (§58) and execution lifecycle legality (§57)', () => {
  for (const s of ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'] as const) assert.equal(isTerminalChild(s), true);
  for (const s of ['PLANNED', 'SUBMITTING', 'OPEN', 'PARTIAL', 'CANCELLING', 'UNKNOWN'] as const) {
    assert.equal(isTerminalChild(s), false);
  }
  // §57: the happy path and the refusal of anything after a terminal state.
  assert.equal(canTransition('READY', 'RUNNING'), true);
  assert.equal(canTransition('RUNNING', 'PARTIALLY_FILLED'), true);
  assert.equal(canTransition('PARTIALLY_FILLED', 'RISK_STOPPED'), true);
  assert.equal(canTransition('PAUSED', 'RUNNING'), true);
  assert.equal(canTransition('FILLED', 'RUNNING'), false);
  assert.equal(canTransition('CANCELLED', 'RUNNING'), false);
  assert.equal(canTransition('RISK_STOPPED', 'PARTIALLY_FILLED'), false);
  assert.equal(isTerminalExecution('FILLED'), true);
  assert.equal(isTerminalExecution('RUNNING'), false);
});

test('ticker → snapshot: touch prices, no NaN on a last-only ticker (§69)', () => {
  const s = tickerToSnapshot({ symbol: 'BTC/USDT', bid: 99, ask: 101, last: 100, timestamp: 1 }, 5);
  assert.equal(s.mid, 100);
  assert.equal(s.spreadBps, 200);
  assert.equal(s.timestamp, 5);
  const lastOnly = tickerToSnapshot({ symbol: 'BTC/USDT', bid: null, ask: null, last: 42, timestamp: 1 }, 5);
  assert.equal(lastOnly.bid, 42);
  assert.equal(lastOnly.spreadBps, 0);
  assert.ok(Number.isFinite(lastOnly.mid));
});

test('emergency stop (§75): owner-scoped, cancels managed orders, NEVER closes positions', async () => {
  resetAdapterCache();
  const cancelled: string[] = [];
  const closed: string[] = [];
  setLiveAdapterFactory(async () => ({
    validateCredentials: async () => { throw new Error('not used'); },
    getBalances: async () => [],
    getAccountEquity: async () => { throw new Error('not used'); },
    getMarkets: async () => [],
    getTicker: async () => { throw new Error('not used'); },
    getOrderBook: async () => { throw new Error('not used'); },
    getPositions: async () => [],
    getOpenOrders: async () => [],
    placeOrder: async () => { closed.push('place'); throw new Error('not used'); },
    cancelOrder: async (orderId: string) => { cancelled.push(orderId); },
    getFees: async () => ({ symbol: 'BTC/USDT', makerBps: 0, takerBps: 0 }),
    capabilities: () => { throw new Error('not used'); },
  }));

  // Minimal store fake: only the members emergencyStop touches. Test seam —
  // the production store is integration-tested against Postgres at P3.
  const events: { executionId: string; name: string }[] = [];
  const statuses: { id: string; status: string }[] = [];
  const store = {
    listRunningExecutions: async () => [
      { id: 'e1', userId: 'userA', accountId: 'accA', exchange: 'binance', marketType: 'linear_perp', symbol: 'BTC/USDT', side: 'buy', status: 'RUNNING', mode: 'live' },
      { id: 'e2', userId: 'userB', accountId: 'accB', exchange: 'binance', marketType: 'linear_perp', symbol: 'BTC/USDT', side: 'buy', status: 'RUNNING', mode: 'live' },
    ],
    listChildOrders: async (executionId: string) => [
      child({ id: `${executionId}-c1`, executionId, clientOrderId: `fud_${executionId}_1`, exchangeOrderId: `x-${executionId}`, status: 'OPEN' }),
      child({ id: `${executionId}-c2`, executionId, clientOrderId: `fud_${executionId}_2`, exchangeOrderId: `x-${executionId}-2`, status: 'FILLED', filledQuantity: 1 }),
    ],
    updateChildOrder: async (executionId: string, clientOrderId: string, patch: { status?: string }) => { statuses.push({ id: `${executionId}/${clientOrderId}`, status: patch.status ?? '' }); },
    updateExecutionStatus: async (id: string, status: string) => { statuses.push({ id, status }); },
    appendEvent: async (executionId: string, name: string) => { events.push({ executionId, name }); },
  } as unknown as ExecutorStore;

  const result = await emergencyStop(store, { userId: 'userA' }, 'test-worker');
  // Only userA's execution is stopped; userB's is untouched (§108 ownership).
  assert.equal(result.stopped, 1);
  assert.deepEqual(statuses, [
    { id: 'e1/fud_e1_1', status: 'CANCELLED' }, // the open managed order
    { id: 'e1', status: 'STOPPED' },
  ]);
  assert.equal(result.cancelledOrders, 1);
  // The filled child is terminal and never re-cancelled; the venue saw one cancel.
  assert.deepEqual(cancelled, ['x-e1']);
  // §75: positions are never closed — no place/close call ever fired.
  assert.deepEqual(closed, []);
  assert.ok(events.every((e) => e.executionId === 'e1'));
  resetAdapterCache();
  resetAdapterCache();
});
