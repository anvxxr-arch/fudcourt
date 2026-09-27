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
 *    /insights, /drophunting) 403s as HTML to every client including real
 *    browsers -- BUT their Next.js data routes
 *    /_next/data/<buildId>/funding-rounds.json and .../token-unlock.json
 *    answer 200 with the full pageProps (fallbackRounds / fallbackData).
 *    Those power the 'funding' and 'unlocks' modes; each ships a 20-row
 *    SSR sample whose total/ordering varies between fetches upstream, so the
 *    envelope labels them as samples and stamps fetchedAt -- never "the
 *    latest N of exactly M".
 *  - /ico/<key> data routes exist but their investor/valuation totals shift
 *    between fetches (measured 47.5M -> 27.7M for the same project) ->
 *    deliberately NOT wired to any mode (see scripts/verify-cryptorank.py
 *    informational probe).
 *
 * Absent upstream metric -> null -> renders an em-dash. Never 0, never faked.
 */

export const CR_BASE = 'https://cryptorank.io';

export const CR_MODES = ['home', 'coins', 'trending', 'gainers', 'losers', 'funding', 'unlocks'] as const;
export type CrMode = (typeof CR_MODES)[number];

/**
 * Mode -> helper invocation. The client never passes a raw path (mode only);
 * 'funding'/'unlocks' go through the Next.js DATA route
 * /_next/data/<buildId>/... because their HTML paths 403 to every client
 * while the data routes answer 200 (measured 2026-09-27).
 */
export const CR_MODE_ARGS: Record<CrMode, [flag: '--path' | '--data-route', value: string]> = {
  home: ['--path', '/'],
  coins: ['--path', '/all-coins-list'],
  trending: ['--path', '/trending'],
  gainers: ['--path', '/gainers'],
  losers: ['--path', '/losers'],
  funding: ['--data-route', '/funding-rounds'],
  unlocks: ['--data-route', '/token-unlock'],
};

/** Canonical HTML URL of what a mode's data represents (for the envelope). */
export const CR_MODE_UPSTREAM: Record<CrMode, string> = {
  home: `${CR_BASE}/`,
  coins: `${CR_BASE}/all-coins-list`,
  trending: `${CR_BASE}/trending`,
  gainers: `${CR_BASE}/gainers`,
  losers: `${CR_BASE}/losers`,
  funding: `${CR_BASE}/funding-rounds`,
  unlocks: `${CR_BASE}/token-unlock`,
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

/** Funding-board row (20-row SSR sample; slim: no amounts upstream-side). */
export interface CrFundingBoardRow {
  date: string | null;
  name: string | null;
  symbol: string | null;
  key: string | null;
  image: string | null;
  twitterScore: number | null;
}

/** Token-unlock row (20-row SSR sample of the upcoming-unlock schedule). */
export interface CrUnlockRow {
  date: string | null;
  name: string | null;
  symbol: string | null;
  key: string | null;
  image: string | null;
  priceUsd: number | null;
  change24h: number | null;
  marketCap: number | null;
  /** % of supply unlocking next event. */
  nextUnlockPct: number | null;
  nextUnlockTokens: number | null;
  nextAllocation: string | null;
  lockedPct: number | null;
  unlockedPct: number | null;
}

export interface CrEnvelope {
  kind: CrMode;
  upstream: string;
  /** Actual data route fetched (funding/unlocks only; HTML modes omit it). */
  dataRoute?: string;
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
  rows?: (CrCoin | CrTrendingRow | CrFundingBoardRow | CrUnlockRow)[];
}
