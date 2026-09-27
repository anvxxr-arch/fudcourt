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

export const CR_MODES = [
  'home', 'coins', 'trending', 'gainers', 'losers',
  'funding', 'unlocks',            // REFUSED (synthetic data-route class)
  'categories', 'exchanges', 'coin', // live HTML class, 3-gate verified
  'listings',                      // /listings HTML, gate2 majors 0.7%
  'blockchains', 'chain',          // chain index (278) + keyed ecosystem detail
] as const;
export type CrMode = (typeof CR_MODES)[number];

/**
 * Keyed live modes: the route takes ?key=<slug> (validated CR_KEY_RE, never
 * clamped -- bad format 400, honest upstream miss 404 passthrough).
 * All three keyed families passed the 3-gate decoy detector on 2026-09-27:
 * nonexistent slug -> 404, prices within 0.002-0.25% of coins.llama.fi,
 * cross-surface agreement with the homepage.
 */
export const CR_KEYED_PATHS = {
  categories: (key: string) => `/categories/${key}`,
  coin: (key: string) => `/price/${key}`,
  chain: (key: string) => `/blockchains/${key}`,
} as const;
export type CrKeyedMode = keyof typeof CR_KEYED_PATHS;
export const CR_DEFAULT_KEYS: Record<CrKeyedMode, string> = {
  categories: 'chain',
  coin: 'bitcoin',
  chain: 'ethereum',
};

/** exchanges takes a STRICT whitelist key (paths contain '/', regex won't do). */
export const CR_EXCHANGE_LISTS = ['cex/spot', 'dex/spot', 'perpetuals'] as const;
export type CrExchangeKey = (typeof CR_EXCHANGE_LISTS)[number];
export const CR_DEFAULT_EXCHANGE: CrExchangeKey = 'cex/spot';
export const CR_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 28 overview categories (sitemap: 84 URLs = these x {overview,ath,performance}). */
export const CR_CATEGORY_SLUGS = [
  'predictionmarkets', 'blockchain-infrastructure', 'chain', 'blockchain-service',
  'gamefi', 'social', 'stablecoin', 'currency', 'defi', 'exchange',
  'non-fungible-tokens-nft', 'meme', 'ce-fi', 'payments', 'wallet',
  'tokenizedassets', 'rwa', 'depin', 'launchpad', 'interoperability',
  'miningandcompute', 'compliance', 'dataanalytics', 'ai', 'liquidstaking',
  'brokerage', 'treasure', 'privacy',
] as const;

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
  categories: ['--path', '/categories/chain'],      // default key; route overrides
  exchanges: ['--path', '/exchanges/cex/spot'],     // default key; route overrides
  coin: ['--path', '/price/bitcoin'],               // default key; route overrides
  listings: ['--path', '/listings'],
  blockchains: ['--path', '/blockchains'],
  chain: ['--path', '/blockchains/ethereum'],        // default key; route overrides
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
  categories: `${CR_BASE}/categories/chain`,
  exchanges: `${CR_BASE}/exchanges/cex/spot`,
  coin: `${CR_BASE}/price/bitcoin`,
  listings: `${CR_BASE}/listings`,
  blockchains: `${CR_BASE}/blockchains`,
  chain: `${CR_BASE}/blockchains/ethereum`,
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
  /** listings widget only: derived from histPrices['7D'] anchor. */
  change7d?: number | null;
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

/** Exchange ranking row (exchanges/cex/spot HTML: 50 rows, reported volume). */
export interface CrExchangeRow {
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
}

/** Per-coin detail card (/price/<key> HTML: coin + priceStatistics). */
export interface CrCoinDetail {
  key: string;
  name: string;
  symbol: string;
  image: string | null;
  priceUsd: number | null;
  /** Derived from histPrices['24H'].USD anchor; labelled in envelope. */
  change24h: number | null;
  marketCap: number | null;
  fullyDilutedMarketCap: number | null;
  volume24h: number | null;
  availableSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  circulatingPct: number | null;
  athUsd: number | null;
  athDate: string | null;
  atlUsd: number | null;
  atlDate: string | null;
  fromAthPct: number | null;
  fromAtlPct: number | null;
  listingDate: string | null;
  lifeCycle: string | null;
  rank: number | null;
}

/** Chain index row (/blockchains HTML: 278 chains). */
export interface CrChainRow {
  slug: string;
  name: string;
  image: string | null;
  network: string | null;
  explorerUrl: string | null;
  marketCap: number | null;
}

/** Chain detail meta (blockchains/<slug> HTML: blockchain dict). */
export interface CrChainInfo {
  slug: string;
  name: string;
  network: string | null;
  marketCap: number | null;
  explorerUrl: string | null;
  ecosystem: string | null;
}

/** Category header (categories/<slug> HTML). */
export interface CrCategoryInfo {
  slug: string;
  name: string;
  gainers: number | null;
  losers: number | null;
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
  category?: CrCategoryInfo;
  detail?: CrCoinDetail;
  chain?: CrChainInfo;
  /** blockchains index mode: full upstream chain list. */
  chainRows?: CrChainRow[];
  /** listings mode: three independent 20-row widgets. */
  listings?: {
    recentlyAdded: CrCoin[];
    mostSearched: CrCoin[];
    mostVisited: CrCoin[];
  };
  rows?: (CrCoin | CrTrendingRow | CrExchangeRow)[];
}
