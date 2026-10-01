/**
 * plan.ts — the Execution Planner (PRD §24, §56, §79-80, §98).
 *
 * Pure request → plan transformation: it resolves the entry reference, validates
 * the intent (strict, field-named errors — never clamped, never silently fixed),
 * sizes the position through the risk engine, applies the leverage/margin/
 * liquidation policy, and emits BOTH the immutable `ExecutionPlan` (what creation
 * stores, PRD §99) and the `PreviewResult` (what the composer renders, PRD §80).
 *
 * Division of labor (PRD §98 lists more than one layer can do in-process):
 *  - THIS module: sizing, fees, leverage, margin, liquidation, constraints — all
 *    deterministic math over the inputs it is handed.
 *  - The API route: fetches account equity + market data + fees, resolves the
 *    fee/slippage models, enforces session ownership, and enforces §79 items that
 *    need the venue (credential health, permissions, rate-limit capacity).
 *
 * Honesty rules baked in here (house rules + PRD §11/§38/§116/§117):
 *  - A missing stop makes every stop-based figure `null`, never 0 (§38 only
 *    REQUIRES a stop for risk-based sizing; capital modes may run without one).
 *  - Risk % and Allocation % are different sizing modes with different outputs —
 *    never one control, never one label.
 *  - Risk+Profit conflicts (§14) are returned as `conflicts`, never resolved by
 *    silently shrinking the user's ask. ANY conflict blocks creation (§117
 *    default BLOCK); the preview still shows Requested vs Possible.
 *  - The risk bound is a hard constraint: when both bounds fight, the risk-safe
 *    quantity is what the plan carries, and the gap is explained in the conflict.
 *
 * Entry reference: a limit entry plans at its own price; a market entry plans at
 * the touch (buy → ask, sell → bid) — the conservative side of the spread, since
 * that is what a market order actually pays (§26).
 */
import Decimal from 'decimal.js';
import {
  DEFAULT_RISK_PROFILE,
  venueKey,
  type BalanceBasis,
  type BalanceSnapshot,
  type ConstraintConflict,
  type EntryDefinition,
  type ExecutionPlan,
  type ExecutionRequest,
  type FeeModel,
  type InstrumentMetadata,
  type MarketSnapshot,
  type PreviewResult,
  type RiskProfile,
  type SizingDefinition,
  type SlippageModel,
  type ExchangeId,
} from '@/platform/executor/types';
import {
  autoSafeLeverage,
  calculateProfitPosition,
  calculateRiskPosition,
  estimateNetProfit,
  liquidationPriceApprox,
  maxSafeQuantity,
  projectedRisk,
  resolveBalanceBasis,
  roundQuantityDown,
} from '@/platform/executor/risk';
import { defaultSlices } from '@/platform/executor/engine';

/** House-default slippage model. The API may override per venue after measurement. */
export const DEFAULT_SLIPPAGE_MODEL: SlippageModel = { slippageBps: 5, safetyReservePct: 0.01 };

export interface PlanInputs {
  request: ExecutionRequest;
  /** Required for a market entry (the reference price comes from it); optional for limit. */
  snapshot: MarketSnapshot | null;
  exchange: ExchangeId;
  instrument: InstrumentMetadata;
  feeModel: FeeModel;
  slippageModel: SlippageModel;
  balances: BalanceSnapshot | null;
  riskProfile?: RiskProfile;
}

export interface PlanOutcome {
  /** Fatal, field-named. Non-empty ⇒ plan/preview are null (the API answers 400). */
  errors: string[];
  plan: ExecutionPlan | null;
  preview: PreviewResult | null;
}

// ---------------------------------------------------------------------------
// small exact helpers (Decimal; never float arithmetic on money)
// ---------------------------------------------------------------------------

const D = (x: number | string): Decimal => new Decimal(x);
const toNum = (d: Decimal): number => d.toNumber();

function isPosNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

