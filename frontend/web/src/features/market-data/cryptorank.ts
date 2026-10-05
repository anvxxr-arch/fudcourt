/**
 * CryptoRank (cryptorank.io) read-only types + mode map.
 *
 * Data path: /api/cryptorank (thin proxy, DR-005) -> backend/data (Go,
 * 127.0.0.1:3101) -> cryptorank.io <script id="__NEXT_DATA__"> SSR payload.
 * The Go service owns mode/key validation and the shaping; this file is the
 * TS-side mirror of its tables, and scripts/verify/check-contract.py fails the build
 * if the two ever disagree. tests/oracle/cr_fetch.py is no longer a runtime path --
 * it survives only as verify-cryptorank.py's independent oracle.
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
 * scripts/verify/verify-cryptorank.py; the route never runs them (CR_DISABLED).
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
  /** listings only: rows whose histPrices anchor upstream actually shipped, per widget.
   * Consumers assert derived-non-null counts EQUAL these (anti-fabrication + no missed derivation). */
  anchor24h?: { recentlyAdded: number; mostSearched: number; mostVisited: number };
  anchor7d?: { recentlyAdded: number; mostSearched: number; mostVisited: number };
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

/**
 * CryptoRank shapers: pure functions turning upstream __NEXT_DATA__ shapes
 * (HelperOut.pageProps / fallback rows) into the typed Cr* envelopes.
 *
 * Extracted verbatim from app/api/cryptorank/route.ts (SG-4.1) so the
 * deterministic fixture tests (scripts/tests/shaper-tests.ts) can import them
 * offline without loading the Next route module. No I/O here: the live data
 * path is the Go fudcourt-data sidecar (DR-005), and tests/oracle/cr_fetch.py survives
 * only as verify-cryptorank.py's independent oracle. See
 * scripts/fixtures/expected/ for this module's frozen envelope output.
 */

export type HelperOut = {
  ok: boolean;
  path?: string;
  status?: number;
  error?: string;
  pageProps?: Record<string, unknown>;
  fetchedAt?: number;
  cache?: string;
};
/* ------------------------------- shaping ------------------------------- */

export const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
/** Upstream ships some numerics as strings (token-unlock marketCap). */
export const asNumLoose = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
export const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** Upstream marks undisclosed names/types as '~'; render as absent (em-dash), not as a tilde. */
export const asStrOrDash = (v: unknown): string | null => {
  const s = asStr(v);
  return s === '~' ? null : s;
};
export const asPriceUsd = (v: unknown): number | null =>
  v && typeof v === 'object' ? asNum((v as Record<string, unknown>).USD) : asNum(v);

export type RawCoin = Record<string, unknown>;

export function shapeCoin(r: RawCoin, change24h: number | null): CrCoin {
  const category = r.category as { name?: unknown } | null;
  const ath = r.athPrice as Record<string, unknown> | null;
  const athDate = r.athMarketCap as Record<string, unknown> | null;
  return {
    rank: asNum(r.rank),
    key: asStr(r.key) ?? '',
    name: asStr(r.name) ?? asStr(r.fullName) ?? '',
    symbol: asStr(r.symbol) ?? '',
    image: asStr(r.image),
    priceUsd: asPriceUsd(r.price),
    marketCap: asNum(r.marketCap),
    volume24hUsd: asNum(r.volume24hUsd) ?? asNum(r.volume24h),
    category: category && typeof category.name === 'string' ? category.name : null,
    listingDate: asStr(r.listingDate),
    lifeCycle: asStr(r.lifeCycle),
    athUsd: ath ? asPriceUsd(ath) : null,
    change24h,
  };
}

/**
 * 24h change from upstream's own histPrices anchor: histPrices['24H'].USD is
 * the price 24h ago. Plain arithmetic on upstream fields -- labelled in the
 * envelope as derived, never presented as a native field.
 */
export function changeFromAnchor(r: RawCoin): number | null {
  const hist = r.histPrices as Record<string, Record<string, unknown>> | null;
  const anchor = hist?.['24H']?.USD;
  const now = (r.price as Record<string, unknown> | null)?.USD;
  const a = asNum(anchor);
  const n = asNum(now);
  if (a == null || n == null || a === 0) return null;
  return ((n - a) / a) * 100;
}

/** listings widgets: priceUsd may sit only in price.USD or only in priceUsd;
 * chg24h/chg7d derived from histPrices anchors where shipped, else null. */
