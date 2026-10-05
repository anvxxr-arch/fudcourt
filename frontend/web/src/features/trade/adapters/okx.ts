/** OKX — CEX, API key. Symbol convention: `<BASE>-<QUOTE>` (BTC-USDT). */
import { VENUE_MARKET_TYPES } from '@/features/trade/taxonomy';
import type { VenueBinding } from './types';
import { ACCOUNT_READ, BALANCES_READ, POSITIONS_READ } from './types';

export const okxBinding: VenueBinding = {
  venue: 'okx',
  venueType: 'cex',
  kind: 'api-key',
  marketTypes: VENUE_MARKET_TYPES.okx,
  venueSymbol: (base, quote) => `${base}-${quote}`.toUpperCase(),
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
