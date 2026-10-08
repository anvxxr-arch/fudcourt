/**
 * The coin directory's domain model — the LISTINGS universe seen as a whole:
 * the all-coins directory, the three discovery widgets, and the per-coin drill
 * down. Types plus the pure derivations the board renders with.
 *
 * WHY THIS IS A DIRECTORY, NOT A PRICE BOARD. Three different upstream tables
 * answer three different questions and each carries its own incompleteness:
 *   - `mode=coins` is the ranked all-coins list (100 rows). It reports
 *     `changeSource: 'unavailable'` — the mode ships NO 24h change at all, so
 *     every change cell is `—` and the board says so rather than printing a 0
 *     that would read as a flat market.
 *   - `mode=listings` is three discovery widgets (recently added / most
 *     searched / most visited) whose change is DERIVED from upstream histPrices
 *     anchors. The envelope ships `anchor24h`/`anchor7d` counts; the derivation
 *     below re-counts the non-null changes and the board reports whether they
 *     agree, because a derived count that disagrees with the anchor is a
 *     signal the two are not measuring the same rows.
 *   - `mode=coin&key=` is the per-coin drill down; its `image` may be null and
 *     every metric may be absent.
 *
 * THE ONE RULE EVERY SECTION OBEYS. A metric the upstream did not publish
 * renders `—`, never 0. A summed total is stated ONLY when every row in view
 * states its component — a partial sum under a "total" label is the same
 * fabrication one level up.
 *
 * THE CHANGE SCALE (measured live, not assumed). CryptoRank's `coin`/`listings`
 * change fields are PERCENT-scaled numbers — the number IS the percent. The
 * brief labels them "a FRACTION"; the arithmetic says otherwise and the board
 * follows the data: Tether's coin detail ships `change24h: -0.0373` and
 * CoinMarketCap independently prices USDT at `-0.031%` for the same window
 * (a fraction reading would print -3.73%, two orders of magnitude off a
 * stablecoin). So `upstreamChangePercent` returns the value unchanged and the
 * board renders it with a `%` sign; a null stays null (never 0).
 *
 * PURE: no network, no clock (`nowSec` is a parameter where a clock is needed),
 * no I/O — so it unit-tests offline against fixed rows.
 */

/** One coin directory row, as `mode=coins` (and the chain/tag/category rows) ship it. */
export type CoinsRow = {
  rank: number | null;
  /** The CryptoRank key — the slug `mode=coin&key=` takes. */
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
  /** Null on the `coins` surface — the envelope reports `changeSource: 'unavailable'`. */
  change24h: number | null;
};

/** One discovery-widget row (`mode=listings`): the coin shape plus a 7d change. */
export type ListingsRow = CoinsRow & {
  /** A PERCENT-scaled number (see `upstreamChangePercent`), or null -> `—`. */
  change7d: number | null;
};

/** The three `/listings` widgets. */
export const LISTINGS_WIDGETS = ['recentlyAdded', 'mostSearched', 'mostVisited'] as const;
export type ListingsWidgetKey = (typeof LISTINGS_WIDGETS)[number];
export type ListingsWidgets = Record<ListingsWidgetKey, ListingsRow[]>;

/** How many rows the envelope says upstream shipped each histPrices anchor. */
export type ListingsAnchors = Partial<Record<ListingsWidgetKey, number | null>>;

/** One per-coin detail row (`mode=coin&key=`). */
export type CoinDetail = {
  key: string;
  name: string;
  symbol: string;
  image: string | null;
  priceUsd: number | null;
  /** A PERCENT-scaled number (see `upstreamChangePercent`), or null -> `—`. */
  change24h: number | null;
  marketCap: number | null;
  fullyDilutedMarketCap: number | null;
  volume24h: number | null;
  availableSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  /** A PERCENT. */
  circulatingPct: number | null;
  athUsd: number | null;
  athDate: string | null;
  atlUsd: number | null;
  atlDate: string | null;
  /** PERCENTS. */
  fromAthPct: number | null;
  fromAtlPct: number | null;
  listingDate: string | null;
  lifeCycle: string | null;
  rank: number | null;
};

/** One CoinMarketCap market pair (the subset the board renders). */
export type MarketPairRow = {
  exchangeName: string | null;
  price: number | null;
  volumeUsd: number | null;
};

/** One CoinGlass open-interest exchange row. */
export type OpenInterestRow = {
  exchangeName: string | null;
  /** The SYMBOL CoinGlass keys on — identical on every row of one read. */
  symbol: string | null;
  openInterest: number | null;
  h4OIChangePercent: number | null;
  h1VolChangePercent: number | null;
};

