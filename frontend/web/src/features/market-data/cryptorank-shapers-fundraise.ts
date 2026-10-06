/** CryptoRank fundraise shapers (funding rounds, upcoming ICOs,
 * launchpool events, node sales). Split verbatim from
 * ./cryptorank-shapers-funding (now a barrel).
 * Shared helpers and coin shapers are single-sourced from
 * ./cryptorank-shapers-coins.
 */
import type {
  CrFundingRound,
  CrUpcomingIco,
  CrLaunchpoolRow,
  CrNodeSaleRow,
} from './cryptorank-types';
import {
  asNum,
  asStr,
  asStrOrDash,
} from './cryptorank-shapers-coins';
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
