/**
 * The whale watcher's client — the one upstream read, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. The read goes through the collapsed API gateway
 * (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to the
 * `:3101` Go sidecar; that sidecar owns every validation (the `mode` table, the
 * signature, the decrypt). This file must never grow a guard: a second validator
 * is the one thing that could drift from the sidecar's, which is the same rule
 * `features/risk/client.ts` records for its two reads.
 *
 * What it does own: the shape the board renders with, so a component reads a
 * typed row instead of `any` — and the reading of a FAILED upstream, which is an
 * error to surface, never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type { WhalePagination, WhaleRow } from './model';

/** The coinank envelope for `mode=whales`, verbatim (an OBJECT payload). */
export type WhaleEnvelope = {
  kind: 'whales';
  upstream: string;
  fetchedAt: number;
  /** Always the computed client signature — this family carries no issued key. */
  auth: string;
  upstreamCode?: string;
  upstreamMsg?: string;
  data: {
    /** The page's positions. */
    list: WhaleRow[];
    /** The upstream's own page descriptor — the board states seen vs total. */
    pagination: WhalePagination;
  };
  /** What the sidecar did to the bytes. */
  derived: string;
};

/** The read, with its own failure — a failed read is a stated failure, not empty. */
export type WhaleSources = {
  data: WhaleEnvelope | null;
  error: string | null;
};

/**
 * Read page 1 of the upstream whale ranking. A failure resolves to `error` (the
 * envelope names it), and the board renders that error rather than an empty table,
 * because "no positions" and "the ranking read failed" are different claims.
 */
export async function fetchWhaleSource(signal?: AbortSignal): Promise<WhaleSources> {
  return getJSON<WhaleEnvelope>('/api/coinank?mode=whales', { signal, cache: 'no-store' }).then(
    (d) => ({ data: d, error: null as string | null }),
    (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) }),
  );
}