export function shapeListing(r: RawCoin): CrCoin {
  const price = asPriceUsd(r.price) ?? asNum(r.priceUsd);
  const hist = (r.histPrices ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const chg = (period: string): number | null => {
    const a = asNum(hist[period]?.USD);
    return a !== null && price !== null && a !== 0 ? ((price - a) / a) * 100 : null;
  };
  return { ...shapeCoin(r, null), priceUsd: price, change24h: chg('24H'), change7d: chg('7D') };
}

/** /blockchains index row: slug/name/images/network/explorer. */
export function shapeChainRow(r: RawCoin): CrChainRow {
  const images = (r.images ?? {}) as Record<string, unknown>;
  return {
    slug: asStr(r.slug) ?? asStr(r.key) ?? '',
    name: asStr(r.name) ?? '',
    image: asStr(images.x60) ?? asStr(r.image),
    network: asStr(r.tokenPlatformName) ?? asStr(r.network),
    explorerUrl: asStr(r.explorerUrl),
    marketCap: asNum(r.marketCap),
  };
}

export function shapeGlobal(pp: Record<string, unknown>): CrGlobal {
  const init = (pp.initData ?? {}) as Record<string, unknown>;
  const g = (init.globalData ?? {}) as Record<string, unknown>;
  const gas = (g.gas ?? {}) as Record<string, unknown>;
  const avg = (gas.average ?? {}) as Record<string, unknown>;
  return {
    totalMarketCap: asNum(g.totalMarketCap),
    totalMarketCapChangePercent: asNum(g.totalMarketCapChangePercent),
    totalVolume24h: asNum(g.totalVolume24h),
    totalVolume24hChangePercent: asNum(g.totalVolume24hChangePercent),
    btcDominance: asNum(g.btcDominance),
    btcDominanceChangePercent: asNum(g.btcDominanceChangePercent),
    ethDominance: asNum(g.ethDominance),
    ethDominanceChangePercent: asNum(g.ethDominanceChangePercent),
    allCurrencies: asNum(g.allCurrencies),
    gasGwei: asNum(avg.gasPriceGwei),
  };
}

export function shapeFunding(r: Record<string, unknown>): CrFundingRound {
  const coin = (r.coin ?? {}) as Record<string, unknown>;
  const funds = Array.isArray(r.funds) ? (r.funds as Record<string, unknown>[]) : [];
  return {
    date: asStrOrDash(r.date),
    type: asStrOrDash(r.type),
    raiseUsd: asNum(r.raise),
    valuationUsd: asNum(r.valuation),
    coinName: asStrOrDash(coin.name),
    coinKey: asStr(coin.key),
    coinIcon: asStr(coin.icon),
    funds: funds.map((f) => asStrOrDash(f.name)).filter((n): n is string => n != null),
  };
}

export function shapeIco(r: Record<string, unknown>): CrUpcomingIco {
  const coin = (r.coin ?? {}) as Record<string, unknown>;
  const platform = (r.platform ?? {}) as Record<string, unknown>;
  return {
    name: asStrOrDash(coin.name),
    symbol: asStrOrDash(coin.symbol),
    key: asStr(coin.key),
    platform: asStrOrDash(platform.name),
    raiseUsd: asNum(r.raise),
    date: asStr(r.date),
  };
}

export function shapeTrending(r: RawCoin): CrTrendingRow {
  return {
    rank: asNum(r.rank),
    key: asStr(r.key) ?? '',
    name: asStr(r.name) ?? '',
    symbol: asStr(r.symbol) ?? '',
    image: asStr(r.image),
    priceUsd: asPriceUsd(r.price),
    change24h: asNum(r.priceChange24h),
    marketCap: asNum(r.marketCap),
    volume24hUsd: asNum(r.volume24hUsd) ?? asNum(r.volume24h),
    high24h: asNum(r.highPrice24h),
    low24h: asNum(r.lowPrice24h),
  };
}

/** exchanges/cex/spot HTML: fallbackData, 50 rows, cryptorank REPORTED volume. */
export function shapeExchange(r: Record<string, unknown>, i: number): CrExchangeRow {
  const volumes = (r.volumes ?? {}) as Record<string, Record<string, number>>;
  const day = (volumes.day ?? {}) as Record<string, number>;
  const week = (volumes.week ?? {}) as Record<string, number>;
  const month = (volumes.month ?? {}) as Record<string, number>;
  return {
    rank: i + 1,
    key: typeof r.key === 'string' ? r.key : '',
    name: typeof r.name === 'string' ? r.name : '',
    image: typeof r.icon === 'string' ? r.icon : null,
    dayVolUsd: asNum(day.toUSD),
    weekVolUsd: asNum(week.toUSD),
    monthVolUsd: asNum(month.toUSD),
    percentVolume: asNum(r.percentVolume),
    pairsCount: asNum(r.pairsCount),
    currenciesCount: asNum(r.currenciesCount),
    exchangeType: typeof r.exchangeType === 'string' ? r.exchangeType : null,
  };
}

/** /price/<key> HTML: coin + priceStatistics + histPrices anchor for 24h. */
export function shapeCoinDetail(pp: Record<string, unknown>, key: string): CrCoinDetail {
  const coin = (pp.coin ?? {}) as Record<string, unknown>;
  const stats = (pp.priceStatistics ?? {}) as Record<string, unknown>;
  const hist = (coin.histPrices ?? {}) as Record<string, { USD?: number } | undefined>;
  const hist24 = hist['24H'];
  const p24 = asNum(hist24?.USD);
  const price = asPriceUsd(coin.price);
  const change24h =
    p24 !== null && price !== null && p24 !== 0 ? ((price - p24) / p24) * 100 : null;
  const ath = asPriceUsd(stats.athPrice);
  const atl = asPriceUsd(stats.atlPrice);
  return {
    key,
    name: typeof coin.name === 'string' ? coin.name : '',
    symbol: typeof coin.symbol === 'string' ? coin.symbol : '',
    image: typeof coin.image === 'string' ? coin.image : null,
    priceUsd: price,
    change24h,
    marketCap: asNum(stats.marketCap ?? coin.marketCap),
    fullyDilutedMarketCap: asNum(stats.fullyDilutedMarketCap),
    volume24h: asNum(stats.volume24h ?? coin.volume24h),
    availableSupply: asNum(stats.availableSupply),
    totalSupply: asNum(stats.totalSupply),
    maxSupply: asNum(stats.maxSupply),
    circulatingPct: asNum(stats.availableSupplyPercent),
    athUsd: ath,
    athDate: typeof stats.athPriceDate === 'string' ? stats.athPriceDate : null,
    atlUsd: atl,
    atlDate: typeof stats.atlPriceDate === 'string' ? stats.atlPriceDate : null,
    fromAthPct: asNum(stats.fromAthPrice),
    fromAtlPct: asNum(stats.fromAtlPrice),
    listingDate: typeof stats.listingDate === 'string' ? stats.listingDate : null,
    lifeCycle: typeof coin.lifeCycle === 'string' ? coin.lifeCycle : null,
    rank: asNum(coin.rank ?? coin.cRank),
  };
}

export function envelope(
  kind: CrLiveMode,
  h: HelperOut,
  opts: { key?: string; upstream?: string } = {},
): CrEnvelope {
  const pp = (h.pageProps ?? {}) as Record<string, unknown>;
  const base = {
    kind,
    upstream: opts.upstream ?? CR_MODE_UPSTREAM[kind],
    fetchedAt: h.fetchedAt ?? Math.floor(Date.now() / 1000),
    cache: h.cache ?? 'MISS',
  };

  if (kind === 'home') {
    const fundingRaw = Array.isArray(pp.fallbackRecentFundingRounds)
      ? (pp.fallbackRecentFundingRounds as Record<string, unknown>[])
      : [];
    const icoRaw = Array.isArray(pp.upcomingIco) ? (pp.upcomingIco as Record<string, unknown>[]) : [];
    return {
      ...base,
      count: fundingRaw.length + icoRaw.length,
      slice:
        `homepage slice: ${fundingRaw.length} most recent rounds + ${icoRaw.length} upcoming IDOs; ` +
        'the full fundraising boards (/funding-rounds, /ico*) are WAF-challenged to every non-browser client',
      global: shapeGlobal(pp),
      fundingRounds: fundingRaw.map(shapeFunding),
      upcomingIco: icoRaw.map(shapeIco),
    };
  }

  if (kind === 'coins') {
    const coins = Array.isArray(pp.coins) ? (pp.coins as RawCoin[]) : [];
    return {
      ...base,
      count: coins.length,
      upstreamTotal: coins.length,
      changeSource: 'unavailable',
      rows: coins.map((r) => shapeCoin(r, null)),
    };
  }

  if (kind === 'trending') {
    const table = (pp.fallbackTableData ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(table.data) ? (table.data as RawCoin[]) : [];
    return {
      ...base,
      count: rows.length,
      upstreamTotal: asNum(table.total) ?? rows.length,
      changeSource: 'direct',
      rows: rows.map(shapeTrending),
    };
  }

  if (kind === 'categories') {
    const fallbackCoins = pp.fallbackCoins;
    if (!Array.isArray(fallbackCoins)) {
      throw new Error('categories: missing fallbackCoins');
    }
    const cat = (pp.category ?? {}) as Record<string, unknown>;
    const gl = (pp.gainersLosersData ?? {}) as Record<string, number>;
    const info: CrCategoryInfo = {
      slug: opts.key ?? 'chain',
      name: typeof cat.name === 'string' ? cat.name : (opts.key ?? 'chain'),
      gainers: asNum(gl.gainers),
      losers: asNum(gl.losers),
    };
    const catRows = fallbackCoins.map((r) => shapeCoin(r, null));
    // change24h: category fallbackCoins carry NO hist anchor -> unavailable
    // upstream, so every row renders null and the board labels it.
    return {
      ...base,
      count: catRows.length,
      slice: `category '${info.slug}' overview — ${catRows.length} coins by mcap; category breadth gainers ${info.gainers ?? '—'} / losers ${info.losers ?? '—'}`,
      changeSource: 'unavailable',
      category: info,
      rows: catRows,
    };
  }

  if (kind === 'exchanges') {
    const fd = pp.fallbackData;
    if (!Array.isArray(fd)) {
      throw new Error('exchanges: missing fallbackData');
    }
    if (opts.key === 'cex-transparency') {
      // Reserve-transparency rows carry NO volume fields (different schema):
      // volume stays null (honest), reserves map to their own columns.
      const trRows: CrExchangeRow[] = fd.map((r, i) => ({
        rank: i + 1,
        key: asStr(r.key) ?? '',
        name: asStr(r.name) ?? '',
        image: asStr(r.icon),
        dayVolUsd: null,
        weekVolUsd: null,
        monthVolUsd: null,
        percentVolume: null,
        pairsCount: null,
        currenciesCount: null,
        exchangeType: null,
        reservesUsd: asNum(r.reserves),
        cleanReservesUsd: asNum(r.cleanReserves),
        stablecoinsPercent: asNum(r.stablecoinsPercent),
        walletsCount: asNum(r.walletsCount),
        auditorName: asStr(r.auditorName),
        auditDate: asStr(r.auditDate),
      }));
      return {
        ...base,
        count: trRows.length,
        slice: `${trRows.length} exchanges with published reserve wallets — cryptorank reported proof-of-reserves (their aggregation, NOT an independent attestation); 12/14 keys cross-check against their own spot list; volume absent on this surface (null, never 0)`,
        rows: trRows,
      };
    }
    const exRows = fd.map((r, i) => shapeExchange(r, i));
    const variant =
      opts.key === 'dex/spot' ? 'DEX spot' : opts.key === 'perpetuals' ? 'perpetuals (futures)' : 'spot CEX';
    return {
      ...base,
      count: exRows.length,
      slice: `top ${exRows.length} ${variant} — cryptorank's OWN reported 24h volume (their methodology, not independent); per-row % share of listed total`,
      rows: exRows,
    };
  }

  if (kind === 'listings') {
    const ra = pp.recentlyAddedCoins;
    const ms = pp.mostSearchedCoins;
    const mv = pp.mostVisitedCoins;
    if (!Array.isArray(ra) || !Array.isArray(ms) || !Array.isArray(mv)) {
      throw new Error('listings: missing widget arrays');
    }
    // How many rows upstream actually shipped a usable anchor for -- the same
    // condition shapeListing() derives with. Reported per widget so consumers
    // (the harness) can assert non-null == anchors: a world-state-proof
    // equality that catches both missed derivation and fabrication. Measured
    // 2026-09-28: a freshly-landed recentlyAdded batch (<24h old) ships no
    // '24H' key at all -> 0 anchors, 0 derived, 0 == 0.
    const anchorCount = (rows: unknown[], period: string): number => {
      let n = 0;
      for (const row of rows) {
        const hp = ((row as { histPrices?: Record<string, Record<string, unknown>> | null }).histPrices ?? {}) as Record<string, Record<string, unknown> | undefined>;
        const a = asNum(hp[period]?.USD);
        if (a !== null && a !== 0) n += 1;
      }
      return n;
    };
    const cov = (period: string) => ({
      recentlyAdded: anchorCount(ra, period),
      mostSearched: anchorCount(ms, period),
      mostVisited: anchorCount(mv, period),
    });
    return {
      ...base,
      count: ra.length + ms.length + mv.length,
      slice:
        `three /listings widgets: ${ra.length} recently added + ${ms.length} most searched + ${mv.length} most visited; ` +
        'chg24h/chg7d derived from histPrices["24H"]/["7D"] anchors where the widget ships them, em-dash otherwise; ' +
        'anchor24h/anchor7d report how many rows upstream shipped each anchor (derived count must equal them)',
      changeSource: 'derived-from-histPrices-24H',
      anchor24h: cov('24H'),
      anchor7d: cov('7D'),
      listings: {
        recentlyAdded: ra.map(shapeListing),
        mostSearched: ms.map(shapeListing),
        mostVisited: mv.map(shapeListing),
      },
    };
  }

  if (kind === 'coin') {
    if (!pp.coin) {
      throw new Error('coin: missing pageProps.coin');
    }
    const detail = shapeCoinDetail(pp, opts.key ?? 'bitcoin');
    return {
      ...base,
      count: 1,
      slice: `coin detail '${detail.key}' — price from page payload; change24h derived from histPrices['24H'] anchor`,
      changeSource: 'derived-from-histPrices-24H',
      detail,
    };
  }

  if (kind === 'blockchains') {
    const chains = pp.blockchains;
    if (!Array.isArray(chains)) {
      throw new Error('blockchains: missing blockchains array');
    }
    const chainRows = chains.map((r) => shapeChainRow(r));
    return {
      ...base,
      count: chainRows.length,
      slice: `chain directory from /blockchains — ${chainRows.length} chains (slug feed for ?key= chain detail); explorer links are upstream's own`,
      chainRows,
    };
  }

  if (kind === 'chain') {
    const bc = (pp.blockchain ?? null) as Record<string, unknown> | null;
    const fc = pp.fallbackCoins;
    if (!bc || !Array.isArray(fc)) {
      throw new Error('chain: missing blockchain/fallbackCoins');
    }
    const info: CrChainInfo = {
      slug: opts.key ?? 'ethereum',
      name: asStr(bc.name) ?? (opts.key ?? 'ethereum'),
      network: asStr(bc.network),
      marketCap: asNum(bc.marketCap),
      explorerUrl: asStr(bc.explorerUrl),
      ecosystem: asStr(bc.ecosystem),
    };
    const chainCoins = fc.map((r) => shapeCoin(r, null));
    // change24h: ecosystem rows ship no hist anchor on this surface -> null
    return {
      ...base,
      count: chainCoins.length,
      upstreamTotal: chainCoins.length,
      slice:
        `chain '${info.slug}' ecosystem — ${chainCoins.length} tokens by mcap ` +
        '(native coin lives outside the ecosystem list upstream); chg columns unavailable, never faked',
      changeSource: 'unavailable',
      chain: info,
      rows: chainCoins,
    };
  }

  if (kind === 'launchpool') {
    const fd = pp.fallbackData as { data?: unknown; total?: unknown } | null;
    if (!fd || !Array.isArray(fd.data)) {
      throw new Error('launchpool: missing fallbackData.data');
    }
    const lpRows = (fd.data as Record<string, unknown>[]).map(shapeLaunchpoolRow);
    const total = typeof fd.total === 'number' ? fd.total : null;
    const variant = opts.key === 'upcoming' ? 'upcoming' : opts.key === 'active' ? 'active' : 'past';
    return {
      ...base,
      count: lpRows.length,
      upstreamTotal: total,
      slice:
        `${variant} launchpool events — ${lpRows.length} rows shown` +
        (total ? ` of ${total} upstream (SSR ships page 1 only; upstream ignores ?page=)` : '') +
        '; windows are upstream ISO dates, null = not announced (em-dash)',
      launchpoolRows: lpRows,
    };
  }

  if (kind === 'nodesale') {
    // nodesale pages ship `initialData` (launchpool uses `fallbackData`).
    const fd = (pp.initialData ?? pp.fallbackData) as {
      data?: unknown;
      total?: unknown;
    } | null;
    if (!fd || !Array.isArray(fd.data)) {
      throw new Error('nodesale: missing initialData/fallbackData.data');
    }
    const ndRows = (fd.data as Record<string, unknown>[]).map(shapeNodesaleRow);
    const total = typeof fd.total === 'number' ? fd.total : null;
    const variant = opts.key === 'upcoming' ? 'upcoming' : opts.key === 'active' ? 'active' : 'past';
    return {
      ...base,
      count: ndRows.length,
      upstreamTotal: total,
      slice:
        `${variant} node sales — ${ndRows.length} rows shown` +
        (total ? ` of ${total} upstream (SSR ships page 1 only; upstream ignores ?page=)` : '') +
        '; node prices are upstream tier ranges in USD (never market price); windows null = not announced (em-dash)',
      nodesaleRows: ndRows,
    };
  }

  if (kind === 'ecosystems') {
    const fe = pp.fallbackEcosystems as { data?: unknown; count?: unknown } | null;
    if (!fe || !Array.isArray(fe.data)) {
      throw new Error('ecosystems: missing fallbackEcosystems.data');
    }
    const ecoRows = (fe.data as Record<string, unknown>[]).map(shapeEcosystemRow);
    const count = typeof fe.count === 'number' ? fe.count : null;
    return {
      ...base,
      count: ecoRows.length,
      upstreamTotal: count,
      slice:
        `ecosystem index — ${ecoRows.length} of ${count ?? '?'} ecosystems ` +
        '(SSR ships page 1 only); mcap/tvl/change figures are cryptorank\'s OWN ' +
        'ecosystem aggregates (their methodology)',
      ecosystemRows: ecoRows,
    };
  }

  if (kind === 'ecosystem') {
    const fc = pp.fallbackCoins as { data?: unknown; count?: unknown } | null;
    if (!fc || !Array.isArray(fc.data)) {
      throw new Error('ecosystem: missing fallbackCoins.data');
    }
    const info = shapeEcosystemInfo(pp, opts.key ?? 'ethereum');
    const coinRows = (fc.data as Record<string, unknown>[]).map((r) =>
      shapeCoin(r, null),
    );
    const count = typeof fc.count === 'number' ? fc.count : null;
    return {
      ...base,
      count: coinRows.length,
      upstreamTotal: count,
      slice:
        `'${info.name}' ecosystem — ${coinRows.length} of ${count ?? '?'} coins ` +
        '(SSR page 1); eco rows carry NO price upstream -> chg columns null, never ' +
        'faked; native coin quote above is upstream\'s own',
      changeSource: 'unavailable',
      ecosystem: info,
      rows: coinRows,
    };
  }

  if (kind === 'rwa') {
    const af = pp.assetsFallback as { data?: unknown; total?: unknown } | null;
    if (!af || !Array.isArray(af.data)) {
      throw new Error('rwa: missing assetsFallback.data');
    }
    const rows = (af.data as Record<string, unknown>[]).map(shapeRwaRow);
    const total = typeof af.total === 'number' ? af.total : null;
    return {
      ...base,
      count: rows.length,
      upstreamTotal: total,
      slice:
        `RWA assets — ${rows.length} of ${total ?? '?'} upstream (SSR page 1); ` +
        'price = upstream quote (marketState may be CLOSED = last session close); ' +
        'tokenized* = cryptorank tokenized-asset metrics (their methodology)',
      rwaRows: rows,
    };
  }

  if (kind === 'rwaasset') {
    const af = pp.assetFallback as { data?: unknown } | null;
    if (!af || !af.data || typeof af.data !== 'object') {
      throw new Error('rwaasset: missing assetFallback.data');
    }
    const asset = shapeRwaAsset(
      af.data as Record<string, unknown>,
      opts.key ?? '',
    );
    return {
      ...base,
      count: 1,
      slice:
        `asset detail '${asset.ticker || asset.slug}' — upstream quote at ` +
        `${asset.quoteUpdatedAt ?? 'unknown time'} (marketState ${asset.marketState ?? '?'}); ` +
        'exchange/sector = upstream metadata',
      rwaAsset: asset,
    };
  }

  if (kind === 'quarterly') {
    const btc = pp.initialQuarterlyReturnsBtc;
    const eth = pp.initialQuarterlyReturnsEth;
    if (!Array.isArray(btc) || !Array.isArray(eth)) {
      throw new Error('quarterly: missing initialQuarterlyReturnsBtc/Eth');
    }
    return {
      ...base,
      count: btc.length + eth.length,
      slice:
        `BTC (${btc.length} years) + ETH (${eth.length} years) quarterly open/close — ` +
        'upstream values; return% is computed in the UI from these numbers (labelled); ' +
        'isFull=false = quarter in progress; 2026 closes verified vs independent ' +
        'daily history (0.03-0.40% on 2026-09-27)',
      quarterlyBtc: btc.map(shapeQuarterYear),
      quarterlyEth: eth.map(shapeQuarterYear),
    };
  }

  if (kind === 'prediction') {
    const { agg, rows } = shapePrediction(pp);
    const tb = pp.tableFallbackData as { total?: unknown } | null;
    const total = tb && typeof tb.total === 'number' ? tb.total : null;
    return {
      ...base,
      count: rows.length,
      upstreamTotal: total,
      prediction: agg,
      predictionRows: rows,
      slice:
        `prediction markets — ${rows.length} of ${total ?? '?'} listings (SSR page 1); ` +
        'volume/markets/OI aggregates + platform split are upstream figures (window NOT ' +
        'disclosed upstream); row volume24h is explicitly 24h; external links go to ' +
        'the venue (kalshi/polymarket)',
    };
  }

  if (kind === 'news') {
    const list = pp.news;
    if (!Array.isArray(list)) {
      throw new Error('news: missing news array');
    }
    const newsRows = list.map(shapeNewsRow);
    return {
      ...base,
      count: newsRows.length,
      slice:
        `${newsRows.length} latest items — links out to the original publishers; ` +
        'upstream ships the first page only (?page= is a no-op upstream); ' +
        'date null = pinned promo slot (em-dash); status = upstream sentiment tag',
      newsRows,
    };
  }

  if (kind === 'tags') {
    const list = pp.tags;
    if (!Array.isArray(list)) {
      throw new Error('tags: missing tags array');
    }
    const tagRows = list.map(shapeTagRow);
    return {
      ...base,
      count: tagRows.length,
      upstreamTotal: tagRows.length,
      slice:
        `${tagRows.length} tags (topic taxonomy, distinct from categories) — ` +
        'breadth stats + avgPriceChange are upstream tag averages; rankedCoins = index-card top coins',
      tagRows,
    };
  }

  if (kind === 'tag') {
    const tg = (pp.tag ?? null) as Record<string, unknown> | null;
    const coins = pp.coins;
    const gl = (pp.gainersLosersData ?? {}) as Record<string, number>;
    if (!tg || !Array.isArray(coins)) {
      throw new Error('tag: missing tag/coins');
    }
    const info: CrTagInfo = {
      slug: asStr(tg.slug) ?? (opts.key ?? 'layer-1'),
      name: asStr(tg.name) ?? (opts.key ?? 'layer-1'),
      subtitle: asStr(tg.subtitle),
    };
    const tagCoins = (coins as RawCoin[]).map((r) => shapeCoin(r, null));
    // change24h: measured 0/65 rows ship histPrices or priceChange24h on this
    // surface -> every row renders null and the board labels it upstream-absent.
    return {
      ...base,
      count: tagCoins.length,
      upstreamTotal: tagCoins.length,
      changeSource: 'unavailable',
      slice:
        `tag '${info.slug}' — ${tagCoins.length} coins by mcap; ` +
        `breadth ${gl.gainers ?? '—'} gainers / ${gl.losers ?? '—'} losers; ` +
        'chg columns absent upstream (measured), never faked',
      tag: info,
      rows: tagCoins,
    };
  }

  if (kind === 'converter') {
    const icc = pp.initialCompactCoins;
    if (!Array.isArray(icc)) {
      throw new Error('converter: missing initialCompactCoins');
    }
    const convRows: CrConverterRow[] = (icc as Record<string, unknown>[]).map((r) => ({
      key: asStr(r.key) ?? '',
      name: asStr(r.name) ?? '',
      symbol: asStr(r.symbol) ?? '',
      icon: asStr(r.icon),
      priceUsd: asNum(r.price),
    }));
    return {
      ...base,
      count: convRows.length,
      upstreamTotal: convRows.length,
      changeSource: 'unavailable',
      slice:
        `full price list — all ${convRows.length} coins with live price ` +
        '(converter page payload: /all-coins-list ships only the top 100); ' +
        'price only — no 24h change upstream (em-dash, never 0)',
      converterRows: convRows,
    };
  }

  if (kind === 'media') {
    const fd = pp.fallbackData as { data?: unknown; count?: unknown } | null;
    if (!fd || !Array.isArray(fd.data)) {
      throw new Error('media: missing fallbackData.data');
    }
    const mediaRows: CrMediaRow[] = (fd.data as Record<string, unknown>[]).map((r) => ({
      id: asStr(r.id) ?? '',
      title: asStr(r.title) ?? '',
      channelTitle: asStr(r.channelTitle),
      publishedAt: asStr(r.publishedAt),
      durationSeconds: asNum(r.durationSeconds),
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String).slice(0, 6) : [],
    }));
    const total = typeof fd.count === 'number' ? fd.count : null;
    return {
      ...base,
      count: mediaRows.length,
      upstreamTotal: total,
      changeSource: 'unavailable',
      slice:
        `video feed — ${mediaRows.length} of ${total ?? '?'} videos (SSR page 1 only); ` +
        'id = YouTube video id (ground truth: youtube oembed title+channel match, verified); ' +
        'duration/published straight from upstream',
      mediaRows,
    };
  }

  if (kind === 'newstag') {
    const tg = (pp.tag ?? null) as Record<string, unknown> | null;
    const list = pp.news;
    if (!tg || !Array.isArray(list)) {
      // GET maps tag=null to a real 404 before shaping; reaching here with a
      // missing array is a schema break, not a missing tag.
      throw new Error('newstag: missing news array');
    }
    const info: CrTagInfo = {
      slug: asStr(tg.key) ?? (opts.key ?? 'defi'),
      name: asStr(tg.name) ?? (opts.key ?? 'defi'),
      subtitle: null,
    };
    const newsRows = list.map(shapeNewsRow);
    const rel = Array.isArray(pp.tags)
      ? (pp.tags as Record<string, unknown>[])
          .map((t) => ({ slug: asStr(t.key) ?? '', name: asStr(t.name) ?? '' }))
          .filter((t) => t.slug)
      : [];
    return {
      ...base,
      count: newsRows.length,
      upstreamTotal: newsRows.length,
      slice:
        `articles tagged '${info.slug}' — ${newsRows.length} shown (upstream ships no tag total); ` +
        'unknown slugs are answered locally as 404 from upstream\'s tag=null soft-404 marker ' +
        '(never an unfiltered feed under a tag label); relatedCoins prices llama-verified',
      newsRows,
      tag: info,
      relatedTags: rel,
    };
  }

  if (kind === 'aioverview') {
    const ov = (pp.overviewData ?? null) as Record<string, unknown> | null;
    if (!ov) {
      throw new Error('aioverview: missing overviewData');
    }
    const market = (ov.market ?? {}) as Record<string, unknown>;
    const funding = (ov.fundingRound ?? {}) as Record<string, unknown>;
    const drop = (ov.dropHunting ?? {}) as Record<string, unknown>;
    const vest = (ov.vesting ?? {}) as Record<string, unknown>;
    const aiOverview: CrAiOverview = {
      market: {
        summary: asStr(market.aiSummary),
        updatedAt: asStr(market.updatedAt),
      },
      news: (Array.isArray(ov.news) ? (ov.news as Record<string, unknown>[]) : []).map((n) => ({
        id: asNum(n.id),
        title: asStr(n.title) ?? '',
        date: asStr(n.date),
        isBullish:
          typeof n.isBullish === 'boolean' ? n.isBullish : null,
      })),
      funding: {
        summary: asStr(funding.aiSummary),
        rounds: (Array.isArray(funding.rounds)
          ? (funding.rounds as Record<string, unknown>[])
          : []
        ).map((r) => ({
          key: asStr(r.key),
          name: asStr(r.name) ?? '',
          stage: asStr(r.stage),
          raisedUsd: asNum(r.raised),
        })),
      },
      dropHunting: {
        summary: asStr(drop.aiSummary),
        activities: (Array.isArray(drop.activities)
          ? (drop.activities as Record<string, unknown>[])
          : []
        ).map((a) => {
          const coin = (a.coin ?? null) as Record<string, unknown> | null;
          return {
            key: asStr(a.key) ?? '',
            type: asStr(a.type),
            coinName: coin ? asStr(coin.name) : null,
          };
        }),
      },
      vesting: {
        summary: asStr(vest.aiSummary),
        unlocks: (Array.isArray(vest.vesting)
          ? (vest.vesting as Record<string, unknown>[])
          : []
        ).map((v) => {
          const coin = (v.coin ?? null) as Record<string, unknown> | null;
          return {
            date: asStr(v.date),
            unlockPercent: asNum(v.unlockPercent),
            coinName: coin ? asStr(coin.name) : null,
          };
        }),
      },
    };
    return {
      ...base,
      count: aiOverview.news.length + aiOverview.funding.rounds.length +
        aiOverview.dropHunting.activities.length + aiOverview.vesting.unlocks.length,
      slice:
        'upstream AI digest — summaries are cryptorank\'s own generated text ' +
        '(their words, labelled as theirs); structured slices are plain rows; ' +
        'cross-surface coherence vs mode=home enforced in harness ' +
        '(mcap/volume/dominance <= 0.5%), CoinGecko total-cap sanity band 5%',
      aiOverview,
    };
  }

  // gainers / losers -- same upstream row shape, change derived from anchor
  const rows = Array.isArray(pp.fallbackData) ? (pp.fallbackData as RawCoin[]) : [];
  return {
    ...base,
    count: rows.length,
    upstreamTotal: rows.length,
    changeSource: 'derived-from-histPrices-24H',
    rows: rows.map((r) => shapeCoin(r, changeFromAnchor(r))),
  };
}

/**
 * Launchpool event row: upstream ships price as a STRING (coerce) and the
 * window as ISO strings (null = not announced -> null -> em-dash).
 */
export function shapeLaunchpoolRow(r: Record<string, unknown>): CrLaunchpoolRow {
  const cat = r.category as { name?: unknown } | null | undefined;
  const pads = Array.isArray(r.launchpads)
    ? (r.launchpads as { name?: unknown }[])
        .map((p) => asStr(p.name))
        .filter((n): n is string => n !== null)
    : [];
  const pv =
    typeof r.price === 'string' || typeof r.price === 'number'
      ? Number(r.price)
      : NaN;
  return {
    key: asStr(r.key) ?? '',
    name: asStr(r.name) ?? '',
    symbol: asStr(r.symbol) ?? '',
    category: cat ? asStr(cat.name) : null,
    totalRaiseUsd: asNum(r.totalRaise),
    priceUsd: Number.isFinite(pv) ? pv : null,
    launchpads: pads,
    when: asStr(r.when),
    till: asStr(r.till),
  };
}

/** Node sale row: nodePriceFrom/To = upstream tier range USD (not market price). */
export function shapeNodesaleRow(r: Record<string, unknown>): CrNodeSaleRow {
  const cat = r.category as { name?: unknown } | null | undefined;
  return {
    key: asStr(r.key) ?? '',
    name: asStr(r.name) ?? '',
    symbol: asStr(r.symbol) ?? '',
    image: asStr(r.image),
    category: cat ? asStr(cat.name) : null,
    when: asStr(r.when),
    till: asStr(r.till),
    nodePriceFromUsd: asNum(r.nodePriceFrom),
    nodePriceToUsd: asNum(r.nodePriceTo),
    raiseUsd: asNum(r.raise),
    totalRaiseUsd: asNum(r.totalRaise),
  };
}

/** Ecosystem index row: upstream aggregate fields (mcap/tvl are THEIR math). */
export function shapeEcosystemRow(r: Record<string, unknown>): CrEcosystemRow {
  const tags = Array.isArray(r.tags)
    ? (r.tags as unknown[])
        .map((t) => (typeof t === 'string' ? t : asStr((t as Record<string, unknown>)?.name)))
        .filter((t): t is string => t !== null && t !== undefined && t !== '')
    : [];
  return {
    key: asStr(r.key) ?? '',
    name: asStr(r.name) ?? '',
    logo: asStr(r.logo),
    projects: asNum(r.projects),
    projectsChange3m: asNum(r.projectsChange3M),
    marketCapUsd: asNum(r.marketCap),
    marketCapChange24hPct: asNum(r.marketCapChangePercent24H),
    tvlUsd: asNum(r.tvl),
    tvlChange24hPct: asNum(r.tvlChangePercent24H),
    tags,
  };
}

export function shapeEcosystemInfo(
  pp: Record<string, unknown>,
  slug: string,
): CrEcosystemInfo {
  const info = (pp.ecosystemData ?? {}) as Record<string, unknown>;
  const bc = info.blockchain as { key?: unknown; name?: unknown } | null | undefined;
  const coin = info.coin as Record<string, unknown> | null | undefined;
  return {
    slug,
    name: asStr(info.name) ?? slug,
    description: asStr(info.description),
    blockchain:
      bc && asStr(bc.key) !== null
        ? { key: asStr(bc.key) ?? '', name: asStr(bc.name) ?? asStr(bc.key) ?? '' }
        : null,
    coin:
      coin && asStr(coin.key) !== null
        ? {
            key: asStr(coin.key) ?? '',
            name: asStr(coin.name) ?? '',
            symbol: asStr(coin.symbol) ?? '',
            priceUsd: asNum(coin.priceUSD),
            change24h: asNum(coin.priceChangePercent24H),
          }
        : null,
  };
}

/** upstream detail path needs the PLURAL type segment (commodity -> commodities). */
export function rwaDetailKey(type: string, slug: string): string {
  const plural =
    type === 'commodity' ? 'commodities'
    : type === 'stock' ? 'stocks'
    : type === 'etf' ? 'etfs'
    : type === 'bond' ? 'bonds'
    : `${type}s`;
  return `${plural}/${slug}`;
}

export function shapeRwaRow(r: Record<string, unknown>): CrRwaRow {
  const slug = asStr(r.slug) ?? '';
  const type = asStr(r.type) ?? '';
  return {
    rank: asNum(r.rank),
    slug,
    detailKey: slug && type ? rwaDetailKey(type, slug) : '',
    ticker: asStr(r.ticker) ?? '',
    name: asStr(r.name) ?? '',
    type,
    image: asStr(r.image),
    priceUsd: asNum(r.price),
    change24h: asNum(r.change24h),
    change7d: asNum(r.change7d),
    marketCapUsd: asNum(r.marketCap),
    volume24hUsd: asNum(r.volume24h),
    tokenizedPriceUsd: asNum(r.tokenizedPrice),
    tokenizedMcapUsd: asNum(r.tokenizedMarketCap),
    tokenizedVolume24hUsd: asNum(r.tokenizedVolume24h),
    isLeveraged: r.isLeveraged === true,
    marketState: asStr(r.marketState),
    mainTokenKey: asStr(r.mainTokenKey),
  };
}

export function shapeRwaAsset(d: Record<string, unknown>, detailKey: string): CrRwaAsset {
  const info = (d.info ?? {}) as Record<string, unknown>;
  const slug = asStr(d.slug) ?? detailKey.split('/').pop() ?? '';
  const type = asStr(d.type) ?? '';
  return {
    slug,
    detailKey,
    ticker: asStr(d.ticker) ?? '',
    name: asStr(d.name) ?? '',
    type,
    image: asStr(d.image),
    priceUsd: asNum(d.price),
    change24h: asNum(d.change24h),
    change24hAbs: asNum(d.change24hAbs),
    marketState: asStr(d.marketState),
    currency: asStr(d.currency),
    quoteUpdatedAt: asStr(d.quoteUpdatedAt),
    isLeveraged: d.isLeveraged === true,
    country: asStr(info.country),
    exchange: asStr(info.exchange),
    sector: asStr(info.sector),
    industry: asStr(info.industry),
    website: asStr(info.website),
  };
}

export function shapeQuarterQ(q: unknown): CrQuarterQ | null {
  if (!q || typeof q !== 'object') return null;
  const q0 = q as Record<string, unknown>;
  return {
    openUsd: asNum(q0.openUSD),
    closeUsd: asNum(q0.closeUSD),
    isFull: q0.isFull !== false,
  };
}

export function shapeQuarterYear(y: unknown): CrQuarterlyYear {
  const y0 = (y ?? {}) as Record<string, unknown>;
  return {
    year: asNum(y0.year),
    q1: shapeQuarterQ(y0.q1),
    q2: shapeQuarterQ(y0.q2),
    q3: shapeQuarterQ(y0.q3),
    q4: shapeQuarterQ(y0.q4),
  };
}

/** Prediction aggregates: 3 responses, platformData merged by platform name. */
export function shapePrediction(
  pp: Record<string, unknown>,
): { agg: CrPredictionAgg; rows: CrPredictionRow[] } {
  const tv = (pp.totalVolumeResponse ?? {}) as Record<string, unknown>;
  const mk = (pp.marketsResponse ?? {}) as Record<string, unknown>;
  const oi = (pp.openInterestResponse ?? {}) as Record<string, unknown>;
  const byPlat: Record<string, CrPredictionAgg['platforms'][number]> = {};
  const addPlat = (
    list: unknown,
    field: 'volumeUsd' | 'marketsCount' | 'openInterestUsd',
    src: 'volume' | 'marketsCount' | 'openInterest',
  ) => {
    if (!Array.isArray(list)) return;
    for (const p of list as Record<string, unknown>[]) {
      const name = asStr(p.platform);
      if (!name) continue;
      const row = (byPlat[name] ??= {
        platform: name,
        volumeUsd: null,
        marketsCount: null,
        openInterestUsd: null,
      });
      const v = asNum(p[src]);
      if (field === 'volumeUsd') row.volumeUsd = v;
      else if (field === 'marketsCount') row.marketsCount = v;
      else row.openInterestUsd = v;
    }
  };
  addPlat(tv.platformData, 'volumeUsd', 'volume');
  addPlat(mk.platformData, 'marketsCount', 'marketsCount');
  addPlat(oi.platformData, 'openInterestUsd', 'openInterest');
  const agg: CrPredictionAgg = {
    totalVolumeUsd: asNum(tv.totalVolume),
    volumeChangePct: asNum(tv.changePercent),
    marketsCount: asNum(mk.totalMarketsCount),
    marketsChangePct: asNum(mk.changePercent),
    openInterestUsd: asNum(oi.totalOpenInterest),
    oiChangePct: asNum(oi.changePercent),
    platforms: Object.values(byPlat),
  };
  const tb = (pp.tableFallbackData ?? {}) as { data?: unknown };
  const rows: CrPredictionRow[] = (Array.isArray(tb.data) ? tb.data : []).map(
    (raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: asStr(r.id) ?? '',
        title: asStr(r.title) ?? '',
        platform: asStr(r.platform),
        category: asStr(r.categoryName),
        endDate: asStr(r.endDate),
        volume24hUsd: asNum(r.volume24h),
        bid: asNum(r.bid),
        ask: asNum(r.ask),
        spread: asNum(r.spread),
        externalUrl: asStr(r.externalUrl),
      };
    },
  );
  return { agg, rows };
}

