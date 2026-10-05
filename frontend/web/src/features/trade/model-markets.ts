/**
 * model-markets.ts — market types, instruments, and domain entities (split from model-taxonomy.ts).
 *
 * WHAT lives here: the WHAT (MarketType/MARKET_TYPES), the HOW (ExecutionStrategy,
 * OrderType, MarginMode), the instrument registry (INSTRUMENTS + helpers), and the
 * venue-agnostic domain entities (Instrument, VenueCapability, Position,
 * TradingAccount, MarketRow, PortfolioSummary). Venue-owned tables and the
 * capability matrix live in `./model-venues`. Re-exported by `./model-taxonomy`
 * so existing importers keep working unchanged.
 */
import type { VenueId, VenueType } from './model-venues';

/** WHAT is traded. The canonical set, in the plan's order. */
export type MarketType = 'spot' | 'margin' | 'perpetual' | 'futures' | 'options' | 'swap';

/** The vocabulary the public ticker board (`/api/ticker`) speaks. */
export type TickerType = 'spot' | 'swap' | 'future' | 'option';

export type MarketTypeEntry = {
  id: MarketType;
  label: string;
  /** One line on what this market type is — the board's tab tooltip. */
  note: string;
  /**
   * Which ticker-board type quotes this market type, or `null` when the board
   * has no such vocabulary yet. `perpetual` maps to `swap` because a perpetual
   * IS a swap in the venue vocabulary; `margin` is `null` because a margin
   * balance is an account setting, not a separate quotable instrument.
   */
  tickerType: TickerType | null;
  /** Whether opening here requires a connected, funded account. */
  requiresAccount: boolean;
};

export const MARKET_TYPES: readonly MarketTypeEntry[] = [
  {
    id: 'spot',
    label: 'Spot',
    note: 'Buy and sell the asset outright, settled immediately. No leverage, no liquidation.',
    tickerType: 'spot',
    requiresAccount: true,
  },
  {
    id: 'margin',
    label: 'Margin',
    note: 'Borrow against collateral to trade a larger spot position. Interest accrues on the loan.',
    tickerType: null,
    requiresAccount: true,
  },
  {
    id: 'perpetual',
    label: 'Perpetual',
    note: 'A leveraged contract with no expiry, held open by periodic funding payments.',
    tickerType: 'swap',
    requiresAccount: true,
  },
  {
    id: 'futures',
    label: 'Futures',
    note: 'A leveraged contract with a fixed expiry and settlement, priced at a basis to spot.',
    tickerType: 'future',
    requiresAccount: true,
  },
  {
    id: 'options',
    label: 'Options',
    note: 'A right, not an obligation, to buy or sell at a strike before expiry. Priced by implied volatility.',
    tickerType: 'option',
    requiresAccount: true,
  },
  {
    id: 'swap',
    label: 'Swap',
    note: 'Exchange one asset for another on-chain, routed through DEX pools. No order book, no account.',
    tickerType: 'swap',
    requiresAccount: false,
  },
] as const;
/** HOW an order is worked. Independent of the market type and the venue. */
export type ExecutionStrategy = 'direct' | 'twap' | 'vwap' | 'iceberg' | 'scaled' | 'dca' | 'smart_route';

export type ExecutionStrategyEntry = {
  id: ExecutionStrategy;
  label: string;
  note: string;
};

export const EXECUTION_STRATEGIES: readonly ExecutionStrategyEntry[] = [
  { id: 'direct', label: 'Direct', note: 'One order, sent as placed. The default.' },
  { id: 'twap', label: 'TWAP', note: 'Slice the order evenly over a time window to track the time-weighted average price.' },
  { id: 'vwap', label: 'VWAP', note: 'Slice in proportion to traded volume to track the volume-weighted average price.' },
  { id: 'iceberg', label: 'Iceberg', note: 'Show a small tip on the book and refill it as the hidden size fills.' },
  { id: 'scaled', label: 'Scaled', note: 'Split across price levels — accumulate on the way down, distribute on the way up.' },
  { id: 'dca', label: 'DCA', note: 'Fixed buys on a schedule, regardless of price.' },
  { id: 'smart_route', label: 'Smart Route', note: 'Score venues on effective execution cost and route to the cheapest.' },
] as const;
/** The order types a user can express, independent of which venue supports them. */
export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit' | 'take_profit' | 'trailing_stop' | 'oco';

export type OrderTypeEntry = {
  id: OrderType;
  label: string;
  note: string;
};

export const ORDER_TYPES: readonly OrderTypeEntry[] = [
  { id: 'market', label: 'Market', note: 'Fill immediately at the best available price.' },
  { id: 'limit', label: 'Limit', note: 'Rest on the book at your price or better.' },
  { id: 'stop_market', label: 'Stop Market', note: 'Trigger a market order once a stop price trades.' },
  { id: 'stop_limit', label: 'Stop Limit', note: 'Trigger a limit order once a stop price trades.' },
  { id: 'take_profit', label: 'Take Profit', note: 'Close at a target price to bank the gain.' },
  { id: 'trailing_stop', label: 'Trailing Stop', note: 'A stop that follows the price by a fixed distance.' },
  { id: 'oco', label: 'OCO', note: 'One-Cancels-Other: a take-profit and a stop, where filling one cancels the other.' },
] as const;
/** Margin mode (plan Phase 2) — a property of a position, not a market type. */
export type MarginMode = 'cross' | 'isolated';

