/**
 * The derivatives desk's domain model — the futures tape read verbatim from
 * CoinGlass and CoinAnk: open interest and its change, funding-rate extremes,
 * per-venue liquidations across six intervals, and the long/short ratio.
 *
 * WHAT THIS IS. The futures market's plumbing, not its price: how much open
 * interest a perpetual carries, how extreme its funding has become, which venues
 * are being liquidated and by how much, and how the book is split between longs
 * and shorts. Every figure is read from the venue aggregates as the upstream
 * ships it — this module DERIVES the extreme, the order and the slice, and
 * derives nothing about the market itself.
 *
 * A MISSING VALUE IS NEVER A ZERO. CoinAnk's long/short feed ships `null` for an
 * exchange that does not list a coin — a REAL absence, not a measurement of zero
 * — and a field the payload does not carry renders `—` at the edge. A real `0`
 * (a coin with no liquidations this interval, a funding rate of exactly zero)
 * still renders as its own figure, because a zero and an absence are different
 * claims and only one of them is true here.
 *
 * THE LIQUIDATION INTERVAL IS A CLOSED SET. Upstream answers an UNSUPPORTED
 * interval with HTTP 200 and `totalTurnover: 0` on EVERY row — a payload that
 * claims success while measuring nothing. The sidecar rejects those locally
 * (400), so the board only ever asks for the six intervals below; inventing a
 * seventh would render a table of zeros dressed as data.
 *
 * THE LONG/SHORT FEED IS A PAGE, NOT THE MARKET. CoinAnk serves 726 rows at a
 * time; the board pages through them client-side and STATES the slice, because
 * "the 50 coins on this page in upstream order" and "the market's long/short
 * ratio" are different claims and only the first is true. The two ratio families
 * (`a*`, `b*`) keep their upstream field names VERBATIM — a friendlier label
 * would be inventing a meaning the payload does not carry.
 *
 * PURE: no network, no clock, no I/O — so every read here unit-tests offline
 * against fixed rows.
 */

/** CoinGlass `mode=statistics` `data`: the whole-market headline figures. */
export type DerivativesStatistics = {
  /** 24h volume change, percent. */
  volH24Chain: number;
  /** Short share of the book, percent (`longRate + shortRate === 100`). */
  shortRate: number;
  /** Open-interest 24h change, percent. */
  oiH24Chain: number;
  /** Total open interest, USD. */
  openInterest: number;
  /** Long share of the book, percent. */
  longRate: number;
  /** Liquidation 24h change, percent. */
  lqH24Chain: number;
  /** 24h liquidations, USD. */
  liquidationH24VolUsd: number;
  /** 24h liquidation event count. */
  liquidationH24Num: number;
  /** 24h volume, USD. */
  volUsd: number;
};

/** The per-row liquidation split CoinGlass nests under `liqInfo`. */
export type MarketLiqInfo = {
  totalVolUsd: number | null;
  longVolUsd?: number | null;
  shortVolUsd?: number | null;
  longNumber?: number | null;
  shortNumber?: number | null;
  number?: number | null;
  amount?: number | null;
  symbol?: string;
};

/** One CoinGlass `mode=markets` row (20 rows). */
export type DerivativesMarketRow = {
  symbol: string;
  price: number;
  priceChangePercent: number;
  openInterest: number;
  oichangePercent: number;
  volUsd: number;
  avgFundingRate: number;
  liqInfo?: MarketLiqInfo;
};

/** One funding-rate row, as CoinGlass ships it inside `data.min` / `data.max`. */
export type FundingRow = {
  exchangeName: string;
  /** Percent, spanning roughly -1.0 .. 1.1046. */
  fundingRate: number;
  symbol: string;
  originalSymbol: string;
  quoteCurrency?: string;
  /** Present on `data.max` rows only. */
  predictedRate?: number;
  /** Present on `data.min` rows only. */
  marketUrl?: string;
};

/** CoinGlass `mode=fundingRate` `data`: 50 most negative and 50 most positive. */
export type FundingExtremes = {
  min: FundingRow[];
  max: FundingRow[];
};