function isNonNeg(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/** Fee rates as Decimals (bps of notional). */
function feeRates(feeModel: FeeModel, entryType: 'market' | 'limit') {
  return {
    entry: D(entryType === 'limit' ? feeModel.makerBps : feeModel.takerBps).div(10_000),
    exit: D(feeModel.takerBps).div(10_000),
  };
}

function slippageRate(slippageModel: SlippageModel): Decimal {
  return D(slippageModel.slippageBps).div(10_000);
}

/** 2-dp display string for conflict messages (PRD §14's dollar figures). */
const usd = (x: number): string => `$${x.toFixed(2)}`;

// ---------------------------------------------------------------------------
// entry reference + validation
// ---------------------------------------------------------------------------

/**
 * The price the plan is built around. Limit → its own price; market → the touch.
 * Returns null when the request is a market entry and no snapshot was supplied.
 */
export function resolveEstimatedEntry(
  request: Pick<ExecutionRequest, 'entry' | 'side'>,
  snapshot: MarketSnapshot | null,
): number | null {
  const entry: EntryDefinition = request.entry;
  if (entry.type === 'limit') return entry.price;
  if (!snapshot) return null;
  return request.side === 'buy' ? snapshot.ask : snapshot.bid;
}

/**
 * Strict field validation (PRD §38, §79's locally-checkable subset, §89).
 * Every message names the field — house rule: bad input is a 400 with the
 * field named, never a clamp and never a silent default.
 */
export function validatePlanInputs(inputs: PlanInputs, refPrice: number): string[] {
  const { request: req, instrument, slippageModel, balances, riskProfile } = inputs;
  const errors: string[] = [];
  const profile = riskProfile ?? DEFAULT_RISK_PROFILE;
  const entryType: 'market' | 'limit' = req.entry.type === 'limit' ? 'limit' : 'market';

  if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(req.symbol)) errors.push(`symbol: '${req.symbol}' is not a normalized symbol (expected BASE/QUOTE, e.g. BTC/USDT)`);
  if (req.symbol !== instrument.symbol) errors.push(`symbol: request '${req.symbol}' does not match instrument '${instrument.symbol}'`);
  const limitPrice = req.entry.type === 'limit' ? req.entry.price : null;
  if (req.entry.type === 'limit' && !isPosNum(limitPrice)) errors.push('entry.price: must be a positive number for a limit entry');

  // spot product rules (§89): no leverage, no margin mode, no sell-open.
  if (req.marketType === 'spot') {
    if (req.leverage) errors.push('leverage: not applicable to spot (PRD §89) — remove it or select a linear perpetual');
    if (req.marginMode) errors.push('marginMode: not applicable to spot (PRD §89)');
    if (req.side === 'sell' && req.intent === 'open') errors.push('intent: spot sell-open requires a margin/short product (PRD §89) — use intent close/reduce to sell held assets');
  }

  // stop / target side rules against the entry reference.
  const stop = req.stopLoss;
  if (stop && !isPosNum(stop.price)) errors.push('stopLoss.price: must be a positive number');
  if (stop && isPosNum(stop.price)) {
    const wrongSide = req.side === 'buy' ? stop.price >= refPrice : stop.price <= refPrice;
    if (wrongSide) errors.push(`stopLoss.price: ${usd(stop.price)} is not on the loss side of entry ${usd(refPrice)} (buy ⇒ stop below entry, sell ⇒ stop above entry)`);
  }
  if (!Array.isArray(req.takeProfits)) errors.push('takeProfits: must be an array (use [] for none)');
  let fractionSum = D(0);
  (req.takeProfits ?? []).forEach((tp, i) => {
    if (!isPosNum(tp.price)) errors.push(`takeProfits[${i}].price: must be a positive number`);
    else {
      const wrongSide = req.side === 'buy' ? tp.price <= refPrice : tp.price >= refPrice;
      if (wrongSide) errors.push(`takeProfits[${i}].price: ${usd(tp.price)} is not on the profit side of entry ${usd(refPrice)}`);
    }
    if (tp.fraction !== undefined) {
      if (!isPosNum(tp.fraction) || tp.fraction > 1) errors.push(`takeProfits[${i}].fraction: must be in (0, 1]`);
      else fractionSum = fractionSum.add(tp.fraction);
    } else {
      fractionSum = fractionSum.add(1);
    }
  });
  if (fractionSum.greaterThan(1)) errors.push(`takeProfits: close fractions sum to ${fractionSum.toString()} — each level closes quantity×fraction and the sum may not exceed 1`);

  // sizing (§12/§52) + its prerequisites (§38).
  const sizing: SizingDefinition = req.sizing;
  if (!isPosNum(sizing.value)) errors.push('sizing.value: must be a positive number');
  const riskMode = sizing.mode === 'risk_usd' || sizing.mode === 'risk_percent';
  const profitMode = sizing.mode === 'target_profit_usd' || sizing.mode === 'target_profit_percent';
  if (riskMode && !stop) errors.push(`stopLoss: required for ${sizing.mode} sizing — without a stop the position risk is unbounded (PRD §38)`);
  if (profitMode && (req.takeProfits ?? []).length === 0) errors.push(`takeProfits: at least one take-profit is required for ${sizing.mode} sizing`);
  if (req.targetProfit !== undefined) {
    if (!isPosNum(req.targetProfit)) errors.push('targetProfit: must be a positive number');
    if ((req.takeProfits ?? []).length === 0) errors.push('targetProfit: requires at least one take-profit level to price the outcome');
  }
  if (req.maxRisk !== undefined) {
    if (!isPosNum(req.maxRisk)) errors.push('maxRisk: must be a positive number');
    if (!stop) errors.push('maxRisk: requires a stop-loss to bound the loss (PRD §38)');
  }
  if (sizing.mode === 'fixed_margin' && req.marketType === 'linear_perp') {
    const lev = req.leverage;
    if (!lev || lev.mode !== 'manual') errors.push("leverage: fixed_margin sizing requires mode 'manual' — margin alone cannot determine notional without a leverage");
  }

  // leverage (§18/§53) + profile cap (§88).
  const lev = req.leverage;
  if (lev?.mode === 'manual') {
    if (!Number.isInteger(lev.leverage) || lev.leverage < 1) errors.push('leverage.leverage: must be a positive integer');
    else {
      if (instrument.maxLeverage !== null && lev.leverage > instrument.maxLeverage) errors.push(`leverage.leverage: ${lev.leverage}x exceeds the exchange maximum ${instrument.maxLeverage}x`);
      if (lev.leverage > profile.maxLeverage) errors.push(`leverage.leverage: ${lev.leverage}x exceeds your risk profile maximum ${profile.maxLeverage}x (maxLeverage)`);
    }
  }
  if (lev?.mode === 'auto_safe') {
    if (lev.maxLeverage !== undefined && (!Number.isInteger(lev.maxLeverage) || lev.maxLeverage < 1)) errors.push('leverage.maxLeverage: must be a positive integer');
    if (lev.liquidationBufferPct !== undefined && !isNonNeg(lev.liquidationBufferPct)) errors.push('leverage.liquidationBufferPct: must be >= 0');
    if (lev.maxMarginPct !== undefined && (!isPosNum(lev.maxMarginPct) || lev.maxMarginPct > 1)) errors.push('leverage.maxMarginPct: must be in (0, 1]');
  }

  // execution method (§54) — its parameters and its pairing with the entry type.
  const ex = req.execution;
  switch (ex.type) {
    case 'market':
      if (entryType !== 'market') errors.push('execution: a market execution requires entry type market');
      break;
    case 'limit': {
      if (req.entry.type !== 'limit') errors.push('execution: a limit execution requires entry type limit');
      else if (isPosNum(ex.price) && ex.price !== req.entry.price) errors.push('execution.price: must match entry.price — the entry defines the price level, the execution the method');
      if (ex.postOnly !== undefined && typeof ex.postOnly !== 'boolean') errors.push('execution.postOnly: must be a boolean');
      break;
    }
    case 'twap':
    case 'adaptive_twap': {
      if (!isPosNum(ex.durationMs)) errors.push('execution.durationMs: must be a positive number');
      if (ex.slices !== undefined && (!Number.isInteger(ex.slices) || ex.slices < 1)) errors.push('execution.slices: must be a positive integer');
      if (ex.type === 'adaptive_twap' && !['passive', 'balanced', 'aggressive', 'immediate'].includes(ex.urgency)) errors.push('execution.urgency: must be passive | balanced | aggressive | immediate');
      // Jitter is a bounded perturbation, not a licence to slice 0 or negative
      // quantity: below 1 a slice can be floored away and normalized upwards, and
      // above 100% the schedule becomes unrepresentable. Refuse, never clamp (§55).
      if (ex.config !== undefined) {
        if (ex.config === null || typeof ex.config !== 'object') errors.push('execution.config: must be an object');
        else {
          if (ex.config.durationMs !== undefined && ex.config.durationMs !== ex.durationMs) {
            errors.push('execution.config.durationMs: must match execution.durationMs');
          }
          if (!['market', 'limit', 'maker'].includes(ex.config.orderType)) errors.push('execution.config.orderType: must be market | limit | maker');
          for (const key of ['quantityJitterPct', 'intervalJitterPct'] as const) {
            const v = ex.config[key];
            if (v === undefined) continue;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 1) {
              errors.push(`execution.config.${key}: must be a fraction in [0, 1)`);
            }
          }
        }
      }
      break;
    }
    case 'iceberg':
      if (!isPosNum(ex.visibleQuantity)) errors.push('execution.visibleQuantity: must be a positive number');
      break;
    case 'chase_limit':
      if (!['passive', 'balanced', 'aggressive', 'immediate'].includes(ex.urgency)) errors.push('execution.urgency: must be passive | balanced | aggressive | immediate');
      if (ex.maxReplacements !== undefined && (!Number.isInteger(ex.maxReplacements) || ex.maxReplacements < 0)) {
        errors.push('execution.maxReplacements: must be a non-negative integer');
      }
      if (ex.maxChaseDistance !== undefined && !isNonNeg(ex.maxChaseDistance)) {
        errors.push('execution.maxChaseDistance: must be >= 0');
      }
      break;
    case 'scale_in':
    case 'scale_out': {
      if (!Array.isArray(ex.levels) || ex.levels.length === 0) errors.push('execution.levels: must be a non-empty array');
      else {
        let sum = D(0);
        ex.levels.forEach((l, i) => {
          if (!isPosNum(l.price)) errors.push(`execution.levels[${i}].price: must be a positive number`);
          if (!isPosNum(l.fraction) || l.fraction > 1) errors.push(`execution.levels[${i}].fraction: must be in (0, 1]`);
          else sum = sum.add(l.fraction);
        });
        if (!sum.equals(1)) errors.push(`execution.levels: fractions must sum to 1 (got ${sum.toString()})`);
      }
      break;
    }
  }

  // constraints (§55) — never clamped; a request that contradicts itself is an error.
  const c = req.constraints;
  if (c) {
    if (c.maxSlippageBps !== undefined && !isNonNeg(c.maxSlippageBps)) errors.push('constraints.maxSlippageBps: must be >= 0');
    if (c.maxSpreadBps !== undefined && !isNonNeg(c.maxSpreadBps)) errors.push('constraints.maxSpreadBps: must be >= 0');
    if (c.maxPrice !== undefined && !isPosNum(c.maxPrice)) errors.push('constraints.maxPrice: must be a positive number');
    if (c.minPrice !== undefined && !isPosNum(c.minPrice)) errors.push('constraints.minPrice: must be a positive number');
    if (isPosNum(c.maxPrice) && isPosNum(c.minPrice) && c.minPrice > c.maxPrice) errors.push('constraints: minPrice exceeds maxPrice');
    if (c.maxDurationMs !== undefined && !isPosNum(c.maxDurationMs)) errors.push('constraints.maxDurationMs: must be a positive number');
    if (c.makerOnly && (ex.type === 'market' || (entryType === 'market' && ex.type !== 'chase_limit'))) {
      errors.push('execution: makerOnly cannot be satisfied by a market-taking execution');
    }
    if (isPosNum(c.maxPrice) && req.side === 'buy' && refPrice > c.maxPrice) errors.push(`constraints.maxPrice: entry estimate ${usd(refPrice)} exceeds the cap ${usd(c.maxPrice)}`);
    if (isPosNum(c.minPrice) && req.side === 'sell' && refPrice < c.minPrice) errors.push(`constraints.minPrice: entry estimate ${usd(refPrice)} is below the floor ${usd(c.minPrice)}`);
    if (isNonNeg(c.maxSlippageBps) && entryType === 'market' && slippageModel.slippageBps > c.maxSlippageBps) {
      errors.push(`constraints.maxSlippageBps: the sizing estimate (${slippageModel.slippageBps} bps) exceeds the configured cap (${c.maxSlippageBps} bps)`);
    }
  }

  // risk profile hard cap (§72/§88): max risk per trade, when a basis resolves.
  if (riskMode && isPosNum(sizing.value) && balances) {
    const basis = 'balanceBasis' in sizing ? sizing.balanceBasis : null;
    const basisVal = basis ? resolveBalanceBasis(basis, balances, req.symbol) : null;
    if (sizing.mode === 'risk_percent') {
      if (sizing.value > profile.maxRiskPerTradePct) errors.push(`sizing.value: ${sizing.value}% exceeds your risk profile maximum ${profile.maxRiskPerTradePct}% per trade (maxRiskPerTradePct)`);
    } else if (basisVal) {
      const capUsd = D(basisVal).mul(profile.maxRiskPerTradePct).div(100);
      if (D(sizing.value).greaterThan(capUsd)) errors.push(`sizing.value: ${usd(sizing.value)} exceeds your risk profile maximum ${usd(capUsd.toNumber())} per trade (maxRiskPerTradePct)`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// sizing resolution
// ---------------------------------------------------------------------------

interface Sized {
  quantity: number;
  unroundedQuantity: number;
  notional: number;
  /** Risk bound the sizing mode carries (risk modes); null otherwise. */
  budget: number | null;
  riskBasis: BalanceBasis | null;
  balanceReference: number | null;
  /** Five-part breakdown when a stop exists; else the stop-less fee figures. */
  priceRisk: number | null;
  entryFee: number;
  exitFee: number;
  slippageBudget: number;
  safetyReserve: number | null;
  totalRisk: number | null;
  warnings: string[];
  errors: string[];
}

export function sizePosition(inputs: PlanInputs, refPrice: number): Sized {
  const { request: req, instrument, feeModel, slippageModel, balances } = inputs;
  const sizing = req.sizing;
  const stop = req.stopLoss?.price ?? null;
  const entryType: 'market' | 'limit' = req.entry.type === 'limit' ? 'limit' : 'market';
  const mult = D(instrument.contractMultiplier);
  const warnings: string[] = [];
  const errors: string[] = [];
  const empty: Omit<Sized, 'warnings' | 'errors'> = {
    quantity: 0, unroundedQuantity: 0, notional: 0, budget: null, riskBasis: null, balanceReference: null,
    priceRisk: null, entryFee: 0, exitFee: 0, slippageBudget: 0, safetyReserve: null, totalRisk: null,
  };

  // percentage bases (§10) — unresolved basis is an error, never a fabricated 0.
  let basis: BalanceBasis | null = null;
  let basisVal: number | null = null;
  if ('balanceBasis' in sizing) {
    basis = sizing.balanceBasis;
    basisVal = balances ? resolveBalanceBasis(basis, balances, req.symbol) : null;
    if (basisVal === null) errors.push(`sizing.balanceBasis: '${basis}' could not be resolved from the account snapshot`);
  }

  const rates = feeRates(feeModel, entryType);
  const slip = slippageRate(slippageModel);
  const primaryExit = stop ?? req.takeProfits?.[0]?.price ?? refPrice;

  // §33: a scale-in builds the position at SEVERAL prices, so the risk the user
  // budgeted must cover EVERY potential fill, not a single reference price. A
  // laddered entry averages in below the reference, and its worst case is the
  // level that ends up furthest from the stop while carrying the most size.
  // Sizing on `refPrice` alone would understate the bound — and the product's
  // core invariant is that the strategy may never silently exceed it.
  if (sizing.mode === 'risk_usd' || sizing.mode === 'risk_percent') {
    if (req.execution.type === 'scale_in' && stop !== null) {
      return sizeScaleInRisk(inputs, refPrice);
    }
  }

  switch (sizing.mode) {
    case 'risk_usd':
    case 'risk_percent': {
      if (errors.length || stop === null) return { ...empty, warnings, errors };
      const budget = sizing.mode === 'risk_usd' ? sizing.value : D(basisVal as number).mul(sizing.value).div(100).toNumber();
      const r = calculateRiskPosition({
        side: req.side, entry: refPrice, stop, riskBudget: budget,
        feeModel, slippageModel, instrument, entryType,
      });
      return {
        quantity: r.quantity, unroundedQuantity: r.unroundedQuantity, notional: r.notional,
        budget, riskBasis: basis, balanceReference: basisVal,
        priceRisk: r.risk.priceRisk, entryFee: r.risk.entryFee, exitFee: r.risk.exitFee,
        slippageBudget: r.risk.estimatedSlippage, safetyReserve: r.risk.safetyReserve, totalRisk: r.risk.totalRisk,
        warnings: [...warnings, ...r.warnings], errors,
      };
    }
    case 'target_profit_usd':
    case 'target_profit_percent': {
      if (errors.length || !req.takeProfits?.length) return { ...empty, warnings, errors };
      const desired = sizing.mode === 'target_profit_usd' ? sizing.value : D(basisVal as number).mul(sizing.value).div(100).toNumber();
      const r = calculateProfitPosition({
        side: req.side, entry: refPrice, target: req.takeProfits[0].price, desiredProfit: desired,
        feeModel, slippageModel, instrument, entryType,
      });
      const notional = toNum(D(r.quantity).mul(refPrice).mul(mult));
      const entryFee = toNum(D(notional).mul(rates.entry));
      const exitNotional = toNum(D(r.quantity).mul(primaryExit).mul(mult));
      const exitFee = toNum(D(exitNotional).mul(rates.exit));
      const slippageBudget = entryType === 'market' ? toNum(D(notional).mul(slip)) : 0;
      const priceRisk = stop !== null ? toNum(D(r.quantity).mul(mult).mul(Math.abs(refPrice - stop))) : null;
      const safetyReserve = priceRisk !== null ? toNum(D(priceRisk).mul(slippageModel.safetyReservePct)) : null;
      const totalRisk = priceRisk !== null ? priceRisk + entryFee + exitFee + slippageBudget + (safetyReserve as number) : null;
      return {
        quantity: r.quantity, unroundedQuantity: r.unroundedQuantity, notional,
        budget: null, riskBasis: basis, balanceReference: basisVal,
        priceRisk, entryFee, exitFee, slippageBudget, safetyReserve, totalRisk,
        warnings: [...warnings, ...r.warnings], errors,
      };
    }
    case 'allocation_usd':
    case 'allocation_percent': {
      if (errors.length) return { ...empty, warnings, errors };
      const capital = sizing.mode === 'allocation_usd' ? sizing.value : D(basisVal as number).mul(sizing.value).div(100).toNumber();
      // Allocation = capital deployed: N = Q × E × mult = capital (§11/§16).
      const raw = D(capital).div(D(refPrice).mul(mult));
      return finishCapital(inputs, refPrice, primaryExit, raw, { ...empty, warnings, errors, riskBasis: basis, balanceReference: basisVal });
    }
    case 'notional_usd': {
      if (errors.length) return { ...empty, warnings, errors };
      const raw = D(sizing.value).div(D(refPrice).mul(mult));
      return finishCapital(inputs, refPrice, primaryExit, raw, { ...empty, warnings, errors, riskBasis: basis, balanceReference: basisVal });
    }
    case 'fixed_quantity': {
      if (errors.length) return { ...empty, warnings, errors };
      const raw = D(sizing.value);
      return finishCapital(inputs, refPrice, primaryExit, raw, { ...empty, warnings, errors, riskBasis: basis, balanceReference: basisVal });
    }
    case 'fixed_margin': {
      if (errors.length) return { ...empty, warnings, errors };
      const manual = req.leverage?.mode === 'manual' ? req.leverage.leverage : 1;
      const lev = req.marketType === 'linear_perp' ? manual : 1;
      const notional = D(sizing.value).mul(lev);
      const raw = notional.div(D(refPrice).mul(mult));
      return finishCapital(inputs, refPrice, primaryExit, raw, { ...empty, warnings, errors, riskBasis: basis, balanceReference: basisVal });
    }
  }
}

/**
 * §33 — scale-in risk sizing across EVERY potential fill.
 *
 * A ladder such as `25% @ 100 / 25% @ 98 / 25% @ 96 / 25% @ 94` cannot be priced
 * like a single entry: the position is built at four prices, and its worst case
 * is not the average. Per unit the risk is `|levelPrice − stop|`, and the total
 * is the fraction-weighted sum — plus fees charged on each level's own notional
 * and the exit fee on the whole (fully filled) position, so the budget covers the
 * most expensive way the ladder can complete.
 *
 * Solving is one-dimensional and exact: with fractions `fᵢ` fixed, total risk is
 * linear in quantity, so `Q = budget / riskPerUnit` and the price risk at the
 * reference is `Q × Σfᵢ|levelᵢ − stop|`. Rounding Q DOWN to the step grid keeps
 * the bound intact (§106, §71).
 */
function sizeScaleInRisk(inputs: PlanInputs, refPrice: number, boundOverride?: number): Sized {
  const { request: req, instrument, feeModel, slippageModel, balances } = inputs;
  const sizing = req.sizing;
  const stop = (req.stopLoss?.price ?? null) as number;
  const levels = req.execution.type === 'scale_in' ? req.execution.levels : [];
  const entryType: 'market' | 'limit' = req.entry.type === 'limit' ? 'limit' : 'market';
  const mult = D(instrument.contractMultiplier);
  const warnings: string[] = [];
  const errors: string[] = [];
  const empty: Omit<Sized, 'warnings' | 'errors'> = {
    quantity: 0, unroundedQuantity: 0, notional: 0, budget: null, riskBasis: null, balanceReference: null,
    priceRisk: null, entryFee: 0, exitFee: 0, slippageBudget: 0, safetyReserve: null, totalRisk: null,
  };
  if (levels.length === 0) {
    return { ...empty, warnings: [...warnings, 'scale_in has no levels'], errors };
  }

  let basis: BalanceBasis | null = null;
  let basisVal: number | null = null;
  if ('balanceBasis' in sizing) {
    basis = sizing.balanceBasis;
    basisVal = balances ? resolveBalanceBasis(basis, balances, req.symbol) : null;
    if (basisVal === null) errors.push(`sizing.balanceBasis: '${basis}' could not be resolved from the account snapshot`);
  }
  if (errors.length) return { ...empty, warnings, errors };

  // `boundOverride` carries the §37/§117 hard bound, which may be tighter than
  // the sizing mode's own budget (§8) — e.g. a per-trade profile cap.
  const budget = boundOverride !== undefined
    ? D(boundOverride)
    : sizing.mode === 'risk_usd' ? D(sizing.value) : D(basisVal as number).mul(sizing.value).div(100);
  const rates = feeRates(feeModel, entryType);
  const slip = slippageRate(slippageModel);

  // Per-unit risk of the whole ladder, weighted by each level's fraction.
  let weightedDistance = D(0);
  let entryNotionalPerUnit = D(0);
  for (const level of levels) {
    const f = D(level.fraction);
    const price = D(level.price);
    weightedDistance = weightedDistance.plus(f.mul(price.minus(stop).abs()));
    entryNotionalPerUnit = entryNotionalPerUnit.plus(f.mul(price).mul(mult));
  }
  // Fees per unit: each level pays its own entry fee, the whole position pays one
  // exit fee at the stop, and a market entry pays slippage on its own notional.
  const perUnitFees = entryNotionalPerUnit.mul(rates.entry)
    .plus(D(stop).mul(mult).mul(rates.exit))
    .plus(entryType === 'market' ? entryNotionalPerUnit.mul(slip) : D(0));
  const reserveRate = D(slippageModel.safetyReservePct);
  const perUnitTotal = weightedDistance.mul(mult).plus(perUnitFees).plus(weightedDistance.mul(mult).mul(reserveRate));

  if (perUnitTotal.lte(0)) {
    return { ...empty, budget: budget.toNumber(), riskBasis: basis, balanceReference: basisVal, warnings: [...warnings, 'scale_in levels sit on the stop: risk is unbounded'], errors };
  }

  const raw = budget.div(perUnitTotal);
  const quantity = roundQuantityDown(raw.toNumber(), instrument);
  const q = D(quantity);
  const unroundedQuantity = raw.toNumber();
  const notional = toNum(q.mul(entryNotionalPerUnit));
  const priceRisk = toNum(q.mul(weightedDistance).mul(mult));
  const entryFee = toNum(q.mul(entryNotionalPerUnit).mul(rates.entry));
  const exitFee = toNum(q.mul(D(stop).mul(mult)).mul(rates.exit));
  const slippageBudget = entryType === 'market' ? toNum(q.mul(entryNotionalPerUnit).mul(slip)) : 0;
  const safetyReserve = priceRisk * slippageModel.safetyReservePct;
  const totalRisk = priceRisk + entryFee + exitFee + slippageBudget + safetyReserve;
  if (totalRisk > budget.toNumber() + 1e-9) {
    errors.push(`risk budget exceeded: the ladder needs $${totalRisk.toFixed(2)} but the budget is $${budget.toFixed(2)}`);
  }
  return {
    quantity, unroundedQuantity, notional,
    budget: budget.toNumber(), riskBasis: basis, balanceReference: basisVal,
    priceRisk, entryFee, exitFee, slippageBudget, safetyReserve, totalRisk,
    warnings, errors,
  };
}

/**
 * Shared tail for the capital/outcome-neutral modes: round the raw quantity DOWN
 * (§71 risk-safe), price it, and produce the stop-less-or-full fee figures.
 */
function finishCapital(
  inputs: PlanInputs,
  refPrice: number,
  primaryExit: number,
  rawQuantity: Decimal,
  base: Sized,
): Sized {
  const { request: req, instrument, feeModel, slippageModel } = inputs;
  const entryType: 'market' | 'limit' = req.entry.type === 'limit' ? 'limit' : 'market';
  const rates = feeRates(feeModel, entryType);
  const slip = slippageRate(slippageModel);
  const mult = D(instrument.contractMultiplier);
  const stop = req.stopLoss?.price ?? null;
  const warnings = [...base.warnings];

  const quantity = roundQuantityDown(rawQuantity.toString(), instrument);
  const unroundedQuantity = rawQuantity.toNumber();
  if (quantity === 0 && unroundedQuantity > 0) {
    warnings.push(`quantity rounds to zero at step size ${instrument.stepSize} — nothing to send (§70/§71)`);
  } else if (quantity < unroundedQuantity) {
    warnings.push(`quantity ${unroundedQuantity} rounded DOWN to ${quantity} (step ${instrument.stepSize}, §71 risk-safe)`);
  }
  const notional = toNum(D(quantity).mul(refPrice).mul(mult));
  if (quantity > 0 && instrument.minNotional !== null && notional < instrument.minNotional) {
    warnings.push(`notional ${usd(notional)} is below the venue minimum ${usd(instrument.minNotional)} — the venue will reject this order (§70)`);
  }
  const entryFee = toNum(D(notional).mul(rates.entry));
  const exitNotional = toNum(D(quantity).mul(primaryExit).mul(mult));
  const exitFee = toNum(D(exitNotional).mul(rates.exit));
  const slippageBudget = entryType === 'market' ? toNum(D(notional).mul(slip)) : 0;
  const priceRisk = stop !== null ? toNum(D(quantity).mul(mult).mul(Math.abs(refPrice - stop))) : null;
  const safetyReserve = priceRisk !== null ? toNum(D(priceRisk).mul(slippageModel.safetyReservePct)) : null;
  const totalRisk = priceRisk !== null ? priceRisk + entryFee + exitFee + slippageBudget + (safetyReserve as number) : null;
  return {
    ...base, quantity, unroundedQuantity, notional,
    priceRisk, entryFee, exitFee, slippageBudget, safetyReserve, totalRisk,
  };
}

// ---------------------------------------------------------------------------
// the planner
// ---------------------------------------------------------------------------

export function planExecution(inputs: PlanInputs): PlanOutcome {
  const { request: req, instrument, feeModel, slippageModel, balances, snapshot, exchange } = inputs;
  const profile = inputs.riskProfile ?? DEFAULT_RISK_PROFILE;
  const entryType: 'market' | 'limit' = req.entry.type === 'limit' ? 'limit' : 'market';

  // 1. reference price first: a market entry with no snapshot cannot be priced.
  const refPrice = resolveEstimatedEntry(req, snapshot);
  if (refPrice === null) {
    return { errors: ['entry: a market entry requires a market snapshot to price it'], plan: null, preview: null };
  }
  // A Scale In ladder fills at several prices, so its realized entry is the
  // fraction-weighted average, not the top-level limit. One economic price
  // feeds liquidation (§17/§21), notional, the profit projection (§13) and the
  // R:R the user reads (§84); §33's sizing already prices each level separately,
  // and this keeps those downstream figures consistent with that arithmetic.
  const estimatedEntry = req.execution.type === 'scale_in'
    ? req.execution.levels.reduce((acc, l) => acc.plus(D(l.price).mul(D(l.fraction))), D(0)).toNumber()
    : refPrice;
  const errors = [...new Set(validatePlanInputs(inputs, refPrice))];
  if (errors.length) return { errors, plan: null, preview: null };

  const warnings: string[] = [];
  const conflicts: ConstraintConflict[] = [];
  const mult = D(instrument.contractMultiplier);
  const stop = req.stopLoss?.price ?? null;
  const tps = req.takeProfits ?? [];
  const primaryTp = tps[0]?.price ?? null;

  // 2. size.
  const sized = sizePosition(inputs, refPrice);
  warnings.push(...sized.warnings);
  if (sized.errors.length) return { errors: sized.errors, plan: null, preview: null };

  let quantity = sized.quantity;
  let unroundedQuantity = sized.unroundedQuantity;
  let notional = sized.notional;
  let priceRisk = sized.priceRisk;
  let entryFee = sized.entryFee;
  let exitFee = sized.exitFee;
  let safetyReserve = sized.safetyReserve;
  let totalRisk = sized.totalRisk;

  const riskBound = req.maxRisk ?? sized.budget;

  // 3. dual-bound validation (§14): risk bound is HARD, profit is a target.
  if (req.targetProfit !== undefined && primaryTp !== null) {
    const achievable = estimateNetProfit({
      side: req.side, entry: estimatedEntry, quantity, takeProfits: tps,
      feeModel, slippageModel, instrument, entryType,
    });
    if (achievable < req.targetProfit - Math.max(1e-9, req.targetProfit * 1e-9)) {
      // What it would take to hit the target (the PRD's "Required Risk ≈ $Y").
      const qProfit = calculateProfitPosition({
        side: req.side, entry: refPrice, target: primaryTp, desiredProfit: req.targetProfit,
        feeModel, slippageModel, instrument, entryType,
      });
      const requiredRisk = stop !== null
        ? projectedRisk({
            side: req.side, averageEntry: refPrice, quantity: qProfit.quantity, stop,
            feeModel, slippageModel, instrument,
          }).totalRisk
        : toNum(D(qProfit.quantity).mul(refPrice).mul(mult));
      const requestedMaxLoss = riskBound ?? totalRisk ?? 0;
      conflicts.push({
        code: riskBound !== null ? 'risk_vs_profit' : 'target_profit_unreachable',
        message:
          `Requested: max loss ${usd(requestedMaxLoss)}, target profit ${usd(req.targetProfit)}. ` +
          `Possible using current SL/TP: max loss ${usd(totalRisk ?? requestedMaxLoss)}, profit ${usd(achievable)}. ` +
          `To achieve ${usd(req.targetProfit)} target: required risk ≈ ${usd(requiredRisk)}.`,
        detail: {
          requestedMaxLoss,
          requestedTargetProfit: req.targetProfit,
          achievableProfit: achievable,
          requiredRisk,
        },
      });
    }
  }

  // 4. hard risk bound (§37/§117): a request whose projected risk exceeds the
  //    bound is RESIZED to the safe quantity and BLOCKED from creation.
  if (riskBound !== undefined && riskBound !== null && stop !== null && totalRisk !== null && totalRisk > riskBound + Math.max(1e-9, riskBound * 1e-9)) {
    const requestedRisk = totalRisk;
    if (req.execution.type === 'scale_in') {
      // `maxSafeQuantity` prices from a single reference entry, so feeding it a
      // ladder's VWAP would UNDER-count the per-unit risk (Σfᵢ|levelᵢ − stop|)
      // and hand back a quantity that breaches the very bound being enforced.
      // Re-solve the ladder against the bound itself instead.
      const safe = sizeScaleInRisk(inputs, refPrice, riskBound);
      quantity = safe.quantity;
      unroundedQuantity = safe.unroundedQuantity;
      notional = safe.notional;
      priceRisk = safe.priceRisk;
      entryFee = safe.entryFee;
      exitFee = safe.exitFee;
      safetyReserve = safe.safetyReserve;
      totalRisk = safe.totalRisk;
    } else {
      const maxSafe = maxSafeQuantity({
        side: req.side, referenceEntry: refPrice, stop, remainingBudget: riskBound,
        filledQuantity: 0, feeModel, slippageModel, instrument,
      });
      quantity = maxSafe.maxAdditionalQuantity;
      unroundedQuantity = maxSafe.unroundedAdditionalQuantity;
      notional = toNum(D(quantity).mul(refPrice).mul(mult));
      priceRisk = maxSafe.projectedRiskAfter.priceRisk;
      entryFee = maxSafe.projectedRiskAfter.entryFee;
      exitFee = maxSafe.projectedRiskAfter.exitFee;
      safetyReserve = maxSafe.projectedRiskAfter.safetyReserve;
      totalRisk = maxSafe.projectedRiskAfter.totalRisk;
    }
    conflicts.push({
      code: 'risk_bound_exceeded',
      message: `Projected risk ${usd(requestedRisk)} exceeds the ${usd(riskBound)} bound — creation is blocked (PRD §117). Safe quantity at the bound: ${quantity}.`,
      detail: { maxRisk: riskBound, projectedRisk: requestedRisk, safeQuantity: quantity },
    });
    warnings.push(`quantity resized ${unroundedQuantity} → ${quantity} to hold the ${usd(riskBound)} risk bound (§37)`);
  }

  // 5. balance sufficiency (§79) — block, don't hope.
  const marginRes = resolveLeverageAndMargin(inputs, refPrice, notional, warnings);
  if (balances) {
    const avail = req.marketType === 'spot' ? balances.spotAvailable : balances.futuresAvailable;
    if (avail !== null && marginRes.margin !== null && marginRes.margin > avail + 1e-9) {
      conflicts.push({
        code: 'insufficient_balance',
        message: `Required margin ${usd(marginRes.margin)} exceeds available ${req.marketType === 'spot' ? 'spot' : 'futures'} balance ${usd(avail)}.`,
        detail: { requiredMargin: marginRes.margin, availableBalance: avail },
      });
    }
  }

  // 6. plan assembly.
  const durationMs = (req.execution.type === 'twap' || req.execution.type === 'adaptive_twap')
    ? req.execution.durationMs
    : (req.constraints?.maxDurationMs ?? null);
  const estimatedSlices = estimateSlices(req, quantity);
  const leverageMode = req.marketType === 'spot' ? 'manual' : (req.leverage?.mode ?? 'auto_safe');
  const budget = sized.budget ?? req.maxRisk ?? null;

  const plan: ExecutionPlan = {
    venueKey: venueKey(exchange, req.marketType, req.symbol),
    symbol: req.symbol,
    marketType: req.marketType,
    side: req.side,
    intent: req.intent,
    quantity,
    notional,
    estimatedEntry,
    stopLoss: stop,
    takeProfits: tps,
    risk: {
      budget,
      estimatedTotalRisk: totalRisk,
      priceRisk,
      estimatedFees: entryFee + exitFee,
      slippageBudget: sized.slippageBudget,
      safetyReserve,
    },
    leverage: { mode: leverageMode as 'manual' | 'auto_safe', selected: marginRes.leverage },
    margin: { estimatedInitial: marginRes.margin, mode: req.marketType === 'spot' ? null : (req.marginMode ?? profile.defaultMarginMode) },
    liquidation: marginRes.liquidation,
    execution: {
      strategy: req.execution.type,
      durationMs,
      estimatedSlices,
      urgency: 'urgency' in req.execution ? req.execution.urgency : null,
    },
    instrument,
    feeModel,
    slippageModel,
    balanceSnapshot: balances,
    marketSnapshot: snapshot,
    sizingMode: req.sizing.mode,
    sizingValue: req.sizing.value,
    riskBasis: sized.riskBasis,
    balanceReference: sized.balanceReference,
  };

  // 7. preview figures (§80/§84).
  const expectedLossAtStop = totalRisk !== null ? -totalRisk : null;
  const expectedProfitAtTarget = primaryTp !== null
    ? estimateNetProfit({
        side: req.side, entry: refPrice, quantity, takeProfits: tps,
        feeModel, slippageModel, instrument, entryType,
      })
    : null;
  const riskReward =
    expectedLossAtStop !== null && expectedLossAtStop < 0 && expectedProfitAtTarget !== null
      ? expectedProfitAtTarget / Math.abs(expectedLossAtStop)
      : null;
  if (expectedProfitAtTarget !== null && expectedProfitAtTarget < 0) {
    warnings.push(`fees and slippage exceed the gross target profit — the target would realize ${usd(expectedProfitAtTarget)}`);
  }

  const preview: PreviewResult = {
    plan,
    expectedLossAtStop,
    expectedProfitAtTarget,
    targetPrice: primaryTp,
    riskReward,
    conflicts,
    warnings,
    mode: req.mode ?? 'preview',
  };
  return { errors: [], plan, preview };
}

/**
 * Leverage/margin/liquidation policy (§17-§21). Spot: no leverage — the margin
 * figure IS the required capital (§16). Futures: manual is validated, absent
 * means AUTO_SAFE with the profile's cap (the product promise of §4 G4: risk →
 * size → leverage → margin, never the reverse).
 */
function resolveLeverageAndMargin(
  inputs: PlanInputs,
  refPrice: number,
  notional: number,
  warnings: string[],
): {
  leverage: number | null;
  margin: number | null;
  liquidation: ExecutionPlan['liquidation'];
} {
  const { request: req, instrument, balances } = inputs;
  const profile = inputs.riskProfile ?? DEFAULT_RISK_PROFILE;
  const none: ExecutionPlan['liquidation'] = { priceApprox: null, stopToLiquidationBuffer: null, safe: null };
  if (req.marketType === 'spot' || notional === 0) {
    return { leverage: null, margin: req.marketType === 'spot' ? notional : null, liquidation: none };
  }
  const stop = req.stopLoss?.price ?? null;
  const mmr = instrument.maintenanceMarginRate;

  let leverage: number;
  if (req.leverage?.mode === 'manual') {
    leverage = req.leverage.leverage;
  } else {
    const auto: { maxLeverage?: number; liquidationBufferPct?: number; maxMarginPct?: number } =
      req.leverage?.mode === 'auto_safe' ? req.leverage : {};
    const availableBalance =
      balances?.futuresAvailable ?? balances?.totalExchangeEquity ?? null;
    if (availableBalance === null || availableBalance <= 0) {
      warnings.push('auto_safe: no futures available balance in the snapshot — leverage selection needs one; falling back to 1x with liquidation check only');
    }
    const r = autoSafeLeverage({
      side: req.side,
      entry: refPrice,
      stop,
      notional,
      availableBalance: availableBalance ?? 0,
      maxLeverage: auto.maxLeverage ?? Math.min(profile.maxLeverage, instrument.maxLeverage ?? profile.maxLeverage),
      exchangeMaxLeverage: instrument.maxLeverage,
      liquidationBufferPct: auto.liquidationBufferPct ?? 0.2,
      maxMarginPct: auto.maxMarginPct ?? 1,
      maintenanceMarginRate: mmr,
    });
    warnings.push(...r.warnings);
    if (!r.liquidationSafe) {
      warnings.push('auto_safe: no leverage satisfies both margin and the SL→liquidation buffer — liquidation is NOT safely beyond the stop (§20)');
    }
    leverage = r.selected;
  }

  const margin = toNum(D(notional).div(leverage));
  const priceApprox = liquidationPriceApprox({ side: req.side, entry: refPrice, leverage, maintenanceMarginRate: mmr });
  let stopToLiquidationBuffer: number | null = null;
  let safe: boolean | null = null;
  if (stop !== null) {
    stopToLiquidationBuffer = req.side === 'buy' ? stop - priceApprox : priceApprox - stop;
    safe = stopToLiquidationBuffer > 0;
    const stopDistance = Math.abs(refPrice - stop);
    if (safe && stopDistance > 0 && stopToLiquidationBuffer < stopDistance * 0.2) {
      warnings.push(`SL→liquidation buffer ${usd(stopToLiquidationBuffer)} is under 20% of the stop distance (§20) — thin protection`);
    }
  }
  return { leverage, margin, liquidation: { priceApprox, stopToLiquidationBuffer, safe } };
}

/** Slice projection for the plan block (§56): the engine owns the runtime split. */
function estimateSlices(req: ExecutionRequest, quantity: number): number | null {
  const ex = req.execution;
  switch (ex.type) {
    case 'twap':
    case 'adaptive_twap':
      return ex.slices ?? defaultSlices(ex.durationMs);
    case 'iceberg':
      return Math.max(1, Math.ceil(quantity / ex.visibleQuantity));
    case 'scale_in':
    case 'scale_out':
      return ex.levels.length;
    default:
      return null;
  }
}
