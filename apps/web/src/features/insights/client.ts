/**
 * The insights boards' client — the two upstream reads, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. Both reads go through the collapsed API gateway
 * (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to the
 * `:3101` Go sidecar; that sidecar owns every validation (the `mode` table, the
 * slice arithmetic). This file must never grow a guard or a validator: a second
 * one is the one thing that could drift from the sidecar's, which is the same rule
 * `features/risk/client.ts` records for the prediction family.
 *
 * What it does own: the shapes the board renders with (so a component reads a
 * typed row instead of `any`) and the reading of a FAILED upstream, which is an
 * error to surface — never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type { AiOverview, QuarterlyRow } from './model';

/** The envelope fields every CryptoRank mode shares. */
export type CryptorankEnvelope = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  cache: string;
  count: number;
  /** The sidecar's own slice provenance, when the mode carries one. */
  slice?: string;
  /** Present when upstream states a full table size. */
  upstreamTotal?: number | null;
};

/** `mode=quarterly` — the BTC and ETH quarterly tables. */
export type QuarterlyEnvelope = CryptorankEnvelope & {
  kind: 'quarterly';
  quarterlyBtc?: QuarterlyRow[];
  quarterlyEth?: QuarterlyRow[];
};

/** `mode=aioverview` — CryptoRank's own AI digest. */
export type AiOverviewEnvelope = CryptorankEnvelope & {
  kind: 'aioverview';
  aiOverview?: AiOverview;
};

/** A read that either resolved to a payload or failed with a reason — never both. */
export type Source<T> = { data: T | null; error: string | null };

/**
 * One read. A rejection is captured as the error side rather than thrown, so the
 * board can render "the read failed" for THIS section while the other keeps its
 * own state: "no rows" and "the read broke" are different claims.
 */
async function read<T>(url: string, signal?: AbortSignal): Promise<Source<T>> {
  try {
    const data = await getJSON<T>(url, { signal, cache: 'no-store' });
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `mode=quarterly` — the BTC and ETH quarterly price tables. */
export function fetchQuarterly(signal?: AbortSignal): Promise<Source<QuarterlyEnvelope>> {
  return read<QuarterlyEnvelope>('/api/cryptorank?mode=quarterly', signal);
}

/** `mode=aioverview` — CryptoRank's own AI market digest. */
export function fetchAiOverview(signal?: AbortSignal): Promise<Source<AiOverviewEnvelope>> {
  return read<AiOverviewEnvelope>('/api/cryptorank?mode=aioverview', signal);
}
