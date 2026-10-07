/**
 * The spot-ETF flow desk's client — the one upstream read, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. The read goes through the collapsed API gateway
 * (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to the
 * `:3101` Go sidecar; that sidecar owns every validation (the `mode` table, the
 * bounds, the upstream parse). This file must never grow a guard: a second
 * validator is the one thing that could drift from the sidecar's. The same rule
 * `features/risk/client.ts` and `features/news/client.ts` record.
 *
 * What it does own: the shape the board renders from, so a component reads a
 * typed row instead of `any` — and the reading of a FAILED upstream, which is an
 * error to surface, never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type { EtfDayRow } from './model';

/**
 * The CoinAnk `mode=etf` envelope. `data` is the day array (707 rows, newest
 * first). `upstreamCount`, when present, is upstream's own count of what it
 * served.
 */
export type EtfEnvelope = {
  kind: 'etf';
  upstream: string;
  fetchedAt: number;
  auth: string | boolean;
  upstreamCode: number;
  upstreamCount?: number;
  data: EtfDayRow[];
  derived: string;
};

/** The read, with its own failure — a half-read board is a stated half. */
export type EtfSources = {
  data: EtfEnvelope | null;
  error: string | null;
};

/**
 * Read the ETF flow feed. A failure is NOT an empty read: the caller renders the
 * error side, because "no ETF rows this window" and "the upstream read failed"
 * are different claims and only one is true.
 */
export async function fetchEtfSource(signal?: AbortSignal): Promise<EtfSources> {
  return getJSON<EtfEnvelope>('/api/coinank?mode=etf', { signal, cache: 'no-store' }).then(
    (data) => ({ data, error: null as string | null }),
    (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) })
  );
}
