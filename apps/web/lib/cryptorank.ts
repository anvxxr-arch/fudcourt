/**
 * CryptoRank (cryptorank.io) read-only types + mode map.
 *
 * Data path: /api/cryptorank -> scripts/cr_fetch.py (venv curl_cffi) ->
 * <script id="__NEXT_DATA__"> SSR payload of the site's own market pages.
 *
 * Why this shape exists (measured 2026-09-27):
 *  - api.cryptorank.io/v0/* answers a Cloudflare managed challenge to every
 *    non-browser client tried (stock curl, curl_cffi chrome131, headful
 *    Chrome, Camoufox, with and without WARP) -> their JSON API is unusable.
 *  - The MARKET pages (/, /all-coins-list, /trending, /gainers, /losers)
 *    return 200 via curl_cffi with the full Next.js SSR payload, which is
 *    exactly what their frontend hydrates from.
 *  - The FUNDRAISING tree (/funding-rounds, /ico*, /token-unlock, /funds*,
 *    /insights, /drophunting) 403s behind the interstitial to every client
 *    including real browsers -> full boards stay out; only the homepage
 *    6-row slices are reachable and are labelled as slices, never as totals.
 *
 * Absent upstream metric -> null -> renders an em-dash. Never 0, never faked.
 */

export const CR_BASE = 'https://cryptorank.io';

export const CR_MODES = ['home', 'coins', 'trending', 'gainers', 'losers'] as const;
export type CrMode = (typeof CR_MODES)[number];

/** Route -> upstream path. The client never passes a raw path (mode only). */
export const CR_MODE_PATHS: Record<CrMode, string> = {
  home: '/',
  coins: '/all-coins-list',
  trending: '/trending',
  gainers: '/gainers',
  losers: '/losers',
};

export interface CrGlobal {
  totalMarketCap: number | null;
  totalMarketCapChangePercent: number | null;
  totalVolume24h: number | null;
  totalVolume24hChangePercent: number | null;
  btcDominance: number | null;
  btcDominanceChangePercent: number | null;
  ethDominance: number | null;
  ethDominanceChangePercent: number | null;
  allCurrencies: number | null;
  gasGwei: number | null;
}

/** Shared coin row. change24h null = upstream didn't ship an anchor -> em-dash. */
export interface CrCoin {
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
  change24h: number | null;
}

export interface CrTrendingRow {
  rank: number | null;
  key: string;
  name: string;
  symbol: string;
  image: string | null;
  priceUsd: number | null;
  change24h: number | null;
  marketCap: number | null;
  volume24hUsd: number | null;
  high24h: number | null;
  low24h: number | null;
}

export interface CrFundingRound {
  date: string | null;
  type: string | null;
  raiseUsd: number | null;
  valuationUsd: number | null;
  coinName: string | null;
  coinKey: string | null;
  coinIcon: string | null;
  funds: string[];
}

export interface CrUpcomingIco {
  name: string | null;
  symbol: string | null;
  key: string | null;
  platform: string | null;
  raiseUsd: number | null;
  date: string | null;
}

export interface CrEnvelope {
  kind: CrMode;
  upstream: string;
  fetchedAt: number;
  cache: string;
  /** Row count in this payload. */
  count: number;
  /** Full upstream table size when the page states it (trending: 266). */
  upstreamTotal?: number | null;
  /** Slice provenance: homepage slices are partial BY DESIGN (see header). */
  slice?: string;
  /** How change24h was obtained for this payload. */
  changeSource?: 'direct' | 'derived-from-histPrices-24H' | 'unavailable';
  global?: CrGlobal;
  fundingRounds?: CrFundingRound[];
  upcomingIco?: CrUpcomingIco[];
  rows?: (CrCoin | CrTrendingRow)[];
}