/** One CoinAnk `mode=liquidation` row (10 rows per interval). */
export type LiquidationRow = {
  exchangeName: string;
  baseCoin: string;
  totalTurnover: number;
  longTurnover: number;
  shortTurnover: number;
  percentage: number;
  longRatio: number;
  shortRatio: number;
  interval: string;
};

/** A long/short ratio cell: a number, or null when that exchange does not list the coin. */
export type ExchangeRatio = number | null;

/**
 * One CoinAnk `mode=longShort` row (726 rows). The `a*` fields are one ratio
 * family, the `b*` fields another; a null member is a MISSING EXCHANGE, never a
 * zero.
 */
export type LongShortRow = {
  coinName: string;
  ts: number;
  abinanceU: ExchangeRatio;
  abinanceC: ExchangeRatio;
  ahuobiU: ExchangeRatio;
  ahuobiC: ExchangeRatio;
  ahuobiF: ExchangeRatio;
  aokex: ExchangeRatio;
  bbinanceU: ExchangeRatio;
  bbinanceC: ExchangeRatio;
  bhuobiU: ExchangeRatio;
  bhuobiC: ExchangeRatio;
  bhuobiF: ExchangeRatio;
  bokex: ExchangeRatio;
};

/** The six intervals CoinAnk's liquidation feed answers; anything else is a local 400. */
export const LIQ_INTERVALS = ['1h', '2h', '4h', '6h', '12h', '1d'] as const;
export type LiqInterval = (typeof LIQ_INTERVALS)[number];

/** The board's default liquidation interval — the widest window upstream serves. */
export const LIQ_DEFAULT_INTERVAL: LiqInterval = '1d';

/**
 * The exchange-ratio columns of the long/short table, in the upstream's own
 * field order. These are the upstream field names VERBATIM: the two families
 * (`a*`, `b*`) are CoinAnk's own, and naming them anything friendlier would be
 * inventing a meaning the payload does not carry.
 */
export const LONG_SHORT_RATIO_COLUMNS = [
  'abinanceU', 'abinanceC', 'ahuobiU', 'ahuobiC', 'ahuobiF', 'aokex',
  'bbinanceU', 'bbinanceC', 'bhuobiU', 'bhuobiC', 'bhuobiF', 'bokex',
] as const;
export type LongShortRatioColumn = (typeof LONG_SHORT_RATIO_COLUMNS)[number];

/** The long/short table's page size, stated on the board. */
export const LONGSHORT_PAGE_SIZE = 50;

/**
 * A funding array ordered by extremeness: `'min'` is most negative first, `'max'`
 * most positive first.
 *
 * The upstream already ships `data.min` / `data.max` in that order, but the board
 * re-sorts rather than trust it: "the 50 most negative" is a claim about the
 * ORDER, and a payload whose order drifted would otherwise be mislabelled. A
 * non-finite rate sorts last so it can never masquerade as the extreme.
 */
export function orderFunding(rows: readonly FundingRow[], side: 'min' | 'max'): FundingRow[] {
  const rank = (r: FundingRow): number => (Number.isFinite(r.fundingRate) ? r.fundingRate : side === 'min' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
  const copy = [...rows];
  copy.sort((a, b) => (side === 'min' ? rank(a) - rank(b) : rank(b) - rank(a)));
  return copy;
}

/**
 * A long/short ratio cell as the board should read it: the number when the
 * payload carries a finite one, otherwise null. Undefined, NaN and Infinity are
 * all ABSENT — they render `—`, never `0`.
 */
export function ratioOf(row: LongShortRow, key: LongShortRatioColumn): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One page of rows, plus the slice facts the board states. */
export type Page<T> = {
  rows: T[];
  /** The clamped current page, 1-based. */
  page: number;
  /** Total page count, at least 1. */
  pages: number;
  /** Total row count across every page. */
  total: number;
  /** 1-based index of the first row shown (0 when the page is empty). */
  from: number;
  /** 1-based index of the last row shown. */
  to: number;
};

/**
 * Slice one page out of a row set, clamped to the valid page range. Pure: the
 * caller owns the page state, this only reads it. Used by the long/short table so
 * all 726 rows are reachable while the slice in view is always stated.
 */
export function paginate<T>(rows: readonly T[], page: number, size: number): Page<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (current - 1) * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page: current, pages, total, from: total === 0 ? 0 : start + 1, to: start + slice.length };
}
