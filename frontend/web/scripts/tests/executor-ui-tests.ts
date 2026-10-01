/**
 * Composer request tests — OFFLINE, no venue, no router, no DOM.
 *
 * The engine suites cover the strategies, but the COMPOSER is where a user
 * actually sets a control, and it is client-side: nothing server-rendered ever
 * exercised the `chase_limit` branches, which is how §29/§32 controls could be
 * declared in the contract, honoured nowhere, and never even offered. These tests
 * pin the composer→API seam: a control present in the form must appear in the
 * request, and an untouched optional field must be OMITTED rather than sent as 0
 * — "unset" and "set to zero" are different instructions to the engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecution, type ComposerState } from '../../src/features/executor/ui';

/** The composer's shipped default form state, with only the fields a test sets. */
function state(over: Partial<ComposerState> = {}): ComposerState {
  return {
    accountId: '',
    marketType: 'linear_perp',
    symbol: 'BTC/USDT',
    side: 'buy',
    intent: 'open',
    entryType: 'market',
    entryPrice: '',
    postOnly: false,
    stopLoss: '',
    takeProfits: [{ price: '', fraction: '' }],
    sizingMode: 'risk_percent',
    sizingValue: '1',
    basis: 'futures_equity',
    leverageMode: 'auto_safe',
    manualLeverage: '5',
    marginMode: '',
    strategy: 'adaptive_twap',
    durationMinutes: '30',
    slices: '',
    urgency: 'balanced',
    quantityJitterPct: '',
    intervalJitterPct: '',
    visibleQty: '',
    maxChaseDistance: '',
    maxReplacements: '',
    levels: [{ price: '', fraction: '' }],
    maxSlippageBps: '',
    maxSpreadBps: '',
    maxPrice: '',
    minPrice: '',
    maxDurationMinutes: '',
    makerOnly: false,
    allowMarketFallback: false,
    cancelIfRiskExceeded: false,
    stopIfDisconnected: false,
    riskPolicy: 'resize_then_stop',
    mode: 'paper',
    ...over,
  } as ComposerState;
}

test('§28/§29: a blank jitter field sends NO config — the naive schedule, not a silent random one', () => {
  const ex = buildExecution(state({ strategy: 'twap' }));
  assert.equal(ex.type, 'twap');
  assert.equal('config' in ex, false, 'no jitter requested ⇒ no config object at all');
  assert.equal('slices' in ex, false, 'a blank slice field is omitted, not sent as 0');
});

test('§28/§29: setting a jitter carries it in the config, and the values are fractions', () => {
  const ex = buildExecution(state({ strategy: 'twap', quantityJitterPct: '0.25', intervalJitterPct: '0.1' }));
  assert.equal(ex.type, 'twap');
  assert.ok('config' in ex && ex.config, 'a config is present when jitter is requested');
  assert.equal(ex.config.quantityJitterPct, 0.25, 'the percentage is parsed to a fraction');
  assert.equal(ex.config.intervalJitterPct, 0.1);
  assert.equal(ex.config.durationMs, 1_800_000, 'config.durationMs must match the execution duration');
  assert.equal(ex.config.orderType, 'market');
});

test('§28/§29: jitter is available on adaptive TWAP too, and maker-only picks the maker order type', () => {
  const ex = buildExecution(state({ strategy: 'adaptive_twap', quantityJitterPct: '0.2', makerOnly: true }));
  assert.equal(ex.type, 'adaptive_twap');
  assert.ok(ex.type === 'adaptive_twap' && ex.config, 'a config is present when jitter is requested');
  assert.equal(ex.config.orderType, 'maker', 'a maker-only execution must ask for maker child orders');
});

test('§28/§29: a typed slice count is rounded to an integer, a blank one is omitted', () => {
  const typed = buildExecution(state({ strategy: 'twap', slices: '12.6' }));
  assert.ok('slices' in typed && typed.slices === 13, '12.6 rounds to 13');
  const blank = buildExecution(state({ strategy: 'twap' }));
  assert.equal('slices' in blank, false);
});

test('§32: a blank chase budget sends no bound — the engine keeps its defaults', () => {
  const ex = buildExecution(state({ strategy: 'chase_limit' }));
  assert.equal(ex.type, 'chase_limit');
  assert.equal('maxReplacements' in ex, false, 'unset means the engine default, not zero');
  assert.equal('maxChaseDistance' in ex, false);
  assert.equal(ex.urgency, 'balanced');
});

test('§32: the chase bounds travel when the user sets them', () => {
  const ex = buildExecution(state({ strategy: 'chase_limit', maxChaseDistance: '25', maxReplacements: '7' }));
  assert.ok('maxChaseDistance' in ex && ex.maxChaseDistance === 25);
  assert.ok('maxReplacements' in ex && ex.maxReplacements === 7);
});

test('§32: a fractional replacement budget is rounded, and a zero budget IS sent (it is meaningful)', () => {
  // `0` is a legitimate instruction — place once, never reprice — so it must
  // survive the omit-if-unset rule. This is the case a naive `value || undefined`
  // filter would silently drop.
  const zero = buildExecution(state({ strategy: 'chase_limit', maxReplacements: '0' }));
  assert.ok('maxReplacements' in zero, 'an explicit 0 must be transmitted');
  assert.equal((zero as { maxReplacements: number }).maxReplacements, 0);
  const rounded = buildExecution(state({ strategy: 'chase_limit', maxReplacements: '3.7' }));
  assert.equal((rounded as { maxReplacements: number }).maxReplacements, 4);
});

test('the non-TWAP strategies still build, and carry no jitter config', () => {
  for (const strategy of ['market', 'limit', 'scale_in', 'scale_out'] as const) {
    const ex = buildExecution(state({ strategy, entryPrice: '100000', levels: [{ price: '100', fraction: '1' }] }));
    assert.equal(ex.type, strategy);
    assert.equal('config' in ex, false, `${strategy} carries no TWAP config`);
  }
});
