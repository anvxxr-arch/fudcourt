'use strict';
/**
 * executor-ui-smoke.cjs — render the real executor panels in a DOM against a
 * stubbed fetch and prove the surface works end to end.
 *
 * Throwaway verification harness — deleted after the run.
 */
const { act } = require('react');
const { Window } = require('happy-dom');

const win = new Window({ url: 'http://localhost:3000/executor/new' });
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event',
  'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'localStorage',
]) {
  Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const ReactDOMClient = require('react-dom/client');

const linkStub = { __esModule: true, default: ({ children, href }) => React.createElement('a', { href }, children) };
const navStub = { __esModule: true, useRouter: () => ({ push() {}, replace() {} }) };
require.cache[require.resolve('next/link', { paths: [__dirname] })] = { id: 'next/link', filename: 'next/link', loaded: true, exports: linkStub };
require.cache[require.resolve('next/navigation', { paths: [__dirname] })] = { id: 'next/navigation', filename: 'next/navigation', loaded: true, exports: navStub };

const calls = [];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let handler = () => json({ error: 'no handler' }, 500);
globalThis.fetch = async (path, init = {}) => {
  const method = init.method || 'GET';
  calls.push({ path, method, body: init.body === undefined ? null : JSON.parse(init.body) });
  return handler(path, init, method);
};

const ACCOUNT = {
  id: 'acc-1', userId: 'u1', exchange: 'bybit', label: 'Bybit Main', apiKeyMasked: 'abc...xyz',
  permissions: { read: true, spotTrade: true, futuresTrade: true, withdraw: null },
  health: 'ACTIVE', createdAt: 1, updatedAt: 1, lastUsedAt: null, revokedAt: null,
};

const PLAN = {
  venueKey: 'bybit:linear_perp:BTC/USDT', symbol: 'BTC/USDT', marketType: 'linear_perp', side: 'buy', intent: 'open',
  quantity: 0.024, notional: 2440, estimatedEntry: 100000, stopLoss: 98000, takeProfits: [{ price: 106000 }],
  risk: { budget: 50, estimatedTotalRisk: 49.72, priceRisk: 47.14, estimatedFees: 2.18, slippageBudget: 0.4, safetyReserve: 0.25 },
  leverage: { mode: 'auto_safe', selected: 8 }, margin: { estimatedInitial: 305, mode: 'isolated' },
  liquidation: { priceApprox: 87200, stopToLiquidationBuffer: 10800, safe: true },
  execution: { strategy: 'adaptive_twap', durationMs: 1800000, estimatedSlices: 12, urgency: 'balanced' },
  instrument: {
    symbol: 'BTC/USDT', marketType: 'linear_perp', exchange: 'bybit', baseAsset: 'BTC', quoteAsset: 'USDT',
    settlementAsset: 'USDT', tickSize: 0.1, stepSize: 0.001, minQuantity: 0.001, maxQuantity: null,
    minNotional: 5, maxNotional: null, contractMultiplier: 1, maxLeverage: 50, maintenanceMarginRate: 0.005,
    leverageBrackets: [],
  },
  feeModel: { makerBps: 2, takerBps: 5 },
  slippageModel: { slippageBps: 3, depthNotionalUsd: 50000, impactCoefficient: 0.1 },
  balanceSnapshot: { spotAvailable: null, spotEquity: null, futuresAvailable: 4000, futuresEquity: 5000, totalExchangeEquity: 5200 },
  marketSnapshot: { symbol: 'BTC/USDT', bid: 99999, ask: 100001, mid: 100000, spreadBps: 0.2, last: 100000, timestamp: 1 },
  sizingMode: 'risk_percent', sizingValue: 1, riskBasis: 'futures_equity', balanceReference: 5000,
};

function previewBody(overrides) {
  return Object.assign({
    mode: 'paper', expectedLossAtStop: -49.72, expectedProfitAtTarget: 147.32, targetPrice: 106000,
    riskReward: 2.9464, conflicts: [],
    warnings: ['quantity 0.024401 rounded DOWN to 0.024 (step 0.001, §71 risk-safe)'],
    plan: PLAN,
  }, overrides);
}

const RUNNING = {
  id: 'exec-9', userId: 'u1', accountId: 'acc-1', exchange: 'bybit', symbol: 'BTC/USDT', marketType: 'linear_perp',
  side: 'buy', intent: 'open', status: 'RUNNING', mode: 'paper', sizingMode: 'risk_percent', sizingValue: 1,
  riskBudget: 50, riskBasis: 'futures_equity', entryDefinition: { type: 'market' }, stopDefinition: { price: 98000 },
  takeProfitDefinition: [{ price: 106000 }], executionStrategy: 'adaptive_twap',
  executionConfig: { type: 'adaptive_twap', durationMs: 1800000, urgency: 'balanced' }, constraints: {},
  plannedQuantity: 0.025, plannedNotional: 2500, actualQuantity: 0.0167, actualNotional: 1670,
  averageFillPrice: 100142, estimatedFees: 2.18, actualFees: 1.4, plannedRisk: 50, currentRisk: 47.83,
  strategyState: null, createdAt: 1000, startedAt: Date.now() - 1214000, completedAt: null, cancelledAt: null,
};

const CHILD_ORDER = {
  id: 'co-1', executionId: 'exec-9', exchangeOrderId: null, clientOrderId: 'fud_exec-9_1', symbol: 'BTC/USDT',
  side: 'buy', type: 'limit', price: 100000, quantity: 0.0125, filledQuantity: 0, status: 'OPEN', isExit: false,
  submittedAt: 1001, updatedAt: 1002, filledAt: null,
};

const FILL = {
  id: 'f-1', executionId: 'exec-9', childOrderId: 'co-0', exchangeTradeId: 'tx-1', price: 100142,
  quantity: 0.0167, quoteQuantity: 1670, fee: 1.4, feeAsset: 'USDT', timestamp: 1700000,
};

const EVENT = { id: 'e-1', executionId: 'exec-9', name: 'EXECUTION_STARTED', payload: { from: 'READY', to: 'RUNNING' }, createdAt: 1700000 };

const PROFILE = {
  defaultRiskMode: 'risk_percent', defaultRisk: 1, maxRiskPerTradePct: 2, maxOpenRiskPct: 5,
  maxDailyLossPct: 5, maxLeverage: 10, defaultMarginMode: 'isolated', defaultExecutionUrgency: 'balanced',
};

const ui = require('@/features/executor/ui.js');
const client = require('@/features/executor/client.js');

const checks = [];
const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });

