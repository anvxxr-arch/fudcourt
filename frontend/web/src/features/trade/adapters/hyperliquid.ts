/**
 * Hyperliquid — DEX (on-chain order book), wallet connection. A perpetual is
 * addressed by the coin name alone (`BTC`), so base is the symbol and quote is
 * implicit USDC.
 */
import { VENUE_MARKET_TYPES } from '@/features/trade/taxonomy';
import type { VenueBinding } from './types';
import { ACCOUNT_READ, BALANCES_READ, POSITIONS_READ } from './types';

export const hyperliquidBinding: VenueBinding = {
  venue: 'hyperliquid',
  venueType: 'dex',
  kind: 'wallet',
  marketTypes: VENUE_MARKET_TYPES.hyperliquid,
  venueSymbol: (base) => base.toUpperCase(),
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
