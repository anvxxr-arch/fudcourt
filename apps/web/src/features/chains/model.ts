/**
 * The chain & ecosystem directory's domain model — the network map seen from
 * OUTSIDE any one asset: the chains CryptoRank indexes, their ecosystems, and
 * the tokens that live inside one chain.
 *
 * WHY THIS IS ONE SURFACE WITH A KEYED DETAIL, NOT THREE LISTS.
 *   - The chain directory (`mode=blockchains`, 277 rows) is the index: every
 *     chain with the market cap CryptoRank assigns it and its explorer link.
 *   - The ecosystem index (`mode=ecosystems`) is upstream's OWN ecosystem
 *     aggregates — 20 of 106 on SSR page 1, so the board states the slice.
 *   - The chain detail (`mode=chain&key=<slug>`) is keyed by a directory slug
 *     and ships a few thousand ecosystem tokens in ONE array, so the board
 *     paginates it client-side and states the page slice it is showing.
 *
 * THE ONE RULE EVERY SECTION OBEYS. A metric the upstream did not publish
 * renders `—`, never 0. `0` is a measurement; `—` is the absence of one, and a
 * board that prints 0 for an absent metric asserts a number upstream never
 * made. The directory's "total market cap" is therefore stated ONLY when EVERY
 * row in view states one — a partial sum under a "total" label is the same
 * fabrication one level up.
 *
 * THE CHANGE COLUMN IS ABSENT, NOT FLAT. The chain-detail mode reports
 * `changeSource: 'unavailable'` — it ships no change column at all — so the
 * board says so and renders `—` in every change cell rather than a 0 that would
 * read as a flat market.
 *
 * PURE: no network, no I/O. The one time value the directory records (the read
 * instant) is passed IN as `nowSec` rather than read, so the whole module
 * unit-tests offline against fixed rows.
 */

/** One chain-directory row, as CryptoRank's `blockchains` mode ships it (277). */
export type ChainRow = {
  slug: string;
  name: string;
  image: string | null;
  /** Upstream's own network label (e.g. 'Ethereum', 'BNB', 'ETH'). */
  network: string | null;
  /** Upstream's own explorer link; null when it published none. */
  explorerUrl: string | null;
  /** Upstream's own market cap for the chain; null -> `—`, never 0. */
  marketCap: number | null;
};

/** One ecosystem-index row (`mode=ecosystems`, 20 of 106). */
export type EcosystemRow = {
  /** The slug a chain/ecosystem detail is keyed by. */
  key: string;
  name: string;
  logo: string | null;
  projects: number | null;
  /**
   * Upstream's own 3-month change figure for its project count. It carries no
   * `Pct` suffix upstream, so the board shows it exactly as shipped and does
   * not append a percent sign the upstream never stated.
   */
  projectsChange3m: number | null;
  marketCapUsd: number | null;
  /** A PERCENT number (e.g. -3.568 = -3.57%), unlike the coin-change fractions. */
  marketCapChange24hPct: number | null;
  tvlUsd: number | null;
  /** A PERCENT number, as `marketCapChange24hPct` is. */
  tvlChange24hPct: number | null;
  tags: string[];
};

/** The chain header CryptoRank ships beside `mode=chain` rows. */
export type ChainDetail = {
  slug: string;
  name: string;
  network: string | null;
  marketCap: number | null;
  explorerUrl: string | null;
  ecosystem: string | null;
};

/** One ecosystem-token row inside `mode=chain&key=<slug>` (the paginated `rows`). */
export type ChainTokenRow = {
  rank: number | null;
  key: string;
  name: string;
  symbol: string | null;
  image: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  volume24hUsd: number | null;
  category: string | null;
  listingDate: string | null;
  lifeCycle: string | null;
  athUsd: number | null;
  /** A FRACTION and null on this surface — the mode reports no change column. */
  change24h: number | null;
};

/** How the envelope's change column was obtained (mirrors the sidecar field). */
export type ChainsChangeSource = 'direct' | 'derived-from-histPrices-24H' | 'unavailable';

/** The page size the keyed chain detail paginates its token array by. */
export const CHAINS_DETAIL_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

/**
 * Whether the board may show a change column at all, and why not when it may not.
 *
 * Only an EXPLICITLY listed source counts as available. An `unavailable` source
 * (this detail mode) and a MISSING source are both treated as unavailable:
 * absent provenance is not provenance, and "we were not told where this came
 * from" cannot be read as "here is the number".
 */
