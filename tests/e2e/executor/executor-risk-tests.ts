/**
 * Executor risk-engine unit tests (PRD §124–§125): OFFLINE, no network/DB/Valkey.
 *
 * Contract under test: `@/platform/executor/risk` — pure decimal-backed math.
 * The PRD worked examples are asserted FIRST and exactly (they are the spec):
 * §8 risk sizing, §9 percent budget, §13 profit sizing, §14 conflict response
 * shape, §15 solver, §16 spot flow, §20–§21 liquidation buffer. Then edges
 * (fees/slippage, rounding boundaries, min-notional, tiny/huge quantities,
 * invalid SL, leverage caps) and the PRD §125 property loops over a seeded LCG.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  riskEngine,
  calculateRiskPosition,
  calculateProfitPosition,
  estimateNetProfit,
  solvePosition,
  projectedRisk,
  maxSafeQuantity,
  autoSafeLeverage,
  liquidationPriceApprox,
  resolveBalanceBasis,
  roundQuantityDown,
  roundPrice,
} from '@/platform/executor/risk';
import type { BalanceBasis, BalanceSnapshot, FeeModel, InstrumentMetadata, SlippageModel } from '@/platform/executor/types';

const BTC: InstrumentMetadata = {
  symbol: 'BTC/USDT',
  marketType: 'linear_perp',
  exchange: 'binance',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  settlementAsset: 'USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minQuantity: null,
  maxQuantity: null,
  minNotional: null,
  maxNotional: null,
  contractMultiplier: 1,
  maxLeverage: 125,
  maintenanceMarginRate: 0.005,
  leverageBrackets: [],
};
/** Whole-unit instrument for the PRD's toy examples (E=100 …). */
const UNIT: InstrumentMetadata = { ...BTC, symbol: 'UNIT/USDT', baseAsset: 'UNIT', stepSize: 1, tickSize: 0.01 };
const NO_FEES: FeeModel = { makerBps: 0, takerBps: 0 };
const NO_SLIP: SlippageModel = { slippageBps: 0, safetyReservePct: 0 };
const FEES: FeeModel = { makerBps: 10, takerBps: 25 };
const SLIP: SlippageModel = { slippageBps: 5, safetyReservePct: 0.01 };

