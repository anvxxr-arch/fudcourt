/**
 * The sector / tag taxonomy client — the two upstream reads, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. Both reads go through the collapsed API gateway
 * (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to the
 * `:3101` Go sidecar; that sidecar owns every validation (the `mode` table, the
 * tag slug resolution, the 404 for an unknown slug). This file must never grow a
 * guard or a validator: a second one is the one thing that could drift from the
 * sidecar's, which is the same rule `features/risk/client.ts` records.
 *
 * What it does own: the shapes the board renders with (so a component reads a
 * typed row instead of `any`) and the reading of a FAILED upstream, which is an
 * error to surface — never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type { TagChangeSource, TagCoinRow, TagInfo, TagRow } from './model';

/** The envelope fields every CryptoRank mode shares. */
export type CryptorankEnvelope = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  cache: string;
  count: number;
  /** Present when upstream states a full table size. */
  upstreamTotal?: number | null;
  /** Slice provenance, as the sidecar words it. */
  slice?: string;
  /** How the change column was obtained, when the mode carries one. */
  changeSource?: TagChangeSource;
};

/** `mode=tags` — the topic taxonomy index (`tagRows[183]`). */
export type TagsEnvelope = CryptorankEnvelope & { kind: 'tags'; tagRows?: TagRow[] };
/** `mode=tag&key=<slug>` — `tag` is the header, `rows` the coins. */
export type TagEnvelope = CryptorankEnvelope & { kind: 'tag'; tag?: TagInfo; rows?: TagCoinRow[] };

/** A read that either resolved to a payload or failed with a reason — never both. */
export type Source<T> = { data: T | null; error: string | null };

/**
 * One read. A rejection (including the sidecar's 404 for an unknown slug) is
 * captured as the error side rather than thrown, so the board renders "the read
 * failed" for THIS selection: "no rows" and "the read broke" are different
 * claims.
 */
async function read<T>(url: string, signal?: AbortSignal): Promise<Source<T>> {
  try {
    const data = await getJSON<T>(url, { signal, cache: 'no-store' });
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `mode=tags` — the topic taxonomy index (183 rows). */
export function fetchTags(signal?: AbortSignal): Promise<Source<TagsEnvelope>> {
  return read<TagsEnvelope>('/api/cryptorank?mode=tags', signal);
}

/** `mode=tag&key=<slug>` — one tag's page. An unknown slug resolves to a 404 error side. */
export function fetchTag(slug: string, signal?: AbortSignal): Promise<Source<TagEnvelope>> {
  return read<TagEnvelope>(`/api/cryptorank?mode=tag&key=${slug}`, signal);
}
