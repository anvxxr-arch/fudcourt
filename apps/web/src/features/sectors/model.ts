/**
 * The sector / tag taxonomy board's domain model — CryptoRank's TOPIC taxonomy
 * seen as a ranked list of themes and, keyed by slug, the coins inside one.
 *
 * WHY THIS IS TWO BOARDS AND NOT ONE. `mode=tags` is the taxonomy INDEX: 183
 * tags, each with its own aggregate breadth (market cap, 24h volume, dominance,
 * gainers/losers) and its top `rankedCoins`. `mode=tag&key=<slug>` is ONE tag's
 * page: a header and the 326 coins that carry it. An index row and a coin row
 * are different shapes with different provenance, so they are two reads, and
 * selecting a tag keys the second.
 *
 * THE ONE RULE EVERY SECTION OBEYS. A metric the upstream did not publish
 * renders `—`, never 0. `0` is a measurement; `—` is the absence of one. A tag
 * with a null `change24h` (2 of the 183) is not a flat tag. A detail row's
 * `change24h` is null for EVERY row on this surface — the envelope reports
 * `changeSource: 'unavailable'` — so the board says so rather than printing a 0
 * that would read as a flat market. And counts summed across tags are labelled
 * as sums OVER THE ROWS THAT STATE THEM, never as an unqualified total.
 *
 * UNITS. `mode=tags` ships `change24h` and `dominance` as PERCENTS (`-2.88` is
 * -2.88%), unlike the FRACTION `change24h` other CryptoRank modes ship — the
 * board must not multiply these by 100.
 *
 * PURE: no network, no clock (`nowSec` is a parameter), no I/O — so it
 * unit-tests offline against fixed rows.
 */

/** One of a tag's headline coins (name + key only, as the index ships it). */
export type RankedCoin = { name: string; key: string };

/** One taxonomy row, as CryptoRank's `mode=tags` ships it (183 rows). */
export type TagRow = {
  id: number | null;
  /** The slug `mode=tag&key=` accepts. */
  slug: string;
  name: string;
  description: string | null;
  marketCap: number | null;
  volume24h: number | null;
  /** A PERCENT of total listed market cap (79.68 = 79.68%), not a fraction. */
  dominance: number | null;
  gainers: number | null;
  losers: number | null;
  /** A PERCENT on THIS surface (-2.88 = -2.88%) — do NOT multiply by 100. */
  change24h: number | null;
  rankedCoins: RankedCoin[];
};

/** One coin row inside a tag's page (`mode=tag&key=<slug>`), 326 rows. */
export type TagCoinRow = {
  rank: number | null;
  key: string;
  name: string;
  symbol: string;
  image: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  volume24hUsd: number | null;
  category: string | null;
  listingDate: string | null;
  lifeCycle: string | null;
  athUsd: number | null;
  /** Null on this surface — the envelope reports `changeSource: 'unavailable'`. */
  change24h: number | null;
};

/** The header CryptoRank ships beside a tag's coin rows. */
export type TagInfo = { slug: string; name: string; subtitle: string | null };

/** How the envelope's change column was obtained (mirrors the sidecar field). */
export type TagChangeSource = 'direct' | 'derived-from-histPrices-24H' | 'unavailable';

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

/**
 * Whether the board may show the detail change column at all, and why not when
 * it may not. Only an EXPLICITLY listed source counts as available: an
 * `unavailable` source and a MISSING source are both treated as unavailable —
 * absent provenance is not provenance.
 */