/** News row: date is epoch MILLISECONDS upstream (null = pinned promo slot). */
export function shapeNewsRow(r: Record<string, unknown>): CrNewsRow {
  const ms = typeof r.date === 'number' && r.date > 1e12 ? r.date : null;
  const src = r.source as unknown;
  const status =
    r.status === 'bullish' || r.status === 'bearish' ? r.status : null;
  const rc = Array.isArray(r.relatedCoins)
    ? (r.relatedCoins as Record<string, unknown>[])
        .filter((c) => typeof c.symbol === 'string')
        .slice(0, 6)
        .map((c) => ({
          symbol: String(c.symbol),
          priceUsd: typeof c.price === 'number' ? c.price : null,
          change24h: typeof c.priceChange === 'number' ? c.priceChange : null,
        }))
    : [];
  return {
    id: typeof r.id === 'number' ? r.id : null,
    title: asStr(r.title) ?? '',
    url: asStr(r.url),
    source:
      typeof src === 'string'
        ? src
        : src && typeof src === 'object'
          ? asStr((src as { name?: unknown }).name)
          : null,
    date: ms === null ? null : new Date(ms).toISOString(),
    status,
    readingMinutes: asNum(r.readingTimeMinutes),
    isAdvertisement: r.isAdvertisement === true,
    relatedCoins: rc,
  };
}

/** Tag index row: avgPriceChange is upstream's own per-tag average. */
export function shapeTagRow(r: Record<string, unknown>): CrTagRow {
  const apc = (r.avgPriceChange ?? null) as Record<string, unknown> | null;
  const rc = Array.isArray(r.rankedCoins)
    ? (r.rankedCoins as Record<string, unknown>[])
        .slice(0, 4)
        .map((c) => ({
          name: asStr(c.name) ?? '',
          key: asStr(c.key),
        }))
    : [];
  return {
    id: typeof r.id === 'number' ? r.id : null,
    slug: asStr(r.slug) ?? '',
    name: asStr(r.name) ?? (asStr(r.slug) ?? ''),
    description: asStr(r.description),
    marketCap: asNum(r.marketCap),
    volume24h: asNum(r.volume24h),
    dominance: asNum(r.dominance),
    gainers: asNum(r.gainers),
    losers: asNum(r.losers),
    change24h: apc ? asNum(apc['24H']) : null,
    rankedCoins: rc,
  };
}
