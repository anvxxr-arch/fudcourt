/**
 * The funding desk's domain model — the per-symbol funding-rate matrix read
 * verbatim from CoinAnk's `mode=fundingRate`: 885 symbols, each carrying a
 * per-venue funding map across every venue CoinAnk tracks.
 *
 * WHAT THIS IS. The perpetuals' cost-of-carry, symbol by symbol: for each of the
 * 885 symbols the upstream ships a `umap` (USDT-margined venues, ~11) and a
 * `cmap` (COIN-margined venues, ~6), each mapping a venue name to its rate
 * object. This module DERIVES the per-symbol cross-venue min/max/mean, the
 * distinct-venue count, the extremes, and the filter/sort/paginate — and derives
 * nothing about the market itself.
 *
 * A MISSING VALUE IS NEVER A ZERO. A venue the upstream does not carry for a
 * symbol is simply ABSENT from the map, and a rate the upstream ships as `null`
 * (or omits) renders `—`, never `0`. A real `0` rate still renders as its own
 * figure, because a zero and an absence are different claims.
 *
 * THE RATE IS A FRACTION, NOT A PERCENT. CoinAnk's `fundingRate` is a fraction
 * (e.g. `1.049e-05` = 0.001049%). Every figure this board renders as a percent
 * goes through `fractionToPercent` (×100) so the ×100 lives in exactly one
 * place; a `null`/non-finite rate stays `null` and renders `—`.
 *
 * THE MAP IS A SNAPSHOT, NOT A SERIES. Upstream ships the CURRENT rate per
 * venue; the board states the slice (symbols tracked, venues seen) rather than
 * pretending a single read is a market-wide claim.
 *
 * PURE: no network, no clock, no I/O — `nowSec` is passed IN by the caller for
 * the funding countdown, so every read here unit-tests offline against fixed
 * rows.
 */

/** One venue's rate object, as CoinAnk ships it inside `umap` / `cmap`. */
export type FundingVenue = {
  baseCoin: string | null;
  exchangeName: string | null;
  /** `'USDT'` for a `umap` venue, `'COIN'` for a `cmap` venue. */
  exchangeType: string | null;
  /** The venue's own instrument symbol (e.g. `BTCUSDT`, `BTCUSD_PERP`). */
  symbol: string | null;
  /** The funding rate as a FRACTION — multiply by 100 for a percent. May be null. */
  fundingRate: number | null;
  /** The venue's estimated next rate, as a fraction. May be null. */
  estimatedRate: number | null;
  /** The venue's last funding time, ms since epoch. */
  fundingTime: number | null;
  /** The venue's next funding time, ms since epoch. May be null. */
  nextFundingTime: number | null;
  ts: number | null;
  append: unknown;
  fundingRateCap: number | null;
  fundingRateFloor: number | null;
  frCap: number | null;
  frFloor: number | null;
  interval: number | null;
  fr: number | null;
};

/** One symbol row of `mode=fundingRate`: its symbol and its two venue maps. */
export type FundingSymbolRow = {
  symbol: string;
  /** USDT-margined venues (venue name -> rate object). May be empty. */
  umap: Record<string, FundingVenue>;
  /** COIN-margined venues (venue name -> rate object). May be empty. */
  cmap: Record<string, FundingVenue>;
  follow: boolean;
};

/** Which margin map a read is over. */
export type VenueSide = 'umap' | 'cmap';

/** The board's page size for the 885-symbol table, stated on the board. */
export const SYMBOLS_PAGE_SIZE = 100;

/** The default sort direction of the symbol table (largest cross-venue mean first). */
export const DEFAULT_SORT_DIR: SortDir = 'desc';

/** A sort direction for the cross-venue mean column. */
export type SortDir = 'asc' | 'desc';

/** A finite number, or null — undefined, NaN and Infinity are all ABSENT. */
export function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * A funding rate as a percent: the upstream fraction ×100. A `null`/non-finite
 * rate stays `null` and renders `—`, never `0`. This is the ONE place the ×100
 * lives, so a fraction can never be printed as if it were already a percent.
 */
export function fractionToPercent(v: number | null | undefined): number | null {
  const finite = finiteOrNull(v);
  return finite === null ? null : finite * 100;
}

/** The per-symbol cross-venue summary, all rates as PERCENTS (null = no finite rate). */
export type SymbolFunding = {
  symbol: string;
  /** Venues the symbol carries in this map (regardless of whether the rate is finite). */
  venueCount: number;
  /** Venues carrying a finite funding rate (the basis of min/max/mean). */
  ratedVenues: number;
  /** The lowest cross-venue rate, percent. Null when no venue carries a finite rate. */
  min: number | null;
  /** The highest cross-venue rate, percent. Null when no venue carries a finite rate. */
  max: number | null;
  /** The cross-venue mean rate, percent. Null when no venue carries a finite rate. */
  mean: number | null;
};

/**
 * The cross-venue summary of one symbol over one map: the venue count, and the
 * min/max/mean of the FINITE funding rates, each converted to a percent. A venue
 * whose rate is `null` is counted in `venueCount` (the symbol does carry it) but
 * is not measured, so it never pulls the mean toward a fabricated zero.
 */
