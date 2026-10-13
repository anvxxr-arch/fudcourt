import {
  OPENSEA_CHAINS_TTL_MS,
  OPENSEA_EVENT_TYPES,
  OPENSEA_FLOOR_TIMEFRAMES,
  OPENSEA_SEARCH_ASSET_TYPES,
  OPENSEA_STATS_TTL_MS,
  OPENSEA_TOP_SORTS,
  OPENSEA_TRENDING_TIMEFRAMES,
  OPENSEA_TTL_MS,
  OpenSeaError,
  accountNfts,
  bestListing,
  bestOffer,
  collectionEvents,
  collectionNfts,
  contractNfts,
  floorPrices,
  getChains,
  getCollection,
  getNFT,
  getStats,
  listCollections,
  searchOpenSea,
  topCollections,
  traitFloors,
  trendingCollections,
} from '@/features/nft/opensea';
import { fail, failInternal, publicJson } from '../../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * Public read over OpenSea v2. No tier: this is public chain data, not the
 * private holdings the `/api/treasury` family gates.
 *
 *   ?chains                             the venue's chain list         (keyless)
 *   ?stats=<slug>                       floor/volume/sales/owners       (keyless)
 *   ?collection=<slug>                  one collection record          (keyless)
 *   ?collections=<n>[&next=<cursor>]     the venue's collection index   (keyless)
 *   ?chain=<slug>&contract=<addr>        the NFTs of one contract       (needs key)
 *   ?chain=<slug>&address=<wallet>       the NFTs one account holds     (needs key)
 *   ?chain=<slug>&contract=<addr>&token=<id>  one NFT drill-down        (needs key)
 *   ?collectionNfts=<slug>[&traits=..][&next=..]  NFTs by collection    (needs key)
 *   ?traitFloors=<slug>                  floor per trait value          (needs key)
 *   ?floorPrices=<slug>[&timeframe=..][&resolution=..]  floor series    (needs key)
 *   ?bestListing=<slug>&token=<id>       cheapest fillable listing      (needs key, null when none)
 *   ?bestOffer=<slug>&token=<id>         highest offer                  (needs key, null when none)
 *   ?trending[&timeframe=..][&chains=..][&category=..][&next=..]  trending (needs key)
 *   ?top[&sort_by=..][&chains=..][&category=..][&next=..]         top    (needs key)
 *   ?events=<slug>[&event_type=..][&next=..][&after=..][&before=..]  events (needs key)
 *   ?search=<q>[&chains=..][&asset_types=..]  venue search             (needs key)
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const chain = p.get('chain');
  const contract = p.get('contract');
  const address = p.get('address');
  const token = p.get('token');
  const slug = p.get('collection');
  const next = p.get('next') ?? undefined;
  const limit = p.get('limit') ?? (p.has('collections') ? p.get('collections') : 20);

  let doRead: () => Promise<unknown>;
  let ttlMs = OPENSEA_TTL_MS;
  if (p.has('chains')) {
    doRead = () => getChains();
    ttlMs = OPENSEA_CHAINS_TTL_MS;
  } else if (p.has('stats')) {
    const s = p.get('stats');
    if (!s) return fail('specify ?stats=<slug>', 400);
    doRead = () => getStats(s);
    ttlMs = OPENSEA_STATS_TTL_MS;
  } else if (slug) {
    doRead = () => getCollection(slug);
  } else if (chain && contract && token) {
    doRead = () => getNFT(chain, contract, token);
  } else if (chain && contract) {
    doRead = () => contractNfts(chain, contract, limit, next);
  } else if (chain && address) {
    doRead = () => accountNfts(chain, address, limit, next);
  } else if (p.has('collections')) {
    doRead = () => listCollections(limit, next);
  } else if (p.has('collectionNfts')) {
    const s = p.get('collectionNfts');
    if (!s) return fail('specify ?collectionNfts=<slug>', 400);
    doRead = () => collectionNfts(s, limit, next, p.get('traits') ?? undefined);
  } else if (p.has('traitFloors')) {
    const s = p.get('traitFloors');
    if (!s) return fail('specify ?traitFloors=<slug>', 400);
    doRead = () => traitFloors(s);
    ttlMs = OPENSEA_STATS_TTL_MS;
  } else if (p.has('floorPrices')) {
    const s = p.get('floorPrices');
    if (!s) return fail('specify ?floorPrices=<slug>', 400);
    const tf = p.get('timeframe') ?? undefined;
    if (
      tf !== undefined &&
      !(OPENSEA_FLOOR_TIMEFRAMES as readonly string[]).includes(tf)
    ) {
      return fail(
        'unknown timeframe',
        400,
        `${JSON.stringify(tf)} is not one of ${OPENSEA_FLOOR_TIMEFRAMES.join('|')}`,
      );
    }
    doRead = () => floorPrices(s, tf, p.get('resolution') ?? undefined);
    ttlMs = OPENSEA_STATS_TTL_MS;
  } else if (p.has('bestListing')) {
    const s = p.get('bestListing');
    if (!s || !token) return fail('specify ?bestListing=<slug>&token=<id>', 400);
    doRead = () => bestListing(s, token);
    ttlMs = OPENSEA_STATS_TTL_MS;
  } else if (p.has('bestOffer')) {
    const s = p.get('bestOffer');
    if (!s || !token) return fail('specify ?bestOffer=<slug>&token=<id>', 400);
    doRead = () => bestOffer(s, token);
    ttlMs = OPENSEA_STATS_TTL_MS;
  } else if (p.has('trending')) {
    const tf = p.get('timeframe') ?? undefined;
    if (tf !== undefined && !(OPENSEA_TRENDING_TIMEFRAMES as readonly string[]).includes(tf)) {
      return fail(
        'unknown timeframe',
        400,
        `${JSON.stringify(tf)} is not one of ${OPENSEA_TRENDING_TIMEFRAMES.join('|')}`,
      );
    }
    doRead = () =>
      trendingCollections(limit, tf, p.get('chains') ?? undefined, p.get('category') ?? undefined, next);
    ttlMs = OPENSEA_STATS_TTL_MS;
  } else if (p.has('top')) {
    const sort = p.get('sort_by') ?? undefined;
    if (sort !== undefined && !(OPENSEA_TOP_SORTS as readonly string[]).includes(sort)) {
      return fail(
        'unknown sort_by',
        400,
        `${JSON.stringify(sort)} is not one of ${OPENSEA_TOP_SORTS.join('|')}`,
      );
    }
    doRead = () =>
      topCollections(limit, sort, p.get('chains') ?? undefined, p.get('category') ?? undefined, next);
    ttlMs = OPENSEA_STATS_TTL_MS;
  } else if (p.has('events')) {
    const s = p.get('events');
    if (!s) return fail('specify ?events=<slug>', 400);
    const et = p.get('event_type') ?? undefined;
    if (et !== undefined && !(OPENSEA_EVENT_TYPES as readonly string[]).includes(et)) {
      return fail(
        'unknown event_type',
        400,
        `${JSON.stringify(et)} is not one of ${OPENSEA_EVENT_TYPES.join('|')}`,
      );
    }
    doRead = () =>
      collectionEvents(
        s,
        limit,
        et,
        next,
        p.get('after') ?? undefined,
        p.get('before') ?? undefined,
        p.get('traits') ?? undefined,
      );
    ttlMs = OPENSEA_STATS_TTL_MS;
  } else if (p.has('search')) {
    const searchQuery = p.get('search');
    if (!searchQuery) return fail('specify ?search=<query>', 400);
    const at = p.get('asset_types') ?? undefined;
    if (at !== undefined) {
      const unknown = at
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t && !(OPENSEA_SEARCH_ASSET_TYPES as readonly string[]).includes(t));
      if (unknown.length > 0) {
        return fail(
          'unknown asset_types',
          400,
          `${JSON.stringify(unknown.join(','))} is not in ${OPENSEA_SEARCH_ASSET_TYPES.join('|')}`,
        );
      }
    }
    doRead = () => searchOpenSea(searchQuery, limit, p.get('chains') ?? undefined, at);
    ttlMs = OPENSEA_STATS_TTL_MS;
  } else {
    return fail(
      'specify ?chains, ?stats=<slug>, ?collections=<n>, ?collection=<slug>, ?chain=<slug>&contract=<address>, ?chain=<slug>&address=<wallet>, ?chain=<slug>&contract=<address>&token=<id>, ?collectionNfts=<slug>, ?traitFloors=<slug>, ?floorPrices=<slug>, ?bestListing=<slug>&token=<id>, ?bestOffer=<slug>&token=<id>, ?trending, ?top, ?events=<slug>, or ?search=<query>',
      400,
    );
  }

  try {
    return publicJson(await doRead(), Math.round(ttlMs / 1000));
  } catch (e) {
    // Each failure kind gets its own status, so a caller never has to parse
    // prose to tell "this deployment has no key" (503) from "OpenSea never
    // answered" (504) from "this deployment is throttled" (429) from
    // "OpenSea answered badly, key included" (502).
    if (e instanceof OpenSeaError) {
      const status =
        e.kind === 'missing-key'
          ? 503
          : e.kind === 'transport'
            ? 504
            : e.kind === 'rate-limited'
              ? 429
              : 502;
      return fail(e.message, status);
    }
    return failInternal(e);
  }
}
