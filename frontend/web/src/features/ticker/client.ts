/**
 * Ticker family — exchange-native market data via CCXT, keyless.
 *
 * Replaces the CoinGecko `/api/markets` family (lib/markets.ts) as the source
 * for the public ticker board. Rationale (owner, 2026-09-28): a single
 * aggregator is a single point of failure and a single point of trust, so
 * prices come from exchanges directly and are cross-checked between them.
 *
 * The cross-exchange check is the point: every quote below is relayed from
 * independent venues, and `spread` reports their divergence. A pair that
 * disagrees is a fact to display, never something to average away.
 *
 * Scope is centralized-exchange instruments only — spot, perpetual, dated
 * future and option. DEX pools are a different family (lib/dex.ts) and are
 * deliberately excluded: a DEX quote has no venue to cross-check against and
 * no order book in the same sense, so folding it into this board would put an
 * unverifiable price next to verified ones.
 *
 * Venue reachability on this host was measured, not assumed (2026-09-28);
 * see TICKER_VENUES for the per-venue, per-type table and why Binance, Kucoin
 * and Gate are excluded.
 */

export * from './markets';
import type { TickerExchange, TickerSymbol, TickerType } from './markets';


/** OUR params — validated strictly in the route (400, never clamped). */
export const TICKER_SORTS = ['symbol', 'price', 'change', 'volume', 'spread'] as const;
export type TickerSort = (typeof TICKER_SORTS)[number];

export const TICKER_ORDERS = ['asc', 'desc'] as const;
export type TickerOrder = (typeof TICKER_ORDERS)[number];

export const TICKER_PAGE_SIZE_MAX = 50;
export const TICKER_SEARCH_MAX = 16;

/** One upstream sweep serves every search/sort/page for this long. */
import { getJSON } from '@/lib/fetch';

export const TICKER_TTL_MS = 60_000;

/** Timeframes the detail chart accepts. CCXT timeframe codes, not free text. */
export const TICKER_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
export type TickerTimeframe = (typeof TICKER_TIMEFRAMES)[number];

/** Hard cap on candles returned for the chart, so a request can't be unbounded. */
export const TICKER_CANDLE_MAX = 500;

/**
 * A quote from one venue. `baseVolume` is the base asset, `quoteVolume` the
 * quote asset; exchanges disagree on which they populate per endpoint, so a
 * null is a real "this venue did not report it", never coerced to 0.
 */
export type VenueQuote = {
  exchange: TickerExchange;
  last: number;
  bid: number | null;
  ask: number | null;
  /** Venue's own 24h high/low, not derived from a candle scan. */
  high24h: number | null;
  low24h: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
  /**
   * 24h change as a fraction, straight from the venue (`percentage`). Both
   * OKX and Bybit report it natively, so it is relayed rather than derived
   * from high/low — a derived value would be wrong for a pair that made a
   * new high in the window.
   */
  change24h: number | null;
  /** Venue's own timestamp, so a stale quote is visible as stale. */
  at: number;
  /**
   * Open interest, in base units, for derivatives. Null on spot (no such
   * concept) and null when the venue's ticker omits it — ccxt does not return
   * it inline, it needs a separate fetch, so a missing value here means "we did
   * not ask or could not get it", never "the market has none".
   */
  openInterest: number | null;
  /**
   * Funding rate as a fraction (0.0001 = 0.01% per interval), perpetual only.
   * Null elsewhere, for the same reason as openInterest.
   */
  fundingRate: number | null;
};

/**
 * One dated future or option instrument.
 *
 * A future is identified by its expiry; an option additionally by its strike
 * and whether it is a call or a put. Expiry is a millisecond timestamp, which
 * is what ccxt reports and what lets the UI group strikes under a date instead
 * of showing raw epoch numbers.
 */
export type TickerInstrument = {
  /**
   * Settlement currency, e.g. 'USDT' on a Bybit future, 'USD' on an OKX one.
   *
   * This is load-bearing rather than cosmetic. The same coin has a USD-settled
   * future at one venue and a USDT-settled one at another, and their prices
   * differ by a real basis — not because a venue is wrong. Averaging or
   * "cross-checking" across the two would report that basis as venue
   * disagreement, so rows are grouped by settlement and labelled.
   */
  settle: string | null;
  /** The exchange's own symbol, e.g. 'BTC/USD:BTC-261030'. */
  symbol: string;
  type: TickerType;
  /** Expiry in ms, or null for instruments that do not expire. */
  expiry: number | null;
  /** Option strike in quote units; null for anything but options. */
  strike: number | null;
  /** 'call' | 'put'; null for anything but options. */
  optionKind: 'call' | 'put' | null;
  /** Contract size, which differs per venue and must not be assumed to be 1. */
  contractSize: number | null;
};
/**
 * One board row: the pair, every venue that quoted it, and the cross-venue
 * divergence. Fields no venue reports (market cap, circulating supply, global
 * rank) are deliberately absent rather than filled with a guess.
 */
