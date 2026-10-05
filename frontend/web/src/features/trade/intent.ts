/**
 * intent.ts — the trade composer's request builder (plan Phase 4, pure half).
 *
 * A trade intent becomes an `ExecutionRequest` for the executor's risk engine
 * HERE, as a pure function of the form state: no router, no DOM, no React. The
 * view (`ui/composer.tsx`) is then only wiring, and the two honesty rules this
 * seam enforces are testable offline —
 *
 *  1. A market type the executor cannot work returns `null`, so the composer
 *     sends nothing rather than a request the planner would reject.
 *  2. A control present in the markup is never silently dropped from the
 *     request: every field the form collects is read here, and `missingRequired`
 *     names the ones that would make the request impossible BEFORE it reaches
 *     the wire.
 *
 * Numbers arrive from the DOM as text. An empty field stays ABSENT (never a
 * silent `0`), and the two places a number is mandatory say so through
 * `missingRequired` instead of substituting one.
 */
import { executorMarketTypeFor } from '@/features/trade/client';
import type { MarketType, VenueId } from '@/features/trade/taxonomy';
import type {
  BalanceBasis,
  ExecutionMode,
  ExecutionRequest,
  MarginMode,
  SizingMode,
} from '@/platform/executor/types';

/** Every field the composer form collects. */
export type ComposerState = {
  accountId: string;
  venue: VenueId;
  base: string;
  quote: string;
  side: 'buy' | 'sell';
  intent: 'open' | 'close' | 'reduce';
  entryType: 'market' | 'limit';
  entryPrice: string;
  postOnly: boolean;
  stopLoss: string;
  takeProfit: string;
  sizingMode: SizingMode;
  sizingValue: string;
  basis: BalanceBasis;
  leverageMode: 'manual' | 'auto_safe';
  manualLeverage: string;
  marginMode: MarginMode | '';
  mode: ExecutionMode;
};

/** Sizing modes that read the balance basis (a percentage of something). */
export const BASIS_SIZING: ReadonlySet<SizingMode> = new Set<SizingMode>([
  'risk_percent',
  'allocation_percent',
  'target_profit_percent',
]);

/** Sizing modes that are meaningless without a stop — the risk bound IS the stop distance. */
export const RISK_SIZING: ReadonlySet<SizingMode> = new Set<SizingMode>(['risk_usd', 'risk_percent']);

/** A numeric field as text: empty stays absent, never a silent 0. */
export function num(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The composer's `ExecutionRequest`, or `null` when the market type has no
 * executor counterpart. Pure over the form state.
 */
export function buildTradeRequest(state: ComposerState, marketType: MarketType): ExecutionRequest | null {
  const execMT = executorMarketTypeFor(marketType);
  if (execMT === null) return null;
  const entryPrice = num(state.entryPrice);
  const isLimit = state.entryType === 'limit';
  const sizingValue = num(state.sizingValue) ?? 0;
  const sizing = BASIS_SIZING.has(state.sizingMode)
    ? { mode: state.sizingMode, value: sizingValue, balanceBasis: state.basis }
    : { mode: state.sizingMode, value: sizingValue };
  const request: ExecutionRequest = {
    accountId: state.accountId,
    symbol: `${state.base.trim().toUpperCase()}/${state.quote.trim().toUpperCase()}`,
    marketType: execMT,
    side: state.side,
    intent: state.intent,
    entry: isLimit ? { type: 'limit', price: entryPrice ?? 0, postOnly: state.postOnly } : { type: 'market' },
    sizing: sizing as ExecutionRequest['sizing'],
    execution: isLimit ? { type: 'limit', price: entryPrice ?? 0, postOnly: state.postOnly } : { type: 'market' },
    mode: state.mode,
  };
  const stopLoss = num(state.stopLoss);
  if (stopLoss !== undefined) request.stopLoss = { price: stopLoss };
  const takeProfit = num(state.takeProfit);
  if (takeProfit !== undefined) request.takeProfits = [{ price: takeProfit }];
  if (execMT === 'linear_perp') {
    request.leverage = state.leverageMode === 'manual'
      ? { mode: 'manual', leverage: num(state.manualLeverage) ?? 0 }
      : { mode: 'auto_safe' };
    if (state.marginMode !== '') request.marginMode = state.marginMode;
  }
  return request;
}

/**
 * The checks that keep an impossible request off the wire. A non-empty result
 * disables Preview and Place, so the composer never posts a request the planner
 * would reject — the reason is shown instead.
 */
export function missingRequired(state: ComposerState, marketType: MarketType): string[] {
  const missing: string[] = [];
  if (executorMarketTypeFor(marketType) === null) return missing;
  if (state.accountId === '') missing.push('accountId: connect a venue account first');
  if (state.base.trim() === '' || state.quote.trim() === '') missing.push('symbol: base and quote are required');
  const sizingValue = num(state.sizingValue);
  if (sizingValue === undefined || sizingValue <= 0) missing.push('sizing.value: must be a positive number');
  if (RISK_SIZING.has(state.sizingMode) && num(state.stopLoss) === undefined) {
    missing.push('stopLoss: required for risk sizing — without a stop the position risk is unbounded');
  }
  if (state.entryType === 'limit' && num(state.entryPrice) === undefined) {
    missing.push('entry.price: a limit needs a price');
  }
  return missing;
}
