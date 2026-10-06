/** CryptoRank envelope per-mode branches: blockchains/chain/launchpool/nodesale/ecosystems/ecosystem boards.
 * Split verbatim from ./cryptorank-shapers-envelope-modes-core (now the
 * first-half modes barrel); that file re-exports this module so importers
 * keep working unchanged.
 */
import type { EnvelopeBase, EnvelopeOpts } from './cryptorank-shapers-envelope-modes-core';
import {
  asNum,
  asStr,
  shapeChainRow,
  shapeCoin,
} from './cryptorank-shapers-coins';
import {
  shapeEcosystemRow,
  shapeEcosystemInfo,
} from './cryptorank-shapers-boards';
import {
  shapeLaunchpoolRow,
  shapeNodesaleRow,
} from './cryptorank-shapers-fundraise';
import type {
  CrEnvelope,
  CrChainInfo,
} from './cryptorank-types';
export function shapeBlockchainsEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeChainEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeLaunchpoolEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeNodesaleEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeEcosystemsEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const fe = pp.fallbackEcosystems as { data?: unknown; count?: unknown } | null;
    if (!fe || !Array.isArray(fe.data)) {
      throw new Error('ecosystems: missing fallbackEcosystems.data');
    }
    const ecoRows = (fe.data as Record<string, unknown>[]).map(shapeEcosystemRow);
    const count = typeof fe.count === 'number' ? fe.count : null;
    return {
      ...base,
      count: ecoRows.length,
      upstreamTotal: count,
      slice:
        `ecosystem index — ${ecoRows.length} of ${count ?? '?'} ecosystems ` +
        '(SSR ships page 1 only); mcap/tvl/change figures are cryptorank\'s OWN ' +
        'ecosystem aggregates (their methodology)',
      ecosystemRows: ecoRows,
    };
}
export function shapeEcosystemEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const fc = pp.fallbackCoins as { data?: unknown; count?: unknown } | null;
    if (!fc || !Array.isArray(fc.data)) {
      throw new Error('ecosystem: missing fallbackCoins.data');
    }
    const info = shapeEcosystemInfo(pp, opts.key ?? 'ethereum');
    const coinRows = (fc.data as Record<string, unknown>[]).map((r) =>
      shapeCoin(r, null),
    );
    const count = typeof fc.count === 'number' ? fc.count : null;
    return {
      ...base,
      count: coinRows.length,
      upstreamTotal: count,
      slice:
        `'${info.name}' ecosystem — ${coinRows.length} of ${count ?? '?'} coins ` +
        '(SSR page 1); eco rows carry NO price upstream -> chg columns null, never ' +
        'faked; native coin quote above is upstream\'s own',
      changeSource: 'unavailable',
      ecosystem: info,
      rows: coinRows,
    };
}
