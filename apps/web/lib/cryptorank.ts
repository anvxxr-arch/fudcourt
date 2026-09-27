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
 *  - Fundraising data on the board comes from the homepage slices
 *    (fallbackRecentFundingRounds + upcomingIco via mode 'home', labelled as
 *    slices, 6 rows each) PLUS mode 'launchpool' (/past|/active|/upcoming-
 *    launchpool HTML, gated 2026-09-27: nonexistent path -> 404, past/
 *    upcoming date windows coherent, active windows all contain now, and
 *    the gno-land window matches KuCoin's official GemPool announcement
 *    2026-09-16 -> 2026-09-26) PLUS mode 'nodesale' (/past|/active|/
 *    /upcoming-nodesale: nonexistent -> 404, keys 3/3 match /price/<key>
 *    name+symbol, Fuse ember presale 2025-02-11 == Chainwire+Bitget).
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
  'launchpool',                    // event lists: /past|/active|/upcoming-launchpool
  'nodesale',                      // node sale lists: /past|/active|/upcoming-nodesale
  'news',                           // /news aggregator feed (links out to publishers)
  'tags', 'tag',                    // tag taxonomy index (182) + keyed coin detail
  'ecosystems', 'ecosystem',        // ecosystem index (106) + keyed detail
  'rwa', 'rwaasset',                // RWA index (209) + keyed type/slug detail
  'quarterly',                      // BTC/ETH quarterly returns (GATE2 vs CG daily)
  'prediction',                     // prediction-market aggregates + markets table
  'converter',                      // full price list: /converter (4,975 coins, price only)
  'media',                          // /media video aggregator (GATE3 = YT oembed match)
  'newstag',                        // /news/tag/<slug> filtered feed (soft-404 -> local 404)
  'aioverview',                     // /ai-market-overview upstream AI digest (coherence-gated)
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
  tag: (key: string) => `/tags/${key}`,
  ecosystem: (key: string) => `/ecosystems/${key}`,
  rwaasset: (key: string) => `/rwa/${key}`,   // key = '<plural-type>/<slug>'
  newstag: (key: string) => `/news/tag/${key}`, // soft-404: tag=null -> local 404, never unfiltered
} as const;
export type CrKeyedMode = keyof typeof CR_KEYED_PATHS;
export const CR_DEFAULT_KEYS: Record<CrKeyedMode, string> = {
  categories: 'chain',
  coin: 'bitcoin',
  chain: 'ethereum',
  tag: 'layer-1',
  ecosystem: 'ethereum',
  rwaasset: 'stocks/wendy-s',
  newstag: 'defi',
};

/** exchanges takes a STRICT whitelist key (paths contain '/', regex won't do). */
export const CR_EXCHANGE_LISTS = ['cex/spot', 'dex/spot', 'perpetuals', 'cex-transparency'] as const;
export type CrExchangeKey = (typeof CR_EXCHANGE_LISTS)[number];
export const CR_DEFAULT_EXCHANGE: CrExchangeKey = 'cex/spot';

/** launchpool event lists (paths contain no slug; strict whitelist). */
export const CR_LP_LISTS = ['past', 'upcoming', 'active'] as const;
export type CrLpKey = (typeof CR_LP_LISTS)[number];
export const CR_DEFAULT_LP: CrLpKey = 'past';

/**
 * Node sale event lists (paths contain no slug; strict whitelist).
 * Gates 2026-09-27: GATE1 /past-nodesale/zzz -> 404; cross-surface 3/3
 * keys match /price/<key> name+symbol; GATE3 = Chainwire+Bitget Fuse
 * Ember presale 2025-02-11 == row when=2025-02-11.
 */
export const CR_ND_LISTS = ['past', 'active', 'upcoming'] as const;
export type CrNdKey = (typeof CR_ND_LISTS)[number];
export const CR_DEFAULT_ND: CrNdKey = 'past';

