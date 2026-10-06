import { VENUE_MARKET_TYPES, type MarketType, type VenueId, type VenueType } from '@/features/trade/model';
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
/** Binance — CEX, API key. Symbol convention: `<BASE><QUOTE>` (BTCUSDT). */
export const binanceBinding: VenueBinding = {
  venue: 'binance',
  venueType: 'cex',
  kind: 'api-key',
  marketTypes: VENUE_MARKET_TYPES.binance,
  venueSymbol: (base, quote) => `${base}${quote}`.toUpperCase(),
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
/** Bybit — CEX, API key. Symbol convention: `<BASE><QUOTE>` (BTCUSDT). */
export const bybitBinding: VenueBinding = {
  venue: 'bybit',
  venueType: 'cex',
  kind: 'api-key',
  marketTypes: VENUE_MARKET_TYPES.bybit,
  venueSymbol: (base, quote) => `${base}${quote}`.toUpperCase(),
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
/** MEXC — CEX, API key. Symbol convention: `<BASE><QUOTE>` (BTCUSDT). */
export const mexcBinding: VenueBinding = {
  venue: 'mexc',
  venueType: 'cex',
  kind: 'api-key',
  marketTypes: VENUE_MARKET_TYPES.mexc,
  venueSymbol: (base, quote) => `${base}${quote}`.toUpperCase(),
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
/** OKX — CEX, API key. Symbol convention: `<BASE>-<QUOTE>` (BTC-USDT). */
export const okxBinding: VenueBinding = {
  venue: 'okx',
  venueType: 'cex',
  kind: 'api-key',
  marketTypes: VENUE_MARKET_TYPES.okx,
  venueSymbol: (base, quote) => `${base}-${quote}`.toUpperCase(),
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
/**
 * Hyperliquid — DEX (on-chain order book), wallet connection. A perpetual is
 * addressed by the coin name alone (`BTC`), so base is the symbol and quote is
 * implicit USDC.
 */
export const hyperliquidBinding: VenueBinding = {
  venue: 'hyperliquid',
  venueType: 'dex',
  kind: 'wallet',
  marketTypes: VENUE_MARKET_TYPES.hyperliquid,
  venueSymbol: (base) => base.toUpperCase(),
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
/**
 * Uniswap — EVM AMM, wallet connection. A pool is addressed by token CONTRACT
 * addresses, not a base/quote ticker, so the venue symbol cannot be derived from
 * base+quote alone and is honestly `null` (the adapter resolves it from the
 * token list at call time).
 */
export const uniswapBinding: VenueBinding = {
  venue: 'uniswap',
  venueType: 'dex',
  kind: 'wallet',
  marketTypes: VENUE_MARKET_TYPES.uniswap,
  venueSymbol: () => null,
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
/**
 * Jupiter — Solana swap aggregator, wallet connection. Routes are addressed by
 * SPL mint addresses, so the venue symbol is not derivable from base+quote and
 * is honestly `null`.
 */
export const jupiterBinding: VenueBinding = {
  venue: 'jupiter',
  venueType: 'dex',
  kind: 'wallet',
  marketTypes: VENUE_MARKET_TYPES.jupiter,
  venueSymbol: () => null,
  reads: { positions: POSITIONS_READ, balances: BALANCES_READ, account: ACCOUNT_READ },
};
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
