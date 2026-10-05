/**
 * Uniswap — EVM AMM, wallet connection. A pool is addressed by token CONTRACT
 * addresses, not a base/quote ticker, so the venue symbol cannot be derived from
 * base+quote alone and is honestly `null` (the adapter resolves it from the
 * token list at call time).
 */
import { VENUE_MARKET_TYPES } from '@/features/trade/taxonomy';
import type { VenueBinding } from './types';
import { ACCOUNT_READ, BALANCES_READ, POSITIONS_READ } from './types';

export const uniswapBinding: VenueBinding = {
  venue: 'uniswap',
  venueType: 'dex',
  kind: 'wallet',
  marketTypes: VENUE_MARKET_TYPES.uniswap,
  venueSymbol: () => null,
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
