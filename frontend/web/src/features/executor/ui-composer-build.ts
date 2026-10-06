/**
 * ui-composer-build.ts — composer state + request builders (PRD §82, §83).
 * Split from ui-composer.tsx (verbatim); single source for ComposerState,
 * INITIAL, and the pure builders. Re-exported through ./ui-composer (and ./ui).
 */
import type {
  BalanceBasis,
  ExecutionDefinition,
  ExecutionMode,
  ExecutionRequest,
  ExecutionStrategy,
  TwapConfig,
  ExecutionUrgency,
  LeverageDefinition,
  MarginMode,
  SizingDefinition,
  SizingMode,
  TakeProfitDefinition,
} from '@/lib/executor';
import { minutesToMs, num } from './ui-shared';
import { EMPTY_ROW, RISK_SIZING, type LevelRow } from './ui-composer-fields';

// composer state (PRD §82, §83)
// ---------------------------------------------------------------------------

export type ComposerState = {
  accountId: string;
  marketType: 'spot' | 'linear_perp';
  symbol: string;
  side: 'buy' | 'sell';
  intent: 'open' | 'close' | 'reduce';
  entryType: 'market' | 'limit';
  entryPrice: string;
  postOnly: boolean;
  stopLoss: string;
  takeProfits: LevelRow[];
  sizingMode: SizingMode;
  sizingValue: string;
  basis: BalanceBasis;
  leverageMode: 'manual' | 'auto_safe';
  manualLeverage: string;
  marginMode: MarginMode | '';
  strategy: ExecutionStrategy;
  durationMinutes: string;
  slices: string;
  urgency: ExecutionUrgency;
  quantityJitterPct: string;
  intervalJitterPct: string;
  visibleQty: string;
  maxChaseDistance: string;
  maxReplacements: string;
  levels: LevelRow[];
  maxSlippageBps: string;
  maxSpreadBps: string;
  maxPrice: string;
  minPrice: string;
  maxDurationMinutes: string;
  makerOnly: boolean;
  allowMarketFallback: boolean;
  cancelIfRiskExceeded: boolean;
  stopIfDisconnected: boolean;
  riskPolicy: 'resize_then_stop' | 'pause' | 'stop';
  existingPositionPolicy: 'add' | 'reject';
  mode: ExecutionMode;
};

export const INITIAL: ComposerState = {
  accountId: '',
  marketType: 'linear_perp',
  symbol: 'BTC/USDT',
  side: 'buy',
  intent: 'open',
  entryType: 'market',
  entryPrice: '',
  postOnly: false,
  stopLoss: '',
  takeProfits: [{ ...EMPTY_ROW }],
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
  levels: [{ ...EMPTY_ROW }],
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
  existingPositionPolicy: 'reject',
  mode: 'paper',
};


/** A required numeric field's value. The gate below blocks the request before it could reach the wire. */
function required(text: string): number {
  const value = num(text);
  return value === undefined ? 0 : value;
}

function buildSizing(state: ComposerState): SizingDefinition {
  const value = required(state.sizingValue);
  if (state.sizingMode === 'risk_percent') return { mode: 'risk_percent', value, balanceBasis: state.basis };
  if (state.sizingMode === 'allocation_percent') return { mode: 'allocation_percent', value, balanceBasis: state.basis };
  if (state.sizingMode === 'target_profit_percent') return { mode: 'target_profit_percent', value, balanceBasis: state.basis };
  return { mode: state.sizingMode, value };
}

function buildLeverage(state: ComposerState): LeverageDefinition | undefined {
  // §89: spot has no leverage and the planner rejects the field outright.
  if (state.marketType === 'spot') return undefined;
  return state.leverageMode === 'manual'
    ? { mode: 'manual', leverage: required(state.manualLeverage) }
    : { mode: 'auto_safe' };
}

