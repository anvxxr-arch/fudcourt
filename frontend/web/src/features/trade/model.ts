/**
 * The trade domain's canonical data model (plan Phase 3, 5, 17, 18).
 *
 * THE POINT OF THIS FILE. Every venue spells the same instrument differently —
 * Binance says `BTCUSDT`, another venue says `BTC-USDT`, a third says
 * `BTC/USDT`, a fourth appends `-PERP`. If any of those spellings reaches a
 * view, the view is now coupled to a venue and cannot be reused. So the whole
 * domain speaks ONE instrument shape, and the venue's own symbol is a FIELD on
 * it (`venueSymbol`), never the identity. The frontend never needs to know a
 * native exchange symbol; it addresses `btc-usdt` and the adapter resolves.
 *
 * The four entities and what they are for:
 *
 *   Instrument     — identity + constraints of a tradable thing, venue-agnostic.
 *   VenueCapability— what a specific venue ACTUALLY supports for an instrument.
 *                    Not every venue has every order type; the executor fills
 *                    the gap rather than the UI hiding the button.
 *   Position       — a normalized open position, so a CEX perp and a DEX swap
 *                    render in the same table.
 *   TradingAccount — a user's connection to a venue (API key or wallet), with
 *                    the credential material deliberately NOT part of this shape.
 *
 * Honesty rules that live in the TYPES, not in a comment somewhere:
 *   - a measured field is `number | null`, never `0` for "unknown";
 *   - `capabilities` states what is FALSE as well as what is true, so a missing
 *     order type is a stated limitation rather than an absent button;
 *   - the account shape carries `apiKeyMasked`, never a key — the full secret
 *     has no field to live in.
 */
import type { MarginMode, MarketType, OrderType, VenueId, VenueType } from '@/features/trade/taxonomy';

/**
 * A tradable instrument, canonical and venue-agnostic.
 *
 * `id` is the stable URL/registry key (`btc-usdt`); it is what a route resolves
 * and what an order references. `venueSymbol` is how the VENUE spells the same
 * thing and is resolved by the adapter, so a caller never builds one.
 */
export type Instrument = {
  /** Canonical, stable, URL-safe: `<base>-<quote>` lowercased, e.g. `btc-usdt`. */
  id: string;
  base: string;
  quote: string;
  marketType: MarketType;
  /** The venue this binding is for. An instrument id may have one per venue. */
  venue: VenueId;
  /** The venue's OWN symbol, e.g. `BTCUSDT`. Never rendered as the identity. */
  venueSymbol: string;
  /** `linear` / `inverse` / `quanto` for derivatives; null for spot and swap. */
  contractType: string | null;
  /** Minimum price increment. Null when the venue does not publish one. */
  tickSize: number | null;
  /** Minimum quantity increment (lot). Null when the venue does not publish one. */
  lotSize: number | null;
  /** Minimum order notional, in quote units. Null when the venue does not publish one. */
  minOrder: number | null;
  /** Max leverage the venue allows here; null for anything unleveraged. */
  maxLeverage: number | null;
  /** ISO-8601 expiry for a dated instrument (futures/options); null otherwise. */
  expiry: string | null;
};

/**
 * What a venue supports for one instrument (plan Phase 5).
 *
 * This is where the value proposition lives: when `nativeTwap` is false, the
 * FUDCourt executor slices the order itself. So the board states the gap rather
 * than hiding it — a trader reading "TWAP: executor" knows the strategy is
 * ours, not the venue's.
 */
export type VenueCapability = {
  venue: VenueId;
  instrumentId: string;
  marketType: MarketType;
  /** Every order type, each explicitly true or false. No absent keys. */
  orderTypes: Readonly<Record<OrderType, boolean>>;
  /** Whether the venue natively slices a TWAP/VWAP, or we do it. */
  nativeTwap: boolean;
  nativeVwap: boolean;
  nativeIceberg: boolean;
  leverage: boolean;
  /** Null for a market type with no margin concept (spot, swap). */
  marginModes: { cross: boolean; isolated: boolean } | null;
  reduceOnly: boolean;
  postOnly: boolean;
};

/** One leg of a normalized open position, as returned by any venue adapter. */
export type Position = {
  id: string;
  accountId: string;
  venue: VenueId;
  venueType: VenueType;
  instrumentId: string;
  marketType: MarketType;
  /** Signed: positive is long, negative is short. Spot holdings are long-only. */
  quantity: number;
  entryPrice: number | null;
  markPrice: number | null;
  leverage: number | null;
  marginMode: MarginMode | null;
  margin: number | null;
  liquidationPrice: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  /** Unix ms the position was opened, or null when the venue does not report it. */
  openedAt: number | null;
};

/**
 * A user's connection to a venue (plan Phase 18).
 *
 * The credential material has NO field here on purpose: only the masked key is
 * ever part of the domain shape, so a secret cannot leak into a view by someone
 * spreading the object. Secrets live server-side in the executor store.
 */
export type TradingAccount = {
  id: string;
  venue: VenueId;
  venueType: VenueType;
  label: string;
  /** Partial display only: `abc...xyz`. Never the full key. */
  apiKeyMasked: string | null;
  /** Whether the connection is a wallet (DEX) rather than an API key (CEX). */
  kind: 'api-key' | 'wallet';
  /** Whether the venue reports trade permission. Null = venue is silent. */
  canTrade: boolean | null;
  /** True when the key was granted withdrawal rights — the UI warns, never hides. */
  hasWithdrawPermission: boolean | null;
};

/** One row of the command center's market board, after the ticker normalizes it. */
export type MarketRow = {
  /** The canonical instrument id the row addresses. */
  instrumentId: string;
  base: string;
  quote: string;
  marketType: MarketType;
  /** Median price across venues, or null when no venue answered. */
  price: number | null;
  /**
   * 24h change in PERCENT (1.39 = +1.39%), or null when uncomputable.
   *
   * PERCENT, not a fraction — the ticker reports ccxt's `percentage` field
   * directly (and its own board prints it with no x100). Treating it as a
   * fraction printed +138.87% for a +1.39% move, so the unit is stated here and
   * the formatters take percent. See `client.ts` for the same warning.
   */
  change24h: number | null;
  /** 24h quote volume, or null when no venue reported one. */
  quoteVolume: number | null;
  /**
   * Per-venue prices, so the board can show the actual sources.
   *
   * `venue` is a plain string, NOT a `VenueId`: a PRICE SOURCE is not the same
   * list as a TRADABLE VENUE. The public ticker reads ten venues (okx, bybit,
   * bitget, mexc, phemex, bingx, bitfinex, htx, coinbase, kraken) to establish a
   * price; FUDCourt can only ROUTE an order to the venues in `VENUES`. Typing
   * this as `VenueId` would silently drop every source we cannot trade on and
   * pretend the price came from fewer venues than it did.
   */
  venues: readonly { venue: string; price: number | null }[];
  /** Max relative divergence across venues, in percent. Null under two venues. */
  spreadPct: number | null;
};

/** The command center's headline account figures, all nullable when unconnected. */
export type PortfolioSummary = {
  /** Total account equity in quote terms, or null when no account is connected. */
  equity: number | null;
  available: number | null;
  exposure: number | null;
  /** Realized P&L since UTC midnight. Null when no account is connected. */
  pnlToday: number | null;
  /** Whether any account is connected at all. */
  connected: boolean;
};