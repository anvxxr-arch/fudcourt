/** CryptoRank envelope per-mode branches: RWA/quarterly/prediction/news/tags/media/AI boards.
 * Split verbatim from ./cryptorank-shapers-envelope (now the dispatcher
 * entry); that file re-exports this module so importers keep working unchanged.
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
  shapeNewsRow,
  shapeTagRow,
} from './cryptorank-shapers-boards';
import type {
  CrEnvelope,
  CrTagInfo,
  CrConverterRow,
  CrMediaRow,
  CrAiOverview,
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
export function shapeNewsEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeTagsEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeTagEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
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
export function shapeMediaEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const fd = pp.fallbackData as { data?: unknown; count?: unknown } | null;
    if (!fd || !Array.isArray(fd.data)) {
      throw new Error('media: missing fallbackData.data');
    }
    const mediaRows: CrMediaRow[] = (fd.data as Record<string, unknown>[]).map((r) => ({
      id: asStr(r.id) ?? '',
      title: asStr(r.title) ?? '',
      channelTitle: asStr(r.channelTitle),
      publishedAt: asStr(r.publishedAt),
      durationSeconds: asNum(r.durationSeconds),
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String).slice(0, 6) : [],
    }));
    const total = typeof fd.count === 'number' ? fd.count : null;
    return {
      ...base,
      count: mediaRows.length,
      upstreamTotal: total,
      changeSource: 'unavailable',
      slice:
        `video feed — ${mediaRows.length} of ${total ?? '?'} videos (SSR page 1 only); ` +
        'id = YouTube video id (ground truth: youtube oembed title+channel match, verified); ' +
        'duration/published straight from upstream',
      mediaRows,
    };
}
export function shapeNewstagEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const tg = (pp.tag ?? null) as Record<string, unknown> | null;
    const list = pp.news;
    if (!tg || !Array.isArray(list)) {
      // GET maps tag=null to a real 404 before shaping; reaching here with a
      // missing array is a schema break, not a missing tag.
      throw new Error('newstag: missing news array');
    }
    const info: CrTagInfo = {
      slug: asStr(tg.key) ?? (opts.key ?? 'defi'),
      name: asStr(tg.name) ?? (opts.key ?? 'defi'),
      subtitle: null,
    };
    const newsRows = list.map(shapeNewsRow);
    const rel = Array.isArray(pp.tags)
      ? (pp.tags as Record<string, unknown>[])
          .map((t) => ({ slug: asStr(t.key) ?? '', name: asStr(t.name) ?? '' }))
          .filter((t) => t.slug)
      : [];
    return {
      ...base,
      count: newsRows.length,
      upstreamTotal: newsRows.length,
      slice:
        `articles tagged '${info.slug}' — ${newsRows.length} shown (upstream ships no tag total); ` +
        'unknown slugs are answered locally as 404 from upstream\'s tag=null soft-404 marker ' +
        '(never an unfiltered feed under a tag label); relatedCoins prices llama-verified',
      newsRows,
      tag: info,
      relatedTags: rel,
    };
}
export function shapeAioverviewEnvelope(
  pp: Record<string, unknown>,
  base: EnvelopeBase,
  opts: EnvelopeOpts,
): CrEnvelope {
    const ov = (pp.overviewData ?? null) as Record<string, unknown> | null;
    if (!ov) {
      throw new Error('aioverview: missing overviewData');
    }
    const market = (ov.market ?? {}) as Record<string, unknown>;
    const funding = (ov.fundingRound ?? {}) as Record<string, unknown>;
    const drop = (ov.dropHunting ?? {}) as Record<string, unknown>;
    const vest = (ov.vesting ?? {}) as Record<string, unknown>;
    const aiOverview: CrAiOverview = {
      market: {
        summary: asStr(market.aiSummary),
        updatedAt: asStr(market.updatedAt),
      },
      news: (Array.isArray(ov.news) ? (ov.news as Record<string, unknown>[]) : []).map((n) => ({
        id: asNum(n.id),
        title: asStr(n.title) ?? '',
        date: asStr(n.date),
        isBullish:
          typeof n.isBullish === 'boolean' ? n.isBullish : null,
      })),
      funding: {
        summary: asStr(funding.aiSummary),
        rounds: (Array.isArray(funding.rounds)
          ? (funding.rounds as Record<string, unknown>[])
          : []
        ).map((r) => ({
          key: asStr(r.key),
          name: asStr(r.name) ?? '',
          stage: asStr(r.stage),
          raisedUsd: asNum(r.raised),
        })),
      },
      dropHunting: {
        summary: asStr(drop.aiSummary),
        activities: (Array.isArray(drop.activities)
          ? (drop.activities as Record<string, unknown>[])
          : []
        ).map((a) => {
          const coin = (a.coin ?? null) as Record<string, unknown> | null;
          return {
            key: asStr(a.key) ?? '',
            type: asStr(a.type),
            coinName: coin ? asStr(coin.name) : null,
          };
        }),
      },
      vesting: {
        summary: asStr(vest.aiSummary),
        unlocks: (Array.isArray(vest.vesting)
          ? (vest.vesting as Record<string, unknown>[])
          : []
        ).map((v) => {
          const coin = (v.coin ?? null) as Record<string, unknown> | null;
          return {
            date: asStr(v.date),
            unlockPercent: asNum(v.unlockPercent),
            coinName: coin ? asStr(coin.name) : null,
          };
        }),
      },
    };
    return {
      ...base,
      count: aiOverview.news.length + aiOverview.funding.rounds.length +
        aiOverview.dropHunting.activities.length + aiOverview.vesting.unlocks.length,
      slice:
        'upstream AI digest — summaries are cryptorank\'s own generated text ' +
        '(their words, labelled as theirs); structured slices are plain rows; ' +
        'cross-surface coherence vs mode=home enforced in harness ' +
        '(mcap/volume/dominance <= 0.5%), CoinGecko total-cap sanity band 5%',
      aiOverview,
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