function buildLevels(rows: LevelRow[]): { levels: { price: number; fraction: number }[]; incomplete: boolean } {
  const levels: { price: number; fraction: number }[] = [];
  let incomplete = false;
  for (const row of rows) {
    const price = num(row.price);
    const fraction = num(row.fraction);
    // A half-typed row must never become level 0 at price 0: the planner's own
    // "non-empty array" / "fractions must sum to 1" rules are the right gate.
    if (price === undefined || fraction === undefined) {
      incomplete = true;
      continue;
    }
    levels.push({ price, fraction });
  }
  return { levels, incomplete };
}

/**
 * The composer's execution-method body, as a PURE function of the form state.
 *
 * Exported because this is the seam where a control can be present in the markup
 * and still silently dropped from the request the server validates — precisely
 * the §29/§32 defect the engine audit found. Testing it needs no router and no
 * DOM, and it fails loudly if a field is added to the form but not the request.
 */
export function buildExecution(state: ComposerState): ExecutionDefinition {
  const durationMs = minutesToMs(state.durationMinutes) ?? 0;
  const sliceCount = optionalInt(state.slices);
  // Jitter is opt-in (PRD §28/§29): blank means the naive equal schedule. Keys are
  // omitted rather than sent as 0, so "unset" stays distinguishable from "no jitter".
  const qJit = num(state.quantityJitterPct);
  const iJit = num(state.intervalJitterPct);
  const config: TwapConfig | undefined = qJit === undefined && iJit === undefined
    ? undefined
    : {
        durationMs,
        orderType: state.makerOnly ? 'maker' : 'market',
        ...withOptional('quantityJitterPct', qJit),
        ...withOptional('intervalJitterPct', iJit),
      };
  switch (state.strategy) {
    case 'market':
      return { type: 'market' };
    case 'limit':
      return { type: 'limit', price: required(state.entryPrice), postOnly: state.postOnly };
    case 'twap':
      return { type: 'twap', durationMs, ...withOptional('slices', sliceCount), ...withOptional('config', config) };
    case 'adaptive_twap':
      return { type: 'adaptive_twap', durationMs, urgency: state.urgency, ...withOptional('slices', sliceCount), ...withOptional('config', config) };
    case 'iceberg':
      return { type: 'iceberg', visibleQuantity: required(state.visibleQty) };
    case 'chase_limit':
      return {
        type: 'chase_limit',
        urgency: state.urgency,
        ...withOptional('maxChaseDistance', num(state.maxChaseDistance)),
        ...withOptional('maxReplacements', optionalInt(state.maxReplacements)),
      };
    case 'scale_in':
      return { type: 'scale_in', levels: buildLevels(state.levels).levels };
    case 'scale_out':
      return { type: 'scale_out', levels: buildLevels(state.levels).levels };
  }
}

/**
 * Spreads a key ONLY when it holds a value, so an untouched optional field is
 * omitted from the request rather than sent as 0/false/'' — the server must be
 * able to tell "not set" from "set to zero".
 */
function withOptional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** An optional integer field: blank ⇒ undefined, else rounded (slice counts). */
function optionalInt(text: string): number | undefined {
  const value = num(text);
  return value === undefined ? undefined : Math.round(value);
}

/** Optional constraint keys are omitted, never sent as 0/false placeholders. */
function buildConstraints(state: ComposerState): NonNullable<ExecutionRequest['constraints']> {
  const constraints: NonNullable<ExecutionRequest['constraints']> = {};
  const maxSlippageBps = num(state.maxSlippageBps);
  const maxSpreadBps = num(state.maxSpreadBps);
  const maxPrice = num(state.maxPrice);
  const minPrice = num(state.minPrice);
  const maxDurationMs = minutesToMs(state.maxDurationMinutes);
  if (maxSlippageBps !== undefined) constraints.maxSlippageBps = maxSlippageBps;
  if (maxSpreadBps !== undefined) constraints.maxSpreadBps = maxSpreadBps;
  if (maxPrice !== undefined) constraints.maxPrice = maxPrice;
  if (minPrice !== undefined) constraints.minPrice = minPrice;
  if (maxDurationMs !== undefined) constraints.maxDurationMs = maxDurationMs;
  if (state.makerOnly) constraints.makerOnly = true;
  if (state.allowMarketFallback) constraints.allowMarketFallback = true;
  if (state.cancelIfRiskExceeded) constraints.cancelIfRiskExceeded = true;
  if (state.stopIfDisconnected) constraints.stopIfDisconnected = true;
  return constraints;
}

