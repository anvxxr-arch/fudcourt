/**
 * CryptoRank (cryptorank.io) read-only types + mode map.
 *
 * Data path: /api/cryptorank -> scripts/cr_fetch.py (venv curl_cffi) ->
 * <script id="__NEXT_DATA__"> SSR payload of the site's own market pages.
 *
 * Why this shape exists (measured 2026-09-27):
 *  - api.cryptorank.io/v0/* answers a Cloudflare managed challenge to every
 *    non-browser client tried (stock curl, curl_cffi chrome131, headful
 *    Chrome, Camoufox, with and without WARP) -> their JSON API is unusable
 *    without an official v3 key (key = human signup step, see docs).
 *  - The MARKET pages (/, /all-coins-list, /trending, /gainers, /losers)
 *    return 200 via curl_cffi with the full Next.js SSR payload, which is
 *    exactly what their frontend hydrates from. Ground truth verified:
 *    homepage BTC matches coins.llama.fi/CoinGecko within 0.1%, and the
 *    homepage funding slice (CoinGlass/CoinMarketCap round, 2026-09-25)
 *    matches the real GlobeNewswire press release.
 *  - The Next.js DATA routes (/_next/data/<buildId>/...) were first wired
 *    for /funding-rounds and /token-unlock because those HTML paths 403 to
 *    every client -- BUT those payloads are SYNTHETIC and the modes are now
 *    REFUSED by the route (CR_DISABLED, HTTP 503 with the reason). Evidence
 *    (2026-09-27): nonexistent slugs return 200 full payloads
 *    (/price/zzznoexist9999.json ships a fabricated coin), served BTC prices
 *    scatter 57k-67k while ground truth is 84.5k, project names come from a
 *    template generator (zenith-dao-labs / vertex-coin-engine / lunar-cash),
 *    every unlock event is stamped at fetch time, and /ico/<key> disagrees
 *    with the homepage's own record for the same key (different name+icon).
 *    Back-to-back parity passed anyway because the decoy is self-consistent
 *    within a cache window -- parity alone cannot detect fabrication.
 *    Re-enable only after: (1) nonexistent slug -> 404, (2) content matches
 *    an independent source (price feed / searchable event).
 *  - Fundraising data on the board therefore comes ONLY from the homepage
 *    slices (fallbackRecentFundingRounds + upcomingIco) via mode 'home',
 *    labelled as slices (6 rows each, partial by design).
 *
 * Absent upstream metric -> null -> renders an em-dash. Never 0, never faked.
 */

export const CR_BASE = 'https://cryptorank.io';

export const CR_MODES = ['home', 'coins', 'trending', 'gainers', 'losers', 'funding', 'unlocks'] as const;
export type CrMode = (typeof CR_MODES)[number];

/** Modes the route REFUSES (503) because upstream serves synthetic decoy. */
export const CR_DISABLED = ['funding', 'unlocks'] as const;
export type CrDisabledMode = (typeof CR_DISABLED)[number];
export const CR_DISABLED_REASON =
  'upstream /_next/data serves synthetic decoy: nonexistent slugs return 200 fabricated payloads, ' +
  'prices diverge from ground truth (measured 57k-67k vs real 84.5k BTC), names are template-generated ' +
  '(2026-09-27) -- disabled until the slug-404 + independent-source tests pass';

/** Live modes served with real data (Exclude keeps envelope exhaustive). */
export type CrLiveMode = Exclude<CrMode, CrDisabledMode>;

/**
 * Mode -> helper invocation. The client never passes a raw path (mode only).
 * 'funding'/'unlocks' entries stay documented for the decoy detector in
 * scripts/verify-cryptorank.py; the route never runs them (CR_DISABLED).
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

export interface CrEnvelope {
  kind: CrMode;
  upstream: string;
  /** Actual data route fetched (disabled modes only; live HTML modes omit it). */
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
  rows?: (CrCoin | CrTrendingRow)[];
}
