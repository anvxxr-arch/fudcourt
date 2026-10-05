/** CryptoRank envelope/row types. Split verbatim from cryptorank.ts; that file
 * re-exports everything so existing importers keep working unchanged.
 */
import type { CrMode } from './cryptorank-modes';

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