export const CR_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * RWA detail keys are `<plural-type>/<slug>` (upstream path /rwa/stocks/wendy-s;
 * /rwa/<slug> alone 404s). Plural type set from the sitemap (bonds 16,
 * commodities 4, etfs 52, stocks 346).
 */
export const CR_RWA_TYPES = ['bonds', 'commodities', 'etfs', 'stocks'] as const;
export const CR_RWA_KEY_RE =
  /^(bonds|commodities|etfs|stocks)\/[a-z0-9][a-z0-9-]{0,63}$/;

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
  launchpool: ['--path', '/past-launchpool'],        // default variant; route overrides
  nodesale: ['--path', '/past-nodesale'],            // default variant; route overrides
  news: ['--path', '/news'],
  tags: ['--path', '/tags'],
  tag: ['--path', '/tags/layer-1'],              // default key; route overrides
  ecosystems: ['--path', '/ecosystems'],
  ecosystem: ['--path', '/ecosystems/ethereum'],  // default key; route overrides
  rwa: ['--path', '/rwa'],
  rwaasset: ['--path', '/rwa/stocks/wendy-s'],    // default key; route overrides
  quarterly: ['--path', '/charts/quarterly-returns'],
  prediction: ['--path', '/prediction-markets'],
  converter: ['--path', '/converter'],
  media: ['--path', '/media'],
  newstag: ['--path', '/news/tag/defi'],      // default key; route overrides
  aioverview: ['--path', '/ai-market-overview'],
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
  launchpool: `${CR_BASE}/past-launchpool`,
  nodesale: `${CR_BASE}/past-nodesale`,
  news: `${CR_BASE}/news`,
  tags: `${CR_BASE}/tags`,
  tag: `${CR_BASE}/tags/layer-1`,
  ecosystems: `${CR_BASE}/ecosystems`,
  ecosystem: `${CR_BASE}/ecosystems/ethereum`,
  rwa: `${CR_BASE}/rwa`,
  rwaasset: `${CR_BASE}/rwa/stocks/wendy-s`,
  quarterly: `${CR_BASE}/charts/quarterly-returns`,
  prediction: `${CR_BASE}/prediction-markets`,
  converter: `${CR_BASE}/converter`,
  media: `${CR_BASE}/media`,
  newstag: `${CR_BASE}/news/tag/defi`,
  aioverview: `${CR_BASE}/ai-market-overview`,
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
  /** cex-transparency variant only: reported proof-of-reserves (null elsewhere). */
  reservesUsd?: number | null;
  cleanReservesUsd?: number | null;
  stablecoinsPercent?: number | null;
  walletsCount?: number | null;
  auditorName?: string | null;
  auditDate?: string | null;
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

/**
 * News feed row (/news HTML: aggregator; every row links OUT to the original
 * publisher, verified against the publisher's own <title>). date = epoch-ms
 * upstream, ISO here; null upstream = pinned promo slot -> em-dash.
 */
export interface CrNewsRow {
  id: number | null;
  title: string;
  url: string | null;
  source: string | null;
  date: string | null;
  /** upstream sentiment tag. */
  status: 'bullish' | 'bearish' | null;
  readingMinutes: number | null;
  isAdvertisement: boolean;
  /** relatedCoins snapshot: symbol + upstream live price (llama-verified). */
  relatedCoins: { symbol: string; priceUsd: number | null; change24h: number | null }[];
}

/**
 * Launchpool event row (/past-launchpool | /upcoming-launchpool HTML).
 * when/till = upstream ISO window; null upstream = not announced -> em-dash.
 * SSR ships the first page only (?page= is NOT honored upstream -> honest
 * 'of N' label, never a page param that silently no-ops).
 */
export interface CrLaunchpoolRow {
  key: string;
  name: string;
  symbol: string;
  category: string | null;
  totalRaiseUsd: number | null;
  priceUsd: number | null;
  launchpads: string[];
  when: string | null;
  till: string | null;
}