function assertFiniteJson(value: unknown): void {
  const round = JSON.parse(JSON.stringify(value));
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${path} is not finite: ${v}`);
    else if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, item] of Object.entries(v)) walk(item, `${path}.${k}`);
  };
  walk(round, '$');
}
/** Deterministic LCG (Numerical Recipes constants) — property loops must replay identically. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// PRD worked examples (the spec)
// ---------------------------------------------------------------------------

test('PRD §8: BTC E=100000 S=98000 risk $20 → 0.01 BTC / $1,000 at zero fees', () => {
  const pos = calculateRiskPosition({ side: 'buy', entry: 100000, stop: 98000, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: BTC });
  assert.equal(pos.quantity, 0.01);
  assert.equal(pos.unroundedQuantity, 0.01);
  assert.equal(pos.notional, 1000);
  assert.equal(pos.risk.priceRisk, 20);
  assert.equal(pos.risk.totalRisk, 20);
  assert.deepEqual(pos.warnings, []);
});

test('PRD §9: futures equity $5,000 × 1% → $50 budget, sizing identical to fixed USD', () => {
  const balances: BalanceSnapshot = {
    spotAvailable: 200,
    spotEquity: 250,
    futuresAvailable: 4900,
    futuresEquity: 5000,
    totalExchangeEquity: 5250,
    assetEquity: 3000,
    custom: 777,
  };
  const pct = 0.01;
  const budget = (resolveBalanceBasis('futures_equity', balances) ?? 0) * pct;
  assert.equal(budget, 50);
  const pos = calculateRiskPosition({ side: 'buy', entry: 100000, stop: 98000, riskBudget: budget, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: BTC });
  assert.equal(pos.quantity, 0.025);
  assert.equal(pos.notional, 2500);
});

test('PRD §13: BTC E=100000 TP=105000 profit $50 → 0.01 BTC / $1,000 at zero fees', () => {
  const res = calculateProfitPosition({ side: 'buy', entry: 100000, target: 105000, desiredProfit: 50, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: BTC });
  assert.equal(res.quantity, 0.01);
  assert.equal(res.unroundedQuantity, 0.01);
  assert.equal(res.notional, 1000);
  assert.equal(res.estimatedProfit, 50);
  assert.deepEqual(res.warnings, []);
});

test('PRD §14: E=100 SL=95 TP=110 risk $20 profit $100 → conflict exactly as printed', () => {
  const res = solvePosition({
    side: 'buy',
    instrument: UNIT,
    feeModel: NO_FEES,
    slippageModel: NO_SLIP,
    known: { entry: 100, stop: 95, target: 110, risk: 20, profit: 100 },
  });
  assert.equal(res.conflicts.length, 1);
  const conflict = res.conflicts[0];
  assert.equal(conflict.code, 'risk_vs_profit');
  assert.deepEqual(conflict.detail, { maxLoss: 20, targetProfit: 100, achievableProfit: 40, requiredRisk: 50 });
  assert.match(conflict.message, /Requested: Max Loss \$20, Target Profit \$100/);
  assert.match(conflict.message, /Possible using current SL\/TP: Max Loss \$20, Profit \$40/);
  assert.match(conflict.message, /To achieve \$100 target, Required Risk ≈ \$50/);
  // Risk cap binds: the risk-derived quantity is what stays feasible.
  assert.equal(res.solved.quantity, 4);
});

test('PRD §15: E=100 TP=120 profit $200 margin $250 → Q=10, N=$1,000, L=4x at zero fees', () => {
  const res = solvePosition({
    side: 'buy',
    instrument: UNIT,
    feeModel: NO_FEES,
    slippageModel: NO_SLIP,
    known: { entry: 100, target: 120, profit: 200, margin: 250 },
  });
  assert.deepEqual(res.solved, { entry: 100, target: 120, quantity: 10, profit: 200, margin: 250, notional: 1000, leverage: 4 });
  assert.deepEqual(res.unsatisfied, ['stop', 'risk']);
  assert.deepEqual(res.conflicts, []);
});

test('PRD §16: spot flow — balance $2,500 risk 1% E=100 SL=95 → 5 units / $500 required capital', () => {
  const balances: BalanceSnapshot = { spotAvailable: 2500, spotEquity: 2500, futuresAvailable: null, futuresEquity: null, totalExchangeEquity: 2500 };
  const basis = resolveBalanceBasis('spot_available', balances);
  assert.equal(basis, 2500);
  const pos = calculateRiskPosition({ side: 'buy', entry: 100, stop: 95, riskBudget: (basis ?? 0) * 0.01, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(pos.quantity, 5);
  assert.equal(pos.notional, 500);
});

test('PRD §20-21: E=100 SL=95 buffer 20% → liquidation safe exactly when liq ≤ 94', () => {
  // margin feasible at L=10 (N=1000, available=100): liq = 100·(1−1/10+0) = 90 ≤ 94 → safe.
  const safe = autoSafeLeverage({
    side: 'buy', entry: 100, stop: 95, notional: 1000, availableBalance: 100,
    maxLeverage: 125, exchangeMaxLeverage: null, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0,
  });
  assert.equal(safe.selected, 10);
  assert.equal(safe.liquidationPrice, 90);
  assert.equal(safe.liquidationSafe, true);
  // Margin forces L=50: liq = 100·(1−1/50+0) = 98 > 94 → the flag must say so.
  const tight = autoSafeLeverage({
    side: 'buy', entry: 100, stop: 95, notional: 1000, availableBalance: 20,
    maxLeverage: 125, exchangeMaxLeverage: null, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0,
  });
  assert.equal(tight.selected, 50);
  assert.equal(tight.liquidationPrice, 98);
  assert.equal(tight.liquidationSafe, false);
  assert.ok(tight.warnings.some((w) => w.includes('SL-to-liquidation buffer')));
});

// ---------------------------------------------------------------------------
// Rounding (PRD §71) + balance basis (PRD §10)
// ---------------------------------------------------------------------------

test('roundQuantityDown floors to the step grid (PRD §71: 0.012583 @ 0.001 → 0.012)', () => {
  assert.equal(roundQuantityDown(0.012583, BTC), 0.012);
  assert.equal(roundQuantityDown('0.012583', BTC), 0.012);
  assert.equal(roundQuantityDown(0.013, BTC), 0.013); // boundary value is preserved
  assert.equal(roundQuantityDown(0.0129999, BTC), 0.012);
  assert.equal(roundQuantityDown(0.0009, BTC), 0);
  assert.equal(roundQuantityDown(-0.005, BTC), 0);
});

test('roundPrice snaps to tick, ties half-up', () => {
  assert.equal(roundPrice(1.005, BTC), 1.01); // exact tie rounds up
  assert.equal(roundPrice(1.004, BTC), 1);
  assert.equal(roundPrice('100.0049', BTC), 100);
  assert.equal(roundPrice(98000.126, BTC), 98000.13);
});

test('resolveBalanceBasis: every basis maps explicitly; unknown/absent → null, never 0', () => {
  const full: BalanceSnapshot = { spotAvailable: 1, spotEquity: 2, futuresAvailable: 3, futuresEquity: 4, totalExchangeEquity: 5, assetEquity: 6, custom: 7 };
  assert.equal(resolveBalanceBasis('spot_available', full), 1);
  assert.equal(resolveBalanceBasis('spot_equity', full), 2);
  assert.equal(resolveBalanceBasis('futures_available', full), 3);
  assert.equal(resolveBalanceBasis('futures_equity', full), 4);
  assert.equal(resolveBalanceBasis('total_exchange_equity', full), 5);
  assert.equal(resolveBalanceBasis('asset_equity', full), 6);
  assert.equal(resolveBalanceBasis('custom', full), 7);
  const bare: BalanceSnapshot = { spotAvailable: null, spotEquity: null, futuresAvailable: null, futuresEquity: null, totalExchangeEquity: null };
  assert.equal(resolveBalanceBasis('futures_equity', bare), null);
  assert.equal(resolveBalanceBasis('asset_equity', bare), null); // caller-supplied; absent is not zero
  assert.equal(resolveBalanceBasis('custom', bare), null);
  assert.equal(resolveBalanceBasis('nonsense' as BalanceBasis, full), null);
});

// ---------------------------------------------------------------------------
// Sizing behavior: LONG + SHORT, fees, slippage, edges
// ---------------------------------------------------------------------------

test('risk sizing works mirrored for shorts', () => {
  const long = calculateRiskPosition({ side: 'buy', entry: 100, stop: 95, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  const short = calculateRiskPosition({ side: 'sell', entry: 100, stop: 105, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(long.quantity, 4);
  assert.equal(short.quantity, 4);
  assert.equal(short.notional, 400);
  assert.equal(short.risk.totalRisk, 20);
  const shortProfit = calculateProfitPosition({ side: 'sell', entry: 100, target: 90, desiredProfit: 50, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(shortProfit.quantity, 5);
  assert.equal(shortProfit.estimatedProfit, 50);
});

test('fees + slippage shrink quantity below the zero-fee size; limit entry beats market entry', () => {
  const base = calculateRiskPosition({ side: 'buy', entry: 100000, stop: 98000, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: BTC });
  const market = calculateRiskPosition({ side: 'buy', entry: 100000, stop: 98000, riskBudget: 20, feeModel: FEES, slippageModel: SLIP, instrument: BTC, entryType: 'market' });
  const limit = calculateRiskPosition({ side: 'buy', entry: 100000, stop: 98000, riskBudget: 20, feeModel: FEES, slippageModel: SLIP, instrument: BTC, entryType: 'limit' });
  assert.equal(base.quantity, 0.01);
  assert.equal(market.quantity, 0.007);
  assert.equal(limit.quantity, 0.008); // maker fee, zero entry slippage
  assert.ok(market.quantity < base.quantity && limit.quantity < base.quantity && market.quantity < limit.quantity);
  // unitRisk = 2020 + 250 + 245 + 50 = 2565 per BTC → 20/2565 = 0.00779727… retained verbatim for invariants
  assert.ok(Math.abs(market.unroundedQuantity - 20 / 2565) < 1e-12);
  assert.ok(market.unroundedQuantity > market.quantity);
  // Breakdown sums exactly: 0.007 × [2000·1.01 + 250 + 245 + 50] = 17.955
  assert.equal(market.risk.priceRisk, 14);
  assert.equal(market.risk.entryFee, 1.75);
  assert.equal(market.risk.exitFee, 1.715);
  assert.equal(market.risk.estimatedSlippage, 0.35);
  assert.equal(market.risk.safetyReserve, 0.14);
  assert.equal(market.risk.totalRisk, 17.955);
  assert.ok(market.risk.totalRisk <= 20);
});

test('stop distance extremes: huge distance → quantity 0 with warning; tiny distance still sizes safely', () => {
  const huge = calculateRiskPosition({ side: 'buy', entry: 100000, stop: 0.01, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: BTC });
  assert.equal(huge.quantity, 0);
  assert.ok(huge.warnings.some((w) => w.includes('rounds to 0')));
  const tiny = calculateRiskPosition({ side: 'buy', entry: 100, stop: 99.99999999, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.ok(tiny.quantity > 0);
  assert.ok(tiny.unroundedQuantity >= tiny.quantity);
  assert.ok(tiny.risk.totalRisk <= 20);
  assertFiniteJson(tiny);
});

test('minimum notional rejects the order with an explicit warning', () => {
  const inst: InstrumentMetadata = { ...UNIT, minNotional: 150 };
  const pos = calculateRiskPosition({ side: 'buy', entry: 100, stop: 95, riskBudget: 5, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: inst });
  assert.equal(pos.quantity, 0);
  assert.equal(pos.notional, 0);
  assert.ok(pos.warnings.some((w) => w.includes('minNotional')));
  const profit = calculateProfitPosition({ side: 'buy', entry: 100, target: 110, desiredProfit: 10, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: inst });
  assert.equal(profit.quantity, 0);
  assert.ok(profit.warnings.some((w) => w.includes('minNotional')));
});

test('tiny quantity rounds to 0 with a warning; nothing is silently ordered', () => {
  const inst: InstrumentMetadata = { ...UNIT, stepSize: 0.1 };
  const pos = calculateRiskPosition({ side: 'buy', entry: 100, stop: 95, riskBudget: 0.4, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: inst });
  assert.equal(pos.quantity, 0);
  assert.ok(pos.unroundedQuantity > 0 && pos.unroundedQuantity < 0.1);
  assert.ok(pos.warnings.some((w) => w.includes('rounds to 0')));
});

test('huge quantities keep exact cents through Decimal (1e12-scale)', () => {
  const pos = calculateRiskPosition({ side: 'buy', entry: 100000, stop: 98000, riskBudget: 123456789012.35, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: BTC });
  assert.equal(pos.quantity, 61728394.506); // 61728394.506175 floored to step 0.001
  assert.equal(pos.unroundedQuantity, 61728394.506175);
  assert.equal(pos.notional, 6172839450600);
  assert.equal(pos.risk.totalRisk, 123456789012); // 0.35 budget slack < one step of risk — no cents lost
  assert.ok(pos.risk.totalRisk <= 123456789012.35);
  assert.equal(roundQuantityDown('123456789012.345', BTC), 123456789012.345);
  assert.equal(roundPrice('123456789012.345', { ...BTC, tickSize: 0.001 }), 123456789012.345);
});

test('invalid SL / prices → empty result with explanatory warning; structurally invalid input throws', () => {
  const longWrong = calculateRiskPosition({ side: 'buy', entry: 100, stop: 101, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(longWrong.quantity, 0);
  assert.ok(longWrong.warnings.some((w) => w.includes('loss side')));
  const shortWrong = calculateRiskPosition({ side: 'sell', entry: 100, stop: 99, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(shortWrong.quantity, 0);
  assert.ok(shortWrong.warnings.some((w) => w.includes('loss side')));
  const zeroStop = calculateRiskPosition({ side: 'buy', entry: 100, stop: 0, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(zeroStop.quantity, 0);
  assert.ok(zeroStop.warnings.some((w) => w.includes('stop price must be > 0')));
  const nanEntry = calculateRiskPosition({ side: 'buy', entry: NaN, stop: 95, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(nanEntry.quantity, 0);
  assert.ok(nanEntry.warnings.some((w) => w.includes('entry must be finite')));
  assertFiniteJson(nanEntry);
  assert.throws(() => calculateRiskPosition({ side: 'buy', entry: 100, stop: 95, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: undefined as unknown as InstrumentMetadata }), /instrument/);
  assert.throws(() => calculateRiskPosition({ side: 'buy', entry: 100, stop: 95, riskBudget: 20, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: { ...BTC, symbol: undefined as unknown as string } }), /instrument/);
});

test('negative budget clamps to 0 with warning; every result JSON-round-trips finite', () => {
  const pos = calculateRiskPosition({ side: 'buy', entry: 100, stop: 95, riskBudget: -5, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(pos.quantity, 0);
  assert.equal(pos.unroundedQuantity, 0);
  assert.ok(pos.warnings.some((w) => w.includes('clamped to 0')));
  assertFiniteJson(pos);
  assertFiniteJson(calculateProfitPosition({ side: 'buy', entry: 100, target: 110, desiredProfit: -1, feeModel: FEES, slippageModel: SLIP, instrument: UNIT }));
  assertFiniteJson(solvePosition({ side: 'buy', instrument: UNIT, feeModel: NO_FEES, slippageModel: NO_SLIP, known: { entry: 100 } }));
  assertFiniteJson(autoSafeLeverage({ side: 'buy', entry: 100, stop: 95, notional: 1000, availableBalance: 250, maxLeverage: 20, exchangeMaxLeverage: null, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0.005 }));
  assertFiniteJson(maxSafeQuantity({ side: 'buy', referenceEntry: 100, stop: 95, remainingBudget: 20, filledQuantity: 2, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT }));
});

test('profit sizing is NET of costs and never overshoots desiredProfit', () => {
  const inst: InstrumentMetadata = { ...UNIT, stepSize: 0.01 };
  const res = calculateProfitPosition({ side: 'buy', entry: 100, target: 110, desiredProfit: 100, feeModel: FEES, slippageModel: SLIP, instrument: inst, entryType: 'market' });
  // unitProfit = 10 − 0.25 − 0.275 − 0.05 = 9.425 → Q* = 10.610079… → 10.61
  assert.equal(res.quantity, 10.61);
  assert.equal(res.estimatedProfit, 99.99925);
  assert.ok(res.estimatedProfit <= 100);
  assert.ok(res.unroundedQuantity > res.quantity);
  assert.equal(res.warnings.length, 0);
  // Costs shrink profit per unit, so reaching the SAME net target needs MORE quantity.
  const zeroCosts = calculateProfitPosition({ side: 'buy', entry: 100, target: 110, desiredProfit: 100, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: inst });
  assert.equal(zeroCosts.quantity, 10);
  assert.ok(zeroCosts.quantity < res.quantity);
  const impossible = calculateProfitPosition({ side: 'buy', entry: 100, target: 100.001, desiredProfit: 10, feeModel: FEES, slippageModel: SLIP, instrument: inst, entryType: 'market' });
  assert.equal(impossible.quantity, 0);
  assert.ok(impossible.warnings.some((w) => w.includes('does not cover')));
});

// ---------------------------------------------------------------------------
// estimateNetProfit (planner seam)
// ---------------------------------------------------------------------------

test('estimateNetProfit: single full-close level equals calculateProfitPosition exactly', () => {
  const profit = calculateProfitPosition({ side: 'buy', entry: 100, target: 110, desiredProfit: 100, feeModel: FEES, slippageModel: SLIP, instrument: UNIT, entryType: 'market' });
  const net = estimateNetProfit({ side: 'buy', entry: 100, quantity: profit.quantity, takeProfits: [{ price: 110 }], feeModel: FEES, slippageModel: SLIP, instrument: UNIT, entryType: 'market' });
  assert.equal(net, profit.estimatedProfit);
  const zero = estimateNetProfit({ side: 'buy', entry: 100, quantity: 4, takeProfits: [{ price: 110 }], feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(zero, 40); // PRD §14 arithmetic
});

test('estimateNetProfit: multi-level fractions sum per level; unexited remainder pays entry fee only', () => {
  const scaled = estimateNetProfit({ side: 'buy', entry: 100, quantity: 10, takeProfits: [{ price: 110, fraction: 0.5 }, { price: 120, fraction: 0.5 }], feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(scaled, 150); // 5×10 + 5×20
  // Half the position exits at 110 with 10bps fees on the FULL entry: 50 − 0.55 − 1 = 48.45
  const partial = estimateNetProfit({ side: 'buy', entry: 100, quantity: 10, takeProfits: [{ price: 110, fraction: 0.5 }], feeModel: { makerBps: 10, takerBps: 10 }, slippageModel: NO_SLIP, instrument: UNIT, entryType: 'market' });
  assert.equal(partial, 48.45);
});

test('estimateNetProfit: side-aware sign and honest negatives', () => {
  const longLoss = estimateNetProfit({ side: 'buy', entry: 100, quantity: 10, takeProfits: [{ price: 90 }], feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(longLoss, -100);
  const shortWin = estimateNetProfit({ side: 'sell', entry: 100, quantity: 10, takeProfits: [{ price: 90 }], feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(shortWin, 100);
  const shortLoss = estimateNetProfit({ side: 'sell', entry: 100, quantity: 10, takeProfits: [{ price: 110 }], feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(shortLoss, -100);
});

// ---------------------------------------------------------------------------
// Dynamic risk reconciliation (PRD §36–§37)
// ---------------------------------------------------------------------------

test('projectedRisk is linear in quantity and priced at the average entry', () => {
  const one = projectedRisk({ side: 'buy', averageEntry: 100, quantity: 2, stop: 95, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  const two = projectedRisk({ side: 'buy', averageEntry: 100, quantity: 4, stop: 95, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(one.totalRisk, 10);
  assert.equal(two.totalRisk, 20);
  assert.throws(() => projectedRisk({ side: 'buy', averageEntry: 100, quantity: 2, stop: 105, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT }), /loss side/);
});

test('maxSafeQuantity: exact remaining-budget clamp after fills', () => {
  const plan = maxSafeQuantity({ side: 'buy', referenceEntry: 100, stop: 95, remainingBudget: 20, filledQuantity: 0, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(plan.maxAdditionalQuantity, 4);
  assert.equal(plan.unroundedAdditionalQuantity, 4);
  assert.equal(plan.projectedRiskAfter.totalRisk, 20);
  const after = maxSafeQuantity({ side: 'buy', referenceEntry: 100, stop: 95, remainingBudget: 20, filledQuantity: 2, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(after.maxAdditionalQuantity, 2);
  assert.equal(after.projectedRiskAfter.totalRisk, 20); // filled 2 + added 4 = full 20
  const over = maxSafeQuantity({ side: 'buy', referenceEntry: 100, stop: 95, remainingBudget: 20, filledQuantity: 10, feeModel: NO_FEES, slippageModel: NO_SLIP, instrument: UNIT });
  assert.equal(over.maxAdditionalQuantity, 0);
  assert.ok(over.warnings.some((w) => w.includes('already consumes')));
});

test('maxSafeQuantity charges entry costs on the added leg only (filled leg already paid)', () => {
  const res = maxSafeQuantity({ side: 'buy', referenceEntry: 100, stop: 95, remainingBudget: 25, filledQuantity: 1, feeModel: { makerBps: 10, takerBps: 10 }, slippageModel: NO_SLIP, instrument: UNIT, });
  // filled unit: price risk 5 + exit 95·0.001 = 5.095 fixed. added unit: 5 + entry 0.1 + exit 0.095 = 5.195.
  // remaining 25 − 5.095 = 19.905 → 3.831… → 3 whole units.
  assert.equal(res.maxAdditionalQuantity, 3);
  assert.ok(res.unroundedAdditionalQuantity > 3 && res.unroundedAdditionalQuantity < 4);
  assert.equal(res.projectedRiskAfter.totalRisk, 5.095 + 5.195 * 3); // 20.68
  assert.ok(res.projectedRiskAfter.totalRisk <= 25);
});

// ---------------------------------------------------------------------------
// Leverage + liquidation (PRD §18–§21)
// ---------------------------------------------------------------------------

test('liquidationPriceApprox: preview-grade formulas both sides (PRD §21)', () => {
  assert.equal(liquidationPriceApprox({ side: 'buy', entry: 100, leverage: 2, maintenanceMarginRate: 0.005 }), 50.5);
  assert.equal(liquidationPriceApprox({ side: 'sell', entry: 100, leverage: 2, maintenanceMarginRate: 0.005 }), 149.5);
  assert.equal(liquidationPriceApprox({ side: 'buy', entry: 100, leverage: 10, maintenanceMarginRate: null }), 90.5); // default mmr 0.005
  assert.throws(() => liquidationPriceApprox({ side: 'buy', entry: 100, leverage: 0, maintenanceMarginRate: null }), /leverage/);
});

test('autoSafeLeverage: minimum feasible leverage, margin math exact (N=1000 avail=250 → 4x)', () => {
  const res = autoSafeLeverage({ side: 'buy', entry: 100, stop: 95, notional: 1000, availableBalance: 250, maxLeverage: 50, exchangeMaxLeverage: 100, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0.005 });
  assert.equal(res.selected, 4);
  assert.equal(res.estimatedMargin, 250);
  assert.equal(res.liquidationPrice, 75.5);
  assert.equal(res.liquidationSafe, true);
  assert.deepEqual(res.warnings, []);
  // Margin policy caps margin at maxMarginPct of balance: N=1000 avail=1000 → 1x, margin $1000.
  const low = autoSafeLeverage({ side: 'buy', entry: 100, stop: 95, notional: 1000, availableBalance: 1000, maxLeverage: 50, exchangeMaxLeverage: null, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0.005 });
  assert.equal(low.selected, 1);
  assert.equal(low.estimatedMargin, 1000);
});

test('autoSafeLeverage: leverage caps enforced (user + exchange) with honest infeasibility', () => {
  // Margin lower bound 400x exceeds both caps → selected = exchange cap, infeasible, NEVER claimed safe.
  const over = autoSafeLeverage({ side: 'buy', entry: 100, stop: 95, notional: 100000, availableBalance: 250, maxLeverage: 250, exchangeMaxLeverage: 200, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0.005 });
  assert.equal(over.selected, 200); // min(user 250, exchange 200)
  assert.equal(over.liquidationSafe, false);
  assert.ok(over.warnings.some((w) => w.includes('insufficient available balance for margin at max leverage')));
  // User cap below the margin lower bound: selected = user cap + the same warning.
  const userCap = autoSafeLeverage({ side: 'buy', entry: 100, stop: 95, notional: 1000, availableBalance: 250, maxLeverage: 3, exchangeMaxLeverage: 200, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0.005 });
  assert.equal(userCap.selected, 3);
  assert.equal(userCap.liquidationSafe, false);
  assert.ok(userCap.warnings.some((w) => w.includes('insufficient available balance')));
  // Cap below 1 is structurally unselectable.
  const none = autoSafeLeverage({ side: 'buy', entry: 100, stop: 95, notional: 1000, availableBalance: 250, maxLeverage: 0, exchangeMaxLeverage: null, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0.005 });
  assert.equal(none.liquidationSafe, false);
  assert.ok(none.warnings.length > 0);
});

test('autoSafeLeverage: liquidation safety honest when the minimum feasible leverage is unsafe', () => {
  // N=1000 avail=45 → lower bound 23x → liq ≈ 96.15 sits INSIDE the 94 buffer target.
  const res = autoSafeLeverage({ side: 'buy', entry: 100, stop: 95, notional: 1000, availableBalance: 45, maxLeverage: 125, exchangeMaxLeverage: null, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0.005 });
  assert.equal(res.selected, 23);
  assert.equal(res.liquidationPrice, 96.152173913043); // 100·(1 − 1/23 + 0.005), wire-rounded to 12 dp
  assert.equal(res.liquidationSafe, false);
  assert.ok(res.warnings.some((w) => w.includes('SL-to-liquidation buffer')));
  // No stop → safety cannot be verified and is NOT claimed.
  const noStop = autoSafeLeverage({ side: 'buy', entry: 100, stop: null, notional: 1000, availableBalance: 250, maxLeverage: 50, exchangeMaxLeverage: null, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0.005 });
  assert.equal(noStop.liquidationSafe, false);
  assert.ok(noStop.warnings.some((w) => w.includes('cannot be verified')));
});

test('autoSafeLeverage: short side buffer mirrored', () => {
  const res = autoSafeLeverage({ side: 'sell', entry: 100, stop: 105, notional: 1000, availableBalance: 100, maxLeverage: 125, exchangeMaxLeverage: null, liquidationBufferPct: 0.2, maxMarginPct: 1, maintenanceMarginRate: 0 });
  // liq = 100·(1+1/10−0) = 110 ≥ 105 + 5·0.2 = 106 → safe.
  assert.equal(res.selected, 10);
  assert.equal(res.liquidationPrice, 110);
  assert.equal(res.liquidationSafe, true);
});

// ---------------------------------------------------------------------------
// Constraint solver (PRD §15)
// ---------------------------------------------------------------------------

test('solvePosition: fully consistent known set fills every derived value', () => {
  const res = solvePosition({ side: 'buy', instrument: UNIT, feeModel: NO_FEES, slippageModel: NO_SLIP, known: { entry: 100, stop: 95, target: 110, quantity: 4 } });
  assert.deepEqual(res.conflicts, []);
  assert.equal(res.solved.risk, 20);
  assert.equal(res.solved.profit, 40);
  assert.equal(res.solved.notional, 400);
  assert.deepEqual(res.unsatisfied, ['margin', 'leverage']);
});

test('solvePosition: margin/notional/leverage propagation in every direction', () => {
  const fromMargin = solvePosition({ side: 'buy', instrument: UNIT, feeModel: NO_FEES, slippageModel: NO_SLIP, known: { entry: 100, quantity: 4, margin: 100 } });
  assert.equal(fromMargin.solved.notional, 400);
  assert.equal(fromMargin.solved.leverage, 4);
  const fromLeverage = solvePosition({ side: 'buy', instrument: UNIT, feeModel: NO_FEES, slippageModel: NO_SLIP, known: { leverage: 4, margin: 250 } });
  assert.equal(fromLeverage.solved.notional, 1000);
  const fromNotional = solvePosition({ side: 'buy', instrument: UNIT, feeModel: NO_FEES, slippageModel: NO_SLIP, known: { notional: 1000, leverage: 4 } });
  assert.equal(fromNotional.solved.margin, 250);
});

test('solvePosition: underdetermined lists unknowns without guessing; contradictions conflict', () => {
  const open = solvePosition({ side: 'buy', instrument: UNIT, feeModel: NO_FEES, slippageModel: NO_SLIP, known: { entry: 100 } });
  assert.deepEqual(open.solved, { entry: 100 });
  assert.deepEqual(open.conflicts, []);
  assert.deepEqual(open.unsatisfied, ['stop', 'target', 'quantity', 'risk', 'profit', 'margin', 'notional', 'leverage']);
  const bad = solvePosition({ side: 'buy', instrument: UNIT, feeModel: NO_FEES, slippageModel: NO_SLIP, known: { entry: 100, stop: 95, quantity: 4, risk: 30 } });
  assert.ok(bad.conflicts.some((c) => c.code === 'inconsistent_known_values'));
  const badStop = solvePosition({ side: 'buy', instrument: UNIT, feeModel: NO_FEES, slippageModel: NO_SLIP, known: { entry: 100, stop: 105, quantity: 4 } });
  assert.ok(badStop.conflicts.some((c) => c.code === 'invalid_stop'));
});

test('solvePosition: agreeing risk + profit targets produce no conflict', () => {
  const res = solvePosition({ side: 'buy', instrument: UNIT, feeModel: NO_FEES, slippageModel: NO_SLIP, known: { entry: 100, stop: 95, target: 110, risk: 20, profit: 40 } });
  assert.deepEqual(res.conflicts, []);
  assert.equal(res.solved.quantity, 4);
});

// ---------------------------------------------------------------------------
// PRD §125 property-style loops (seeded, deterministic)
// ---------------------------------------------------------------------------

test('property: rounded quantity never exceeds the risk budget (240 seeded cases)', () => {
  const rand = lcg(0xc0ffee);
  for (let i = 0; i < 240; i++) {
    const entry = 10 + rand() * 99990;
    const dist = 0.001 + rand() * 50;
    const side = rand() < 0.5 ? 'buy' : 'sell';
    const stop = side === 'buy' ? entry - dist : entry + dist;
    const budget = 0.01 + rand() * 10000;
    const step = [0.001, 0.01, 0.1, 0.5][Math.floor(rand() * 4)];
    const feeModel: FeeModel = { makerBps: rand() * 30, takerBps: rand() * 50 };
    const slippageModel: SlippageModel = { slippageBps: rand() * 20, safetyReservePct: rand() * 0.05 };
    const instrument: InstrumentMetadata = { ...UNIT, stepSize: step };
    const pos = calculateRiskPosition({ side, entry, stop, riskBudget: budget, feeModel, slippageModel, instrument, entryType: rand() < 0.5 ? 'market' : 'limit' });
    assert.ok(pos.quantity >= 0 && pos.notional >= 0 && pos.risk.totalRisk >= 0, `case ${i}: negative output`);
    assert.ok(pos.quantity <= pos.unroundedQuantity, `case ${i}: rounded > unrounded`);
    assert.ok(pos.risk.totalRisk <= budget * (1 + 1e-9), `case ${i}: ${pos.risk.totalRisk} > budget ${budget}`);
  }
});

test('property: increasing risk budget never reduces safe quantity (60 seeded shapes)', () => {
  const rand = lcg(7);
  for (let i = 0; i < 60; i++) {
    const entry = 10 + rand() * 99990;
    const dist = 0.01 + rand() * 100;
    const side = rand() < 0.5 ? 'buy' : 'sell';
    const stop = side === 'buy' ? entry - dist : entry + dist;
    const instrument: InstrumentMetadata = { ...UNIT, stepSize: [0.001, 0.01, 0.1][Math.floor(rand() * 3)] };
    let prev = -1;
    for (const budget of [0.1, 1, 5, 20, 100, 500, 2500, 12000]) {
      const pos = calculateRiskPosition({ side, entry, stop, riskBudget: budget, feeModel: FEES, slippageModel: SLIP, instrument });
      assert.ok(pos.quantity >= prev, `case ${i}: budget ↑ quantity ↓ (${prev} → ${pos.quantity})`);
      prev = pos.quantity;
    }
  }
});

test('property: SL closer never reduces, SL further never increases theoretical quantity', () => {
  const rand = lcg(99);
  for (let i = 0; i < 60; i++) {
    const entry = 10 + rand() * 99990;
    const side = rand() < 0.5 ? 'buy' : 'sell';
    let prev = -1;
    for (const dist of [100, 50, 20, 10, 5, 2, 1, 0.5]) {
      // dist is descending → SL moves CLOSER: theoretical quantity must never fall.
      const stop = side === 'buy' ? entry - dist : entry + dist;
      const pos = calculateRiskPosition({ side, entry, stop, riskBudget: 25, feeModel: FEES, slippageModel: SLIP, instrument: UNIT });
      assert.ok(pos.unroundedQuantity >= prev * (1 - 1e-12), `case ${i}: SL closer reduced quantity (${prev} → ${pos.unroundedQuantity})`);
      prev = pos.unroundedQuantity;
    }
  }
});

test('property: maxSafeQuantity stays inside budget and caps by min(user, exchange) leverage (200 seeded cases)', () => {
  const rand = lcg(424242);
  for (let i = 0; i < 200; i++) {
    const entry = 10 + rand() * 99990;
    const dist = 0.01 + rand() * 50;
    const side = rand() < 0.5 ? 'buy' : 'sell';
    const stop = side === 'buy' ? entry - dist : entry + dist;
    const budget = 1 + rand() * 5000;
    const filled = rand() * 50;
    const feeModel: FeeModel = { makerBps: rand() * 20, takerBps: rand() * 40 };
    const slippageModel: SlippageModel = { slippageBps: rand() * 10, safetyReservePct: rand() * 0.02 };
    const res = maxSafeQuantity({ side, referenceEntry: entry, stop, remainingBudget: budget, filledQuantity: filled, feeModel, slippageModel, instrument: UNIT });
    assert.ok(res.maxAdditionalQuantity >= 0, `case ${i}: negative add`);
    assert.ok(res.maxAdditionalQuantity <= res.unroundedAdditionalQuantity, `case ${i}: rounded > unrounded`);
    assert.ok(res.projectedRiskAfter.totalRisk <= budget * (1 + 1e-9), `case ${i}: ${res.projectedRiskAfter.totalRisk} > ${budget}`);

    const userMax = 1 + Math.floor(rand() * 100);
    const exchangeMax = rand() < 0.3 ? null : 1 + Math.floor(rand() * 120);
    const lev = autoSafeLeverage({
      side, entry, stop, notional: rand() * 100000, availableBalance: rand() * 5000,
      maxLeverage: userMax, exchangeMaxLeverage: exchangeMax,
      liquidationBufferPct: rand() * 0.5, maxMarginPct: 0.01 + rand(), maintenanceMarginRate: rand() * 0.01,
    });
    const cap = exchangeMax === null ? userMax : Math.min(userMax, exchangeMax);
    assert.ok(lev.selected >= 1 && lev.selected <= cap, `case ${i}: selected ${lev.selected} outside [1, ${cap}]`);
  }
});

test('RiskEngine surface exposes every contract method', () => {
  for (const name of [
    'calculateRiskPosition', 'calculateProfitPosition', 'solvePosition', 'projectedRisk', 'maxSafeQuantity',
    'autoSafeLeverage', 'liquidationPriceApprox', 'resolveBalanceBasis', 'roundQuantityDown', 'roundPrice',
  ]) {
    assert.equal(typeof (riskEngine as unknown as Record<string, unknown>)[name], 'function', `riskEngine.${name} missing`);
  }
});
