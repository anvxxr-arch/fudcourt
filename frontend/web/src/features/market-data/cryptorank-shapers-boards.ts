/** CryptoRank sector-board shapers (ecosystems, RWA, quarterly returns,
 * prediction markets, news, tags).
 * Split verbatim from cryptorank-shapers-markets.ts (now a barrel).
 * Shared helpers and coin shapers are single-sourced from
 * ./cryptorank-shapers-coins.
 */
import type {
  CrEcosystemRow,
  CrEcosystemInfo,
  CrRwaRow,
  CrRwaAsset,
  CrQuarterQ,
  CrQuarterlyYear,
  CrPredictionAgg,
  CrPredictionRow,
  CrNewsRow,
  CrTagRow,
} from './cryptorank-types';
import {
  asNum,
  asStr,
} from './cryptorank-shapers-coins';
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
