/** CryptoRank coin/listing shapers: shared scalar helpers plus pure functions
 * turning upstream __NEXT_DATA__ shapes into typed coin/chain/global rows.
 * Split verbatim from cryptorank-shapers.ts; that barrel re-exports this module.
 */
import type {
  CrChainRow,
  CrCoin,
  CrCoinDetail,
  CrGlobal,
  CrTrendingRow,
} from './cryptorank-types';
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

