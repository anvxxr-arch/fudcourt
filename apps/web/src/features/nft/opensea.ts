/**
 * OpenSea API v2 — the NFT venue.
 *
 * Auth is per-endpoint, and that was MEASURED (2026-10-09) rather than assumed:
 *
 *   KEYLESS (200 without a key):
 *     GET /api/v2/collections                           -> 200
 *     GET /api/v2/collections/{slug}                    -> 200
 *     GET /api/v2/collections/{slug}/stats              -> 200
 *     GET /api/v2/chains                                -> 200
 *   KEYED (401 "Missing an API Key" without one):
 *     GET /api/v2/chain/{chain}/contract/{addr}/nfts    -> 401
 *     GET /api/v2/chain/{chain}/contract/{addr}/nfts/{id} -> 401
 *     GET /api/v2/chain/{chain}/account/{addr}/nfts    -> 401 (flaky keyless, kept keyed — see ANOMALY)
 *     GET /api/v2/collection/{slug}/nfts                -> 401
 *     GET /api/v2/traits/{slug}/floors                  -> 401
 *     GET /api/v2/collections/{slug}/floor_prices       -> 401
 *     GET /api/v2/listings/collection/{slug}/nfts/{id}/best -> 401
 *     GET /api/v2/offers/collection/{slug}/nfts/{id}/best   -> 401
 *     GET /api/v2/collections/trending                  -> 401
 *     GET /api/v2/collections/top                       -> 401
 *     GET /api/v2/events/collection/{slug}              -> 401
 *     GET /api/v2/search                                -> 401
 *     GET /api/v2/account/{addr}/collections            -> 401
 *     GET /api/v2/account/{addr}/portfolio              -> 401
 * ANOMALY (kept fail-closed): GET /chain/{chain}/account/{addr}/nfts answered
 * 200 keyless on some probes and 401 on others for the SAME url (isolated
 * keyless after a 65s cooldown: 401). Upstream is non-deterministic here, so
 * the reader keeps needsKey=true and reports a missing credential before any
 * request is sent — never an empty `nfts` array.
 *
 * So the key is attached when it exists, and a reader that NEEDS it reports the
 * missing credential as itself. A missing key must never arrive as an empty
 * `nfts` array, because that renders as "this wallet owns no NFTs" — a confident
 * falsehood rather than a configuration state. That is why every failure here is
 * thrown as an `OpenSeaError` carrying `kind`: the caller can tell a deployment
 * with no credential from a venue that answered badly, without parsing prose.
 *
 * Errors follow the house convention (`fred.ts`, `bis.ts`, `worldbank.ts`): a
 * rejected read throws, it does not resolve to a null. The route translates
 * `kind` into a status code. The one exception is the best-listing/best-offer
 * pair: a 404 there means "no order", a valid state, so those two readers
 * resolve to null instead of throwing.
 *
 * `chain` here is OpenSea's own slug vocabulary (`ethereum`, `polygon`, `base`,
 * `arbitrum`, `optimism`, `solana`, …). That is a DIFFERENT question from the
 * treasury's `venues` dimension, whose `wallets.chain` column holds display
 * strings ('BSC', 'Solana') resolved case-insensitively against venue keys.
 * There is deliberately no mapping between the two: guessing whether 'BSC' means
 * OpenSea's `matic` would be inventing a fact, so a caller that knows its chain
 * passes the slug. `getChains()` returns the venue's own list, which is the
 * measured basis any future mapping must be built on.
 */
import { limitedFetch } from '@/lib/rate-limit';

export const OPENSEA_BASE = 'https://api.opensea.io/api/v2';

/** Near-static metadata, so a minute is ample and keeps a browsing surface from
 *  spending the key's budget on repeat reads. The shared outbound limiter
 *  already paces every origin at <=5 req/s, so this reader adds no pacing. */
export const OPENSEA_TTL_MS = 60_000;

/** Trading figures move fast; 30s keeps a board live without spending the key
 *  budget on repeat reads inside one browsing session. */
export const OPENSEA_STATS_TTL_MS = 30_000;

/** The chain list changes when OpenSea adds a network — roughly never. One hour
 *  keeps it effectively static while still self-healing if it ever drifts. */
