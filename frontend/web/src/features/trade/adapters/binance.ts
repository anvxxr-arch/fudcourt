/** Binance — CEX, API key. Symbol convention: `<BASE><QUOTE>` (BTCUSDT). */
import { VENUE_MARKET_TYPES } from '@/features/trade/taxonomy';
import type { VenueBinding } from './types';
import { ACCOUNT_READ, BALANCES_READ, POSITIONS_READ } from './types';

export const binanceBinding: VenueBinding = {
  venue: 'binance',
  venueType: 'cex',
  kind: 'api-key',
  marketTypes: VENUE_MARKET_TYPES.binance,
  venueSymbol: (base, quote) => `${base}${quote}`.toUpperCase(),
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
