/**
 * OpenSea API v2 — the NFT venue.
 *
 * Auth is per-endpoint, and that was MEASURED (2026-10-09) rather than assumed:
 *
 *   GET /api/v2/collections                           -> 200 WITHOUT a key
 *   GET /api/v2/chain/{chain}/contract/{addr}/nfts     -> 401 "Missing an API Key,
 *                                                         which is required for
 *                                                         this request."
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
 * `kind` into a status code.
 *
 * `chain` here is OpenSea's own slug vocabulary (`ethereum`, `matic`, `base`,
 * `arbitrum`, `optimism`, `solana`, …). That is a DIFFERENT question from the
 * treasury's `venues` dimension, whose `wallets.chain` column holds display
 * strings ('BSC', 'Solana') resolved case-insensitively against venue keys.
 * There is deliberately no mapping between the two: guessing whether 'BSC' means
 * OpenSea's `matic` would be inventing a fact, so a caller that knows its chain
 * passes the slug.
 */
import { limitedFetch } from '@/lib/rate-limit';

export const OPENSEA_BASE = 'https://api.opensea.io/api/v2';

/** Near-static metadata, so a minute is ample and keeps a browsing surface from
 *  spending the key's budget on repeat reads. The shared outbound limiter
 *  already paces every origin at <=5 req/s, so this reader adds no pacing. */
export const OPENSEA_TTL_MS = 60_000;

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

/** Why a read failed, so a route can map it to a status instead of a guess. */
export type OpenSeaFailureKind = 'missing-key' | 'rejected' | 'upstream' | 'transport';

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
    throw new OpenSeaError(
      'upstream',
      `OpenSea responded ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

const enc = (s: string) => encodeURIComponent(s.trim());

/** The venue's own collection index. Keyless (measured). */
export function listCollections(limit: unknown = 20): Promise<{ collections: OpenSeaCollectionBrief[] }> {
  return read(`/collections?limit=${clampLimit(limit)}`, false);
}

/** One collection record by slug. Keyless (measured). */
export function getCollection(slug: string): Promise<OpenSeaCollectionDetail> {
  return read(`/collections/${enc(slug)}`, false);
}

/** The NFTs of one contract. Requires the key (measured). */
export function contractNfts(
  chain: string,
  contract: string,
  limit: unknown = 20,
): Promise<{ nfts: OpenSeaNFT[] }> {
  return read(`/chain/${enc(chain)}/contract/${enc(contract)}/nfts?limit=${clampLimit(limit)}`, true);
}

/** The NFTs one account holds on one chain. Requires the key (measured). */
export function accountNfts(
  chain: string,
  address: string,
  limit: unknown = 20,
): Promise<{ nfts: OpenSeaNFT[] }> {
  return read(`/chain/${enc(chain)}/account/${enc(address)}/nfts?limit=${clampLimit(limit)}`, true);
}