export const OPENSEA_CHAINS_TTL_MS = 3_600_000;

const TIMEOUT_MS = 20_000;
/** OpenSea caps `limit` at 50 on the NFT reads; the collection index allows more,
 *  but 50 is the floor shared by both and over-asking is a clamp, not an error. */
const MAX_LIMIT = 50;

export type OpenSeaNFT = {
  identifier: string;
  collection: string;
  contract: string;
  token_standard: string;
  name: string | null;
  description?: string | null;
  image_url: string | null;
  display_image_url?: string | null;
  opensea_url?: string;
  chain?: string;
};

export type OpenSeaTrait = {
  trait_type: string;
  display_type?: string | null;
  max_value?: number | null;
  value: string | number | null;
};

export type OpenSeaNFTOwner = {
  address: string;
  quantity: number;
  quantity_string?: string;
};

/** One NFT with the drill-down fields the list reads omit: traits, owners,
 *  rarity-adjacent metadata and the venue's own USD estimate (often null). */
export type OpenSeaNFTDetail = OpenSeaNFT & {
  traits: OpenSeaTrait[];
  owners?: OpenSeaNFTOwner[];
  updated_at?: string;
  is_disabled?: boolean;
  is_nsfw?: boolean;
  estimated_value_usd?: number | null;
  metadata_url?: string | null;
};

export type OpenSeaCollectionBrief = {
  collection: string;
  name: string;
  description: string | null;
  image_url: string | null;
  owner?: string;
  safelist_status?: string;
};

export type OpenSeaCollectionDetail = OpenSeaCollectionBrief & {
  banner_image_url?: string | null;
  category?: string;
  opensea_url?: string;
  contracts?: Array<{ address: string; chain: string }>;
};

export type OpenSeaChain = {
  chain: string;
  name: string;
  symbol: string;
  supports_swaps: boolean;
  block_explorer: string;
  block_explorer_url: string;
};

export type OpenSeaCollectionStats = {
  total: {
    volume: number;
    volume_symbol: string;
    sales: number;
    num_owners: number;
    floor_price: number;
    floor_price_symbol: string;
  };
  intervals: Array<{
    interval: string;
    volume: number;
    volume_symbol: string;
    sales: number;
  }>;
};

export type OpenSeaTraitFloor = {
  trait_type: string;
  value: string;
  floor_price: number;
  payment_token_symbol: string;
};

export type OpenSeaFloorPoint = {
  time: number;
  usd_price?: string | null;
  token_unit?: number | null;
  symbol?: string | null;
  chain?: string | null;
};

/** The price leg of a Seaport order, as served by the best-listing/best-offer
 *  reads. `value` is in the token's smallest unit; `decimals` places it. */
export type OpenSeaOrderPrice = {
  currency: string;
  decimals: number;
  value: string;
};

/** Subset of the Seaport order the venue serves: identity, chain, price and
 *  liveness. The full `protocol_data` is intentionally NOT typed — fulfilling
 *  an order is out of scope (read-only venue), and typing it would invite it. */
export type OpenSeaOrder = {
  order_hash: string;
  chain: string;
  price: OpenSeaOrderPrice;
  status: string;
  order_created_at?: number;
};

/** Why a read failed, so a route can map it to a status instead of a guess. */
export type OpenSeaFailureKind = 'missing-key' | 'rejected' | 'rate-limited' | 'upstream' | 'transport';

export class OpenSeaError extends Error {
  readonly kind: OpenSeaFailureKind;
  /** The upstream HTTP status, or 0 when no response existed (transport/missing key). */
  readonly status: number;

  constructor(kind: OpenSeaFailureKind, message: string, status = 0) {
    super(message);
    this.name = 'OpenSeaError';
    this.kind = kind;
    this.status = status;
  }
}

/** The configured key, or null. Presence is the only branch any caller needs. */
export function openseaKey(): string | null {
  const k = process.env.OPENSEA_API_KEY?.trim();
  return k ? k : null;
}

/** Headers for a read. The key rides only when it is configured. */
export function openseaHeaders(key: string | null = openseaKey()): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (key) h['X-API-KEY'] = key;
  return h;
}

