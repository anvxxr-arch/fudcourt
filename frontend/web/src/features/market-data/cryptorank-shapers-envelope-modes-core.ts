/** CryptoRank envelope per-mode branches: home/coins/trending/categories/exchanges/listings/coin detail boards.
 * Split verbatim from ./cryptorank-shapers-envelope (now the dispatcher
 * entry); that file re-exports this module so importers keep working unchanged.
 */
import type { CrLiveMode } from './cryptorank-modes';
import {
  asNum,
  asStr,
  shapeCoin,
  shapeCoinDetail,
  shapeGlobal,
  shapeListing,
  shapeTrending,
} from './cryptorank-shapers-coins';
import {
  shapeExchange,
} from './cryptorank-shapers-exchanges';
import {
  shapeFunding,
  shapeIco,
} from './cryptorank-shapers-fundraise';
import type {
  CrEnvelope,
  CrExchangeRow,
  CrCategoryInfo,
} from './cryptorank-types';
import type {
  RawCoin,
} from './cryptorank-shapers-coins';
/** Shared per-mode branch context: the dispatcher-built base fields. */
export interface EnvelopeBase {
  kind: CrLiveMode;
  upstream: string;
  fetchedAt: number;
  cache: string;
}
/** Routing opts threaded through every per-mode branch. */
export interface EnvelopeOpts {
  key?: string;
  upstream?: string;
}
export function shapeHomeEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeCoinsEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const coins = Array.isArray(pp.coins) ? (pp.coins as RawCoin[]) : [];
    return {
      ...base,
      count: coins.length,
      upstreamTotal: coins.length,
      changeSource: 'unavailable',
      rows: coins.map((r) => shapeCoin(r, null)),
    };
}
export function shapeTrendingEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeCategoriesEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeExchangesEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeListingsEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeCoinEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export * from './cryptorank-shapers-envelope-modes-chains';
