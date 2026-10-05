/**
 * adapters/index.ts — the trade domain's per-venue read-binding registry
 * (plan Phase 5).
 *
 * One binding per venue in the taxonomy, keyed by `VenueId` so the registry is
 * TOTAL: a venue with no binding is a compile error, not a runtime `undefined`.
 * Each binding answers the two questions the trade surface asks of a venue —
 * "what is your symbol for this pair?" and "where do I read positions, balances
 * and account state?" — and nothing about placing orders, which is the
 * executor's job (G14).
 *
 * The registry is the ONE place the trade domain names a venue's symbol
 * convention, so the composer resolves `btc-usdt` → `BTCUSDT` here and no view
 * ever builds a native symbol itself (the `model.ts` rule).
 */
import type { VenueId } from '@/features/trade/taxonomy';
import type { VenueBinding } from './types';
import { binanceBinding } from './binance';
import { bybitBinding } from './bybit';
import { mexcBinding } from './mexc';
import { okxBinding } from './okx';
import { hyperliquidBinding } from './hyperliquid';
import { uniswapBinding } from './uniswap';
import { jupiterBinding } from './jupiter';

export type { ReadChannel, VenueBinding } from './types';

/** Every venue's binding, keyed by `VenueId` — total over the taxonomy. */
export const VENUE_BINDINGS: Readonly<Record<VenueId, VenueBinding>> = {
  binance: binanceBinding,
  bybit: bybitBinding,
  mexc: mexcBinding,
  okx: okxBinding,
  hyperliquid: hyperliquidBinding,
  uniswap: uniswapBinding,
  jupiter: jupiterBinding,
};

/** The bindings in taxonomy order, for a list renderer. */
export const VENUE_BINDING_LIST: readonly VenueBinding[] = Object.values(VENUE_BINDINGS);

/** The binding for one venue. */
export function bindingFor(venue: VenueId): VenueBinding {
  return VENUE_BINDINGS[venue];
}
