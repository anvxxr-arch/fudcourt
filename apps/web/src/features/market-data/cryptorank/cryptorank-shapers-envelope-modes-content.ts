/** CryptoRank envelope per-mode branches: content/taxonomy boards
 * (news, tags, media, AI overview).
 * Split verbatim from ./cryptorank-shapers-envelope-modes-extra; that file
 * remains a barrel re-exporting this module so importers keep working unchanged.
 */
import type { EnvelopeBase, EnvelopeOpts } from './cryptorank-shapers-envelope-modes-core';
import {
  asNum,
  asStr,
  shapeCoin,
} from './cryptorank-shapers-coins';
import {
  shapeNewsRow,
  shapeTagRow,
} from './cryptorank-shapers-boards';
import type {
  CrEnvelope,
  CrTagInfo,
  CrMediaRow,
  CrAiOverview,
} from './cryptorank-types';
import type {
  RawCoin,
} from './cryptorank-shapers-coins';
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