export function readChangeColumn(changeSource: ChainsChangeSource | undefined): { available: boolean; note: string | null } {
  if (changeSource === 'unavailable') {
    return {
      available: false,
      note: "this mode reports changeSource:'unavailable' — it ships no change column, so the 24h % cell is the em-dash on every row, never a 0 that would read as a flat market",
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

/** The chain directory, read. */
export type ChainDirectoryBoard = {
  rows: ChainRow[];
  /** How many chains the board can see (the whole index, 277). */
  shown: number;
  /** Upstream's stated full size, when it names one (null here — the feed is whole). */
  upstreamTotal: number | null;
  /** Rows that state a market cap. */
  statedCap: number;
  /** The chain with the largest STATED market cap, or null when none states one. */
  topByMarketCap: ChainRow | null;
  /**
   * The sum of chain market caps, ONLY when EVERY row in view states one; null
   * otherwise. A sum over a subset under a "total" label would understate by
   * exactly the rows it skipped.
   */
  totalMarketCapUsd: number | null;
  /** The instant the board read the directory, passed in (never a clock read here). */
  asOf: number;
};

/** Read the chain directory: its coverage, its top chain, and the honest total. */
export function readChainDirectory(
  rows: readonly ChainRow[],
  upstreamTotal: number | null,
  nowSec: number,
): ChainDirectoryBoard {
  let statedCap = 0;
  let sum = 0;
  let everyRowStates = rows.length > 0;
  let top: ChainRow | null = null;
  for (const row of rows) {
    if (row.marketCap !== null && Number.isFinite(row.marketCap)) {
      statedCap += 1;
      sum += row.marketCap;
      if (top === null || row.marketCap > (top.marketCap ?? Number.NEGATIVE_INFINITY)) top = row;
    } else {
      everyRowStates = false;
    }
  }
  return {
    rows: [...rows],
    shown: rows.length,
    upstreamTotal,
    statedCap,
    topByMarketCap: top,
    totalMarketCapUsd: everyRowStates ? sum : null,
    asOf: nowSec,
  };
}

/** One line stating whether the directory's market-cap total may be shown, and why. */
export function capCoverageNote(board: ChainDirectoryBoard): string {
  if (board.shown === 0) return 'no chains were read';
  if (board.totalMarketCapUsd !== null) {
    return `every one of the ${board.shown} chains states a market cap, so the total is stated`;
  }
  const missing = board.shown - board.statedCap;
  return `only ${board.statedCap} of ${board.shown} chains state a market cap, so no total is stated — a sum over the rest would understate by ${missing} chain${missing === 1 ? '' : 's'}`;
}

/** Case-insensitive match of a chain against a free-text query over its name and network. */
export function matchChain(row: ChainRow, query: string): boolean {
  if (query === '') return true;
  return (row.name ?? '').toLowerCase().includes(query) || (row.network ?? '').toLowerCase().includes(query);
}

/**
 * Filter the directory by a free-text query over name/network, and state the
 * slice: `showing N of M chains`, so a filtered view never reads as the whole.
 */
export function filterChains(rows: readonly ChainRow[], query: string): { matched: ChainRow[]; note: string } {
  const needle = query.trim().toLowerCase();
  const matched = needle === '' ? [...rows] : rows.filter((row) => matchChain(row, needle));
  return { matched, note: `showing ${matched.length} of ${rows.length} chains` };
}

/** The ecosystem index, read. */
export type EcosystemBoard = {
  rows: EcosystemRow[];
  shown: number;
  upstreamTotal: number | null;
  /** `n of total ecosystems`, or a stated single-count when upstream names no total. */
  note: string;
};

/**
 * Read the ecosystem index. The slice is stated because "the 20 ecosystems on
 * SSR page 1" and "the 106 the index holds" are different claims, and only the
 * first is what this board can see.
 */
export function readEcosystemBoard(rows: readonly EcosystemRow[], upstreamTotal: number | null): EcosystemBoard {
  const note =
    upstreamTotal === null
      ? `${rows.length} ecosystems — upstream stated no total, so this board reads only the ${rows.length} it shipped`
      : `${rows.length} of ${upstreamTotal} ecosystems`;
  return { rows: [...rows], shown: rows.length, upstreamTotal, note };
}

/** One chain's ecosystem tokens, read: the page in view plus the slice it sits in. */
export type ChainDetailBoard = {
  chain: ChainDetail | null;
  /** The rows on the CURRENT page only. */
  pageRows: ChainTokenRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  /** 1-based index of the first row on this page (0 when the page is empty). */
  firstIndex: number;
  /** 1-based index of the last row on this page (0 when the page is empty). */
  lastIndex: number;
  change: { available: boolean; note: string | null };
  /** A line stating the page slice, e.g. `page 1 of 70 — rows 1–50 of 3510`. */
  pageNote: string;
};

/**
 * Read one chain's detail: its header, the client-side page of its token array,
 * and the state of the change column. `page` is clamped into range, so a stale
 * page number after a refetch lands on a real page rather than an empty one.
 */
export function readChainDetail(
  chain: ChainDetail | null,
  rows: readonly ChainTokenRow[],
  changeSource: ChainsChangeSource | undefined,
  options: { page: number; pageSize: number },
): ChainDetailBoard {
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
  return {
    chain,
    pageRows,
    page,
    pageSize,
    totalRows,
    totalPages,
    firstIndex,
    lastIndex,
    change: readChangeColumn(changeSource),
    pageNote,
  };
}
