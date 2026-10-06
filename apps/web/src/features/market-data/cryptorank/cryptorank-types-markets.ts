/** CryptoRank market-domain row types (funding, exchanges, launchpool, nodesale,
 * news, media, AI overview) plus the CrEnvelope.
 * Split verbatim from cryptorank-types.ts; that barrel re-exports this module.
 * Sector-vertical rows (ecosystems, RWA, quarterly, prediction) live in
 * ./cryptorank-types-sectors, re-exported below.
 */
import type { CrMode } from './cryptorank-modes';
import type {
  CrCategoryInfo,
  CrChainInfo,
  CrChainRow,
  CrCoin,
  CrCoinDetail,
  CrConverterRow,
  CrGlobal,
  CrTagInfo,
  CrTagRow,
  CrTrendingRow,
} from './cryptorank-types-coins';
import type {
  CrEcosystemInfo,
  CrEcosystemRow,
  CrPredictionAgg,
  CrPredictionRow,
  CrQuarterlyYear,
  CrRwaAsset,
  CrRwaRow,
} from './cryptorank-types-sectors';

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

export * from './cryptorank-types-sectors';

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