export type MarginModeEntry = {
  id: MarginMode;
  label: string;
  note: string;
};

export const MARGIN_MODES: readonly MarginModeEntry[] = [
  { id: 'isolated', label: 'Isolated', note: 'Margin is ring-fenced per position; a liquidation cannot touch the rest of the account.' },
  { id: 'cross', label: 'Cross', note: 'The whole account balance backs every position; capital-efficient but shared risk.' },
] as const;
/** Lookup by id — the board resolves every market type through this. */
export const MARKET_TYPE_BY_ID: Readonly<Record<MarketType, MarketTypeEntry>> = Object.fromEntries(
  MARKET_TYPES.map((m) => [m.id, m]),
) as Readonly<Record<MarketType, MarketTypeEntry>>;
/** Whether a market type id is one this domain knows. */
export function isMarketType(value: string): value is MarketType {
  return value in MARKET_TYPE_BY_ID;
}
/**
 * instrument.ts — the trade domain's canonical instrument registry (plan Phase 3).
 *
 * WHY A REGISTRY AND NOT A STRING BUILT IN A VIEW. Every venue spells the same
 * pair differently (`BTCUSDT`, `BTC-USDT`, `BTC/USDT`), so the domain fixes ONE
 * spelling for IDENTITY and lets the adapter resolve the venue's own form (the
 * `model.ts` rule: the native symbol is a FIELD, never the id). This file is the
 * single place that spelling is decided.
 *
 * WHY A CLOSED SET, NOT "ANYTHING THAT PARSES". The registry is the pairs the
 * market board can actually address. `/trade/spot/<id>` must be a REAL 404 for an
 * id we cannot quote — the same rule the ticker detail route keeps — because a
 * shape-only check turns every well-formed pair into an indexable page whose own
 * data source answers "no venue quotes this": a page that exists for a question
 * nobody asked, and a page and its API disagreeing about what exists.
 *
 * The trade domain OWNS this list on purpose (plan Phase 3: "one registry that
 * unifies naming across exchanges"). It is deliberately NOT imported from the
 * ticker family: feature families are independent (DR-018, enforced by the
 * structure gate), so the trade domain declares the identity space it serves
 * rather than reaching into a sibling's module. A board row whose id is not in
 * this registry is left UNLINKED by the board (never a broken link) — see
 * `ui/dashboard.tsx`.
 */

/** The canonical id for a pair: `<base>-<quote>`, lowercased and hyphen-joined. */
export function canonicalInstrumentId(base: string, quote: string): string {
  return `${base.trim().toLowerCase()}-${quote.trim().toLowerCase()}`;
}

/**
 * The bases the trade domain addresses. Every one is quoted against USDT, which
 * is the settlement the cross-venue ticker board reads — so a board row always
 * carries an id this registry has.
 */
const BASES: readonly string[] = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE',
  'ADA', 'AVAX', 'LINK', 'DOT', 'MATIC', 'LTC',
  'TRX', 'TON', 'ARB', 'OP', 'ATOM', 'NEAR',
  'APT', 'SUI', 'PEPE', 'SHIB', 'INJ', 'SEI',
  'TIA', 'RUNE', 'WIF', 'AAVE', 'UNI', 'CRV',
];

/** One canonical instrument. `id` is DERIVED, so it cannot disagree with base/quote. */
export type InstrumentEntry = { id: string; base: string; quote: string };

/** The registry, canonical. `id` is built by `canonicalInstrumentId`, never typed twice. */
export const INSTRUMENTS: readonly InstrumentEntry[] = BASES.map((base) => ({
  id: canonicalInstrumentId(base, 'USDT'),
  base,
  quote: 'USDT',
}));

const INSTRUMENT_BY_ID: ReadonlyMap<string, InstrumentEntry> = new Map(INSTRUMENTS.map((i) => [i.id, i]));

/** Whether a route segment is a canonical instrument id this domain can address. */
export function isInstrumentId(value: string): boolean {
  return INSTRUMENT_BY_ID.has(value);
}

/** The registry entry for an id, or `undefined` when it is not one. */
export function instrumentById(id: string): InstrumentEntry | undefined {
  return INSTRUMENT_BY_ID.get(id);
}

/** `BTC / USDT` — the instrument's display label, from its own halves. */
export function instrumentLabel(id: string): string {
  const entry = INSTRUMENT_BY_ID.get(id);
  return entry ? `${entry.base} / ${entry.quote}` : id.toUpperCase();
}

/**
 * The canonical route for one instrument within a market type
 * (`spot`, `btc-usdt` → `/trade/spot/btc-usdt`). The market type is the route
 * segment and the instrument is its child — the plan's `/trade/<type>/<id>`.
 */
export function instrumentHref(marketType: MarketType, id: string): string {
  return `/trade/${marketType}/${id}`;
}
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