export type TickerRow = {
  symbol: TickerSymbol;
  base: string;
  quote: string;
  /** Which of the four instrument types this row is. Rows never mix types. */
  type: TickerType;
  /** The exact instrument quoted, for derivatives; equals the pair on spot. */
  instrument: TickerInstrument;
  /** Median of the venue quotes, or null when no venue answered. */
  price: number | null;
  /**
   * 24h change in PERCENT (1.39 = +1.39%), or null if uncomputable.
   *
   * This is ccxt's `percentage` field, reported as-is — NOT a fraction. The
   * board's own `fmtPct` appends '%' with no x100, which is what fixed this
   * doc: it previously said "as a fraction (0.042 = +4.2%)", and a consumer
   * that trusted it printed +138.87% for a +1.39% move.
   */
  change24h: number | null;
  high24h: number | null;
  low24h: number | null;
  quoteVolume: number | null;
  /** Per-venue prices, so the UI can show the actual sources. */
  venues: VenueQuote[];
  /**
   * Max relative divergence across venues (0 = identical, 0.01 = 1% apart).
   * Null when fewer than two venues quoted. This is a measurement, not a
   * verdict: a wide spread on a thin pair is information, not an error.
   */
  spread: number | null;
  /** Venues that failed for this symbol; the row is still shown, honestly. */
  failed: TickerExchange[];
};


/**
 * Cross-venue divergence between two prices, in percent of their mean.
 *
 * Returns percent (not a bare fraction) so the value carries the unit its
 * consumers assume: the board appends "%", and the colour thresholds below it
 * are expressed in percent. Returns null for a non-positive mean, which is a
 * data error rather than a spread.
 */
export function spreadBetween(a: number, b: number): number | null {
  const mean = (a + b) / 2;
  if (!Number.isFinite(mean) || mean <= 0) return null;
  return (Math.abs(a - b) / mean) * 100;
}

/**
 * Reduce several venue figures to one displayed value: the median, which
 * ignores a single outlier venue instead of dragging the number with it.
 *
 * `positiveOnly` is not optional decoration — it encodes two different facts.
 * A price must be > 0 (a zero or negative price is a data error, and folding
 * it into the median would print a real-looking number). A 24h change is
 * signed and legitimately negative, so discarding the losers would have
 * turned every losing pair into a blank. Callers state which they mean.
 */
export function medianOf(values: number[], positiveOnly: boolean): number | null {
  const clean = values
    .filter(p => Number.isFinite(p) && (positiveOnly ? p > 0 : true))
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

/** Median of venue prices. Null when no venue supplied a usable price. */
export function medianPrice(prices: number[]): number | null {
  return medianOf(prices, true);
}

/** Board envelope mirrored by `features/ticker/ui.tsx`. */
export type TickerBoardEnvelope<T> = {
  rows?: T[];
  exchanges?: string[];
  typeCounts?: Record<string, number>;
};

/** Transport for the ticker board. URL construction lives here; guards and state stay in the view. */
export function fetchTickerBoard<T>(sort: string, order: string, type: string): Promise<TickerBoardEnvelope<T>> {
  return getJSON<TickerBoardEnvelope<T>>(`/api/ticker?sort=${sort}&order=${order}&type=${type}`, { cache: 'no-store' });
}

/** Transport for the detail meta (which expiries/strikes/venues exist for one coin). */
export function fetchTickerInstruments<T>(base: string): Promise<T> {
  return getJSON<T>(`/api/ticker/instruments?symbol=${encodeURIComponent(`${base}/USDT`)}`, { cache: 'no-store' });
}

/**
 * Transport for one instrument's cross-venue quotes.
 *
 * Only sends a selector the chosen type actually has; sending an expiry
 * for spot would ask for an instrument that does not exist.
 */
export function fetchTickerInstrument<T>(base: string, type: string, opts: { expiry?: string; strike?: string; kind?: string }): Promise<T> {
  const qs = new URLSearchParams({ base, type });
  const needsDated = type === 'future' || type === 'option';
  if (needsDated && opts.expiry) qs.set('expiry', opts.expiry);
  if (type === 'option') {
    if (opts.strike) qs.set('strike', opts.strike);
    qs.set('kind', opts.kind ?? 'call');
  }
  return getJSON<T>(`/api/ticker/instrument?${qs}`, { cache: 'no-store' });
}

