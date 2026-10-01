/**
 * Planner unit tests (PRD §8/§9/§13/§14/§16/§38/§80): run OFFLINE, no network.
 *
 * Contract under test — plan.ts's promises:
 *  - the PRD's worked examples reproduce EXACTLY at zero fees (§8, §13, §14's
 *    $40 achievable profit and $50 required risk, §16's spot flow);
 *  - the risk bound is HARD (§37/§117): a conflicting plan resizes and blocks;
 *  - Risk % and Allocation % are different concepts with different outputs (§11);
 *  - a missing stop makes every stop-based figure `null`, never 0 (§38/§116);
 *  - invalid input is a field-named error, never a silent clamp.
 *
 * Usage: cd frontend/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SLIPPAGE_MODEL,
  planExecution,
  resolveEstimatedEntry,
  sizePosition,
  validatePlanInputs,
  type PlanInputs,
} from '../../src/platform/executor/plan';
import {
  DEFAULT_RISK_PROFILE,
  type BalanceSnapshot,
  type ExecutionRequest,
  type FeeModel,
  type InstrumentMetadata,
  type MarketSnapshot,
} from '../../src/platform/executor/types';

const INSTRUMENT: InstrumentMetadata = {
  symbol: 'BTC/USDT',
  marketType: 'linear_perp',
  exchange: 'binance',
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
  maxLeverage: 125,
  maintenanceMarginRate: 0.004,
  leverageBrackets: [],
};

const NO_FEES: FeeModel = { makerBps: 0, takerBps: 0 };
const NO_SLIP = { slippageBps: 0, safetyReservePct: 0 };

const SNAPSHOT: MarketSnapshot = {
  symbol: 'BTC/USDT',
  bid: 99_995,
  ask: 100_005,
  mid: 100_000,
  spreadBps: 1,
  last: 100_000,
  timestamp: 1_760_000_000_000,
};

const BALANCES: BalanceSnapshot = {
  spotAvailable: 2_500,
  spotEquity: 2_600,
  futuresAvailable: 4_800,
  futuresEquity: 5_000,
  totalExchangeEquity: 7_500,
};

function baseRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    accountId: 'acc-1',
    symbol: 'BTC/USDT',
    marketType: 'linear_perp',
    side: 'buy',
    intent: 'open',
    entry: { type: 'limit', price: 100_000 },
    stopLoss: { price: 98_000 },
    takeProfits: [{ price: 106_000 }],
    sizing: { mode: 'risk_usd', value: 20 },
    leverage: { mode: 'manual', leverage: 5 },
    execution: { type: 'limit', price: 100_000 },
    ...overrides,
  };
}

function inputs(overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    request: baseRequest(),
    snapshot: SNAPSHOT,
    exchange: 'binance',
    instrument: INSTRUMENT,
    feeModel: NO_FEES,
    slippageModel: NO_SLIP,
    balances: BALANCES,
    riskProfile: DEFAULT_RISK_PROFILE,
    ...overrides,
  };
}

test('§8 risk USD: 20 / 2000 = 0.01 BTC, notional $1,000 (zero fees)', () => {
  const out = planExecution(inputs({
    request: baseRequest({
      stopLoss: { price: 98_000 },
      sizing: { mode: 'risk_usd', value: 20 },
    }),
  }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.plan);
  assert.equal(out.plan.quantity, 0.01);
  assert.equal(out.plan.notional, 1_000);
  assert.equal(out.plan.risk.priceRisk, 20);
  assert.equal(out.plan.risk.estimatedTotalRisk, 20);
  assert.ok(out.preview);
  assert.equal(out.preview.expectedLossAtStop, -20);
});

test('§16 spot flow: $2,500 balance, risk 1% = $25, E=100 SL=95 → 5 units / $500 capital', () => {
  const out = planExecution(inputs({
    request: baseRequest({
      marketType: 'spot',
      sizing: { mode: 'risk_percent', value: 1, balanceBasis: 'spot_available' },
      entry: { type: 'limit', price: 100 },
      stopLoss: { price: 95 },
      takeProfits: [{ price: 110 }],
      leverage: undefined,
      execution: { type: 'limit', price: 100 },
    }),
    instrument: { ...INSTRUMENT, symbol: 'BTC/USDT', stepSize: 0.0001, minNotional: 0 },
  }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.plan);
  assert.equal(out.plan.risk.budget, 25); // 1% of 2,500 spot available
  assert.equal(out.plan.quantity, 5);
  assert.equal(out.plan.notional, 500);
  // spot: no leverage, margin IS the required capital (§16).
  assert.equal(out.plan.leverage.selected, null);
  assert.equal(out.plan.margin.estimatedInitial, 500);
  assert.equal(out.plan.liquidation.priceApprox, null);
});

test('§14 dual constraint: requested $20/$100 vs achievable $40, required risk $50', () => {
  const out = planExecution(inputs({
    request: baseRequest({
      entry: { type: 'limit', price: 100 },
      stopLoss: { price: 95 },
      takeProfits: [{ price: 110 }],
      sizing: { mode: 'risk_usd', value: 20 },
      execution: { type: 'limit', price: 100 },
      targetProfit: 100,
    }),
  }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.preview);
  assert.equal(out.preview.conflicts.length, 1);
  const conflict = out.preview.conflicts[0];
  assert.equal(conflict.code, 'risk_vs_profit');
  assert.match(conflict.message, /\$40\.00/); // possible profit at the risk-bound quantity
  assert.match(conflict.message, /\$50\.00/); // required risk for the $100 target
  assert.equal(conflict.detail?.achievableProfit, 40);
  assert.equal(conflict.detail?.requiredRisk, 50);
  // The risk bound wins: the plan carries the safe quantity, never the ask.
  assert.ok(out.plan);
  assert.equal(out.plan.quantity, 4);
});

test('§13 target profit sizing: $50 over 5,000 points = 0.01 BTC', () => {
  const out = planExecution(inputs({
    request: baseRequest({
      sizing: { mode: 'target_profit_usd', value: 50 },
      stopLoss: { price: 98_000 },
      takeProfits: [{ price: 105_000 }],
    }),
  }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.plan);
  assert.equal(out.plan.quantity, 0.01);
  assert.equal(out.plan.risk.budget, null); // outcome mode carries no budget
  assert.ok(out.preview);
  assert.equal(out.preview.expectedProfitAtTarget, 50);
});

test('§38: risk sizing without a stop is refused with the field named', () => {
  const out = planExecution(inputs({
    request: baseRequest({ stopLoss: undefined }),
  }));
  assert.equal(out.plan, null);
  assert.ok(out.errors.some((e) => e.startsWith('stopLoss:')));
});

test('§38/§116: no stop on a capital mode → stop-based figures are null, never 0', () => {
  const out = planExecution(inputs({
    request: baseRequest({
      stopLoss: undefined,
      sizing: { mode: 'notional_usd', value: 1_000 },
    }),
  }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.plan);
  assert.equal(out.plan.risk.budget, null);
  assert.equal(out.plan.risk.priceRisk, null);
  assert.equal(out.plan.risk.estimatedTotalRisk, null);
  assert.equal(out.plan.risk.safetyReserve, null);
  assert.ok(out.preview);
  assert.equal(out.preview.expectedLossAtStop, null);
  assert.equal(out.preview.riskReward, null);
});

test('§11: risk % and allocation % are distinct concepts with distinct outputs', () => {
  const risk = planExecution(inputs({
    request: baseRequest({
      sizing: { mode: 'risk_percent', value: 1, balanceBasis: 'futures_equity' },
    }),
  }));
  const alloc = planExecution(inputs({
    request: baseRequest({
      sizing: { mode: 'allocation_percent', value: 20, balanceBasis: 'futures_equity' },
      stopLoss: undefined,
    }),
  }));
  assert.ok(risk.plan && alloc.plan);
  assert.equal(risk.plan.risk.budget, 50); // 1% of 5,000 = the loss bound
  assert.equal(alloc.plan.risk.budget, null); // allocation carries no loss bound
  // 20% of 5,000 = $1,000 capital deployed at entry 100,000.
  assert.equal(alloc.plan.notional, 1_000);
  assert.equal(alloc.plan.quantity, 0.01);
});

test('fees + slippage shrink quantity and hold the budget invariant', () => {
  const priced = planExecution(inputs({
    feeModel: { makerBps: 2, takerBps: 5 },
    slippageModel: { slippageBps: 5, safetyReservePct: 0.01 },
    request: baseRequest({ entry: { type: 'market' }, execution: { type: 'market' } }),
  }));
  assert.deepEqual(priced.errors, []);
  assert.ok(priced.plan);
  // Zero-fee quantity for the same risk is exactly 0.01 (§8) — cost-aware sizing
  // must never exceed it.
  assert.ok(priced.plan.quantity <= 0.01);
  assert.ok((priced.plan.risk.estimatedTotalRisk ?? 0) <= 20 + 1e-9);
  assert.ok((priced.plan.risk.estimatedFees ?? 0) > 0);
  assert.ok(priced.plan.risk.slippageBudget > 0); // market entry pays entry slippage
});

test('limit (maker) entry charges zero slippage budget', () => {
  const out = planExecution(inputs({
    feeModel: { makerBps: 2, takerBps: 5 },
    slippageModel: DEFAULT_SLIPPAGE_MODEL,
    request: baseRequest({ entry: { type: 'limit', price: 100_000 } }),
  }));
  assert.ok(out.plan);
  assert.equal(out.plan.risk.slippageBudget, 0);
});

test('§37/§117: over-budget plan is resized to the safe quantity and carries a blocking conflict', () => {
  // maxRisk far below the price risk of the fixed-quantity ask.
  const out = planExecution(inputs({
    request: baseRequest({
      sizing: { mode: 'fixed_quantity', value: 1 },
      maxRisk: 20,
    }),
  }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.plan && out.preview);
  assert.ok(out.preview.conflicts.some((c) => c.code === 'risk_bound_exceeded'));
  assert.equal(out.plan.quantity, 0.01); // the §8 safe quantity at $20 risk
  assert.ok((out.plan.risk.estimatedTotalRisk ?? 0) <= 20 + 1e-9);
});

test('validation: wrong-side stop, TP fraction overflow, spot leverage, makerOnly-vs-market', () => {
  const wrongStop = planExecution(inputs({
    request: baseRequest({ stopLoss: { price: 101_000 } }), // buy stop above entry
  }));
  assert.ok(wrongStop.errors.some((e) => e.startsWith('stopLoss.price:')));

  const fractions = planExecution(inputs({
    request: baseRequest({
      takeProfits: [{ price: 106_000, fraction: 0.7 }, { price: 108_000, fraction: 0.7 }],
    }),
  }));
  assert.ok(fractions.errors.some((e) => e.startsWith('takeProfits:')));

  const spotLev = planExecution(inputs({
    request: baseRequest({ marketType: 'spot', leverage: { mode: 'manual', leverage: 5 } }),
  }));
  assert.ok(spotLev.errors.some((e) => e.startsWith('leverage:')));

  const maker = planExecution(inputs({
    request: baseRequest({
      entry: { type: 'market' },
      execution: { type: 'market' },
      constraints: { makerOnly: true },
    }),
  }));
  assert.ok(maker.errors.some((e) => e.startsWith('execution:')));
});

test('profile caps are hard: leverage above profile max and risk above maxRiskPerTradePct are refused', () => {
  const lev = planExecution(inputs({
    request: baseRequest({ leverage: { mode: 'manual', leverage: 25 } }), // profile max 10
  }));
  assert.ok(lev.errors.some((e) => e.startsWith('leverage.leverage:')));

  const risk = planExecution(inputs({
    request: baseRequest({
      sizing: { mode: 'risk_percent', value: 5, balanceBasis: 'futures_equity' }, // cap 2%
    }),
  }));
  assert.ok(risk.errors.some((e) => e.startsWith('sizing.value:')));
});

test('§18/§20 auto leverage: selected ≤ caps, liquidation beyond stop + buffer, thin-buffer warning', () => {
  const out = planExecution(inputs({
    request: baseRequest({
      leverage: { mode: 'auto_safe', liquidationBufferPct: 0.2, maxMarginPct: 1 },
    }),
  }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.plan);
  assert.ok((out.plan.leverage.selected ?? 0) <= DEFAULT_RISK_PROFILE.maxLeverage);
  assert.ok((out.plan.leverage.selected ?? 0) <= (INSTRUMENT.maxLeverage ?? Infinity));
  assert.equal(out.plan.margin.estimatedInitial, out.plan.notional / (out.plan.leverage.selected ?? 1));
  const liq = out.plan.liquidation;
  assert.ok(liq.priceApprox !== null && out.plan.stopLoss !== null);
  assert.ok(liq.priceApprox < out.plan.stopLoss); // long: liquidation below the stop
  assert.equal(liq.safe, true);
});

test('auto leverage without a balance basis warns instead of inventing one', () => {
  const out = planExecution(inputs({
    balances: null,
    request: baseRequest({ leverage: { mode: 'auto_safe' } }),
  }));
  assert.ok(out.plan);
  assert.ok(out.preview?.warnings.some((w) => w.includes('auto_safe')));
});

test('min-notional: below the venue floor the order is refused loudly, never silently', () => {
  const out = planExecution(inputs({
    // $2 of risk at 2,000 points ⇒ 0.001 BTC ⇒ $100 notional, under the $500
    // floor the instrument declares: the venue WOULD reject it (§70).
    instrument: { ...INSTRUMENT, stepSize: 0.001, minNotional: 500 },
    request: baseRequest({ sizing: { mode: 'risk_usd', value: 2 } }),
  }));
  assert.deepEqual(out.errors, []);
  assert.ok(out.plan);
  assert.equal(out.plan.quantity, 0);
  assert.ok(out.preview?.warnings.some((w) => w.includes('minNotional')));
});

test('rounding: quantity rounds DOWN to step and never over-risks (PRD §71, §106)', () => {
  const out = planExecution(inputs({
    instrument: { ...INSTRUMENT, stepSize: 0.001 },
    request: baseRequest({ sizing: { mode: 'risk_usd', value: 25 } }),
  }));
  assert.ok(out.plan);
  // 25/2000 = 0.0125 → step 0.001 → 0.012 (DOWN), and 0.012×2000 = 24 ≤ 25.
  assert.equal(out.plan.quantity, 0.012);
  assert.ok((out.plan.risk.estimatedTotalRisk ?? 0) <= 25);
  assert.ok(out.preview?.warnings.some((w) => w.includes('rounded DOWN')));
});

test('market entry prices at the touch (conservative side), limit at its own price', () => {
  assert.equal(resolveEstimatedEntry({ entry: { type: 'market' }, side: 'buy' }, SNAPSHOT), SNAPSHOT.ask);
  assert.equal(resolveEstimatedEntry({ entry: { type: 'market' }, side: 'sell' }, SNAPSHOT), SNAPSHOT.bid);
  assert.equal(resolveEstimatedEntry({ entry: { type: 'limit', price: 99_000 }, side: 'buy' }, SNAPSHOT), 99_000);
  assert.equal(resolveEstimatedEntry({ entry: { type: 'market' }, side: 'buy' }, null), null);
});

test('unresolved percentage basis is an error naming the basis, never a fabricated 0', () => {
  const out = planExecution(inputs({
    balances: { ...BALANCES, futuresEquity: null },
    request: baseRequest({
      sizing: { mode: 'risk_percent', value: 1, balanceBasis: 'futures_equity' },
    }),
  }));
  assert.ok(out.errors.some((e) => e.includes("'futures_equity'")));
});

test('validatePlanInputs rejects a mismatched instrument and non-normalized symbol', () => {
  const errors = validatePlanInputs(
    inputs({ request: baseRequest({ symbol: 'btcusdt' }) }),
    100_000,
  );
  assert.ok(errors.some((e) => e.startsWith('symbol:')));
});

// §33 — Scale In must budget the worst case over ALL potential fills. A ladder
// fills at several prices, so pricing it like a single entry at `refPrice`
// understates the bound; risk is the fraction-weighted sum of |level − stop|.

test('§33 scale-in sizes against every level, not the single reference price', () => {
  // Ref 100,000, stop 98,000. Naive sizing risks 0.01 × 2000 = $20.
  // The ladder averages in BELOW ref, so its worst case is strictly larger and
  // the quantity must come down, not stay flat.
  const ladder = {
    type: 'scale_in' as const,
    levels: [
      { price: 100_000, fraction: 0.25 },
      { price: 98_000, fraction: 0.25 },
      { price: 96_000, fraction: 0.25 },
      { price: 94_000, fraction: 0.25 },
    ],
  };
  const out = sizePosition(
    inputs({ request: baseRequest({ entry: { type: 'limit', price: 100_000 }, execution: ladder }) }),
    100_000,
  );
  assert.deepEqual(out.errors, []);
  assert.ok(out.quantity > 0, 'a ladder inside the budget must still trade');
  // Weighted distance = .25×2000 + .25×0 + .25×2000 + .25×4000 = 2000.
  // Same as the naive figure here, so pin the exact number and the budget bound.
  assert.ok(Math.abs(out.priceRisk as number - out.quantity * 2000) < 1e-6);
  assert.ok(out.totalRisk as number <= 20 + 1e-9, 'total risk must stay inside the budget');
});

test('§33 a ladder skewed away from ref prices strictly below the naive quantity', () => {
  // Weighted distance = .5×1000 + .5×5000 = 3000 > the 2000 a single entry at
  // ref would assume, so the budgeted quantity must be smaller than 0.01.
  const ladder = {
    type: 'scale_in' as const,
    levels: [
      { price: 99_000, fraction: 0.5 },
      { price: 93_000, fraction: 0.5 },
    ],
  };
  const out = sizePosition(
    inputs({ request: baseRequest({ entry: { type: 'limit', price: 100_000 }, execution: ladder }) }),
    100_000,
  );
  assert.deepEqual(out.errors, []);
  assert.ok(out.quantity < 0.01, `expected < 0.01 for a $20 ladder, got ${out.quantity}`);
  assert.ok(out.totalRisk as number <= 20 + 1e-9);
});

test('§33 scale-in percentage risk uses the ladder too, and a degenerate ladder is refused', () => {
  const ladder = {
    type: 'scale_in' as const,
    levels: [
      { price: 99_000, fraction: 0.5 },
      { price: 93_000, fraction: 0.5 },
    ],
  };
  const pct = sizePosition(
    inputs({
      request: baseRequest({
        entry: { type: 'limit', price: 100_000 },
        execution: ladder,
        sizing: { mode: 'risk_percent', value: 1, balanceBasis: 'futures_equity' },
      }),
    }),
    100_000,
  );
  assert.deepEqual(pct.errors, []);
  // 1% of 5,000 futures equity = $50.
  assert.ok(Math.abs((pct.budget as number) - 50) < 1e-9);
  assert.ok(pct.quantity > 0 && pct.totalRisk as number <= 50 + 1e-9);

  // A level sitting ON the stop has no bounded risk; refuse rather than trade.
  const degenerate = sizePosition(
    inputs({
      request: baseRequest({
        entry: { type: 'limit', price: 100_000 },
        execution: { type: 'scale_in', levels: [{ price: 98_000, fraction: 1 }] },
      }),
    }),
    100_000,
  );
  assert.equal(degenerate.quantity, 0);
  assert.ok(degenerate.errors.length > 0 || degenerate.warnings.length > 0);
});

test('§33 a ladder reports its realized VWAP as the estimated entry, not the top level', () => {
  // 50% @ 99,000 + 50% @ 93,000 fills at 96,000. Reporting the top-level limit
  // would overstate the entry by 4,000 and mis-price liquidation (§17/§21) and
  // the R:R the user reads (§84) — all of which are keyed to `estimatedEntry`.
  const ladder = {
    type: 'scale_in' as const,
    levels: [
      { price: 99_000, fraction: 0.5 },
      { price: 93_000, fraction: 0.5 },
    ],
  };
  const out = planExecution(
    inputs({
      request: baseRequest({ entry: { type: 'limit', price: 100_000 }, execution: ladder }),
    }),
  );
  assert.deepEqual(out.errors, []);
  assert.equal(out.plan?.estimatedEntry, 96_000);
  // Notional must agree: qty × VWAP, not qty × the top level.
  assert.ok(Math.abs((out.plan?.notional ?? 0) - out.plan!.quantity * 96_000) < 1e-6);
});

test('§33 a non-ladder execution still reports its own entry price', () => {
  const out = planExecution(inputs());
  assert.equal(out.plan?.estimatedEntry, 100_000);
});

test('§37 a hard risk bound resize prices a ladder per level, not off its VWAP', () => {
  // The bound is tighter than the sizing budget, so the plan must resize. Feeding
  // a single-reference resolver the ladder's VWAP under-counts per-unit risk
  // (Σfᵢ|levelᵢ − stop|) and would return a quantity that BREACHES the bound.
  const ladder = {
    type: 'scale_in' as const,
    levels: [
      { price: 99_000, fraction: 0.5 },
      { price: 93_000, fraction: 0.5 },
    ],
  };
  const out = planExecution(
    inputs({
      request: baseRequest({
        entry: { type: 'limit', price: 100_000 },
        execution: ladder,
        sizing: { mode: 'risk_usd', value: 1_000 },
        maxRisk: 50,
      }),
    }),
  );
  assert.deepEqual(out.errors, []);
  assert.ok(out.preview?.conflicts.some((c) => c.code === 'risk_bound_exceeded'));
  assert.ok(
    (out.plan?.risk.estimatedTotalRisk ?? Infinity) <= 50 + 1e-9,
    `resized risk ${out.plan?.risk.estimatedTotalRisk} must hold the $50 bound`,
  );
  // A single-reference reading is not merely approximate here: this ladder's
  // VWAP (96,000) sits BELOW its stop (98,000), so a VWAP-based distance is
  // negative and no correct quantity follows from it. Only per-level arithmetic
  // (|99,000−98,000|, |93,000−98,000|, fraction-weighted) gives a real price
  // risk, which is why the bound above can hold at all.
  assert.ok(out.plan!.quantity > 0, 'a ladder inside the bound must still trade');
});
