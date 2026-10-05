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
