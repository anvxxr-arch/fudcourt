/**
 * The derivatives desk's client — the five upstream reads, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. Every read goes through the collapsed API gateway
 * (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to the
 * `:3101` Go sidecar; that sidecar owns every validation (the `mode` tables, the
 * liquidation interval set, the upstream parse). This file must never grow a
 * guard: a second validator is the one thing that could drift from the sidecar's,
 * the same rule `features/risk/client.ts` and `features/news/client.ts` record.
 *
 * What it does own: the shapes the board renders with, so a component reads a
 * typed row instead of `any` — and the reading of a FAILED upstream, which is an
 * error to surface, never an empty board. A read that fails says so on its own
 * side: one dead source is not a dead board.
 */
import { getJSON } from '@/lib/fetch';
import type {
  DerivativesMarketRow,
  DerivativesStatistics,
  FundingExtremes,
  LiquidationRow,
  LiqInterval,
  LongShortRow,
} from './model';

/**
 * The CoinGlass envelope, shared by all three `mode`s. `data` is an object for
 * `statistics` and `fundingRate`, and a 20-row array for `markets`;
 * `upstreamCount` rides on the array modes.
 */
export type CoinglassEnvelope<T> = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  cipher: boolean;
  encrypted: boolean;
  upstreamCode: number;
  upstreamMsg: string;
  data: T;
  derived: string;
  upstreamCount?: number;
};

/**
 * The CoinAnk envelope. `data` is a 10-row array for `liquidation` (carrying the
 * `interval` it answered for) and a 726-row array for `longShort`.
 */
export type CoinankEnvelope<T> = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  auth: string | boolean;
  upstreamCode: number;
  upstreamCount?: number;
  data: T;
  derived: string;
  /** Set only on a labelled last-good serve: upstream refusing, data old. */
  stale?: boolean;
  staleAgeSec?: number;
  interval?: string;
};

/** The four fixed reads, each with its own failure — a half-read tape is a stated half. */
export type DerivativeSources = {
  statistics: CoinglassEnvelope<DerivativesStatistics> | null;
  statisticsError: string | null;
  markets: CoinglassEnvelope<DerivativesMarketRow[]> | null;
  marketsError: string | null;
  funding: CoinglassEnvelope<FundingExtremes> | null;
  fundingError: string | null;
  longShort: CoinankEnvelope<LongShortRow[]> | null;
  longShortError: string | null;
};

/** The liquidation read, keyed to an interval — refetched when the selector moves. */
export type LiquidationRead = {
  data: CoinankEnvelope<LiquidationRow[]> | null;
  error: string | null;
};

/**
 * Read the four fixed sources. A failure on one is NOT a failure of the others:
 * the envelope names which side broke and the board renders that side as an error
 * rather than as an empty list, because "no markets" and "the market read failed"
 * are different claims.
 */
export async function fetchDerivativeSources(signal?: AbortSignal): Promise<DerivativeSources> {
  const [statistics, markets, funding, longShort] = await Promise.all([
    getJSON<CoinglassEnvelope<DerivativesStatistics>>('/api/coinglass?mode=statistics', { signal, cache: 'no-store' }).then(
      (data) => ({ data, error: null as string | null }),
      (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) })
    ),
    getJSON<CoinglassEnvelope<DerivativesMarketRow[]>>('/api/coinglass?mode=markets', { signal, cache: 'no-store' }).then(
      (data) => ({ data, error: null as string | null }),
      (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) })
    ),
    getJSON<CoinglassEnvelope<FundingExtremes>>('/api/coinglass?mode=fundingRate', { signal, cache: 'no-store' }).then(
      (data) => ({ data, error: null as string | null }),
      (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) })
    ),
    getJSON<CoinankEnvelope<LongShortRow[]>>('/api/coinank?mode=longShort', { signal, cache: 'no-store' }).then(
      (data) => ({ data, error: null as string | null }),
      (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) })
    ),
  ]);
  return {
    statistics: statistics.data,
    statisticsError: statistics.error,
    markets: markets.data,
    marketsError: markets.error,
    funding: funding.data,
    fundingError: funding.error,
    longShort: longShort.data,
    longShortError: longShort.error,
  };
}

/**
 * Read the per-venue liquidations for one interval. The interval must be one of
 * the six `LIQ_INTERVALS`; anything else is a local 400 from the sidecar (an
 * unsupported interval answers HTTP 200 with a wall of zeros, which the board
 * must never render as data).
 */
export async function fetchLiquidation(interval: LiqInterval, signal?: AbortSignal): Promise<LiquidationRead> {
  const read = await getJSON<CoinankEnvelope<LiquidationRow[]>>(`/api/coinank?mode=liquidation&interval=${interval}`, {
    signal,
    cache: 'no-store',
  }).then(
    (data) => ({ data, error: null as string | null }),
    (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) })
  );
  return { data: read.data, error: read.error };
}