/**
 * Node sale row (/past|/active|/upcoming-nodesale HTML).
 * when/till = upstream ISO window (null = not announced/ongoing -> em-dash);
 * nodePriceFrom/To = upstream node tier price range in USD (NOT market price).
 * SSR ships one page only, upstream ignores ?page= -> honest 'of N' label.
 */
export interface CrNodeSaleRow {
  key: string;
  name: string;
  symbol: string;
  image: string | null;
  category: string | null;
  when: string | null;
  till: string | null;
  nodePriceFromUsd: number | null;
  nodePriceToUsd: number | null;
  raiseUsd: number | null;
  totalRaiseUsd: number | null;
}

/**
 * Ecosystem index row (/ecosystems HTML: 106 ecosystems, SSR page-1 slice).
 * mcap/tvl + 24h changes are upstream's OWN ecosystem aggregates.
 */
export interface CrEcosystemRow {
  key: string;
  name: string;
  logo: string | null;
  projects: number | null;
  projectsChange3m: number | null;
  marketCapUsd: number | null;
  marketCapChange24hPct: number | null;
  tvlUsd: number | null;
  tvlChange24hPct: number | null;
  tags: string[];
}

/** Ecosystem detail meta (/ecosystems/<key> HTML; coin = native coin quote). */
export interface CrEcosystemInfo {
  slug: string;
  name: string;
  description: string | null;
  blockchain: { key: string; name: string } | null;
  coin: {
    key: string;
    name: string;
    symbol: string;
    priceUsd: number | null;
    change24h: number | null;
  } | null;
}

/**
 * RWA index row (/rwa HTML: 25 of 209, SSR page 1).
 * detailKey = plural-type/slug built upstream-side (commodity -> commodities);
 * upstream /rwa/<slug> alone 404s — the type segment is mandatory.
 */
export interface CrRwaRow {
  rank: number | null;
  slug: string;
  detailKey: string;
  ticker: string;
  name: string;
  type: string;
  image: string | null;
  priceUsd: number | null;
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
}

/** RWA asset detail (/rwa/<plural-type>/<slug> HTML). */
export interface CrRwaAsset {
  slug: string;
  detailKey: string;
  ticker: string;
  name: string;
  type: string;
  image: string | null;
  priceUsd: number | null;
  change24h: number | null;
  change24hAbs: number | null;
  marketState: string | null;
  currency: string | null;
  quoteUpdatedAt: string | null;
  isLeveraged: boolean;
  country: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  website: string | null;
}

/** One quarter's upstream open/close (UI computes return% and labels it). */
export interface CrQuarterQ {
  openUsd: number | null;
  closeUsd: number | null;
  isFull: boolean;
}

export interface CrQuarterlyYear {
  year: number | null;
  q1: CrQuarterQ | null;
  q2: CrQuarterQ | null;
  q3: CrQuarterQ | null;
  q4: CrQuarterQ | null;
}

/** Prediction-market aggregates (upstream window NOT stated -> labelled). */
export interface CrPredictionAgg {
  totalVolumeUsd: number | null;
  volumeChangePct: number | null;
  marketsCount: number | null;
  marketsChangePct: number | null;
  openInterestUsd: number | null;
  oiChangePct: number | null;
  platforms: {
    platform: string;
    volumeUsd: number | null;
    marketsCount: number | null;
    openInterestUsd: number | null;
  }[];
}

/** Prediction-market row (/prediction-markets tableFallbackData page 1). */
export interface CrPredictionRow {
  id: string;
  title: string;
  platform: string | null;
  category: string | null;
  endDate: string | null;
  volume24hUsd: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  externalUrl: string | null;
}

/**
 * Tag index row (/tags HTML, 182 rows) — taxonomy DISTINCT from categories
 * (Layer 1 / PoW / Bitcoin Runes …): upstream ships per-tag breadth stats
 * plus avgPriceChange periods (their own tag average, not derived here).
 */
