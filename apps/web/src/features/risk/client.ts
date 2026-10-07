/**
 * The risk feed's client — the two upstream reads, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. Both reads go through the collapsed API gateway
 * (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to the
 * `:3101` Go sidecar; that sidecar owns every validation (the `mode` table, the
 * `source`/`limit` bounds, the RSS parse). This file must never grow a guard: a
 * second validator is the one thing that could drift from the sidecar's, which
 * is the same rule `features/news/client.ts` records for the news family.
 *
 * What it does own: the shapes the board renders with, so a component reads a
 * typed row instead of `any` — and the reading of a FAILED upstream, which is
 * an error to surface, never an empty feed.
 */
import { getJSON } from '@/lib/fetch';
import type { Headline, PredictionAggregate, PredictionRow } from './model';

/** The only news source the sidecar implements; mirrors its `news.Sources` table. */
export const RISK_NEWS_SOURCE = 'cointelegraph';

/** The rows CryptoRank serves on page 1 of the prediction listing. */
export type PredictionEnvelope = {
  kind: 'prediction';
  upstream: string;
  fetchedAt: number;
  cache: string;
  count: number;
  upstreamTotal: number;
  slice: string;
  prediction: PredictionAggregate;
  predictionRows: PredictionRow[];
};

/** The news sidecar's envelope: `total` is the full parse, `items` the limit head. */
export type NewsEnvelope = {
  items: Headline[];
  total: number;
  upstream: string;
  timestamp: number;
};

/** Both reads, each with its own failure — a half-read feed is a stated half. */
export type RiskSources = {
  prediction: PredictionEnvelope | null;
  predictionError: string | null;
  news: NewsEnvelope | null;
  newsError: string | null;
};

/**
 * Read both upstreams. A failure on one is NOT a failure of the other: the
 * envelope names which side broke and the board renders that side as an error
 * rather than as an empty list, because "no markets" and "the market read
 * failed" are different claims.
 */
export async function fetchRiskSources(signal?: AbortSignal): Promise<RiskSources> {
  const [prediction, news] = await Promise.all([
    getJSON<PredictionEnvelope>('/api/cryptorank?mode=prediction', { signal, cache: 'no-store' }).then(
      (d) => ({ data: d, error: null as string | null }),
      (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) })
    ),
    getJSON<NewsEnvelope>(`/api/news?source=${RISK_NEWS_SOURCE}&limit=40`, { signal, cache: 'no-store' }).then(
      (d) => ({ data: d, error: null as string | null }),
      (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) })
    ),
  ]);
  return {
    prediction: prediction.data,
    predictionError: prediction.error,
    news: news.data,
    newsError: news.error,
  };
}