/** How the envelope's change column was obtained (mirrors the sidecar field). */
export type CoinsChangeSource = 'direct' | 'derived-from-histPrices-24H' | 'unavailable';

/** Whether the board may show a change column, and why not when it may not. */
export type ChangeColumn = { available: boolean; note: string | null };

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

/** A finite number, or null for anything the upstream did not publish. */
function finite(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/**
 * Whether the change column is available, and the reason when it is not.
 *
 * Only an EXPLICITLY listed source counts as available. An `unavailable` source
 * (`mode=coins`) and a MISSING source both read as unavailable: absent
 * provenance is not provenance, and "we were not told where this came from"
 * cannot be read as "here is the number".
 */
export function readChangeColumn(changeSource: CoinsChangeSource | undefined): ChangeColumn {
  if (changeSource === 'unavailable') {
    return {
      available: false,
      note: 'this mode carries no change column upstream (changeSource: unavailable) — the board renders — rather than a 0 that would read as a flat market',
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

/**
 * Normalise a CryptoRank `coin`/`listings` change value for display.
 *
 * The value is a PERCENT-scaled number already (the number IS the percent), so
 * this returns it UNCHANGED — it does NOT multiply by 100. See the module
 * header for the live evidence; a null/unfinite value stays null so the board
 * renders `—`, never 0.
 */
export function upstreamChangePercent(change: number | null): number | null {
  return finite(change);
}

/** The all-coins directory board, read. */
export type CoinsBoard = {
  rows: CoinsRow[];
  listed: number;
  upstreamTotal: number | null;
  /** How many rows state a market cap. */
  marketCapStated: number;
  /** Summed ONLY when every row in view states a cap; null otherwise. */
  totalMarketCapUsd: number | null;
  /** The row with the largest stated cap; null when none states one. */
  topByMarketCap: CoinsRow | null;
  /** How many rows state a 24h change (0 when the mode carries no change column). */
  changeStated: number;
  change: ChangeColumn;
  slice: { shown: number; upstreamTotal: number | null; note: string };
};

/**
 * Read the all-coins directory. The market-cap total is stated only when EVERY
 * row on the page states a cap; where the change column is absent the board
 * carries the reason instead of a count that would read as "nothing moved".
 */
export function readCoinsBoard(
  rows: readonly CoinsRow[],
  upstreamTotal: number | null,
  changeSource: CoinsChangeSource | undefined,
): CoinsBoard {
  let marketCapStated = 0;
  let changeStated = 0;
  let sum = 0;
  let top: CoinsRow | null = null;
  for (const row of rows) {
    const cap = finite(row.marketCap);
    if (cap !== null) {
      marketCapStated += 1;
      sum += cap;
      if (top === null || cap > (finite(top.marketCap) ?? Number.NEGATIVE_INFINITY)) top = row;
    }
    if (finite(row.change24h) !== null) changeStated += 1;
  }
  const everyRowStates = rows.length > 0 && marketCapStated === rows.length;
  const shown = rows.length;
  const note =
    upstreamTotal === null
      ? `showing all ${shown} coins — upstream stated no total`
      : `showing ${shown} of ${upstreamTotal} coins listed upstream`;
  return {
    rows: [...rows],
    listed: shown,
    upstreamTotal,
    marketCapStated,
    totalMarketCapUsd: everyRowStates ? sum : null,
    topByMarketCap: top,
    changeStated,
    change: readChangeColumn(changeSource),
    slice: { shown, upstreamTotal, note },
  };
}

/** Sort directions for the directory table. */
export type CoinSortDir = 'desc' | 'asc';

/**
 * The client-side directory filter + sort: a case-insensitive text match over
 * name, symbol and category, then a market-cap sort. Rows with no stated cap
 * sort LAST in both directions — an absent cap is not a small one, so it must
 * not be ranked as if it were `0`.
 */
export function filterAndSortCoins(rows: readonly CoinsRow[], query: string, dir: CoinSortDir = 'desc'): CoinsRow[] {
  const q = query.trim().toLowerCase();
  const filtered =
    q === ''
      ? [...rows]
      : rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.symbol.toLowerCase().includes(q) ||
            (r.category ?? '').toLowerCase().includes(q),
        );
  return filtered.sort((a, b) => {
    const am = finite(a.marketCap);
    const bm = finite(b.marketCap);
    if (am === null && bm === null) return (a.rank ?? 0) - (b.rank ?? 0);
    if (am === null) return 1;
    if (bm === null) return -1;
    return dir === 'desc' ? bm - am : am - bm;
  });
}

/** One discovery widget, read. */
export type ListingsWidgetRead = {
  key: ListingsWidgetKey;
  rows: ListingsRow[];
  shown: number;
  change24hStated: number;
  change7dStated: number;
  anchor24h: number | null;
  anchor7d: number | null;
  /** Do the re-counted non-null changes equal the anchor upstream shipped? */
  anchor24hMatch: boolean | null;
  anchor7dMatch: boolean | null;
};

/**
 * Read one discovery widget: its rows, the re-counted stated changes, and
 * whether those counts agree with the `anchor24h`/`anchor7d` the envelope ships.
 * A `null` match means the envelope stated no anchor to check against.
 */
export function readListingsWidget(
  key: ListingsWidgetKey,
  rows: readonly ListingsRow[],
  anchor24h: number | null,
  anchor7d: number | null,
): ListingsWidgetRead {
  let change24hStated = 0;
  let change7dStated = 0;
  for (const row of rows) {
    if (finite(row.change24h) !== null) change24hStated += 1;
    if (finite(row.change7d) !== null) change7dStated += 1;
  }
  const a24 = finite(anchor24h);
  const a7 = finite(anchor7d);
  return {
    key,
    rows: [...rows],
    shown: rows.length,
    change24hStated,
    change7dStated,
    anchor24h: a24,
    anchor7d: a7,
    anchor24hMatch: a24 === null ? null : a24 === change24hStated,
    anchor7dMatch: a7 === null ? null : a7 === change7dStated,
  };
}

/** The three-widget listings board, read. */
export type ListingsBoard = {
  widgets: ListingsWidgetRead[];
  totalShown: number;
  /** True when every anchor that was stated agrees with its re-count. */
  allAnchorsMatch: boolean;
};

/** Read the listings board across all three widgets. */
export function readListingsBoard(
  listings: ListingsWidgets | null,
  anchor24h: ListingsAnchors | null,
  anchor7d: ListingsAnchors | null,
): ListingsBoard {
  const widgets = LISTINGS_WIDGETS.map((key) =>
    readListingsWidget(key, listings?.[key] ?? [], anchor24h?.[key] ?? null, anchor7d?.[key] ?? null),
  );
  return {
    widgets,
    totalShown: widgets.reduce((n, w) => n + w.shown, 0),
    allAnchorsMatch: widgets.every((w) => w.anchor24hMatch !== false && w.anchor7dMatch !== false),
  };
}

/** The CoinMarketCap market-pairs page, read. */
export type MarketPairsRead = {
  name: string | null;
  symbol: string | null;
  /** The upstream total pair count, or null when not stated. */
  numMarketPairs: number | null;
  /** How many pairs are on this page. */
  shown: number;
  note: string;
};

/**
 * Read a market-pairs page. `numMarketPairs` is upstream's own total across
 * every venue and every quote; `marketPairs` is the page the sidecar fetched,
 * so the board says "first page of N pairs" and never presents the page as the
 * whole book.
 */
export function readMarketPairs(
  data: { name?: string | null; symbol?: string | null; numMarketPairs?: number | null; marketPairs?: readonly MarketPairRow[] } | null,
  limit: number,
): MarketPairsRead {
  const shown = data?.marketPairs?.length ?? 0;
  const total = finite(data?.numMarketPairs ?? null);
  const note =
    total === null
      ? `first page of ${shown} pairs (limit ${limit}) — upstream stated no total`
      : `first page of ${total.toLocaleString('en-US')} pairs (page holds ${shown}, limit ${limit})`;
  return { name: data?.name ?? null, symbol: data?.symbol ?? null, numMarketPairs: total, shown, note };
}

/** The CoinGlass open-interest read, read. */
export type OpenInterestRead = {
  rows: OpenInterestRow[];
  shown: number;
  symbol: string;
  note: string;
};

/**
 * Read the per-symbol open-interest table. CoinGlass keys on the SYMBOL (upper
 * case), not the CryptoRank slug, so the board states that mapping explicitly.
 */
export function readOpenInterest(rows: readonly OpenInterestRow[], symbol: string): OpenInterestRead {
  return {
    rows: [...rows],
    shown: rows.length,
    symbol,
    note: `CoinGlass keys this read on the SYMBOL ${symbol.toUpperCase()} (not the CryptoRank slug); ${rows.length} exchange rows`,
  };
}

/** Whole days between an upstream ISO instant and `nowSec`; null when unusable. */
export function daysSince(iso: string | null, nowSec: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (nowSec - Math.floor(t / 1000)) / 86_400;
}