export function readTagChangeColumn(changeSource: TagChangeSource | undefined): { available: boolean; note: string | null } {
  if (changeSource === 'unavailable') {
    return {
      available: false,
      note: "the upstream change column is unavailable on this surface — the board says so rather than printing 0, which would read as a flat market",
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

/** A count summed over the tags that state it, beside how many did. */
export type TagBreadth = {
  /** Sum over the rows that state a finite value. */
  total: number;
  /** How many rows stated a value. */
  stated: number;
  /** How many rows the sum is over (the whole board). */
  of: number;
};

/** Sum one count over the tags that state it. Never fabricates a 0 for a null. */
function sumStated(rows: readonly TagRow[], pick: (row: TagRow) => number | null): TagBreadth {
  let total = 0;
  let stated = 0;
  for (const row of rows) {
    const v = pick(row);
    if (v !== null && Number.isFinite(v)) {
      total += v;
      stated += 1;
    }
  }
  return { total, stated, of: rows.length };
}

/** The tag carrying the highest dominance; null when no tag states one. */
export function topDominanceTag(rows: readonly TagRow[]): { slug: string; name: string; dominance: number } | null {
  let best: { slug: string; name: string; dominance: number } | null = null;
  for (const row of rows) {
    if (row.dominance === null || !Number.isFinite(row.dominance)) continue;
    if (best === null || row.dominance > best.dominance) {
      best = { slug: row.slug, name: row.name, dominance: row.dominance };
    }
  }
  return best;
}

/** The taxonomy board, read. */
export type TagBoard = {
  rows: TagRow[];
  /** Rows in view (the whole taxonomy on this surface). */
  tagCount: number;
  /** Upstream's own full-table size, when it states one. */
  upstreamTotal: number | null;
  topDominance: { slug: string; name: string; dominance: number } | null;
  gainers: TagBreadth;
  losers: TagBreadth;
  asOf: number;
};

/**
 * Read the taxonomy index. Breadth counts are sums over the tags that state
 * them (`gainers.stated` / `gainers.of`), never an unqualified total, and the
 * top-dominance tag is keyed by slug so the board can select it.
 */
export function readTagBoard(rows: readonly TagRow[], upstreamTotal: number | null, nowSec: number): TagBoard {
  return {
    rows: [...rows],
    tagCount: rows.length,
    upstreamTotal,
    topDominance: topDominanceTag(rows),
    gainers: sumStated(rows, (r) => r.gainers),
    losers: sumStated(rows, (r) => r.losers),
    asOf: nowSec,
  };
}

/** The columns the taxonomy table can order by. */
export type TagSortKey = 'marketCap' | 'change24h' | 'dominance';

const SORT_VALUE: Record<TagSortKey, (row: TagRow) => number | null> = {
  marketCap: (row) => row.marketCap,
  change24h: (row) => row.change24h,
  dominance: (row) => row.dominance,
};

/**
 * Filter by free text over name + description, then sort descending by one
 * metric. A row with no value for the sort key sorts LAST (an absent metric is
 * not a small one), and ties fall back to name so the order is deterministic.
 */
export function filterAndSortTags(
  rows: readonly TagRow[],
  options: { query: string; sortBy: TagSortKey },
): TagRow[] {
  const needle = options.query.trim().toLowerCase();
  const view = needle === ''
    ? [...rows]
    : rows.filter((row) => {
        const name = row.name.toLowerCase();
        const description = (row.description ?? '').toLowerCase();
        return name.includes(needle) || description.includes(needle);
      });
  const pick = SORT_VALUE[options.sortBy];
  view.sort((a, b) => {
    const av = pick(a);
    const bv = pick(b);
    const an = av === null || !Number.isFinite(av);
    const bn = bv === null || !Number.isFinite(bv);
    if (an && bn) return a.name.localeCompare(b.name);
    if (an) return 1;
    if (bn) return -1;
    if (bv !== av) return bv - av;
    return a.name.localeCompare(b.name);
  });
  return view;
}

/** The tag detail board, read. */
export type TagDetail = {
  info: TagInfo | null;
  rows: TagCoinRow[];
  change: { available: boolean; note: string | null };
  asOf: number;
};

/** Read one tag's page: its header, its coin rows, and the change-column state. */
export function readTagDetail(
  info: TagInfo | null,
  rows: readonly TagCoinRow[],
  changeSource: TagChangeSource | undefined,
  nowSec: number,
): TagDetail {
  return { info, rows: [...rows], change: readTagChangeColumn(changeSource), asOf: nowSec };
}

/** A 1-indexed inclusive page window over a client-side list. */
export type PageSlice = { page: number; pages: number; start: number; end: number; total: number; note: string };

/**
 * Compute a page window, clamped to a real page. `start`/`end` are 1-indexed and
 * INCLUSIVE, so a 326-row list at 50/page reads pages 1..7 and the last window
 * ends at 326. The note states the window and the total, because a page is a
 * slice and the board must say which slice it is showing.
 */
export function pageSlice(total: number, page: number, pageSize: number): PageSlice {
  const size = pageSize > 0 ? Math.floor(pageSize) : 1;
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / size));
  const clamped = Math.min(pages, Math.max(1, Math.floor(page)));
  const start = total === 0 ? 0 : (clamped - 1) * size + 1;
  const end = Math.min(total, clamped * size);
  const note = total === 0 ? 'no rows' : `${start}–${end} of ${total}`;
  return { page: clamped, pages, start, end, total, note };
}
