/**
 * news (Cointelegraph RSS) — TYPING / DISPLAY MIRROR ONLY.
 *
 * The runtime lives in Go: backend/data/internal/news owns the feed table, the
 * strict `source`/`limit` validation, the per-process TTL cache + single-flight
 * and the RSS parse. app/api/news/route.ts validates nothing and forwards every
 * status/body verbatim, so this file must never grow a guard: a second
 * validator is the one thing that could drift from the sidecar's (DR-012, the
 * same rule `features/llama/client.ts` records).
 *
 * What it does own: the shapes the board renders with, so a component reads a
 * typed row instead of `any`.
 */

/** The only implemented feed; mirrors Go's `news.Sources` table. */
export const NEWS_SOURCES = ['cointelegraph'] as const;

/** Inclusive `limit` bounds, mirroring Go's LimitMin/LimitMax (the 400 phrases
 * `between 1 and 100` come from the same pair). */
export const NEWS_LIMIT_MIN = 1;
export const NEWS_LIMIT_MAX = 100;
/** The sidecar's default when `limit` is absent (Go's LimitDefault). */
export const NEWS_LIMIT_DEFAULT = 30;

/** One RSS entry: exactly the six keys Go's `news.Item` ships. Every key is
 * always PRESENT (`''` for an absent feed element), never null — the Go struct
 * has no omitempty for the same reason. */
export type NewsItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  image: string;
  /** The outlet's display name (`Cointelegraph`), not the `source` param. */
  source: string;
};

/** The sidecar's success envelope. `total` is the FULL parsed item count while
 * `items` is the `limit` head, so a 5-row body is never readable as "the feed
 * has 5 items". */
export type NewsEnvelope = {
  items: NewsItem[];
  total: number;
  upstream: string;
  /** Milliseconds, matching Date.now() (the Go side multiplies Unix seconds). */
  timestamp: number;
};

import { getJSON } from '@/lib/fetch';

export function fetchNews(limit = NEWS_LIMIT_DEFAULT): Promise<{ items?: NewsItem[] }> {
  return getJSON<{ items?: NewsItem[] }>(`/api/news?limit=${limit}`, { cache: 'no-store' });
}
