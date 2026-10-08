/**
 * The full price list's client — the one upstream read, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. The read goes through the collapsed API gateway
 * (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to the
 * `:3101` Go sidecar; that sidecar owns every validation (the `mode` table, the
 * `key` whitelist, the slice arithmetic). This file must never grow a guard or
 * a validator: a second one is the one thing that could drift from the
 * sidecar's, which is the same rule `features/risk/client.ts` and
 * `features/chains/client.ts` record for their families.
 *
 * What it does own: the shape the board renders with (so a component reads a
 * typed row instead of `any`) and the reading of a FAILED upstream, which is an
 * error to surface — never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type { ConverterRow, ScreenerChangeSource } from './model';

/**
 * `mode=converter` — the full price list. `count`/`upstreamTotal` are both the
 * whole table (5413); `changeSource: 'unavailable'` means the mode ships no 24h
 * change column at all.
 */
export type ConverterEnvelope = {
  kind: 'converter';
  upstream: string;
  fetchedAt: number;
  cache: string;
  count: number;
  upstreamTotal: number;
  /** Slice provenance, as the sidecar words it. */
  slice: string;
  changeSource: ScreenerChangeSource;
  converterRows?: ConverterRow[];
};

/** A read that either resolved to a payload or failed with a reason — never both. */
export type Source<T> = { data: T | null; error: string | null };

/**
 * Read the full price list. A rejection is captured as the error side rather
 * than thrown, so the board can render "the read failed" — never an empty list:
 * "no coins" and "the read broke" are different claims.
 */
export async function fetchConverter(signal?: AbortSignal): Promise<Source<ConverterEnvelope>> {
  try {
    const data = await getJSON<ConverterEnvelope>('/api/cryptorank?mode=converter', { signal, cache: 'no-store' });
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}