async function render(element) {
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => { root.render(element); });
  await act(async () => {});
  const text = () => container.textContent || '';
  const button = (label) => [...container.querySelectorAll('button')].find((b) => (b.textContent || '').includes(label));
  const click = async (element) => {
    await act(async () => { element.click(); });
    await act(async () => {});
  };
  const type = async (input, value) => {
    if (input === null) throw new Error('type() got no input — the field label does not match the form');
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    });
    await act(async () => {});
  };
  const select = async (labelText, value) => {
    // The history status filter sits in the toolbar, not in a labelled Field,
    // so fall back to matching the option list itself.
    const label = [...container.querySelectorAll('label')].find((l) => (l.textContent || '').startsWith(labelText));
    const element = label === undefined
      ? [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent === labelText))
      : label.parentElement.querySelector('select');
    const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set;
    await act(async () => {
      setter.call(element, value);
      element.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    await act(async () => {});
  };
  const field = (labelText) => {
    const label = [...container.querySelectorAll('label')].find((l) => (l.textContent || '').startsWith(labelText));
    return label === undefined ? null : label.parentElement.querySelector('input, select');
  };
  return { container, text, button, click, type, select, field, find: (needle) => text().includes(needle) };
}

(async () => {
  // ---- ExecutorComposer: §82/§83 form → §84 preview → create (§80) ----
  handler = (path) => {
    if (path === '/api/executor/accounts') return json({ accounts: [ACCOUNT] });
    if (path === '/api/executor/preview') return json({ preview: previewBody({}), liveEnabled: false });
    if (path === '/api/executor/executions') return json({ execution: { id: 'exec-1', status: 'READY' }, plan: PLAN });
    return json({ error: 'unhandled', detail: path }, 500);
  };
  const composer = await render(React.createElement(ui.ExecutorComposer));
  check('accounts fetched and first account preselected', composer.find('Bybit Main'));
  check('§84 block present before any preview', composer.find('RISK PREVIEW') && composer.find('no preview yet'));
  check('Preview blocked while a required field is missing', composer.button('Preview').disabled === true);

  await composer.type(composer.field('Stop loss'), '98000');
  await composer.click(composer.button('Preview'));

  const previewCall = calls.find((c) => c.path === '/api/executor/preview');
  check('POST /api/executor/preview called', previewCall !== undefined && previewCall.method === 'POST');
  check('symbol normalized on the wire', previewCall !== undefined && previewCall.body.symbol === 'BTC/USDT');
  check('mode paper on the wire', previewCall !== undefined && previewCall.body.mode === 'paper');
  check('accountId on the wire', previewCall !== undefined && previewCall.body.accountId === 'acc-1');
  check('risk_percent sizing with a named basis', previewCall !== undefined
    && previewCall.body.sizing.mode === 'risk_percent' && previewCall.body.sizing.balanceBasis === 'futures_equity');
  check('stop loss on the wire', previewCall !== undefined && previewCall.body.stopLoss.price === 98000);
  check('strategy params on the wire', previewCall !== undefined
    && previewCall.body.execution.type === 'adaptive_twap'
    && previewCall.body.execution.durationMs === 1800000
    && previewCall.body.execution.urgency === 'balanced');
  check('no constraint placeholders sent', previewCall !== undefined && Object.keys(previewCall.body.constraints).length === 0);
  check('margin mode omitted when the profile default is wanted', previewCall !== undefined && previewCall.body.marginMode === undefined);
  check('spot-unsafe fields absent on a perp request', previewCall !== undefined && previewCall.body.targetProfit === undefined && previewCall.body.maxRisk === undefined);

  check('§84 account equity', composer.find('$5,000'));
  check('§84 risk budget', composer.find('$50'));
  check('§84 quantity at step precision', composer.find('0.024'));
  check('§84 notional', composer.find('$2,440'));
  check('§84 margin', composer.find('$305'));
  check('§84 leverage', composer.find('8x · AUTO SAFE'));
  check('§84 estimated fees', composer.find('$2.18'));
  check('§84 loss at SL', composer.find('-$49.72'));
  check('§84 profit at TP', composer.find('+$147.32'));
  check('§84 risk/reward', composer.find('2.95'));
  check('§84 liquidation price', composer.find('$87,200'));
  check('§84 SL→liquidation buffer', composer.find('$10,800'));
  check('§84 entry estimate', composer.find('$100,000'));
  check('§80 execution line', composer.find('adaptive_twap'));
  check('warnings shown without blocking', composer.find('WARNING') && composer.find('rounded DOWN'));

  // An edit must invalidate the shown preview rather than leave stale risk.
  await composer.type(composer.field('Stop loss'), '97000');
  check('edited form clears the stale preview', composer.find('the form changed since this preview') && !composer.find('$2,440'));
  await composer.type(composer.field('Stop loss'), '98000');

  await composer.click(composer.button('Create execution'));
  check('POST /api/executor/executions called', calls.some((c) => c.path === '/api/executor/executions' && c.method === 'POST'));
  check('created execution surfaced with its id', composer.find('exec-1'));

  // A conflicting preview is listed and blocks the submit.
  handler = (path) => {
    if (path === '/api/executor/accounts') return json({ accounts: [ACCOUNT] });
    if (path === '/api/executor/preview') {
      return json({ preview: previewBody({ conflicts: [{ code: 'risk_bound_exceeded', message: 'Projected risk $60.00 exceeds the $50.00 bound.' }] }), liveEnabled: false });
    }
    return json({ error: 'unhandled' }, 500);
  };
  const blocked = await render(React.createElement(ui.ExecutorComposer));
  await blocked.type(blocked.field('Stop loss'), '98000');
  await blocked.click(blocked.button('Preview'));
  check('conflict listed with code and message', blocked.find('risk_bound_exceeded') && blocked.find('exceeds the $50.00 bound'));
  check('conflict blocks Create', blocked.button('Create execution').disabled === true);

  // Spot drops the perp-only fields from the request body (§89).
  const spot = await render(React.createElement(ui.ExecutorComposer));
  await spot.select('Market', 'spot');
  await spot.type(spot.field('Stop loss'), '98000');
  await spot.click(spot.button('Preview'));
  const spotCall = calls.filter((c) => c.path === '/api/executor/preview').pop();
  check('spot request carries no leverage or margin mode', spotCall !== undefined
    && spotCall.body.leverage === undefined && spotCall.body.marginMode === undefined);
  check('spot keeps marketType', spotCall !== undefined && spotCall.body.marketType === 'spot');


  const scaled = await render(React.createElement(ui.ExecutorComposer));
  await scaled.type(scaled.field('Stop loss'), '98000');
  await scaled.select('Method', 'scale_in');
  const scaleEditor = [...scaled.container.querySelectorAll('label')].find((l) => (l.textContent || '').startsWith('Scale levels')).parentElement;
  const levelRow = () => [...scaleEditor.querySelectorAll('div')].filter((d) => d.querySelector('input[type="number"]') && d.querySelectorAll('input[type="number"]').length === 2)[0];
  const inputs = () => [...levelRow().querySelectorAll('input')];
  console.log('A', scaled.find('execution.levels: must be a non-empty array'), scaled.button('Preview').disabled);
  await scaled.type(inputs()[0], '105000');
  console.log('B', scaled.find('execution.levels: must be a non-empty array'));
  await scaled.type(inputs()[1], '0.6');
  console.log('C', scaled.find('fractions must sum to 1 (got 0.6000)'), scaled.button('Preview').disabled);
  await scaled.type(inputs()[1], '1');
  console.log('D', scaled.find('fractions must sum to 1'), scaled.button('Preview').disabled, JSON.stringify(inputs().map(i => i.value)));
  process.exitCode = 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
