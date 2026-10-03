/**
 * risk.ts — the pure risk engine (PRD §102: no HTTP, no DB, no exchange API, no frontend).
 *
 * Money math is `decimal.js` throughout (PRD §71); `number` appears only at the
 * wire edge. Every exposure quantity is rounded DOWN to the step grid so a
 * rounded position can never exceed the unrounded budget (PRD §106).
 *
 * Cost model (PRD §22–§23): with mult = contractMultiplier,
 *   priceRisk     = Q·mult·|E−S|
 *   entryFee      = Q·mult·E·(entryType==='limit' ? makerBps : takerBps)/1e4
 *   exitFee       = Q·mult·S·takerBps/1e4      (risk figures exit at the stop)
 *   slippageRisk  = Q·mult·E·slippageBps/1e4   (market entries only; ONCE)
 *   safetyReserve = priceRisk·safetyReservePct (fraction of PRICE RISK)
 *   totalRisk     = Σ = Q·unitRisk             — exactly linear in Q.
 * Profit figures exit at the target instead of the stop and are NET of the same
 * costs (PRD §13): netProfit(Q) = Q·mult·|T−E| − entryFee(T) − exitFee(T) − slip.
 *
 * NaN/±Infinity never leaves this module: structurally invalid input throws a
 * plain Error, numeric edge cases clamp to 0 with a warning (wherever a result
 * carries warnings), and every result JSON-round-trips unchanged. Functions
 * whose frozen result shape has no `warnings` channel (`projectedRisk`,
 * `liquidationPriceApprox`, `round*`) throw on non-finite numbers instead of
 * fabricating a value.
 */
import Decimal from 'decimal.js';
import type {
  AutoLeverageInput,
  AutoLeverageResult,
  BalanceBasis,
  BalanceSnapshot,
  ConstraintConflict,
  FeeModel,
  InstrumentMetadata,
  MaxSafeQuantityInput,
  MaxSafeQuantityResult,
  ProfitPositionInput,
  ProfitPositionResult,
  ProjectedRiskInput,
  RiskBreakdown,
  RiskEngine,
  RiskPositionInput,
  Side,
  SizedPosition,
  SlippageModel,
  SolveInput,
  SolveResult,
  TakeProfitDefinition,
} from '@/platform/executor/types';

const D = Decimal.clone({ precision: 50 });
type Dec = InstanceType<typeof Decimal>;

const BPS = new D('10000');
const ONE = new D(1);
const ZERO = new D(0);
const DEFAULT_MMR = new D('0.005');

