/**
 * The media & news board's client — the three CryptoRank reads, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. Every read goes through the collapsed API
 * gateway (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to
 * the `:3101` Go sidecar; that sidecar owns every validation (the `mode` table,
 * the `key` handling, the `newstag` soft-404 -> HTTP 404, the slice
 * arithmetic). This file must never grow a guard or a validator: a second one
 * is the one thing that could drift from the sidecar's — the same rule
 * `features/risk/client.ts` and `features/news/client.ts` record.
 *
 * What it does own: the shapes the board renders with (so a component reads a
 * typed row instead of `any`) and the reading of a FAILED upstream, which is an
 * error to surface — never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type { MediaRow, NewsRow, NewsTagInfo, RelatedTag } from './model';

/** The envelope fields every CryptoRank mode shares. */
export type CryptorankEnvelope = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  cache: string;
  count: number;
  /** Present when upstream states a full table size (media ships 479). */
  upstreamTotal?: number | null;
  /** Slice provenance, as the sidecar words it. */
  slice?: string;
  /** 'unavailable' means the mode carries no change column — say so, never 0. */
  changeSource?: string;
};

/** `mode=media` — the YouTube video feed, page 1. */
export type MediaEnvelope = CryptorankEnvelope & { kind: 'media'; mediaRows?: MediaRow[] };

/** `mode=news` — the publisher news wire, page 1. */
export type NewsEnvelope = CryptorankEnvelope & { kind: 'news'; newsRows?: NewsRow[] };

/** `mode=newstag&key=<slug>` — `tag` is the header, `newsRows` the articles. */
export type NewstagEnvelope = CryptorankEnvelope & {
  kind: 'newstag';
  tag?: NewsTagInfo;
  newsRows?: NewsRow[];
  relatedTags?: RelatedTag[];
};

/** A read that either resolved to a payload or failed with a reason — never both. */
export type Source<T> = { data: T | null; error: string | null };

/**
 * One read. A rejection (including the sidecar's HTTP 404 for an unknown tag
 * slug) is captured as the error side rather than thrown, so the board can
 * render "the read failed" for THIS section while the others keep their own
 * state: "no rows" and "the read broke" are different claims.
 */
async function read<T>(url: string, signal?: AbortSignal): Promise<Source<T>> {
  try {
    const data = await getJSON<T>(url, { signal, cache: 'no-store' });
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `mode=media` — the video feed (10 of 479). */
export function fetchMedia(signal?: AbortSignal): Promise<Source<MediaEnvelope>> {
  return read<MediaEnvelope>('/api/cryptorank?mode=media', signal);
}

/** `mode=news` — the news wire (10 items, page 1). */
export function fetchNews(signal?: AbortSignal): Promise<Source<NewsEnvelope>> {
  return read<NewsEnvelope>('/api/cryptorank?mode=news', signal);
}

/**
 * `mode=newstag&key=<slug>` — one tag's board. An unknown slug is answered as
 * HTTP 404 by the sidecar; `read` turns that into the error side, so the caller
 * surfaces it rather than rendering an unfiltered feed under a tag label.
 */
export function fetchNewstag(slug: string, signal?: AbortSignal): Promise<Source<NewstagEnvelope>> {
  return read<NewstagEnvelope>(`/api/cryptorank?mode=newstag&key=${encodeURIComponent(slug)}`, signal);
}