/** True when the entry/execution pairing of §54 forces a limit entry. */
export function entryIsLimit(state: ComposerState): boolean {
  return state.strategy === 'limit' || (state.strategy !== 'market' && state.entryType === 'limit');
}

export function buildRequest(state: ComposerState): ExecutionRequest {
  const stopPrice = num(state.stopLoss);
  const takeProfits: TakeProfitDefinition[] = [];
  for (const row of state.takeProfits) {
    const price = num(row.price);
    if (price === undefined) continue;
    const fraction = num(row.fraction);
    takeProfits.push(fraction === undefined ? { price } : { price, fraction });
  }
  const leverage = buildLeverage(state);
  const request: ExecutionRequest = {
    accountId: state.accountId,
    symbol: state.symbol.trim().toUpperCase(),
    marketType: state.marketType,
    side: state.side,
    intent: state.intent,
    entry: entryIsLimit(state)
      ? { type: 'limit', price: required(state.entryPrice), postOnly: state.postOnly }
      : { type: 'market' },
    sizing: buildSizing(state),
    execution: buildExecution(state),
    constraints: buildConstraints(state),
    riskPolicy: state.riskPolicy,
    existingPositionPolicy: state.existingPositionPolicy,
    mode: state.mode,
  };
  if (stopPrice !== undefined) request.stopLoss = { price: stopPrice };
  if (takeProfits.length > 0) request.takeProfits = takeProfits;
  if (leverage !== undefined) request.leverage = leverage;
  // §92: an empty selection means "use the risk profile's default".
  if (state.marketType === 'linear_perp' && state.marginMode !== '') request.marginMode = state.marginMode;
  return request;
}

/**
 * Only the checks that keep an obviously impossible request off the wire.
 * Every other rule — stop vs entry side, profile caps, fraction sums, venue
 * minimums, conflict detection — belongs to the planner, whose field-named
 * message this panel shows verbatim.
 */
export function missingRequired(state: ComposerState): string[] {
  const missing: string[] = [];
  const sizingValue = num(state.sizingValue);
  const slices = num(state.slices);
  if (state.accountId === '') missing.push('accountId: choose a connected account');
  if (state.symbol.trim() === '') missing.push('symbol: e.g. BTC/USDT');
  if (sizingValue === undefined || sizingValue <= 0) missing.push('sizing.value: must be a positive number');
  if (RISK_SIZING.has(state.sizingMode) && num(state.stopLoss) === undefined) {
    missing.push(`stopLoss: required for ${state.sizingMode} sizing — without a stop the position risk is unbounded`);
  }
  if (entryIsLimit(state) && num(state.entryPrice) === undefined) {
    missing.push(state.strategy === 'limit' ? 'execution.price: must match entry.price' : 'entry.price: must be a positive number');
  }
  if ((state.strategy === 'twap' || state.strategy === 'adaptive_twap') && minutesToMs(state.durationMinutes) === undefined) {
    missing.push('execution.durationMs: must be a positive number');
  }
  if (slices !== undefined && slices < 1) missing.push('execution.slices: must be a positive integer');
  if (state.strategy === 'iceberg' && num(state.visibleQty) === undefined) {
    missing.push('execution.visibleQuantity: must be a positive number');
  }
  if (state.strategy === 'scale_in' || state.strategy === 'scale_out') {
    const { levels, incomplete } = buildLevels(state.levels);
    if (levels.length === 0 || incomplete) missing.push('execution.levels: must be a non-empty array');
    else {
      const sum = levels.reduce((total, level) => total + level.fraction, 0);
      if (Math.abs(sum - 1) > 1e-9) missing.push(`execution.levels: fractions must sum to 1 (got ${sum.toFixed(4)})`);
    }
  }
  return missing;
}
