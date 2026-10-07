/**
 * The crypto-breadth boards' domain model — the market seen from OUTSIDE any one
 * asset: tokenized real-world assets, the primary-event calendars, sector
 * rotation, and the venue ranking.
 *
 * WHY THIS IS FOUR BOARDS AND NOT ONE LIST. "Breadth" is not a single metric; it
 * is four different questions, and each one has its own upstream table, its own
 * slice, and its own way of being incomplete:
 *   - RWA: CryptoRank serves page 1 — 25 rows of 210. The board states that and
 *     ranks only within the rows it can see.
 *   - Launch calendar: the event lists ship one SSR page and upstream ignores
 *     `?page=`, so the board names how many it can see and how many state a
 *     raise — a launchpool and a node sale are separate tables (different raise
 *     fields), so they are separate boards.
 *   - Sector rotation: this surface carries NO 24h change column at all (the
 *     envelope reports `changeSource: 'unavailable'`); the board says so instead
 *     of printing a 0 that would read as a flat market.
 *   - Exchange ranking: the reserve-transparency variant carries no volume
 *     fields at all, so its volume columns render `—` rather than 0.
 *
 * THE ONE RULE EVERY SECTION OBEYS. A metric the upstream did not publish
 * renders `—`, never 0. `0` is a measurement; `—` is the absence of one, and a
 * board that prints 0 for an absent metric asserts a number upstream never made.
 * A summed total is therefore stated ONLY when every row in view states its
 * component — a partial sum under a "total" label is the same fabrication one
 * level up.
 *
 * PURE: no network, no clock (`nowSec` is a parameter), no I/O — so it
 * unit-tests offline against fixed rows.
 */

/** One RWA index row, as CryptoRank's `rwa` mode ships it (25 of 210). */
export type BreadthRwaRow = {
  rank: number | null;
  slug: string;
  /** `<plural-type>/<slug>` — the type segment is mandatory on the detail route. */
  detailKey: string;
  ticker: string;
  name: string;
  /** 'commodity' | 'stock' | 'etf' | 'bond' (upstream's own label). */
  type: string;
  image: string | null;
  priceUsd: number | null;
  /** A FRACTION, not a percent — see `rwaChangePercent`. */
  change24h: number | null;
  change7d: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  tokenizedPriceUsd: number | null;
  tokenizedMcapUsd: number | null;
  tokenizedVolume24hUsd: number | null;
  isLeveraged: boolean;
  marketState: string | null;
  mainTokenKey: string | null;
};

/** One launchpool event row (`mode=launchpool&key=<past|upcoming|active>`). */
export type BreadthLaunchpoolRow = {
  key: string;
  name: string;
  symbol: string;
  category: string | null;
  totalRaiseUsd: number | null;
  priceUsd: number | null;
  launchpads: string[];
  /** Upstream ISO window; null = not announced -> em dash. */
  when: string | null;
  till: string | null;
};

/** One node-sale row (`mode=nodesale&key=<past|active|upcoming>`). */
export type BreadthNodesaleRow = {
  key: string;
  name: string;
  symbol: string;
  image: string | null;
  category: string | null;
  when: string | null;
  till: string | null;
  /** Upstream node tier prices in USD (never a market price). */
  nodePriceFromUsd: number | null;
  nodePriceToUsd: number | null;
  raiseUsd: number | null;
  totalRaiseUsd: number | null;
};

/** The category header CryptoRank ships beside `mode=categories` rows. */
export type BreadthCategoryInfo = {
  slug: string;
  name: string;
  gainers: number | null;
  losers: number | null;
};

