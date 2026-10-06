/** CryptoRank coin/trending/chain row types (coins, trending, detail, chains, converter, tags, categories).
 * Split verbatim from cryptorank-types.ts; that barrel re-exports this module.
 */

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

/** Category header (categories/<slug> HTML). */
export interface CrCategoryInfo {
  slug: string;
  name: string;
  gainers: number | null;
  losers: number | null;
}