/** A limit is clamped, never rejected: 1..50, and a non-number means the default. */
export function clampLimit(n: unknown, fallback = 20): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(v)));
}

/** One read through the shared limiter. `needsKey` is the MEASURED fact about the
 *  endpoint, so an unconfigured key is reported as a configuration state before a
 *  request is sent — otherwise OpenSea's 401 would arrive as a generic upstream
 *  failure and read like the venue's fault. */
async function read<T>(path: string, needsKey: boolean, ttlMs = OPENSEA_TTL_MS): Promise<T> {
  const key = openseaKey();
  if (needsKey && !key) {
    throw new OpenSeaError(
      'missing-key',
      'OPENSEA_API_KEY is not configured; this endpoint requires it',
    );
  }
  let res: Response;
  try {
    res = await limitedFetch(
      `${OPENSEA_BASE}${path}`,
      { headers: openseaHeaders(key), signal: AbortSignal.timeout(TIMEOUT_MS) },
      { ttlMs },
    );
  } catch (e) {
    throw new OpenSeaError('transport', e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new OpenSeaError('rejected', `OpenSea rejected the API key (${res.status})`, res.status);
    }
    if (res.status === 429) {
      throw new OpenSeaError(
        'rate-limited',
        `OpenSea throttled this deployment (429)${body ? `: ${body.slice(0, 160)}` : ''}`,
        429,
      );
    }
    throw new OpenSeaError(
      'upstream',
      `OpenSea responded ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

const enc = (s: string) => encodeURIComponent(s.trim());

/** The venue's own chain list. Keyless (measured). Effectively static. */
export function getChains(): Promise<{ chains: OpenSeaChain[] }> {
  return read('/chains', false, OPENSEA_CHAINS_TTL_MS);
}

/** Floor, volume, sales and owners for one collection. Keyless (measured).
 *  Each figure reads against its OWN symbol: `floor_price` is denominated in
 *  `floor_price_symbol`, `volume` in `volume_symbol` — the two can differ. */
export function getStats(slug: string): Promise<OpenSeaCollectionStats> {
  return read(`/collections/${enc(slug)}/stats`, false, OPENSEA_STATS_TTL_MS);
}

/** The venue's own collection index. Keyless (measured). */
export function listCollections(
  limit: unknown = 20,
  next?: unknown,
): Promise<{ collections: OpenSeaCollectionBrief[]; next?: string | null }> {
  const cursor = typeof next === 'string' && next ? `&next=${encodeURIComponent(next)}` : '';
  return read(`/collections?limit=${clampLimit(limit)}${cursor}`, false);
}

/** One collection record by slug. Keyless (measured). */
export function getCollection(slug: string): Promise<OpenSeaCollectionDetail> {
  return read(`/collections/${enc(slug)}`, false);
}

/** One NFT by chain, contract and token id. Requires the key (measured). */
export function getNFT(
  chain: string,
  contract: string,
  identifier: string,
): Promise<{ nft: OpenSeaNFTDetail }> {
  return read(`/chain/${enc(chain)}/contract/${enc(contract)}/nfts/${enc(identifier)}`, true);
}

/** The NFTs of one contract. Requires the key (measured). `next` pages. */
export function contractNfts(
  chain: string,
  contract: string,
  limit: unknown = 20,
  next?: unknown,
): Promise<{ nfts: OpenSeaNFT[]; next?: string | null }> {
  const cursor = typeof next === 'string' && next ? `&next=${encodeURIComponent(next)}` : '';
  return read(`/chain/${enc(chain)}/contract/${enc(contract)}/nfts?limit=${clampLimit(limit)}${cursor}`, true);
}

/** The NFTs one account holds on one chain. Requires the key (measured —
 *  see the module header for the flaky-keyless anomaly). `next` pages. */
export function accountNfts(
  chain: string,
  address: string,
  limit: unknown = 20,
  next?: unknown,
): Promise<{ nfts: OpenSeaNFT[]; next?: string | null }> {
  const cursor = typeof next === 'string' && next ? `&next=${encodeURIComponent(next)}` : '';
  return read(`/chain/${enc(chain)}/account/${enc(address)}/nfts?limit=${clampLimit(limit)}${cursor}`, true);
}

/** The NFTs of one collection, optionally trait-filtered. Requires the key
 *  (measured). Traits are AND-combined upstream. `next` pages. */
export function collectionNfts(
  slug: string,
  limit: unknown = 20,
  next?: unknown,
  traits?: unknown,
): Promise<{ nfts: OpenSeaNFT[]; next?: string | null }> {
  const cursor = typeof next === 'string' && next ? `&next=${encodeURIComponent(next)}` : '';
  const filter =
    typeof traits === 'string' && traits.trim()
      ? `&traits=${encodeURIComponent(traits.trim())}`
      : '';
  return read(`/collection/${enc(slug)}/nfts?limit=${clampLimit(limit)}${cursor}${filter}`, true);
}

/** Cheapest active listing per text trait value. Requires the key (measured).
 *  Floors are NOT converted to a common currency: compare only within the same
 *  `payment_token_symbol`, on the response's `chain`. */
export function traitFloors(slug: string): Promise<{ chain: string; floors: OpenSeaTraitFloor[] }> {
  return read(`/traits/${enc(slug)}/floors`, true, OPENSEA_STATS_TTL_MS);
}

/** Time-series floor for one collection. Requires the key (measured).
 *  `timeframe` is the venue's own vocabulary (one_day, seven_days, …);
 *  unknown values are rejected upstream, never defaulted here. */
export function floorPrices(
  slug: string,
  timeframe?: unknown,
  resolution?: unknown,
): Promise<{ floor_prices: OpenSeaFloorPoint[] }> {
  const tf = typeof timeframe === 'string' && timeframe.trim() ? `?timeframe=${enc(timeframe)}` : '';
  const res =
    typeof resolution === 'number' || (typeof resolution === 'string' && resolution.trim())
      ? `${tf ? '&' : '?'}resolution=${encodeURIComponent(String(resolution).trim())}`
      : '';
  return read(`/collections/${enc(slug)}/floor_prices${tf}${res}`, true, OPENSEA_STATS_TTL_MS);
}

/** Cheapest listing fulfillable through the venue for one NFT. Requires the
 *  key (measured). Null means "no listing" (upstream 404) — a valid state,
 *  not a failure. Note the basis differs from `stats.floor_price`, which
 *  aggregates every marketplace OpenSea reads: this can sit above that floor. */
export async function bestListing(slug: string, identifier: string): Promise<OpenSeaOrder | null> {
  try {
    return await read<OpenSeaOrder>(
      `/listings/collection/${enc(slug)}/nfts/${enc(identifier)}/best`,
      true,
      OPENSEA_STATS_TTL_MS,
    );
  } catch (e) {
    if (e instanceof OpenSeaError && e.kind === 'upstream' && e.status === 404) return null;
    throw e;
  }
}

/** Highest offer for one NFT. Requires the key (measured). Null means
 *  "no offer" (upstream 404) — a valid state, not a failure. */
export async function bestOffer(slug: string, identifier: string): Promise<OpenSeaOrder | null> {
  try {
    return await read<OpenSeaOrder>(
      `/offers/collection/${enc(slug)}/nfts/${enc(identifier)}/best`,
      true,
      OPENSEA_STATS_TTL_MS,
    );
  } catch (e) {
    if (e instanceof OpenSeaError && e.kind === 'upstream' && e.status === 404) return null;
    throw e;
  }
}

/** Portfolio value + P&L for one wallet, all chains unless filtered. Requires
 *  the key (measured). Figures arrive as STRINGS upstream; the route parses
 *  them to numbers and keeps null when a figure is absent. */
export type OpenSeaPortfolio = {
  total_value_usd: string;
  nft_value_usd: string;
  token_value_usd: string;
  pnl_absolute?: string | null;
  pnl_percentage?: string | null;
  timeframe: string;
};

export function accountPortfolio(
  address: string,
  timeframe?: unknown,
  chains?: unknown,
): Promise<OpenSeaPortfolio> {
  const tf = typeof timeframe === 'string' && timeframe.trim() ? `?timeframe=${enc(timeframe)}` : '';
  const ch =
    typeof chains === 'string' && chains.trim()
      ? `${tf ? '&' : '?'}chains=${encodeURIComponent(chains.trim())}`
      : '';
  return read(`/account/${enc(address)}/portfolio${tf}${ch}`, true, OPENSEA_STATS_TTL_MS);
}

/** One collection an account holds, with the venue's own counts and USD mark.
 *  `usd_value`/`item_count` can be null upstream — "no mark", never zero. */
export type OpenSeaAccountCollection = OpenSeaCollectionBrief & {
  item_count?: number | null;
  usd_value?: number | null;
  total_quantity?: number | null;
  contracts?: Array<{ address: string; chain: string }>;
};

/** Every collection one wallet holds, with ownership data. Requires the key
 *  (measured). `after` pages; `chains` filters to venue slugs. */
export function accountCollections(
  address: string,
  limit: unknown = 50,
  after?: unknown,
  chains?: unknown,
): Promise<{ collections: OpenSeaAccountCollection[]; next?: string | null }> {
  const cursor = typeof after === 'string' && after ? `&after=${encodeURIComponent(after)}` : '';
  const ch =
    typeof chains === 'string' && chains.trim()
      ? `&chains=${encodeURIComponent(chains.trim())}`
      : '';
  return read(
    `/account/${enc(address)}/collections?limit=${clampLimit(limit, 50)}${cursor}${ch}`,
    true,
    OPENSEA_STATS_TTL_MS,
  );
}

/** Venue vocabularies the routes validate strictly: an unknown value is a
 *  400, never a silent fallback (the house rule). Exported so the route and
 *  the offline tests read the same list. */
export const OPENSEA_TRENDING_TIMEFRAMES = [
  'one_minute',
  'five_minutes',
  'fifteen_minutes',
  'one_hour',
  'one_day',
  'seven_days',
  'thirty_days',
  'one_year',
  'all_time',
] as const;

export const OPENSEA_TOP_SORTS = [
  'one_day_volume',
  'seven_days_volume',
  'thirty_days_volume',
  'floor_price',
  'one_day_sales',
  'seven_days_sales',
  'thirty_days_sales',
  'total_volume',
  'total_sales',
] as const;

export const OPENSEA_EVENT_TYPES = [
  'sale',
  'transfer',
  'mint',
  'listing',
  'offer',
  'trait_offer',
  'collection_offer',
] as const;

export const OPENSEA_FLOOR_TIMEFRAMES = [
  'one_minute',
  'five_minutes',
  'fifteen_minutes',
  'one_hour',
  'one_day',
  'seven_days',
  'thirty_days',
  'one_year',
  'all_time',
] as const;

export const OPENSEA_SEARCH_ASSET_TYPES = ['collection', 'nft', 'token', 'account'] as const;

/** Trending collections, sorted by sales activity. Requires the key (measured).
 *  `timeframe` is venue vocabulary; the route rejects unknown values with 400
 *  before this is called. `next` pages; `chains` filters to venue slugs. */
export function trendingCollections(
  limit: unknown = 20,
  timeframe?: unknown,
  chains?: unknown,
  category?: unknown,
  next?: unknown,
): Promise<{ collections: OpenSeaCollectionDetail[]; next?: string | null }> {
  const tf =
    typeof timeframe === 'string' && timeframe.trim() ? `&timeframe=${enc(timeframe)}` : '';
  const ch = typeof chains === 'string' && chains.trim() ? `&chains=${encodeURIComponent(chains.trim())}` : '';
  const cat =
    typeof category === 'string' && category.trim() ? `&category=${enc(category)}` : '';
  const cursor = typeof next === 'string' && next ? `&cursor=${encodeURIComponent(next)}` : '';
  return read(
    `/collections/trending?limit=${clampLimit(limit, 20)}${tf}${ch}${cat}${cursor}`,
    true,
    OPENSEA_STATS_TTL_MS,
  );
}

/** Top collections ranked by a stat, descending. Requires the key (measured).
 *  `sort_by` is venue vocabulary; the route rejects unknown values with 400. */
export function topCollections(
  limit: unknown = 20,
  sortBy?: unknown,
  chains?: unknown,
  category?: unknown,
  next?: unknown,
): Promise<{ collections: OpenSeaCollectionDetail[]; next?: string | null }> {
  const sort = typeof sortBy === 'string' && sortBy.trim() ? `&sort_by=${enc(sortBy)}` : '';
  const ch = typeof chains === 'string' && chains.trim() ? `&chains=${encodeURIComponent(chains.trim())}` : '';
  const cat =
    typeof category === 'string' && category.trim() ? `&category=${enc(category)}` : '';
  const cursor = typeof next === 'string' && next ? `&cursor=${encodeURIComponent(next)}` : '';
  return read(
    `/collections/top?limit=${clampLimit(limit, 20)}${sort}${ch}${cat}${cursor}`,
    true,
    OPENSEA_STATS_TTL_MS,
  );
}

/** One marketplace event: sale, transfer, mint, listing or offer. `payment`
 *  carries the amount in the token's smallest unit with its decimals; `asset`
 *  names the item when the event is item-scoped. */
export type OpenSeaEvent = {
  event_type: string;
  event_timestamp: number;
  chain: string;
  order_type?: string | null;
  quantity?: string | number | null;
  payment?: {
    quantity?: string | null;
    token_address?: string | null;
    decimals?: number | null;
    symbol?: string | null;
  } | null;
  maker?: string | null;
  taker?: string | null;
  order_hash?: string | null;
  asset?: { identifier?: string | null; contract?: string | null; collection?: string | null } | null;
};

/** Events for one collection, optionally trait-filtered. Requires the key
 *  (measured). `event_type` is venue vocabulary; the route rejects unknown
 *  values with 400. `next` pages; `after`/`before` are unix seconds. */
export function collectionEvents(
  slug: string,
  limit: unknown = 20,
  eventType?: unknown,
  next?: unknown,
  after?: unknown,
  before?: unknown,
  traits?: unknown,
): Promise<{ asset_events: OpenSeaEvent[]; next?: string | null }> {
  const et = typeof eventType === 'string' && eventType.trim() ? `&event_type=${enc(eventType)}` : '';
  const cursor = typeof next === 'string' && next ? `&next=${encodeURIComponent(next)}` : '';
  const aft =
    typeof after === 'number' || (typeof after === 'string' && after.trim())
      ? `&after=${encodeURIComponent(String(after).trim())}`
      : '';
  const bef =
    typeof before === 'number' || (typeof before === 'string' && before.trim())
      ? `&before=${encodeURIComponent(String(before).trim())}`
      : '';
  const filter =
    typeof traits === 'string' && traits.trim() ? `&traits=${encodeURIComponent(traits.trim())}` : '';
  return read(
    `/events/collection/${enc(slug)}?limit=${clampLimit(limit, 20)}${et}${cursor}${aft}${bef}${filter}`,
    true,
    OPENSEA_STATS_TTL_MS,
  );
}

/** One search hit. Only the collection leg is typed: nft/token/account hits
 *  arrive under their own keys and are passed through as unknown rather than
 *  pinned to a shape nobody has measured. */
export type OpenSeaSearchHit = {
  type: string;
  collection?: OpenSeaCollectionBrief & {
    opensea_url?: string;
    is_disabled?: boolean;
    is_nsfw?: boolean;
  };
  [k: string]: unknown;
};

/** Search across collections, tokens, NFTs and accounts, ranked by relevance.
 *  Requires the key (measured). `asset_types` defaults upstream to
 *  collection+token; the route rejects unknown values with 400. */
export function searchOpenSea(
  searchQuery: string,
  limit: unknown = 20,
  chains?: unknown,
  assetTypes?: unknown,
): Promise<{ results: OpenSeaSearchHit[] }> {
  const ch = typeof chains === 'string' && chains.trim() ? `&chains=${encodeURIComponent(chains.trim())}` : '';
  const at =
    typeof assetTypes === 'string' && assetTypes.trim()
      ? `&asset_types=${encodeURIComponent(assetTypes.trim())}`
      : '';
  return read(
    `/search?query=${enc(searchQuery)}&limit=${clampLimit(limit, 20)}${ch}${at}`,
    true,
    OPENSEA_STATS_TTL_MS,
  );
}
