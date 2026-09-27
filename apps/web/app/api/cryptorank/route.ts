import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  CR_BASE,
  CR_DISABLED,
  CR_DISABLED_REASON,
  CR_DEFAULT_EXCHANGE,
  CR_DEFAULT_KEYS,
  CR_DEFAULT_LP,
  CR_DEFAULT_ND,
  CR_EXCHANGE_LISTS,
  CR_KEY_RE,
  CR_KEYED_PATHS,
  CR_LP_LISTS,
  CR_ND_LISTS,
  CR_MODES,
  CR_MODE_ARGS,
  CR_MODE_UPSTREAM,
  type CrCategoryInfo,
  type CrChainInfo,
  type CrChainRow,
  type CrCoin,
  type CrCoinDetail,
  type CrEnvelope,
  type CrExchangeRow,
  type CrGlobal,
  type CrLaunchpoolRow,
  type CrLiveMode,
  type CrMode,
  type CrFundingRound,
  type CrNewsRow,
  type CrNodeSaleRow,
  type CrTagInfo,
  type CrTagRow,
  type CrTrendingRow,
  type CrUpcomingIco,
} from '../../../lib/cryptorank';

/**
 * CryptoRank read proxy. Mode-only input (never a raw path); the fetch itself
 * happens in scripts/cr_fetch.py under a dedicated curl_cffi venv, because
 * cryptorank.io's API host challenges every non-browser TLS client while its
 * market pages serve their SSR payload through curl_cffi (see lib header).
 *
 * Failure policy (house rule): upstream wall -> 502 with the real upstream
 * status and the helper's own error string. Nothing is ever substituted.
 *
 * Data-integrity policy: modes listed in CR_DISABLED are REFUSED with 503 +
 * the measured reason -- upstream's /_next/data class serves synthetic decoy
 * (nonexistent slugs -> 200 fabricated payloads, prices off ground truth by
 * 30%, measured 2026-09-27). We never forward a payload we cannot trust.
 */

export const dynamic = 'force-dynamic';

const PYTHON = process.env.CR_PYTHON ?? '/home/dwizzy/.venvs/crfetch/bin/python';
const HELPER = path.join(process.cwd(), 'scripts', 'cr_fetch.py');

type HelperOut = {
  ok: boolean;
  path?: string;
  status?: number;
  error?: string;
  pageProps?: Record<string, unknown>;
  fetchedAt?: number;
  cache?: string;
};

function runHelper(flag: '--path' | '--data-route', value: string, fresh = false): Promise<HelperOut> {
  return new Promise((resolve) => {
    const args = fresh ? [HELPER, flag, value, '--ttl', '0'] : [HELPER, flag, value];
    execFile(
      PYTHON,
      args,
      { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(stdout) as HelperOut;
          resolve(parsed);
        } catch {
          resolve({
            ok: false,
            error: `helper produced no JSON: ${err ? String(err.message) : ''} ${String(stderr).slice(-300)}`.trim(),
          });
        }
      },
    );
  });
}

/* ------------------------------- shaping ------------------------------- */

const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
/** Upstream ships some numerics as strings (token-unlock marketCap). */
const asNumLoose = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** Upstream marks undisclosed names/types as '~'; render as absent (em-dash), not as a tilde. */
const asStrOrDash = (v: unknown): string | null => {
  const s = asStr(v);
  return s === '~' ? null : s;
};
const asPriceUsd = (v: unknown): number | null =>
  v && typeof v === 'object' ? asNum((v as Record<string, unknown>).USD) : asNum(v);

type RawCoin = Record<string, unknown>;

