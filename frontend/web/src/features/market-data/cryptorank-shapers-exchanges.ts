/** CryptoRank exchange row shapers (spot volumes plus reserve-transparency columns).
 * Split verbatim from ./cryptorank-shapers-venues (now a barrel).
 * Shared helpers single-sourced from ./cryptorank-shapers-coins.
 */
import type { CrExchangeRow } from './cryptorank-types';
import { asNum } from './cryptorank-shapers-coins';
export function shapeExchange(r: Record<string, unknown>, i: number): CrExchangeRow {
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
