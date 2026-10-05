/**
 * The trade domain's canonical taxonomy (plan Phase 1–2).
 *
 * WHY A TAXONOMY AND NOT A PROVIDER LIST. Three concepts get constantly
 * confused in trading UIs, and confusing them is what makes an engine
 * impossible to extend later:
 *
 *   Market type — WHAT is traded   (spot, margin, perpetual, futures, options, swap)
 *   Venue       — WHERE it trades  (Binance, Bybit, OKX, Hyperliquid, Uniswap…)
 *   Execution   — HOW it is worked (direct, TWAP, VWAP, iceberg, scaled, DCA…)
 *
 * They are orthogonal: a perpetual on Binance worked with a TWAP uses one of
 * each. So NONE of them is a route segment by itself. The routes are market
 * types (`/trade/perpetual`), and the venue and the strategy are METADATA on an
 * order. A `/trade/binance` route would make the venue structural and force a
 * second copy of every market type under every venue — the exact blow-up this
 * file exists to prevent.
 *
 * `venueType` (CEX vs DEX) is a property of the VENUE, not a market type: the
 * same swap can be a CEX order or a DEX pool, and the distinction is where it
 * executes, not what it is.
 *
 * A market type also declares its `tickerType`, which is the vocabulary the
 * public ticker board already speaks (`/api/ticker`). That mapping lives HERE,
 * once, so the board can render a market type without a second hard-coded table
 * — and so a market type the ticker cannot quote yet (margin) is an explicit
 * `null`, never a silent fall-through to spot that answers a different question.
 */

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

/** WHERE it trades. CEX or DEX is a venue property, not a market type. */
export type VenueType = 'cex' | 'dex';

export type VenueId = 'binance' | 'bybit' | 'mexc' | 'okx' | 'hyperliquid' | 'uniswap' | 'jupiter';

export type VenueEntry = {
  id: VenueId;
  label: string;
  type: VenueType;
  /** One line on the venue — the capability board's row tooltip. */
  note: string;
};

