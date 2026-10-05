/**
 * adapters/types.ts — the trade domain's read-binding contract (plan Phase 5).
 *
 * THE BOUNDARY THIS ENCODES. The executor (G14) owns ORDER PLACEMENT: it holds
 * the sealed BYOK credentials and sends the orders. The trade domain owns the
 * READS around a position — where an account's positions, balances and account
 * state come from. A binding is therefore a small, honest map: for one venue,
 * how a canonical base/quote becomes the venue's own symbol, and which read
 * channel serves each resource.
 *
 * WHY A `live` FLAG. A read channel that no route serves yet is a STATED gap,
 * not an empty panel. `live: false` lets the UI say "positions: not served by an
 * API route yet" instead of rendering a zero row, which would be a lie a trader
 * could act on (the same null-vs-0 rule the rest of the domain keeps).
 */
import type { MarketType, VenueId, VenueType } from '@/features/trade/taxonomy';

/** One way the trade domain reads a resource for a venue. */
export type ReadChannel = {
  /** The API path the trade domain reads this from. `:id` is the account id. */
  path: string;
  /** False until a route serves this — the UI renders a stated gap, never an empty panel. */
  live: boolean;
};

/** Everything the trade domain needs to know about one venue's read surface. */
export type VenueBinding = {
  venue: VenueId;
  venueType: VenueType;
  /** API key (CEX) or wallet (DEX) — how a connection to this venue is held. */
  kind: 'api-key' | 'wallet';
  /** The market types this venue serves (mirrors `VENUE_MARKET_TYPES`). */
  marketTypes: readonly MarketType[];
  /**
   * The venue's OWN symbol for a canonical base/quote, or `null` when it cannot
   * be derived from base+quote alone (a DEX routes by token contract, not a
   * ticker). A view never builds a native symbol when this returns `null`.
   */
  venueSymbol: (base: string, quote: string, marketType: MarketType) => string | null;
  /** Where the trade domain reads positions / balances / account state. */
  reads: { positions: ReadChannel; balances: ReadChannel; account: ReadChannel };
};

/**
 * The one channel that IS live today: the executor's credential list is the
 * account source of truth (BYOK, Phase 18), so every binding points at it.
 * Positions and balances are declared but not served by a route yet.
 */
export const ACCOUNT_READ: ReadChannel = { path: '/api/executor/accounts', live: true };
export const POSITIONS_READ: ReadChannel = { path: '/api/trade/accounts/:id/positions', live: false };
export const BALANCES_READ: ReadChannel = { path: '/api/trade/accounts/:id/balances', live: false };
