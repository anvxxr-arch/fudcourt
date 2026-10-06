/**
 * model-market-types.ts - market types, execution strategies, order types,
 * and margin modes (split from model-markets.ts).
 *
 * WHAT lives here: the WHAT (MarketType/MARKET_TYPES), the HOW
 * (ExecutionStrategy, OrderType, MarginMode) and their lookup helpers.
 * The instrument registry and domain entities live in
 * `./model-instruments`. Re-exported by `./model-markets` so existing
 * importers keep working unchanged.
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