export interface CrTagRow {
  id: number | null;
  slug: string;
  name: string;
  description: string | null;
  marketCap: number | null;
  volume24h: number | null;
  dominance: number | null;
  gainers: number | null;
  losers: number | null;
  /** avgPriceChange['24H'] — upstream's own tag average. */
  change24h: number | null;
  /** top coins shown on the index card. */
  rankedCoins: { name: string; key: string | null }[];
}

/** Tag detail header (tags/<slug> HTML). */
export interface CrTagInfo {
  slug: string;
  name: string;
  subtitle: string | null;
}

/**
 * Converter list row (/converter initialCompactCoins): the ONLY no-key
 * surface shipping live price for ALL ~5k coins (top-100 covered by mode
 * 'coins'). Upstream field is `price`; renamed here. No 24h change ships.
 */
export interface CrConverterRow {
  key: string;
  name: string;
  symbol: string;
  icon: string | null;
  priceUsd: number | null;
}

/** Media aggregator row (/media, 10 of 468): id = YouTube video id. */
export interface CrMediaRow {
  id: string;
  title: string;
  channelTitle: string | null;
  /** ISO8601 as shipped. */
  publishedAt: string | null;
  durationSeconds: number | null;
  tags: string[];
}

/**
 * /ai-market-overview digest: summaries are cryptorank's OWN generated text
 * (labelled as theirs, never presented as ours). Structured slices (news/
 * rounds/activities/unlocks) are plain upstream rows. Coherence-gated in the
 * harness against mode 'home' (mcap/volume/dominance <= 0.5%).
 */
export interface CrAiOverview {
  market: { summary: string | null; updatedAt: string | null };
  news: { id: number | null; title: string; date: string | null; isBullish: boolean | null }[];
  funding: {
    summary: string | null;
    rounds: { key: string | null; name: string; stage: string | null; raisedUsd: number | null }[];
  };
  dropHunting: {
    summary: string | null;
    activities: { key: string; type: string | null; coinName: string | null }[];
  };
  vesting: {
    summary: string | null;
    unlocks: { date: string | null; unlockPercent: number | null; coinName: string | null }[];
  };
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
  /** tags index mode: full upstream tag list (feeds the selector). */
  tagRows?: CrTagRow[];
  /** tag detail mode: tag header. */
  tag?: CrTagInfo;
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
  /** launchpool mode: event rows (50-of-527 past / full upcoming). */
  launchpoolRows?: CrLaunchpoolRow[];
  /** nodesale mode: node sale rows (66 past / 5 active / 1 upcoming slice). */
  nodesaleRows?: CrNodeSaleRow[];
  /** ecosystems mode: ecosystem index rows (20 of 106 SSR page-1 slice). */
  ecosystemRows?: CrEcosystemRow[];
  /** ecosystem mode: detail meta; coins ship via `rows` (no price upstream). */
  ecosystem?: CrEcosystemInfo;
  /** rwa mode: asset index rows (25 of 209 SSR page-1 slice). */
  rwaRows?: CrRwaRow[];
  /** rwaasset mode: one asset's detail card. */
  rwaAsset?: CrRwaAsset;
  /** quarterly mode: BTC + ETH yearly quarter open/close tables. */
  quarterlyBtc?: CrQuarterlyYear[];
  quarterlyEth?: CrQuarterlyYear[];
  /** prediction mode: platform aggregates + markets table (20 of ~71k). */
  prediction?: CrPredictionAgg;
  predictionRows?: CrPredictionRow[];
  /** news mode: latest items (first page only; ?page= is a no-op upstream). */
  newsRows?: CrNewsRow[];
  /** converter mode: full price list (all coins with live price, price only). */
  converterRows?: CrConverterRow[];
  /** media mode: video rows (10 of 468 SSR slice; id = YouTube video id). */
  mediaRows?: CrMediaRow[];
  /** newstag mode: related-tag chips shipped on the tag page. */
  relatedTags?: { slug: string; name: string }[];
  /** aioverview mode: upstream AI digest sections (their generated text). */
  aiOverview?: CrAiOverview;
  rows?: (CrCoin | CrTrendingRow | CrExchangeRow)[];
}
