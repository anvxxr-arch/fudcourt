/** CryptoRank sector-vertical row types (ecosystems, RWA, quarterly, prediction).
 * Split verbatim from cryptorank-types-markets.ts; that module re-exports this file.
 */

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

