/**
 * The funding desk's client — the one upstream read, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. The read goes through the collapsed API gateway
 * (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to the
 * `:3101` Go sidecar; that sidecar owns every validation (the `mode` table, the
 * CoinAnk parse, the keyless client signature). This file must never grow a
 * guard: a second validator is the one thing that could drift from the
 * sidecar's, the same rule `features/risk/client.ts` and
 * `features/derivatives/client.ts` record.
 *
 * What it does own: the shape the board renders with, so a component reads a
 * typed row instead of `any` — and the reading of a FAILED upstream, which is an
 * error to surface, never an empty board.
 */
import { getJSON } from '@/lib/fetch';
import type { FundingSymbolRow } from './model';

/**
 * The CoinAnk envelope for `mode=fundingRate`. `data` is one row per SYMBOL,
 * each carrying its `umap` / `cmap` venue maps; `upstreamCount` is the symbol
 * count the upstream reports (885).
 */
export type CoinankFundingEnvelope = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  auth: string | boolean;
  upstreamCode: string | number;
  upstreamCount?: number;
  data: FundingSymbolRow[];
  derived: string;
};

/** The single read, with its own failure — a dead source is not an empty board. */
export type FundingRead = {
  data: CoinankFundingEnvelope | null;
  error: string | null;
};

/**
 * Read the per-symbol funding-rate matrix. A failure resolves to the error side
 * (never an empty list), because "no symbols" and "the funding read failed" are
 * different claims and only one of them is true when the gateway errors.
 */
export async function fetchFundingRates(signal?: AbortSignal): Promise<FundingRead> {
  return getJSON<CoinankFundingEnvelope>('/api/coinank?mode=fundingRate', { signal, cache: 'no-store' }).then(
    (data) => ({ data, error: null as string | null }),
    (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) }),
  );
}