/** One coin row inside a category board (`mode=categories&key=<slug>`). */
export type BreadthCategoryRow = {
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

/** One exchange-ranking row (`mode=exchanges&key=<variant>`). */
export type BreadthExchangeRow = {
  rank: number | null;
  key: string;
  name: string;
  image: string | null;
  dayVolUsd: number | null;
  weekVolUsd: number | null;
  monthVolUsd: number | null;
  percentVolume: number | null;
  pairsCount: number | null;
  currenciesCount: number | null;
  exchangeType: string | null;
};

/** How the envelope's change column was obtained (mirrors the sidecar field). */
export type BreadthChangeSource = 'direct' | 'derived-from-histPrices-24H' | 'unavailable';

// ---------------------------------------------------------------------------
// Allowlists — REDECLARED, not imported.
//
// The structure gate forbids a feature importing another feature's internals, so
// the CryptoRank key tables cannot come from `features/cryptorank/cryptorank-modes.ts`.
// The values below are COPIED VERBATIM from that file (its `CR_CATEGORY_SLUGS`,
// `CR_EXCHANGE_LISTS`, `CR_LP_LISTS`, `CR_ND_LISTS`, and the `CR_DEFAULT_*` consts).
// The sidecar rejects an unknown key (400/404), so a stale entry here surfaces as a
// visible error rather than a silent miss; if upstream adds a key, BOTH lists move.
// ---------------------------------------------------------------------------

/** The 28 overview categories CryptoRank's `/categories/<slug>` route accepts. */
export const BREADTH_CATEGORY_SLUGS = [
  'predictionmarkets', 'blockchain-infrastructure', 'chain', 'blockchain-service',
  'gamefi', 'social', 'stablecoin', 'currency', 'defi', 'exchange',
  'non-fungible-tokens-nft', 'meme', 'ce-fi', 'payments', 'wallet',
  'tokenizedassets', 'rwa', 'depin', 'launchpad', 'interoperability',
  'miningandcompute', 'compliance', 'dataanalytics', 'ai', 'liquidstaking',
  'brokerage', 'treasure', 'privacy',
] as const;
export type BreadthCategorySlug = (typeof BREADTH_CATEGORY_SLUGS)[number];
export const BREADTH_DEFAULT_CATEGORY: BreadthCategorySlug = 'chain';

/** Exchange-ranking variants (strict whitelist — the keys contain a slash). */
export const BREADTH_EXCHANGE_LISTS = ['cex/spot', 'dex/spot', 'perpetuals', 'cex-transparency'] as const;
export type BreadthExchangeKey = (typeof BREADTH_EXCHANGE_LISTS)[number];
export const BREADTH_DEFAULT_EXCHANGE: BreadthExchangeKey = 'cex/spot';
export const BREADTH_EXCHANGE_LABELS: Record<BreadthExchangeKey, string> = {
  'cex/spot': 'CEX spot',
  'dex/spot': 'DEX spot',
  perpetuals: 'Perpetuals',
  'cex-transparency': 'CEX transparency',
};

/** Launchpool event-list variants (strict whitelist). */
export const BREADTH_LP_LISTS = ['past', 'upcoming', 'active'] as const;
export type BreadthLpKey = (typeof BREADTH_LP_LISTS)[number];
export const BREADTH_DEFAULT_LP: BreadthLpKey = 'past';

/** Node-sale event-list variants (strict whitelist). */
export const BREADTH_ND_LISTS = ['past', 'active', 'upcoming'] as const;
export type BreadthNdKey = (typeof BREADTH_ND_LISTS)[number];
export const BREADTH_DEFAULT_ND: BreadthNdKey = 'past';

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

/**
 * Upstream RWA `change24h` is a FRACTION, not a percent — verified live against
 * the detail card's `change24hAbs`: gold `change24h: 0.00716638` at a
 * `priceUsd: 4110.83` gives `change24hAbs: 29.25`, i.e. 0.00716638 * 4110.83.
 * Multiply by 100 for a percent; null stays null (never 0).
 */
export function rwaChangePercent(change24h: number | null): number | null {
  if (change24h === null || !Number.isFinite(change24h)) return null;
  return change24h * 100;
}

/**
 * Whether the board may show a change column at all, and why not when it may not.
 *
 * Only an EXPLICITLY listed source counts as available. An `unavailable` source
 * (the categories surface) and a MISSING source are both treated as unavailable:
 * absent provenance is not provenance, and "we were not told where this came
 * from" cannot be read as "here is the number".
 */
export function readChangeColumn(changeSource: BreadthChangeSource | undefined): { available: boolean; note: string | null } {
  if (changeSource === 'unavailable') {
    return {
      available: false,
      note: 'the upstream change column is unavailable on this surface — the board says so rather than printing 0, which would read as a flat market',
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

/** Parse an upstream ISO instant to whole seconds, or null when absent/unparseable. */
function parseInstant(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export type EventStatus = 'upcoming' | 'active' | 'past' | 'unknown';

/** Where a primary event sits relative to `now`. */
export type EventWindow = {
  status: EventStatus;
  /** Days from `now` to open (negative once open); null when unannounced. */
  daysToOpen: number | null;
  /** Days from `now` to close (negative once closed); null when unannounced. */
  daysToClose: number | null;
  note: string | null;
};

/**
 * Read a launchpool/node-sale window. Either end may be unannounced (null); an
 * event with NO window at all is 'unknown', NOT 'upcoming' — "we were not told
 * when" and "it is coming" are different claims and only one is true.
 */
export function readEventWindow(when: string | null, till: string | null, nowSec: number): EventWindow {
  const open = parseInstant(when);
  const close = parseInstant(till);
  if (open === null && close === null) {
    return { status: 'unknown', daysToOpen: null, daysToClose: null, note: 'no window announced upstream' };
  }
  const daysToOpen = open === null ? null : (open - nowSec) / 86_400;
  const daysToClose = close === null ? null : (close - nowSec) / 86_400;
  if (open !== null && nowSec < open) return { status: 'upcoming', daysToOpen, daysToClose, note: null };
  if (close !== null && nowSec > close) return { status: 'past', daysToOpen, daysToClose, note: null };
  return { status: 'active', daysToOpen, daysToClose, note: null };
}

/** One event list, read: its rows beside their windows, plus the raise honesty. */
export type EventRead<R> = {
  events: { row: R; window: EventWindow }[];
  shown: number;
  /** Rows whose window upstream has not announced at all. */
  unannounced: number;
  /** How many rows state a raise (so the board can say "n of m"). */
  raisedStated: number;
  /**
   * The total raised across the rows in view, ONLY when every row states one;
   * null otherwise. A sum over a subset under a "total" label would understate
   * by exactly the rows it skipped.
   */
  raisedTotalUsd: number | null;
};

/**
 * Read an event list. `raiseOf` names which field is the raise for this family
 * (launchpool reports `totalRaiseUsd`; a node sale reports `raiseUsd`), so one
 * derivation serves both without guessing at the shape.
 */
export function readEventList<R extends { when: string | null; till: string | null }>(
  rows: readonly R[],
  nowSec: number,
  raiseOf: (row: R) => number | null,
): EventRead<R> {
  const events = rows.map((row) => ({ row, window: readEventWindow(row.when, row.till, nowSec) }));
  let raisedStated = 0;
  let sum = 0;
  let everyRowStates = rows.length > 0;
  for (const row of rows) {
    const v = raiseOf(row);
    if (v !== null && Number.isFinite(v)) {
      raisedStated += 1;
      sum += v;
    } else {
      everyRowStates = false;
    }
  }
  return {
    events,
    shown: rows.length,
    unannounced: events.filter((e) => e.window.status === 'unknown').length,
    raisedStated,
    raisedTotalUsd: everyRowStates ? sum : null,
  };
}

/** The RWA board, read. */
export type RwaBoard = {
  rows: BreadthRwaRow[];
  /** Row counts by asset type, largest first. */
  typeMix: { type: string; count: number }[];
  leveraged: number;
  slice: { shown: number; upstreamTotal: number | null; note: string };
};

/**
 * Read the RWA board. The slice is stated because "the 25 assets we can see" and
 * "the 210 the index holds" are different claims, and only the first is what the
 * ranking is over.
 */
export function readRwaBoard(rows: readonly BreadthRwaRow[], upstreamTotal: number | null): RwaBoard {
  const counts = new Map<string, number>();
  let leveraged = 0;
  for (const row of rows) {
    counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
    if (row.isLeveraged) leveraged += 1;
  }
  const typeMix = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const shown = rows.length;
  const note =
    upstreamTotal === null
      ? `showing ${shown} RWA assets — upstream stated no total, so the ranking is over these ${shown} alone`
      : `${shown} of ${upstreamTotal} upstream — the board reads the ${shown} on SSR page 1, and its ranking is over those ${shown}, not the whole index`;
  return { rows: [...rows], typeMix, leveraged, slice: { shown, upstreamTotal, note } };
}

/** The sector-rotation board, read. */
export type CategoryBoard = {
  info: BreadthCategoryInfo | null;
  rows: BreadthCategoryRow[];
  /** gainers+losers when BOTH are stated; null otherwise (never a half-sum). */
  breadth: { gainers: number; losers: number; total: number } | null;
  change: { available: boolean; note: string | null };
};

/** Read a category board: its header breadth, its rows, and the change-column state. */
export function readCategoryBoard(
  info: BreadthCategoryInfo | null,
  rows: readonly BreadthCategoryRow[],
  changeSource: BreadthChangeSource | undefined,
): CategoryBoard {
  const g = info?.gainers ?? null;
  const l = info?.losers ?? null;
  const breadth = g !== null && l !== null ? { gainers: g, losers: l, total: g + l } : null;
  return { info, rows: [...rows], breadth, change: readChangeColumn(changeSource) };
}

/** The exchange-ranking board, read. */
export type ExchangeBoard = {
  rows: BreadthExchangeRow[];
  /** True when at least one row carries a 24h volume. */
  volumeAvailable: boolean;
  /** Sum of 24h volume over the rows that state it; null when none do. */
  dayVolumeShownUsd: number | null;
  /** How many rows state a pair count. */
  pairsStated: number;
  note: string;
};

/**
 * Read the exchange ranking. The reserve-transparency variant ships no volume
 * fields, so `volumeAvailable` is false there and the volume columns must render
 * `—`; the note names which surface this is and whose volume it is (CryptoRank's
 * own reported figure, never presented as independently measured).
 */
export function readExchangeBoard(rows: readonly BreadthExchangeRow[], variant: BreadthExchangeKey): ExchangeBoard {
  let dayVolumeShownUsd: number | null = null;
  let pairsStated = 0;
  for (const row of rows) {
    if (row.dayVolUsd !== null && Number.isFinite(row.dayVolUsd)) {
      dayVolumeShownUsd = (dayVolumeShownUsd ?? 0) + row.dayVolUsd;
    }
    if (row.pairsCount !== null && Number.isFinite(row.pairsCount)) pairsStated += 1;
  }
  const volumeAvailable = rows.some((row) => row.dayVolUsd !== null && Number.isFinite(row.dayVolUsd));
  const note =
    variant === 'cex-transparency'
      ? "this surface is the reserve-transparency list: it carries no volume fields, so every volume column renders — rather than 0; reserves (CryptoRank's own reported proof-of-reserves, not an independent attestation) are the columns this variant does publish"
      : "volume is CryptoRank's OWN reported figure on this surface (their methodology, not independently measured); the % share is per-row share of CryptoRank's listed total";
  return { rows: [...rows], volumeAvailable, dayVolumeShownUsd, pairsStated, note };
}
