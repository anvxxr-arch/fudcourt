/** CryptoRank market envelope builder (all live modes).
 * Split verbatim from ./cryptorank-shapers-venues (now a barrel).
 * Exchange rows single-sourced from ./cryptorank-shapers-exchanges;
 * shared helpers and coin shapers from ./cryptorank-shapers-coins;
 * sector-board shapers from ./cryptorank-shapers-boards; fundraise row
 * shapers from ./cryptorank-shapers-fundraise.
 * shapers from ./cryptorank-shapers-fundraise.
 * ./cryptorank-shapers-envelope-modes-core and
 * ./cryptorank-shapers-envelope-modes-extra; this file keeps the dispatcher
 * and re-exports both so ALL existing importers keep working unchanged.
 */
import { CR_MODE_UPSTREAM } from './cryptorank-modes';
import type { CrLiveMode } from './cryptorank-modes';
import type { CrEnvelope } from './cryptorank-types';
import type { HelperOut } from './cryptorank-shapers-coins';
import {
  shapeHomeEnvelope,
  shapeCoinsEnvelope,
  shapeTrendingEnvelope,
  shapeCategoriesEnvelope,
  shapeExchangesEnvelope,
  shapeListingsEnvelope,
  shapeCoinEnvelope,
  shapeBlockchainsEnvelope,
  shapeChainEnvelope,
  shapeLaunchpoolEnvelope,
  shapeNodesaleEnvelope,
  shapeEcosystemsEnvelope,
  shapeEcosystemEnvelope,
} from './cryptorank-shapers-envelope-modes-core';
import {
  shapeRwaEnvelope,
  shapeRwaassetEnvelope,
  shapeQuarterlyEnvelope,
  shapePredictionEnvelope,
  shapeNewsEnvelope,
  shapeTagsEnvelope,
  shapeTagEnvelope,
  shapeConverterEnvelope,
  shapeMediaEnvelope,
  shapeNewstagEnvelope,
  shapeAioverviewEnvelope,
  shapeGainersLosersEnvelope,
} from './cryptorank-shapers-envelope-modes-extra';
/** /price/<key> HTML: coin + priceStatistics + histPrices anchor for 24h. */
export function envelope(
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
  if (kind === 'home') return shapeHomeEnvelope(pp, base, opts);
  if (kind === 'coins') return shapeCoinsEnvelope(pp, base, opts);
  if (kind === 'trending') return shapeTrendingEnvelope(pp, base, opts);
  if (kind === 'categories') return shapeCategoriesEnvelope(pp, base, opts);
  if (kind === 'exchanges') return shapeExchangesEnvelope(pp, base, opts);
  if (kind === 'listings') return shapeListingsEnvelope(pp, base, opts);
  if (kind === 'coin') return shapeCoinEnvelope(pp, base, opts);
  if (kind === 'blockchains') return shapeBlockchainsEnvelope(pp, base, opts);
  if (kind === 'chain') return shapeChainEnvelope(pp, base, opts);
  if (kind === 'launchpool') return shapeLaunchpoolEnvelope(pp, base, opts);
  if (kind === 'nodesale') return shapeNodesaleEnvelope(pp, base, opts);
  if (kind === 'ecosystems') return shapeEcosystemsEnvelope(pp, base, opts);
  if (kind === 'ecosystem') return shapeEcosystemEnvelope(pp, base, opts);
  if (kind === 'rwa') return shapeRwaEnvelope(pp, base, opts);
  if (kind === 'rwaasset') return shapeRwaassetEnvelope(pp, base, opts);
  if (kind === 'quarterly') return shapeQuarterlyEnvelope(pp, base, opts);
  if (kind === 'prediction') return shapePredictionEnvelope(pp, base, opts);
  if (kind === 'news') return shapeNewsEnvelope(pp, base, opts);
  if (kind === 'tags') return shapeTagsEnvelope(pp, base, opts);
  if (kind === 'tag') return shapeTagEnvelope(pp, base, opts);
  if (kind === 'converter') return shapeConverterEnvelope(pp, base, opts);
  if (kind === 'media') return shapeMediaEnvelope(pp, base, opts);
  if (kind === 'newstag') return shapeNewstagEnvelope(pp, base, opts);
  if (kind === 'aioverview') return shapeAioverviewEnvelope(pp, base, opts);
  return shapeGainersLosersEnvelope(pp, base);
}
export * from './cryptorank-shapers-envelope-modes-core';
export * from './cryptorank-shapers-envelope-modes-extra';