function num(v: number, name: string): Dec {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number`);
  return new D(v);
}
function str(v: number | string, name: string): Dec {
  const d = new D(v);
  if (!d.isFinite()) throw new Error(`${name} must be a finite decimal`);
  return d;
}
/** Nullable read for warning-carrying flows: non-finite is a numeric edge, never a throw. */
function readNum(v: number, name: string, warnings: string[]): Dec | null {
  if (typeof v !== 'number') throw new Error(`${name} must be a number`);
  if (!Number.isFinite(v)) {
    warnings.push(`${name} must be finite; got ${String(v)}`);
    return null;
  }
  return new D(v);
}
function requireInstrument(instrument: InstrumentMetadata): void {
  if (!instrument || typeof instrument.symbol !== 'string') throw new Error('instrument metadata is required');
}
function clampNeg(d: Dec, name: string, warnings: string[]): Dec {
  if (d.isNegative()) {
    warnings.push(`${name} was negative; clamped to 0`);
    return ZERO;
  }
  return d;
}
function checkPrices(entry: Dec, stop: Dec | null, target: Dec | null, side: Side, warnings: string[]): boolean {
  let ok = true;
  if (entry.lte(0)) {
    warnings.push('entry price must be > 0');
    ok = false;
  }
  if (stop && stop.lte(0)) {
    warnings.push('stop price must be > 0');
    ok = false;
  }
  if (target && target.lte(0)) {
    warnings.push('target price must be > 0');
    ok = false;
  }
  if (!ok) return false;
  if (stop && (side === 'buy' ? stop.gte(entry) : stop.lte(entry))) {
    warnings.push(`stop must be on the loss side of entry for a ${side === 'buy' ? 'long' : 'short'} (S < E for long, S > E for short)`);
    ok = false;
  }
  return ok;
}
function feeRates(feeModel: FeeModel, entryType: 'market' | 'limit' | undefined): { rE: Dec; rX: Dec } {
  if (!feeModel) throw new Error('feeModel is required');
  const rE = num(entryType === 'limit' ? feeModel.makerBps : feeModel.takerBps, 'feeBps').div(BPS);
  const rX = num(feeModel.takerBps, 'takerBps').div(BPS);
  return { rE: rE.isNegative() ? ZERO : rE, rX: rX.isNegative() ? ZERO : rX };
}
function slipRates(slippageModel: SlippageModel, entryType: 'market' | 'limit' | undefined): { slip: Dec; reservePct: Dec } {
  if (!slippageModel) throw new Error('slippageModel is required');
  let slip = num(slippageModel.slippageBps, 'slippageBps').div(BPS);
  if (slip.isNegative() || entryType === 'limit') slip = ZERO;
  const reservePct = clampNeg(num(slippageModel.safetyReservePct, 'safetyReservePct'), 'safetyReservePct', []);
  return { slip, reservePct };
}
function multOf(instrument: InstrumentMetadata): Dec {
  const m = num(instrument.contractMultiplier ?? 1, 'contractMultiplier');
  return m.lte(0) ? ONE : m;
}
function stepOf(instrument: InstrumentMetadata): Dec {
  const step = num(instrument.stepSize, 'stepSize');
  if (step.lte(0)) throw new Error('instrument stepSize must be > 0');
  return step;
}
function floorStep(q: Dec, step: Dec): Dec {
  return q.div(step).toDecimalPlaces(0, D.ROUND_DOWN).times(step);
}
/** Wire conversion — the only place Dec becomes number (PRD §71). 12 dp kills float dust. */
function toWire(d: Dec): number {
  return d.toDecimalPlaces(12, D.ROUND_HALF_UP).toNumber();
}
function usd(d: Dec): string {
  const s = d.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}
/** unitRisk (contract): mult·[|E−S|·(1+safetyPct) + E·rE + S·rX + E·slip] — linear in Q. */
function unitRiskDec(e: Dec, s: Dec, mult: Dec, rE: Dec, rX: Dec, slip: Dec, reservePct: Dec): Dec {
  return mult.times(e.minus(s).abs().times(ONE.plus(reservePct)).plus(e.times(rE)).plus(s.times(rX)).plus(e.times(slip)));
}
/** unitProfit (contract): mult·[|T−E| − E·rE − T·rX − E·slip] — NET per unit at the target. */
function unitProfitDec(e: Dec, t: Dec, mult: Dec, rE: Dec, rX: Dec, slip: Dec): Dec {
  return mult.times(t.minus(e).abs().minus(e.times(rE)).minus(t.times(rX)).minus(e.times(slip)));
}
/**
 * Breakdown split by leg: `qRisk` pays price risk + exit fee (position size),
 * `qEntry` pays entry fee + entry slippage (only the newly-opened size). Equal
 * for whole-position views; the split is what makes fill reconciliation (PRD
 * §36–§37) exact.
 */
function breakdownAt(qRisk: Dec, qEntry: Dec, e: Dec, s: Dec, mult: Dec, rE: Dec, rX: Dec, slip: Dec, reservePct: Dec): RiskBreakdown {
  const priceRisk = qRisk.times(mult).times(e.minus(s).abs());
  const entryFee = qEntry.times(mult).times(e).times(rE);
  const exitFee = qRisk.times(mult).times(s).times(rX);
  const estimatedSlippage = qEntry.times(mult).times(e).times(slip);
  const safetyReserve = priceRisk.times(reservePct);
  return {
    priceRisk: toWire(priceRisk),
    entryFee: toWire(entryFee),
    exitFee: toWire(exitFee),
    estimatedSlippage: toWire(estimatedSlippage),
    safetyReserve: toWire(safetyReserve),
    totalRisk: toWire(priceRisk.plus(entryFee).plus(exitFee).plus(estimatedSlippage).plus(safetyReserve)),
  };
}

// ---------------------------------------------------------------------------
// Rounding (PRD §70–§71)
// ---------------------------------------------------------------------------

/** Risk-safe quantity rounding: DOWN to a stepSize multiple (exposure never rounds up). */
export function roundQuantityDown(quantity: number | string, instrument: InstrumentMetadata): number {
  requireInstrument(instrument);
  const rounded = floorStep(str(quantity, 'quantity'), stepOf(instrument));
  return rounded.lte(0) ? 0 : rounded.toNumber();
}

/** Round a price to tick size, ties half-up. */
export function roundPrice(price: number | string, instrument: InstrumentMetadata): number {
  requireInstrument(instrument);
  const tick = num(instrument.tickSize, 'tickSize');
  if (tick.lte(0)) throw new Error('instrument tickSize must be > 0');
  return str(price, 'price').div(tick).toDecimalPlaces(0, D.ROUND_HALF_UP).times(tick).toNumber();
}

// ---------------------------------------------------------------------------
// Balance basis (PRD §10)
// ---------------------------------------------------------------------------

/** Unknown or absent basis → null. NEVER 0: a missing balance is not a zero balance. */
export function resolveBalanceBasis(basis: BalanceBasis, balances: BalanceSnapshot, _symbol?: string): number | null {
  if (!balances) throw new Error('balances snapshot is required');
  switch (basis) {
    case 'spot_available':
      return balances.spotAvailable ?? null;
    case 'spot_equity':
      return balances.spotEquity ?? null;
    case 'futures_available':
      return balances.futuresAvailable ?? null;
    case 'futures_equity':
      return balances.futuresEquity ?? null;
    case 'total_exchange_equity':
      return balances.totalExchangeEquity ?? null;
    case 'asset_equity':
      return balances.assetEquity ?? null;
    case 'custom':
      return balances.custom ?? null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Risk sizing (PRD §8, §22)
// ---------------------------------------------------------------------------

export function calculateRiskPosition(input: RiskPositionInput): SizedPosition {
  const warnings: string[] = [];
  if (!input || !input.instrument) throw new Error('instrument metadata is required');
  requireInstrument(input.instrument);
  const instrument = input.instrument;
  const side: Side = input.side === 'sell' ? 'sell' : 'buy';
  const entryType = input.entryType;
  const { rE, rX } = feeRates(input.feeModel, entryType);
  const { slip, reservePct } = slipRates(input.slippageModel, entryType);
  const mult = multOf(instrument);
  const e = readNum(input.entry, 'entry', warnings);
  const s = readNum(input.stop, 'stop', warnings);
  const budgetRaw = readNum(input.riskBudget, 'riskBudget', warnings);
  const empty = (extra: string[]): SizedPosition => ({
    quantity: 0,
    unroundedQuantity: 0,
    notional: 0,
    risk: breakdownAt(ZERO, ZERO, e ?? ZERO, s ?? ZERO, mult, rE, rX, slip, reservePct),
    warnings: [...warnings, ...extra],
  });
  if (e === null || s === null || budgetRaw === null) return empty([]);
  const budget = clampNeg(budgetRaw, 'riskBudget', warnings);
  if (!checkPrices(e, s, null, side, warnings)) return empty([]);
  const distance = e.minus(s).abs();
  if (distance.lte(0)) return empty(['entry and stop coincide (|E−S| = 0); risk per unit is 0, quantity 0']);

  const unit = unitRiskDec(e, s, mult, rE, rX, slip, reservePct);
  const unrounded = budget.div(unit);
  const step = stepOf(instrument);
  let q = floorStep(unrounded, step);
  if (q.lte(0)) {
    warnings.push(`quantity rounds to 0 at stepSize ${step.toString()}; nothing to order`);
    q = ZERO;
  }
  else if (q.lt(unrounded)) {
    // Rounding is a real reduction in exposure: the caller must be able to see
    // it, so the preview never silently presents a risk-safe size as if it were
    // the exact solve (PRD §71/§116 honesty).
    warnings.push(`quantity ${unrounded.toString()} rounded DOWN to ${q.toString()} at step ${step.toString()}`);
  }
  let notional = q.times(e).times(mult);
  // Instrument bounds (PRD §70) reject with a warning — never silently.
  if (instrument.minNotional != null && notional.gt(0) && notional.lt(new D(instrument.minNotional))) {
    warnings.push(`notional ${toWire(notional)} below minNotional ${instrument.minNotional}; order rejected`);
    q = ZERO;
    notional = ZERO;
  }
  if (instrument.maxNotional != null && notional.gt(new D(instrument.maxNotional))) {
    warnings.push(`notional ${toWire(notional)} above maxNotional ${instrument.maxNotional}; order rejected`);
    q = ZERO;
    notional = ZERO;
  }
  if (instrument.minQuantity != null && q.gt(0) && q.lt(new D(instrument.minQuantity))) {
    warnings.push(`quantity below minQuantity ${instrument.minQuantity}; order rejected`);
    q = ZERO;
    notional = ZERO;
  }
  if (instrument.maxQuantity != null && q.gt(new D(instrument.maxQuantity))) {
    warnings.push(`quantity above maxQuantity ${instrument.maxQuantity}; clamped down`);
    q = floorStep(new D(instrument.maxQuantity), step);
    notional = q.times(e).times(mult);
  }
  return {
    quantity: q.toNumber(),
    unroundedQuantity: unrounded.toNumber(),
    notional: notional.toNumber(),
    risk: breakdownAt(q, q, e, s, mult, rE, rX, slip, reservePct),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Profit sizing (PRD §13) — NET of costs
// ---------------------------------------------------------------------------

export function calculateProfitPosition(input: ProfitPositionInput): ProfitPositionResult {
  const warnings: string[] = [];
  if (!input || !input.instrument) throw new Error('instrument metadata is required');
  requireInstrument(input.instrument);
  const instrument = input.instrument;
  const side: Side = input.side === 'sell' ? 'sell' : 'buy';
  const entryType = input.entryType;
  const { rE, rX } = feeRates(input.feeModel, entryType);
  const { slip, reservePct } = slipRates(input.slippageModel, entryType);
  const mult = multOf(instrument);
  const e = readNum(input.entry, 'entry', warnings);
  const t = readNum(input.target, 'target', warnings);
  const desiredRaw = readNum(input.desiredProfit, 'desiredProfit', warnings);
  const empty = (extra: string[]): ProfitPositionResult => ({
    quantity: 0,
    unroundedQuantity: 0,
    notional: 0,
    estimatedProfit: 0,
    risk: null,
    warnings: [...warnings, ...extra],
  });
  if (e === null || t === null || desiredRaw === null) return empty([]);
  const desired = clampNeg(desiredRaw, 'desiredProfit', warnings);
  if (!checkPrices(e, null, t, side, warnings)) return empty([]);
  if (side === 'buy' ? t.lte(e) : t.gte(e)) return empty(['target must be on the profit side of entry (T > E for long, T < E for short)']);
  const distance = t.minus(e).abs();
  if (distance.lte(0)) return empty(['entry and target coincide (|T−E| = 0); profit per unit is −costs, quantity 0']);

  const unitProfit = unitProfitDec(e, t, mult, rE, rX, slip);
  if (unitProfit.lte(0)) {
    return empty(['target move does not cover fees + slippage per unit; desired profit is unachievable, quantity 0']);
  }
  const unrounded = desired.div(unitProfit);
  const step = stepOf(instrument);
  let q = floorStep(unrounded, step);
  if (q.lte(0)) {
    warnings.push(`quantity rounds to 0 at stepSize ${step.toString()}; nothing to order`);
    q = ZERO;
  }
  // Estimated profit is NET at the rounded quantity, hence always <= desiredProfit.
  let profit = q.times(unitProfit);
  let notional = q.times(e).times(mult);
  if (instrument.minNotional != null && notional.gt(0) && notional.lt(new D(instrument.minNotional))) {
    warnings.push(`notional ${toWire(notional)} below minNotional ${instrument.minNotional}; order rejected`);
    q = ZERO;
    notional = ZERO;
    profit = ZERO;
  }
  if (instrument.minQuantity != null && q.gt(0) && q.lt(new D(instrument.minQuantity))) {
    warnings.push(`quantity below minQuantity ${instrument.minQuantity}; order rejected`);
    q = ZERO;
    notional = ZERO;
    profit = ZERO;
  }
  return {
    quantity: q.toNumber(),
    unroundedQuantity: unrounded.toNumber(),
    notional: notional.toNumber(),
    estimatedProfit: toWire(profit),
    risk: breakdownAt(q, q, e, t, mult, rE, rX, slip, reservePct),
    warnings,
  };
}

/**
 * Net profit if the take-profit plan fills exactly as given (planner seam).
 * Each level closes `quantity × (fraction ?? 1)`; the unexited remainder earns
 * no profit but still carries its share of the entry fee. Move sign follows the
 * side (buy: T > E is profit; sell: T < E is profit). Negative results are
 * returned honestly, never clamped. With one full-close level this equals
 * `calculateProfitPosition(...).estimatedProfit` for the same quantity exactly.
 */
export function estimateNetProfit(input: {
  side: Side;
  entry: number;
  quantity: number;
  takeProfits: TakeProfitDefinition[];
  feeModel: FeeModel;
  slippageModel: SlippageModel;
  instrument: InstrumentMetadata;
  entryType?: 'market' | 'limit';
}): number {
  if (!input || !input.instrument) throw new Error('instrument metadata is required');
  requireInstrument(input.instrument);
  const e = num(input.entry, 'entry');
  const q = clampNeg(num(input.quantity, 'quantity'), 'quantity', []);
  const entryType = input.entryType;
  const { rE, rX } = feeRates(input.feeModel, entryType);
  const { slip } = slipRates(input.slippageModel, entryType);
  const mult = multOf(input.instrument);
  const dir = input.side === 'sell' ? ONE.negated() : ONE;

  let net = ZERO;
  for (const tp of input.takeProfits ?? []) {
    const t = num(tp.price, 'takeProfits[].price');
    const rawFraction = tp.fraction == null ? ONE : num(tp.fraction, 'takeProfits[].fraction');
    const f = Decimal.min(Decimal.max(rawFraction, ZERO), ONE);
    const slice = q.times(f);
    net = net
      .plus(slice.times(mult).times(t.minus(e).times(dir)))
      .minus(slice.times(mult).times(t).times(rX));
  }
  net = net.minus(q.times(mult).times(e).times(rE)).minus(q.times(mult).times(e).times(slip));
  return toWire(net);
}

// ---------------------------------------------------------------------------
// Filled-position risk + remaining-budget resize (PRD §36–§37)
// ---------------------------------------------------------------------------

export function projectedRisk(input: ProjectedRiskInput): RiskBreakdown {
  if (!input || !input.instrument) throw new Error('instrument metadata is required');
  requireInstrument(input.instrument);
  const side: Side = input.side === 'sell' ? 'sell' : 'buy';
  const e = num(input.averageEntry, 'averageEntry');
  const s = num(input.stop, 'stop');
  const q = clampNeg(num(input.quantity, 'quantity'), 'quantity', []);
  if (e.lte(0) || s.lte(0)) throw new Error('averageEntry and stop must be > 0');
  if (side === 'buy' ? s.gte(e) : s.lte(e)) throw new Error('stop must be on the loss side of entry (S < E for long, S > E for short)');
  const { rE, rX } = feeRates(input.feeModel, 'market');
  const { slip, reservePct } = slipRates(input.slippageModel, 'market');
  return breakdownAt(q, q, e, s, multOf(input.instrument), rE, rX, slip, reservePct);
}

/**
 * Largest ADDITIONAL quantity (rounded DOWN) whose full-position risk stays
 * within `remainingBudget` (PRD §36–§37 fill reconciliation). The filled leg is
 * already inside the budget accounting, so `projectedRiskAfter` charges price
 * risk and the exit fee on filled+additional but entry fee and entry slippage
 * only on the ADDED leg (market-priced: the planned entry). The clamp is exact
 * because total risk is linear in each leg's quantity.
 */
export function maxSafeQuantity(input: MaxSafeQuantityInput): MaxSafeQuantityResult & { warnings: string[] } {
  const warnings: string[] = [];
  if (!input || !input.instrument) throw new Error('instrument metadata is required');
  requireInstrument(input.instrument);
  const instrument = input.instrument;
  const side: Side = input.side === 'sell' ? 'sell' : 'buy';
  const { rE, rX } = feeRates(input.feeModel, 'market');
  const { slip, reservePct } = slipRates(input.slippageModel, 'market');
  const mult = multOf(instrument);
  const e = readNum(input.referenceEntry, 'referenceEntry', warnings);
  const s = readNum(input.stop, 'stop', warnings);
  const budgetRaw = readNum(input.remainingBudget, 'remainingBudget', warnings);
  const filledRaw = readNum(input.filledQuantity, 'filledQuantity', warnings);
  const at = (qAdd: Dec, filledQ: Dec, ee: Dec, ss: Dec): RiskBreakdown => breakdownAt(filledQ.plus(qAdd), qAdd, ee, ss, mult, rE, rX, slip, reservePct);
  const invalid = (extra: string[]): MaxSafeQuantityResult & { warnings: string[] } => ({
    maxAdditionalQuantity: 0,
    unroundedAdditionalQuantity: 0,
    projectedRiskAfter: at(ZERO, ZERO, e ?? ZERO, s ?? ZERO),
    warnings: [...warnings, ...extra],
  });
  if (e === null || s === null || budgetRaw === null || filledRaw === null) return invalid([]);
  const budget = clampNeg(budgetRaw, 'remainingBudget', warnings);
  const filled = clampNeg(filledRaw, 'filledQuantity', warnings);
  if (!checkPrices(e, s, null, side, warnings)) return invalid([]);
  const distance = e.minus(s).abs();
  if (distance.lte(0)) return invalid(['entry and stop coincide (|E−S| = 0); risk per unit is 0, additional quantity 0']);

  const base = mult.times(distance).times(ONE.plus(reservePct)).plus(mult.times(s).times(rX));
  const perUnitAdd = base.plus(mult.times(e).times(rE)).plus(mult.times(e).times(slip));
  let remaining = budget.minus(filled.times(base));
  if (remaining.lte(0)) {
    return invalid(['filled position already consumes the remaining risk budget; additional quantity 0']);
  }
  const unrounded = remaining.div(perUnitAdd);
  const step = stepOf(instrument);
  let qAdd = floorStep(unrounded, step);
  if (qAdd.lte(0)) {
    warnings.push(`additional quantity rounds to 0 at stepSize ${step.toString()}`);
    qAdd = ZERO;
  }
  return {
    maxAdditionalQuantity: qAdd.toNumber(),
    unroundedAdditionalQuantity: unrounded.toNumber(),
    projectedRiskAfter: at(qAdd, filled, e, s),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Liquidation approximation + AUTO_SAFE leverage (PRD §19–§21)
// ---------------------------------------------------------------------------

/** Preview-grade only (PRD §21): long liq ≈ E·(1 − 1/L + mmr), short liq ≈ E·(1 + 1/L − mmr). */
export function liquidationPriceApprox(args: { side: Side; entry: number; leverage: number; maintenanceMarginRate: number | null }): number {
  const e = num(args.entry, 'entry');
  const L = num(args.leverage, 'leverage');
  if (L.lte(0)) throw new Error('leverage must be > 0');
  const mmr = args.maintenanceMarginRate == null ? DEFAULT_MMR : num(args.maintenanceMarginRate, 'maintenanceMarginRate');
  const liq = args.side === 'sell' ? e.times(ONE.plus(ONE.div(L)).minus(mmr)) : e.times(ONE.minus(ONE.div(L)).plus(mmr));
  return toWire(liq);
}

/**
 * AUTO_SAFE (PRD §19–§20): margin feasibility is a LOWER bound on leverage
 * (L ≥ ceil(N / (maxMarginPct·availableBalance)), ≥ 1); liquidation safety is an
 * UPPER bound (higher leverage pulls liq toward entry). Selection is the
 * MINIMUM feasible leverage — it maximizes liquidation distance — raised never
 * and capped DOWN at min(userMax, exchangeMax) only when that cap is feasible.
 * When the cap is BELOW the margin lower bound, margin is infeasible at the cap:
 * we select the cap itself (still ≤ every max — PRD §106 holds in every branch),
 * warn `insufficient available balance for margin at max leverage`, and force
 * `liquidationSafe: false`. Otherwise safety is decided by evaluating the §20
 * buffer rule at `selected` — never claimed silently.
 */
export function autoSafeLeverage(input: AutoLeverageInput): AutoLeverageResult {
  const warnings: string[] = [];
  const side: Side = input.side === 'sell' ? 'sell' : 'buy';
  const e = num(input.entry, 'entry');
  const stop = input.stop == null ? null : num(input.stop, 'stop');
  const notional = clampNeg(num(input.notional, 'notional'), 'notional', warnings);
  const available = num(input.availableBalance, 'availableBalance');
  const userMax = num(input.maxLeverage, 'maxLeverage');
  const exchangeMax = input.exchangeMaxLeverage == null ? null : num(input.exchangeMaxLeverage, 'exchangeMaxLeverage');
  const bufferPct = clampNeg(num(input.liquidationBufferPct, 'liquidationBufferPct'), 'liquidationBufferPct', warnings);
  const maxMarginPct = num(input.maxMarginPct, 'maxMarginPct');
  const mmr = input.maintenanceMarginRate == null ? DEFAULT_MMR : num(input.maintenanceMarginRate, 'maintenanceMarginRate');
  const cap = exchangeMax === null ? userMax : D.min(userMax, exchangeMax);
  const unselectable = (reason: string): AutoLeverageResult => {
    warnings.push(reason);
    return { selected: 1, estimatedMargin: 0, liquidationPrice: null, liquidationSafe: false, warnings };
  };
  if (cap.lte(0)) return unselectable('leverage caps are non-positive; cannot select leverage');
  if (e.lte(0)) return unselectable('entry price must be > 0');
  if (maxMarginPct.lte(0)) return unselectable('maxMarginPct must be > 0; cannot size margin');

  // Lower bound from margin policy; at least 1 (PRD §19).
  let selected = notional.div(maxMarginPct.times(D.max(available, ZERO))).toDecimalPlaces(0, D.ROUND_UP);
  if (selected.lt(ONE)) selected = ONE;
  let infeasibleMargin = false;
  if (available.lte(0) || selected.gt(cap)) {
    selected = cap;
    infeasibleMargin = true;
    warnings.push('insufficient available balance for margin at max leverage');
  }
  const estimatedMargin = notional.div(selected);
  const liqD = side === 'sell' ? e.times(ONE.plus(ONE.div(selected)).minus(mmr)) : e.times(ONE.minus(ONE.div(selected)).plus(mmr));

  let liquidationSafe = false;
  if (stop === null) {
    warnings.push('no stop configured; liquidation safety cannot be verified');
  } else if (checkPrices(e, stop, null, side, warnings)) {
    // §20 buffer rule at `selected`: safe ⟺ liq beyond S ∓ liquidationBufferPct·|E−S|.
    const distance = e.minus(stop).abs();
    const target = side === 'sell' ? stop.plus(distance.times(bufferPct)) : stop.minus(distance.times(bufferPct));
    liquidationSafe = side === 'sell' ? liqD.gte(target) : liqD.lte(target);
    if (!liquidationSafe) warnings.push('liquidation price is inside the SL-to-liquidation buffer at the minimum feasible leverage');
  }
  return {
    selected: selected.toNumber(),
    estimatedMargin: toWire(estimatedMargin),
    liquidationPrice: toWire(liqD),
    liquidationSafe: liquidationSafe && !infeasibleMargin,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Constraint solver (PRD §15, §105)
// ---------------------------------------------------------------------------

/** PRD §14 response shape: Requested vs Possible using current SL/TP. */
function riskVsProfitConflict(maxLoss: Dec, targetProfit: Dec, achievableProfit: Dec, requiredRisk: Dec): ConstraintConflict {
  return {
    code: 'risk_vs_profit',
    message:
      `Requested: Max Loss $${usd(maxLoss)}, Target Profit $${usd(targetProfit)}. ` +
      `Possible using current SL/TP: Max Loss $${usd(maxLoss)}, Profit $${usd(achievableProfit)}. ` +
      `To achieve $${usd(targetProfit)} target, Required Risk ≈ $${usd(requiredRisk)}.`,
    detail: {
      maxLoss: toWire(maxLoss),
      targetProfit: toWire(targetProfit),
      achievableProfit: toWire(achievableProfit),
      requiredRisk: toWire(requiredRisk),
    },
  };
}

const SOLVE_KEYS = ['entry', 'stop', 'target', 'quantity', 'risk', 'profit', 'margin', 'notional', 'leverage'] as const;
type SolveKey = (typeof SOLVE_KEYS)[number];

/**
 * Closed-form propagation over any known subset of
 * {entry, stop, target, quantity, risk, profit, margin, notional, leverage}.
 * Underdetermined → listed in `unsatisfied` (never guessed); contradictions and
 * the PRD §14 risk+profit pair → `conflicts`. The §15 example (E=100, TP=120,
 * P=200, margin=250 → Q=10, N=1000, L=4x) reproduces exactly at zero fees.
 */
export function solvePosition(input: SolveInput): SolveResult {
  const warnings: string[] = [];
  const conflicts: ConstraintConflict[] = [];
  const unsatisfied: SolveKey[] = [];
  if (!input || !input.instrument) throw new Error('instrument metadata is required');
  requireInstrument(input.instrument);
  const instrument = input.instrument;
  const side: Side = input.side === 'sell' ? 'sell' : 'buy';
  const { rE, rX } = feeRates(input.feeModel, undefined);
  const { slip, reservePct } = slipRates(input.slippageModel, undefined);
  const mult = multOf(instrument);

  const solved: SolveResult['solved'] = {};
  const vals: Partial<Record<SolveKey, Dec>> = {};
  for (const name of SOLVE_KEYS) {
    const v = (input.known ?? {})[name];
    if (v === undefined) continue;
    const d = readNum(v, `known.${name}`, warnings);
    if (d === null) continue;
    if (d.lte(0)) {
      warnings.push(`${name} must be > 0`);
      continue;
    }
    vals[name] = d;
    solved[name] = toWire(d);
  }
  const contradiction = (code: string, message: string, detail?: Record<string, number>): void => {
    conflicts.push(detail ? { code, message, detail } : { code, message });
  };
  const consistent = (a: Dec | undefined, b: Dec | undefined, label: string): boolean => {
    if (a === undefined || b === undefined) return true;
    const tol = D.max(a.abs(), b.abs(), ONE).times('1e-12');
    if (a.minus(b).abs().lte(tol)) return true;
    contradiction('inconsistent_known_values', `${label} is over-determined inconsistently (${a.toString()} vs ${b.toString()})`, {
      left: toWire(a),
      right: toWire(b),
    });
    return false;
  };

  const e = vals.entry;
  const s = vals.stop;
  const t = vals.target;
  if (e && s && (side === 'buy' ? s.gte(e) : s.lte(e))) {
    contradiction('invalid_stop', `stop must be on the loss side of entry for a ${side === 'buy' ? 'long' : 'short'}`, { entry: toWire(e), stop: toWire(s) });
  } else if (e && t && (side === 'buy' ? t.lte(e) : t.gte(e))) {
    contradiction('invalid_target', `target must be on the profit side of entry for a ${side === 'buy' ? 'long' : 'short'}`, { entry: toWire(e), target: toWire(t) });
  } else {
    const unitRisk = e && s ? unitRiskDec(e, s, mult, rE, rX, slip, reservePct) : undefined;
    const unitProfit = e && t ? unitProfitDec(e, t, mult, rE, rX, slip) : undefined;
    const qFromR = vals.risk && unitRisk ? vals.risk.div(unitRisk) : undefined;
    const qFromP = vals.profit && unitProfit && unitProfit.gt(0) ? vals.profit.div(unitProfit) : undefined;
    const qFromN = vals.notional && e ? vals.notional.div(e.times(mult)) : undefined;

    // PRD §14: both a risk cap and a profit target over the same SL/TP pair.
    if (qFromR && qFromP && input.known?.risk !== undefined && input.known?.profit !== undefined) {
      const achievable = qFromR.times(unitProfit!);
      const required = qFromP.times(unitRisk!);
      const tol = D.max(vals.profit!.abs(), ONE).times('1e-9');
      if (vals.profit!.minus(achievable).abs().gt(tol)) {
        conflicts.push(riskVsProfitConflict(vals.risk!, vals.profit!, achievable, required));
      }
    }
    let q = vals.quantity ?? (qFromR && qFromP ? D.min(qFromR, qFromP) : qFromR ?? qFromP ?? qFromN);
    if (q !== undefined) {
      const agreed =
        consistent(vals.quantity, qFromR, 'quantity vs risk') &&
        consistent(vals.quantity, qFromP, 'quantity vs profit') &&
        consistent(vals.quantity, qFromN, 'quantity vs notional') &&
        consistent(qFromR, qFromN, 'risk-derived vs notional-derived quantity') &&
        consistent(qFromP, qFromN, 'profit-derived vs notional-derived quantity');
      if (agreed) {
        if (vals.quantity === undefined) solved.quantity = toWire(q);
      } else {
        q = undefined;
      }
    }
    if (vals.notional === undefined && q && e) {
      vals.notional = q.times(e).times(mult);
      solved.notional = toWire(vals.notional);
    }
    if (vals.risk === undefined && q && unitRisk) {
      solved.risk = toWire(q.times(unitRisk));
    }
    if (vals.profit === undefined && q && unitProfit) {
      solved.profit = toWire(q.times(unitProfit));
    }
    // L·margin = N (PRD §15).
    const n = vals.notional ?? (q && e ? q.times(e).times(mult) : undefined);
    const lFromM = vals.margin && vals.margin.gt(0) && n ? n.div(vals.margin) : undefined;
    if (lFromM) {
      if (consistent(vals.leverage, lFromM, 'leverage vs margin/notional')) {
        if (vals.leverage === undefined) {
          // Round only when the derived leverage lands on a user-facing integer scale (PRD §15: 4x).
          const roundedL = lFromM.toDecimalPlaces(0, D.ROUND_HALF_UP);
          const finalL = roundedL.minus(lFromM).abs().lte('1e-9') ? roundedL : lFromM;
          vals.leverage = finalL;
          solved.leverage = toWire(finalL);
        }
      } else if (vals.leverage === undefined) {
        vals.leverage = undefined;
      }
    }
    if (vals.margin === undefined && vals.leverage && n) {
      vals.margin = n.div(vals.leverage);
      solved.margin = toWire(vals.margin);
    }
    if (vals.leverage && vals.margin) {
      const nFromLM = vals.leverage.times(vals.margin);
      if (consistent(vals.notional, nFromLM, 'notional vs leverage·margin') && vals.notional === undefined) {
        vals.notional = nFromLM;
        solved.notional = toWire(nFromLM);
      }
    }
  }

  for (const name of SOLVE_KEYS) {
    if (solved[name] === undefined) unsatisfied.push(name);
  }
  return { solved, unsatisfied, conflicts, warnings };
}

// ---------------------------------------------------------------------------
// Engine object (the frozen RiskEngine surface)
// ---------------------------------------------------------------------------

export const riskEngine: RiskEngine = {
  calculateRiskPosition,
  calculateProfitPosition,
  solvePosition,
  projectedRisk,
  maxSafeQuantity,
  autoSafeLeverage,
  liquidationPriceApprox,
  resolveBalanceBasis,
  roundQuantityDown,
  roundPrice,
};
