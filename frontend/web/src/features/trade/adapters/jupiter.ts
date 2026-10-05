/**
 * Jupiter — Solana swap aggregator, wallet connection. Routes are addressed by
 * SPL mint addresses, so the venue symbol is not derivable from base+quote and
 * is honestly `null`.
 */
import { VENUE_MARKET_TYPES } from '@/features/trade/taxonomy';
import type { VenueBinding } from './types';
import { ACCOUNT_READ, BALANCES_READ, POSITIONS_READ } from './types';

export const jupiterBinding: VenueBinding = {
  venue: 'jupiter',
  venueType: 'dex',
  kind: 'wallet',
  marketTypes: VENUE_MARKET_TYPES.jupiter,
  venueSymbol: () => null,
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
