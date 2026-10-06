/** CryptoRank envelope per-mode branches: asset/data boards
 * (RWA, quarterly, prediction, converter, gainers/losers).
 * Split verbatim from ./cryptorank-shapers-envelope-modes-extra; that file
 * remains a barrel re-exporting this module so importers keep working unchanged.
 */
import type { EnvelopeBase, EnvelopeOpts } from './cryptorank-shapers-envelope-modes-core';
import {
  asNum,
  asStr,
  changeFromAnchor,
  shapeCoin,
} from './cryptorank-shapers-coins';
import {
  shapeRwaRow,
  shapeRwaAsset,
  shapeQuarterYear,
  shapePrediction,
} from './cryptorank-shapers-boards';
import type {
  CrEnvelope,
  CrConverterRow,
} from './cryptorank-types';
import type {
  RawCoin,
} from './cryptorank-shapers-coins';
export function shapeRwaEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const af = pp.assetsFallback as { data?: unknown; total?: unknown } | null;
    if (!af || !Array.isArray(af.data)) {
      throw new Error('rwa: missing assetsFallback.data');
    }
    const rows = (af.data as Record<string, unknown>[]).map(shapeRwaRow);
    const total = typeof af.total === 'number' ? af.total : null;
    return {
      ...base,
      count: rows.length,
      upstreamTotal: total,
      slice:
        `RWA assets — ${rows.length} of ${total ?? '?'} upstream (SSR page 1); ` +
        'price = upstream quote (marketState may be CLOSED = last session close); ' +
        'tokenized* = cryptorank tokenized-asset metrics (their methodology)',
      rwaRows: rows,
    };
}
export function shapeRwaassetEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const af = pp.assetFallback as { data?: unknown } | null;
    if (!af || !af.data || typeof af.data !== 'object') {
      throw new Error('rwaasset: missing assetFallback.data');
    }
    const asset = shapeRwaAsset(
      af.data as Record<string, unknown>,
      opts.key ?? '',
    );
    return {
      ...base,
      count: 1,
      slice:
        `asset detail '${asset.ticker || asset.slug}' — upstream quote at ` +
        `${asset.quoteUpdatedAt ?? 'unknown time'} (marketState ${asset.marketState ?? '?'}); ` +
        'exchange/sector = upstream metadata',
      rwaAsset: asset,
    };
}
export function shapeQuarterlyEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const btc = pp.initialQuarterlyReturnsBtc;
    const eth = pp.initialQuarterlyReturnsEth;
    if (!Array.isArray(btc) || !Array.isArray(eth)) {
      throw new Error('quarterly: missing initialQuarterlyReturnsBtc/Eth');
    }
    return {
      ...base,
      count: btc.length + eth.length,
      slice:
        `BTC (${btc.length} years) + ETH (${eth.length} years) quarterly open/close — ` +
        'upstream values; return% is computed in the UI from these numbers (labelled); ' +
        'isFull=false = quarter in progress; 2026 closes verified vs independent ' +
        'daily history (0.03-0.40% on 2026-09-27)',
      quarterlyBtc: btc.map(shapeQuarterYear),
      quarterlyEth: eth.map(shapeQuarterYear),
    };
}
export function shapePredictionEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const { agg, rows } = shapePrediction(pp);
    const tb = pp.tableFallbackData as { total?: unknown } | null;
    const total = tb && typeof tb.total === 'number' ? tb.total : null;
    return {
      ...base,
      count: rows.length,
      upstreamTotal: total,
      prediction: agg,
      predictionRows: rows,
      slice:
        `prediction markets — ${rows.length} of ${total ?? '?'} listings (SSR page 1); ` +
        'volume/markets/OI aggregates + platform split are upstream figures (window NOT ' +
        'disclosed upstream); row volume24h is explicitly 24h; external links go to ' +
        'the venue (kalshi/polymarket)',
    };
}
export function shapeConverterEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const icc = pp.initialCompactCoins;
    if (!Array.isArray(icc)) {
      throw new Error('converter: missing initialCompactCoins');
    }
    const convRows: CrConverterRow[] = (icc as Record<string, unknown>[]).map((r) => ({
      key: asStr(r.key) ?? '',
      name: asStr(r.name) ?? '',
      symbol: asStr(r.symbol) ?? '',
      icon: asStr(r.icon),
      priceUsd: asNum(r.price),
    }));
    return {
      ...base,
      count: convRows.length,
      upstreamTotal: convRows.length,
      changeSource: 'unavailable',
      slice:
        `full price list — all ${convRows.length} coins with live price ` +
        '(converter page payload: /all-coins-list ships only the top 100); ' +
        'price only — no 24h change upstream (em-dash, never 0)',
      converterRows: convRows,
    };
}
export function shapeGainersLosersEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
): CrEnvelope {

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