export const VENUES: readonly VenueEntry[] = [
  { id: 'binance', label: 'Binance', type: 'cex', note: 'Largest centralized spot and USDT-margined derivatives venue.' },
  { id: 'bybit', label: 'Bybit', type: 'cex', note: 'Centralized derivatives venue; linear perpetuals and dated futures.' },
  { id: 'mexc', label: 'MEXC', type: 'cex', note: 'Centralized venue with a wide long-tail spot listing.' },
  { id: 'okx', label: 'OKX', type: 'cex', note: 'Centralized venue quoting USD- and USDT-settled contracts.' },
  { id: 'hyperliquid', label: 'Hyperliquid', type: 'dex', note: 'On-chain order-book perpetual DEX.' },
  { id: 'uniswap', label: 'Uniswap', type: 'dex', note: 'EVM automated-market-maker DEX; swap by pool route.' },
  { id: 'jupiter', label: 'Jupiter', type: 'dex', note: 'Solana swap aggregator; routes across pools for the best price.' },
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

export const VENUE_BY_ID: Readonly<Record<VenueId, VenueEntry>> = Object.fromEntries(
  VENUES.map((v) => [v.id, v]),
) as Readonly<Record<VenueId, VenueEntry>>;

/** The market types a venue can serve, so the board never offers an impossible pairing. */
export const VENUE_MARKET_TYPES: Readonly<Record<VenueId, readonly MarketType[]>> = {
  binance: ['spot', 'margin', 'perpetual', 'futures', 'options'],
  bybit: ['spot', 'perpetual', 'futures', 'options'],
  mexc: ['spot', 'perpetual', 'futures'],
  okx: ['spot', 'margin', 'perpetual', 'futures', 'options'],
  hyperliquid: ['perpetual'],
  uniswap: ['swap'],
  jupiter: ['swap'],
} as const;

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
/**
 * capabilities.ts — the trade domain's declared venue capability matrix
 * (plan Phase 3 board + Phase 5 data).
 *
 * WHAT THIS IS. One row per (venue × market type) the taxonomy says a venue
 * serves — never a pairing outside `VENUE_MARKET_TYPES`, because the board must
 * not offer an impossible combination. Each row states, EXHAUSTIVELY, every
 * `OrderType` as true or false: the supported set is written down, and every
 * other type is an explicit `false`, so a missing capability is a STATED
 * limitation the board renders as `✕`, never an absent column. An absent key is
 * a bug, not a missing feature (the `model.ts` honesty rule).
 *
 * WHERE THE VALUES COME FROM. They are the domain's DECLARED capabilities, not a
 * live probe. For Binance, Bybit and MEXC they agree with the executor's own
 * probed registry (`backend/workers/executor/internal/exchanges` EXCHANGE_CAPABILITIES): a
 * `nativeTwap: false` there is a `nativeTwap: false` here, so the board's
 * "TWAP: executor" cell matches the engine that actually slices the order. The
 * venues the executor does not route yet (OKX, Hyperliquid, Uniswap, Jupiter)
 * are declared from their public order-type surface and called out in the row's
 * own comment. The board never claims more than this table: a `false` is a
 * statement about the VENUE, and the executor's synthetic engine covers the gap
 * (PRD §28) — that is the whole point of stating the gap rather than hiding it.
 *
 * The matrix is BUILT from `VENUE_MARKET_TYPES`, so the two can never disagree:
 * adding a market type to a venue without a capability row is a hard error, and
 * a row for a pairing the taxonomy does not carry is impossible by construction.
 */

/**
 * The supported set written down; every other `OrderType` becomes an explicit
 * `false`. The returned record is TOTAL by construction — the seven keys are
 * always present — so a capability that omits a type cannot be represented.
 */
function orderTypeRecord(supported: readonly OrderType[]): Readonly<Record<OrderType, boolean>> {
  const set = new Set<OrderType>(supported);
  const record = {} as Record<OrderType, boolean>;
  for (const orderType of ORDER_TYPES) record[orderType.id] = set.has(orderType.id);
  return record;
}

/** The order types an order-book venue has for a spot-like (unleveraged) product. */
const BOOK_SPOT: readonly OrderType[] = ['market', 'limit', 'stop_market', 'stop_limit', 'take_profit'];
/** The same book, plus a stop that follows the price (the venue offers trailing). */
const BOOK_TRAILING: readonly OrderType[] = [...BOOK_SPOT, 'trailing_stop'];
/** A derivatives book: the spot set plus trailing; reduce-only is a separate flag. */
const BOOK_DERIV = BOOK_TRAILING;
/** An AMM/DEX swap has exactly one executable order type: market. */
const AMM_SWAP: readonly OrderType[] = ['market'];

/** One capability row's input, minus the venue/market-type the builder supplies. */
type CapabilityFlags = {
  /** The canonical instrument the board uses to represent this row. */
  instrumentId: string;
  /** The order types the venue ACTUALLY has here; everything else is stated false. */
  supported: readonly OrderType[];
  nativeTwap?: boolean;
  nativeVwap?: boolean;
  nativeIceberg?: boolean;
  leverage?: boolean;
  /** Null for a market type with no margin concept (spot, swap). */
  marginModes?: { cross: boolean; isolated: boolean } | null;
  reduceOnly?: boolean;
  postOnly?: boolean;
};

/**
 * The declared flags per venue × market type. Typed `Partial` so a venue only
 * names the market types it serves — the BUILDER iterates `VENUE_MARKET_TYPES`,
 * not this object, so a missing entry is a thrown error and an extra entry is
 * simply unreachable. That keeps the taxonomy the single source of truth for
 * which pairings exist.
 */
const CAPABILITY_INPUTS: Readonly<Record<VenueId, Readonly<Partial<Record<MarketType, CapabilityFlags>>>>> = {
  // ── Binance — the executor's own registry (exchange.ts) is the source ──────
  binance: {
    // spot: OCO is native, iceberg via `icebergQty`, no native TWAP/VWAP.
    spot: { instrumentId: 'btc-usdt', supported: [...BOOK_SPOT, 'trailing_stop', 'oco'], nativeIceberg: true, postOnly: true },
    margin: { instrumentId: 'btc-usdt', supported: [...BOOK_SPOT, 'trailing_stop', 'oco'], nativeIceberg: true, leverage: true, marginModes: { cross: true, isolated: true }, postOnly: true },
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    futures: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    // options: an option book takes market/limit only; no adjustable leverage.
    options: { instrumentId: 'btc-usdt', supported: ['market', 'limit'] },
  },
  // ── Bybit — probed by the executor: trailing true, iceberg/twap/oco false ──
  bybit: {
    spot: { instrumentId: 'btc-usdt', supported: BOOK_TRAILING, postOnly: true },
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    futures: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    options: { instrumentId: 'btc-usdt', supported: ['market', 'limit'] },
  },
  // ── MEXC — probed by the executor: trailing false (trigger orders only) ────
  mexc: {
    spot: { instrumentId: 'btc-usdt', supported: BOOK_SPOT, postOnly: true },
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_SPOT, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    futures: { instrumentId: 'btc-usdt', supported: BOOK_SPOT, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
  },
  // ── OKX — not routed by the executor yet; declared from its order surface ──
  okx: {
    spot: { instrumentId: 'btc-usdt', supported: [...BOOK_SPOT, 'trailing_stop', 'oco'], postOnly: true },
    margin: { instrumentId: 'btc-usdt', supported: [...BOOK_SPOT, 'trailing_stop', 'oco'], leverage: true, marginModes: { cross: true, isolated: true }, postOnly: true },
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    futures: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, leverage: true, marginModes: { cross: true, isolated: true }, reduceOnly: true, postOnly: true },
    options: { instrumentId: 'btc-usdt', supported: ['market', 'limit'] },
  },
  // ── Hyperliquid — an on-chain perp book with a NATIVE TWAP and ALO ─────────
  hyperliquid: {
    perpetual: { instrumentId: 'btc-usdt', supported: BOOK_DERIV, nativeTwap: true, leverage: true, marginModes: { cross: true, isolated: false }, reduceOnly: true, postOnly: true },
  },
  // ── Uniswap / Jupiter — AMM swaps: the pool takes a market swap, nothing else
  uniswap: {
    swap: { instrumentId: 'eth-usdc', supported: AMM_SWAP },
  },
  jupiter: {
    swap: { instrumentId: 'sol-usdc', supported: AMM_SWAP },
  },
};

/** Build one `VenueCapability` row from its flags (omitted flags are stated false/null). */
function toCapability(venue: VenueId, marketType: MarketType, flags: CapabilityFlags): VenueCapability {
  return {
    venue,
    instrumentId: flags.instrumentId,
    marketType,
    orderTypes: orderTypeRecord(flags.supported),
    nativeTwap: flags.nativeTwap ?? false,
    nativeVwap: flags.nativeVwap ?? false,
    nativeIceberg: flags.nativeIceberg ?? false,
    leverage: flags.leverage ?? false,
    marginModes: flags.marginModes ?? null,
    reduceOnly: flags.reduceOnly ?? false,
    postOnly: flags.postOnly ?? false,
  };
}

/**
 * The whole matrix, in taxonomy order: venues as declared, market types in the
 * order `VENUE_MARKET_TYPES` lists them. A venue × market-type pairing with no
 * declared flags throws at module load — the board must never silently drop a
 * pairing the taxonomy says exists.
 */
function buildMatrix(): readonly VenueCapability[] {
  const rows: VenueCapability[] = [];
  for (const venue of VENUES) {
    for (const marketType of VENUE_MARKET_TYPES[venue.id]) {
      const flags = CAPABILITY_INPUTS[venue.id][marketType];
      if (flags === undefined) {
        throw new Error(`capability matrix: no declared flags for ${venue.id} × ${marketType}`);
      }
      rows.push(toCapability(venue.id, marketType, flags));
    }
  }
  return rows;
}

export const CAPABILITY_MATRIX: readonly VenueCapability[] = buildMatrix();

/** The board's columns: every `OrderType`, exhaustively, in taxonomy order. */
export const CAPABILITY_COLUMNS: readonly OrderTypeEntry[] = ORDER_TYPES;

/** The board's rows plus its columns, so a renderer never restates either. */
export function capabilityBoard(): { columns: readonly OrderTypeEntry[]; rows: readonly VenueCapability[] } {
  return { columns: CAPABILITY_COLUMNS, rows: CAPABILITY_MATRIX };
}

/** One venue's rows, in taxonomy order. */
export function capabilitiesForVenue(venue: VenueId): readonly VenueCapability[] {
  return CAPABILITY_MATRIX.filter((row) => row.venue === venue);
}

/** The row for one (venue, market type), or `undefined` when the pairing does not exist. */
export function capabilityFor(venue: VenueId, marketType: MarketType): VenueCapability | undefined {
  return CAPABILITY_MATRIX.find((row) => row.venue === venue && row.marketType === marketType);
}

/**
 * A "supports X, Y, Z but not W" split of a row's order types, for the accounts
 * capability summary. Both lists are derived from the exhaustive record, so the
 * two always account for every `OrderType` — nothing is quietly dropped.
 */
export function capabilityOrderTypeSplit(capability: VenueCapability): {
  supports: readonly OrderTypeEntry[];
  missing: readonly OrderTypeEntry[];
} {
  const supports: OrderTypeEntry[] = [];
  const missing: OrderTypeEntry[] = [];
  for (const entry of ORDER_TYPES) {
    (capability.orderTypes[entry.id] ? supports : missing).push(entry);
  }
  return { supports, missing };
}

/**
 * The executor's market vocabulary is narrower than the trade taxonomy: it can
 * work a spot book or a linear perpetual, and nothing else. A trade market type
 * with no executor counterpart returns `null`, and the composer renders that as
 * a stated gap rather than sending a request the planner would reject.
 */
export function executorMarketTypeFor(marketType: MarketType): 'spot' | 'linear_perp' | null {
  switch (marketType) {
    case 'spot':
    case 'margin':
      return 'spot';
    case 'perpetual':
    case 'futures':
      return 'linear_perp';
    case 'options':
    case 'swap':
      return null;
  }
}
