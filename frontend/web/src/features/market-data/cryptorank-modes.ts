/** CryptoRank mode tables: single source of truth for mode keys, keyed-path
 * builders, strict list whitelists, disabled-mode set, and the mode -> fetch-arg
 * + upstream-URL maps. Split verbatim from cryptorank.ts; that file re-exports
 * everything so existing importers keep working unchanged.
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
