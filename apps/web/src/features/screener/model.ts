/**
 * The full price list's domain model — the widest dataset in the app, read as
 * ONE board: every coin CryptoRank's converter page prices (5413 rows), price
 * only.
 *
 * WHY THIS IS ITS OWN SURFACE. The `/coins` board reads `mode=coins`, which
 * ships only the top 100 coins (CryptoRank's `/all-coins-list` payload). The
 * converter page carries the FULL price list — every coin the site prices —
 * and this board is that list. It is not the same data one level deeper: it is
 * a strictly wider table (5413 vs 100), and the width is the point.
 *
 * THE ONE RULE. A price the upstream did not publish renders `—`, never 0. A
 * `0` is a measurement; `—` is the absence of one, and a board that prints 0
 * for an absent price asserts a number upstream never made. The headline stats
 * therefore COUNT the nulls rather than folding them into a low.
 *
 * THE CHANGE COLUMN IS ABSENT, NOT FLAT. The mode reports
 * `changeSource: 'unavailable'` — it ships no 24h change at all — so the board
 * carries the reason and renders no change cell, rather than a 0 that would
 * read as a market where nothing moved.
 *
 * THE RANK IS OURS, AND NAMED SO. The converter payload ships no rank (a row is
 * `{key,name,symbol,icon,priceUsd}`); the board's rank is the row's 1-based
 * position in the CURRENT view (filtered, sorted, paged) and is stated as such
 * in the footnote, so it is never read as an upstream ranking.
 *
 * THE LIST IS FILTERED, SORTED AND PAGED CLIENT-SIDE. 5413 rows are ~946 KB;
 * rendering them all at once is not an option, so the board shows one page of
 * 100 and states the slice (`page N of M — rows A–B of 5413`).
 *
 * PURE: no network, no clock (`nowSec` is a parameter), no I/O — so it
 * unit-tests offline against fixed rows.
 */

/** One converter row, exactly as CryptoRank's `converter` mode ships it. */
export type ConverterRow = {
  /** The coin slug (`mode=coin&key=`). */
  key: string;
  name: string;
  symbol: string;
  icon: string | null;
  /** The live USD price, or null when upstream stated none -> `—`, never 0. */
  priceUsd: number | null;
};

/** How the envelope's change column was obtained (mirrors the sidecar field). */
export type ScreenerChangeSource = 'direct' | 'derived-from-histPrices-24H' | 'unavailable';

/** Whether the board may show a change column, and why not when it may not. */
export type ChangeColumn = { available: boolean; note: string | null };

/** The page size the board paginates the converter list by. */
export const SCREENER_PAGE_SIZE = 100;

