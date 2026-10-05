/**
 * CoinGecko markets family (keyless, public API) -- the data contract behind
 * the tracker view (src/components/TrackerPage.tsx).
 *
 * Re-aligned 2026-09-28: the tracker has always fetched `/api/markets`, but the
 * route never existed in this tree (orphaned during an earlier restructure ->
 * the view rendered a red "API error"). This lib + route close that gap using
 * the same house pattern as lib/llama.ts: strict OUR params (400, never
 * clamped), upstream relayed honestly, local search/sort labelled as derived.
 */

/** Fixed upstream: CoinGecko /coins/markets (public, keyless, GET-only). */
export const MARKETS_UPSTREAM = 'https://api.coingecko.com/api/v3/coins/markets';

/**
 * CoinGecko caps per_page at 250. The pool is therefore "top 250 by market
 * cap" -- every total/derivative in the response is measured against THIS
 * pool and reported as `pool`, never as an unbounded "all coins".
 */
export const MARKETS_POOL = 250;

/**
 * OUR sort keys. Upstream always arrives mcap_desc -- `mcap` therefore
 * restores the upstream order verbatim (it equals `rank`); the others are
 * genuinely local re-sorts and labelled as such in `derived`.
 */
export const MARKETS_SORTS = ['mcap', 'volume', 'price', 'change', 'name'] as const;
export type MarketsSort = (typeof MARKETS_SORTS)[number];

export const MARKETS_ORDERS = ['asc', 'desc'] as const;
export type MarketsOrder = (typeof MARKETS_ORDERS)[number];

/** OUR limits: strict ranges, validated in the route (400, never clamped). */
export const MARKETS_PAGE_SIZE_MAX = 100;
export const MARKETS_SEARCH_MAX = 64;

/** One upstream fetch serves every search/sort/page combination. */
export const MARKETS_TTL_MS = 60_000;

/** Upstream cache tag for one CoinGecko pool fetch. */
export function marketsUpstreamUrl(): string {
  const p = new URLSearchParams({
    vs_currency: 'usd',
    order: 'market_cap_desc',
    per_page: String(MARKETS_POOL),
    page: '1',
    sparkline: 'false',
    price_change_percentage: '24h',
  });
  return `${MARKETS_UPSTREAM}?${p}`;
}

/** One row of the shape the tracker renders. Nulls stay null (never 0-filled). */
export type MarketsCoin = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name?: string;
  image?: string;
  lastPrice: number;
  priceChangePercent: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  volume: number | null;
  quoteVolume: number | null;
  marketCap: number;
  rank: number;
  count: number;
};