function shapeCoin(r: RawCoin, change24h: number | null): CrCoin {
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
function changeFromAnchor(r: RawCoin): number | null {
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
function shapeListing(r: RawCoin): CrCoin {
  const price = asPriceUsd(r.price) ?? asNum(r.priceUsd);
  const hist = (r.histPrices ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const chg = (period: string): number | null => {
    const a = asNum(hist[period]?.USD);
    return a !== null && price !== null && a !== 0 ? ((price - a) / a) * 100 : null;
  };
  return { ...shapeCoin(r, null), priceUsd: price, change24h: chg('24H'), change7d: chg('7D') };
}

/** /blockchains index row: slug/name/images/network/explorer. */
function shapeChainRow(r: RawCoin): CrChainRow {
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

function shapeGlobal(pp: Record<string, unknown>): CrGlobal {
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

function shapeFunding(r: Record<string, unknown>): CrFundingRound {
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

function shapeIco(r: Record<string, unknown>): CrUpcomingIco {
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

function shapeTrending(r: RawCoin): CrTrendingRow {
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
function shapeExchange(r: Record<string, unknown>, i: number): CrExchangeRow {
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
function shapeCoinDetail(pp: Record<string, unknown>, key: string): CrCoinDetail {
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

function envelope(
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
    return {
      ...base,
      count: ra.length + ms.length + mv.length,
      slice:
        `three /listings widgets: ${ra.length} recently added + ${ms.length} most searched + ${mv.length} most visited; ` +
        'chg24h/chg7d derived from histPrices["24H"]/["7D"] anchors where the widget ships them, em-dash otherwise',
      changeSource: 'derived-from-histPrices-24H',
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
function shapeLaunchpoolRow(r: Record<string, unknown>): CrLaunchpoolRow {
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
function shapeNodesaleRow(r: Record<string, unknown>): CrNodeSaleRow {
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

/** News row: date is epoch MILLISECONDS upstream (null = pinned promo slot). */
function shapeNewsRow(r: Record<string, unknown>): CrNewsRow {
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
function shapeTagRow(r: Record<string, unknown>): CrTagRow {
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

/* -------------------------------- handler ------------------------------- */

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') as CrMode | null;
  if (!mode || !CR_MODES.includes(mode)) {
    return NextResponse.json(
      { error: 'unknown mode', modes: CR_MODES, got: mode },
      { status: 400 },
    );
  }

  const fresh = req.nextUrl.searchParams.get('fresh') === '1';

  // Data-integrity refusal: these modes' upstream class serves synthetic
  // decoy (see CR_DISABLED_REASON). Loud 503, never a forwarded payload.
  if (mode === 'funding' || mode === 'unlocks') {
    return NextResponse.json(
      {
        error: CR_DISABLED_REASON,
        kind: mode,
        disabled: true,
        upstream: CR_MODE_UPSTREAM[mode],
        reverify: 'scripts/verify-cryptorank.py (nonexistent-slug must 404 + independent ground-truth match)',
      },
      { status: 503 },
    );
  }

  // Keyed live modes (categories/coin): ?key=<slug> -- validated, NEVER
  // clamped (bad format = 400; an honest upstream miss forwards its real 404
  // instead of fabricating a row).
  let flag: '--path' | '--data-route' = CR_MODE_ARGS[mode][0];
  let value: string = CR_MODE_ARGS[mode][1];
  let key: string | undefined;
  let upstream = CR_MODE_UPSTREAM[mode];
  if (mode in CR_KEYED_PATHS) {
    const keyed = mode as keyof typeof CR_KEYED_PATHS;
    const raw = req.nextUrl.searchParams.get('key');
    key = raw === null || raw === '' ? CR_DEFAULT_KEYS[keyed] : raw;
    if (!CR_KEY_RE.test(key)) {
      return NextResponse.json(
        {
          error: 'invalid key',
          detail: `key must match ${CR_KEY_RE} (lowercase alnum + dashes, 1-64)`,
          mode,
          key,
        },
        { status: 400 },
      );
    }
    value = CR_KEYED_PATHS[keyed](key);
    upstream = `${CR_BASE}${value}`;
  } else if (mode === 'exchanges') {
    const raw = req.nextUrl.searchParams.get('key');
    key = raw === null || raw === '' ? CR_DEFAULT_EXCHANGE : raw;
    if (!(CR_EXCHANGE_LISTS as readonly string[]).includes(key)) {
      return NextResponse.json(
        {
          error: 'invalid exchange list',
          detail: 'key must be one of the whitelisted venue lists (never clamped)',
          allowed: CR_EXCHANGE_LISTS,
          mode,
          key,
        },
        { status: 400 },
      );
    }
    value = `/exchanges/${key}`;
    upstream = `${CR_BASE}${value}`;
  } else if (mode === 'launchpool') {
    const raw = req.nextUrl.searchParams.get('key');
    key = raw === null || raw === '' ? CR_DEFAULT_LP : raw;
    if (!(CR_LP_LISTS as readonly string[]).includes(key)) {
      return NextResponse.json(
        {
          error: 'invalid launchpool list',
          detail: 'key must be one of the whitelisted event lists (never clamped)',
          allowed: CR_LP_LISTS,
          mode,
          key,
        },
        { status: 400 },
      );
    }
    value =
      key === 'upcoming'
        ? '/upcoming-launchpool'
        : key === 'active'
          ? '/active-launchpool'
          : '/past-launchpool';
    upstream = `${CR_BASE}${value}`;
  } else if (mode === 'nodesale') {
    const raw = req.nextUrl.searchParams.get('key');
    key = raw === null || raw === '' ? CR_DEFAULT_ND : raw;
    if (!(CR_ND_LISTS as readonly string[]).includes(key)) {
      return NextResponse.json(
        {
          error: 'invalid nodesale list',
          detail: 'key must be one of the whitelisted node sale lists (never clamped)',
          allowed: CR_ND_LISTS,
          mode,
          key,
        },
        { status: 400 },
      );
    }
    value =
      key === 'upcoming'
        ? '/upcoming-nodesale'
        : key === 'active'
          ? '/active-nodesale'
          : '/past-nodesale';
    upstream = `${CR_BASE}${value}`;
  }

  const h = await runHelper(flag, value, fresh);
  if (!h.ok) {
    if (h.status === 404) {
      // Honest upstream miss (e.g. /price/zzznoexist) -> real 404.
      return NextResponse.json(
        {
          error: 'upstream 404: no such resource',
          mode,
          key: key ?? null,
          upstreamStatus: 404,
        },
        { status: 404 },
      );
    }
    // Real failure, real detail: upstream wall status or helper crash text.
    return NextResponse.json(
      {
        error: h.error ?? 'cryptorank helper failed',
        upstreamStatus: h.status ?? null,
        upstream,
        kind: mode,
      },
      { status: 502 },
    );
  }

  const body = envelope(mode, h, { key, upstream });
  return NextResponse.json(body, {
    headers: {
      'X-CR-Upstream': body.upstream,
      'X-CR-Cache': body.cache,
      'Cache-Control': 'public, max-age=30',
    },
  });
}