export function symbolFunding(row: FundingSymbolRow, side: VenueSide): SymbolFunding {
  const map = (side === 'umap' ? row.umap : row.cmap) ?? {};
  const venues = Object.values(map);
  const rates: number[] = [];
  for (const venue of venues) {
    const rate = finiteOrNull(venue.fundingRate);
    if (rate !== null) rates.push(rate);
  }
  if (rates.length === 0) {
    return { symbol: row.symbol, venueCount: venues.length, ratedVenues: 0, min: null, max: null, mean: null };
  }
  let min = rates[0];
  let max = rates[0];
  let sum = 0;
  for (const rate of rates) {
    if (rate < min) min = rate;
    if (rate > max) max = rate;
    sum += rate;
  }
  return {
    symbol: row.symbol,
    venueCount: venues.length,
    ratedVenues: rates.length,
    min: fractionToPercent(min),
    max: fractionToPercent(max),
    mean: fractionToPercent(sum / rates.length),
  };
}

/** The summary of every symbol, in upstream order. */
export function symbolFundings(rows: readonly FundingSymbolRow[], side: VenueSide): SymbolFunding[] {
  return rows.map((row) => symbolFunding(row, side));
}

/**
 * The distinct venue names seen across the given map over every symbol — the
 * count of venues the upstream actually covers, not a hard-coded venue list.
 */
export function distinctVenues(rows: readonly FundingSymbolRow[], side: VenueSide): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const map = (side === 'umap' ? row.umap : row.cmap) ?? {};
    for (const venue of Object.keys(map)) seen.add(venue);
  }
  return [...seen].sort();
}

/** A named extreme: the symbol and its rate as a percent. */
export type SymbolExtreme = { symbol: string; percent: number };

/**
 * The symbol carrying the highest cross-venue max and the one carrying the
 * lowest cross-venue min, each with the rate as a percent. A symbol with no
 * finite rate cannot be an extreme and is skipped; when nothing is measured the
 * side is null rather than a fabricated 0.
 */
export function extremeSymbols(
  rows: readonly FundingSymbolRow[],
  side: VenueSide,
): { highestMax: SymbolExtreme | null; lowestMin: SymbolExtreme | null } {
  let highestMax: SymbolExtreme | null = null;
  let lowestMin: SymbolExtreme | null = null;
  for (const row of rows) {
    const summary = symbolFunding(row, side);
    if (summary.max !== null && (highestMax === null || summary.max > highestMax.percent)) {
      highestMax = { symbol: row.symbol, percent: summary.max };
    }
    if (summary.min !== null && (lowestMin === null || summary.min < lowestMin.percent)) {
      lowestMin = { symbol: row.symbol, percent: summary.min };
    }
  }
  return { highestMax, lowestMin };
}

/** A client-side text filter over the symbol, case-insensitive substring. */
export function filterSymbols(rows: readonly SymbolFunding[], query: string): SymbolFunding[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...rows];
  return rows.filter((row) => row.symbol.toLowerCase().includes(needle));
}

/**
 * Sort the symbol summaries by their cross-venue mean, ascending or descending.
 * A symbol with no finite mean (`null`) always sorts LAST in either direction —
 * an unmeasured symbol is not "the smallest mean", it is unmeasured. The input
 * is not mutated.
 */
export function sortSymbols(rows: readonly SymbolFunding[], dir: SortDir): SymbolFunding[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (a.mean === null && b.mean === null) return a.symbol.localeCompare(b.symbol);
    if (a.mean === null) return 1;
    if (b.mean === null) return -1;
    const delta = dir === 'asc' ? a.mean - b.mean : b.mean - a.mean;
    return delta !== 0 ? delta : a.symbol.localeCompare(b.symbol);
  });
  return copy;
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
 * caller owns the page state, this only reads it.
 */
export function paginate<T>(rows: readonly T[], page: number, size: number): Page<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (current - 1) * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page: current, pages, total, from: total === 0 ? 0 : start + 1, to: start + slice.length };
}

/** One flattened venue row of a symbol's per-venue detail table. */
export type VenueRow = {
  venue: string;
  exchangeType: string | null;
  symbol: string | null;
  /** fundingRate as a percent (the upstream fraction ×100). Null -> `—`. */
  fundingRatePct: number | null;
  /** estimatedRate as a percent. Null -> `—`. */
  estimatedRatePct: number | null;
  /** Next funding time, ms since epoch. Null -> `—`. */
  nextFundingTime: number | null;
};

/**
 * Flatten one symbol's venue map into rows, sorted by venue name, for the keyed
 * detail table. Reads the SAME already-fetched data the board holds — the board
 * never refetches for a selection. Rates are converted to percents here.
 */
export function venueRows(row: FundingSymbolRow, side: VenueSide): VenueRow[] {
  const map = (side === 'umap' ? row.umap : row.cmap) ?? {};
  return Object.entries(map)
    .map(([venue, rate]) => ({
      venue,
      exchangeType: rate.exchangeType,
      symbol: rate.symbol,
      fundingRatePct: fractionToPercent(rate.fundingRate),
      estimatedRatePct: fractionToPercent(rate.estimatedRate),
      nextFundingTime: finiteOrNull(rate.nextFundingTime),
    }))
    .sort((a, b) => a.venue.localeCompare(b.venue));
}

/**
 * Seconds until the next funding, given the venue's `nextFundingTime` (ms since
 * epoch) and the caller's `nowSec` (seconds since epoch). Null when the time is
 * missing or already past — a stale time is not "in 0s", it is unknown. Pure:
 * the clock is passed IN, never read here.
 */
export function nextFundingIn(nextFundingTime: number | null, nowSec: number): number | null {
  const ms = finiteOrNull(nextFundingTime);
  if (ms === null) return null;
  const remaining = Math.floor(ms / 1000) - Math.trunc(nowSec);
  return remaining > 0 ? remaining : null;
}