/** A finite number, or null for anything the upstream did not publish. */
function finite(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/**
 * Whether the change column is available, and the reason when it is not.
 *
 * Only an EXPLICITLY listed source counts as available. An `unavailable` source
 * (this converter mode) and a MISSING source both read as unavailable: absent
 * provenance is not provenance, and "we were not told where this came from"
 * cannot be read as "here is the number".
 */
export function readChangeColumn(changeSource: ScreenerChangeSource | undefined): ChangeColumn {
  if (changeSource === 'unavailable') {
    return {
      available: false,
      note: "this mode reports changeSource:'unavailable' — it ships no 24h change column at all, so the board renders no change cell (and would render — on every row rather than a 0 that would read as a flat market)",
    };
  }
  if (changeSource === 'direct') return { available: true, note: null };
  if (changeSource === 'derived-from-histPrices-24H') {
    return { available: true, note: 'the change is derived from upstream histPrices anchors, not a native field' };
  }
  return {
    available: false,
    note: 'the payload named no change source — the board treats the change column as unavailable rather than assume one',
  };
}

/** The full price list, read. */
export type ScreenerBoard = {
  rows: ConverterRow[];
  /** How many rows the board read (the whole converter table). */
  shown: number;
  /** Upstream's stated full size, when it names one. */
  upstreamTotal: number | null;
  /** Rows that state a live price. */
  priced: number;
  /** Rows whose price is null — rendered `—`, counted here, never folded into a low. */
  nullPrice: number;
  /** The highest-priced row, or null when no row states a price. */
  highest: ConverterRow | null;
  /** The lowest-priced row, or null when no row states a price. */
  lowest: ConverterRow | null;
  change: ChangeColumn;
  slice: { shown: number; upstreamTotal: number | null; note: string };
  /** The instant the board read the list, passed in (never a clock read here). */
  asOf: number;
};

/**
 * Read the full price list: its coverage, its price extremes, and the state of
 * the change column. Highest/lowest consider ONLY rows with a stated price — an
 * absent price is not the lowest one.
 */
export function readScreenerBoard(
  rows: readonly ConverterRow[],
  upstreamTotal: number | null,
  changeSource: ScreenerChangeSource | undefined,
  nowSec: number,
): ScreenerBoard {
  let priced = 0;
  let nullPrice = 0;
  let highest: ConverterRow | null = null;
  let lowest: ConverterRow | null = null;
  for (const row of rows) {
    const price = finite(row.priceUsd);
    if (price === null) {
      nullPrice += 1;
      continue;
    }
    priced += 1;
    if (highest === null || price > (finite(highest.priceUsd) ?? Number.NEGATIVE_INFINITY)) highest = row;
    if (lowest === null || price < (finite(lowest.priceUsd) ?? Number.POSITIVE_INFINITY)) lowest = row;
  }
  const shown = rows.length;
  const note =
    upstreamTotal === null
      ? `showing all ${shown} coins — upstream stated no total`
      : `showing all ${shown} of ${upstreamTotal} coins in the full price list`;
  return {
    rows: [...rows],
    shown,
    upstreamTotal,
    priced,
    nullPrice,
    highest,
    lowest,
    change: readChangeColumn(changeSource),
    slice: { shown, upstreamTotal, note },
    asOf: nowSec,
  };
}

/** Case-insensitive match of a row against a free-text query over name and symbol. */
export function matchScreenerRow(row: ConverterRow, query: string): boolean {
  if (query === '') return true;
  return (row.name ?? '').toLowerCase().includes(query) || (row.symbol ?? '').toLowerCase().includes(query);
}

/**
 * Filter the price list by a free-text query over name/symbol. The note states
 * how many of how many matched, so a filtered view never reads as the whole.
 */
export function filterScreenerRows(
  rows: readonly ConverterRow[],
  query: string,
): { matched: ConverterRow[]; note: string } {
  const needle = query.trim().toLowerCase();
  const matched = needle === '' ? [...rows] : rows.filter((row) => matchScreenerRow(row, needle));
  const note =
    needle === ''
      ? `all ${rows.length} coins`
      : `${matched.length} of ${rows.length} coins match “${query.trim()}”`;
  return { matched, note };
}

/** Sort directions for the price list. */
export type ScreenerSortDir = 'asc' | 'desc';

/**
 * Sort by price. Rows with no stated price sort LAST in BOTH directions — an
 * absent price is not a small one, so it must not rank as if it were 0. Ties
 * keep the upstream order (the sort is stable).
 */
export function sortScreenerRows(rows: readonly ConverterRow[], dir: ScreenerSortDir): ConverterRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const ap = finite(a.priceUsd);
    const bp = finite(b.priceUsd);
    if (ap === null && bp === null) return 0;
    if (ap === null) return 1;
    if (bp === null) return -1;
    return dir === 'desc' ? bp - ap : ap - bp;
  });
  return copy;
}

/** One page of the price list, plus the slice it sits in. */
export type ScreenerPage = {
  /** The rows on the CURRENT page only. */
  pageRows: ConverterRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  /** 1-based index of the first row on this page (0 when the page is empty). */
  firstIndex: number;
  /** 1-based index of the last row on this page (0 when the page is empty). */
  lastIndex: number;
  /** A line stating the page slice, e.g. `page 1 of 55 — rows 1–100 of 5413`. */
  pageNote: string;
};

/**
 * Paginate the (already filtered and sorted) list client-side. `page` is
 * clamped into range, so a stale page number after a refetch lands on a real
 * page rather than an empty one.
 */
export function paginateScreenerRows(
  rows: readonly ConverterRow[],
  options: { page: number; pageSize: number },
): ScreenerPage {
  const pageSize = Math.max(1, Math.floor(options.pageSize));
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page || 1)), totalPages);
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  const firstIndex = totalRows === 0 ? 0 : start + 1;
  const lastIndex = start + pageRows.length;
  const pageNote =
    totalRows === 0 ? 'no rows' : `page ${page} of ${totalPages} — rows ${firstIndex}–${lastIndex} of ${totalRows}`;
  return { pageRows, page, pageSize, totalRows, totalPages, firstIndex, lastIndex, pageNote };
}
