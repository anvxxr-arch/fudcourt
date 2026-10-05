/**
 * DeFiLlama client surface, shared by the API route and the UI.
 *
 * Probed live 2026-09-27 against api.llama.fi (public, keyless API).
 * Measured facts these types encode:
 *  - GET /v2/chains               -> list[467], UNSORTED by tvl, 64KB
 *  - GET /protocols                -> list[8386], pre-sorted tvl desc,
 *                                      8.9MB (too heavy to ship raw; 1238
 *                                      entries have tvl=null, at the tail)
 *  - GET /v2/historicalChainTvl    -> list[3288] {date, tvl}, 122KB
 *  - GET /protocol/{slug}         -> 29.7MB single protocol -> never proxied
 *
 * Route modules may only export segment config, so shared types live here.
 */

/** The three reads we proxy. Anything else is a loud 400, not a silent default. */
export const LLAMA_MODES = ['chains', 'protocols', 'historical'] as const;
export type LlamaMode = (typeof LLAMA_MODES)[number];

export const LLAMA_UPSTREAM = 'https://api.llama.fi';

/** Top-protocols trim limits. The 8.9MB upstream body is fetched in full
 * (cached once) and the head is relayed; upstreamTotal always reports what
 * was actually fetched so a trimmed list never implies it is the whole set. */
export const PROTOCOLS_TOP_DEFAULT = 50;
export const PROTOCOLS_TOP_MAX = 200;

/** History window limits. 3288 days is everything upstream has (since 2017). */
export const HISTORICAL_DAYS_DEFAULT = 365;
export const HISTORICAL_DAYS_MAX = 3288;

export interface LlamaChain {
  name: string;
  tvl: number;
  tokenSymbol?: string | null;
  gecko_id?: string | null;
  chainId?: number | null;
}

/** One protocol from the /protocols head — fields measured from live rows. */
export interface LlamaProtocol {
  name: string;
  slug: string;
  category: string | null;
  tvl: number | null; // null happens upstream (1238 of 8386 rows) -> UI shows em-dash
  change_1d: number | null;
  change_7d: number | null;
  mcap: number | null;
  chains: string[];
  url: string | null;
  logo: string | null;
}

export interface LlamaHistoricalPoint {
  date: number;
  tvl: number;
}

/**
 * Derived-view markers. The route returns these whenever it changes the
 * upstream payload (sorting, trimming) — the UI must surface them instead of
 * implying the body is upstream verbatim.
 */
export interface LlamaEnvelope {
  upstream: string;
  fetchedAt: number;
  upstreamTotal: number;
  derived: string; // e.g. "sorted by tvl (upstream sends unsorted)"
}

import { getJSON } from '@/lib/fetch';

/** Proxy-board payload: rows plus the derived-view markers from LlamaEnvelope. */
export interface LlamaBoardResponse {
  rows?: any[];
  derived?: string;
  upstreamTotal?: number;
}

export function fetchLlamaBoards(): Promise<[LlamaBoardResponse, LlamaBoardResponse, LlamaBoardResponse]> {
  return Promise.all([
    getJSON<LlamaBoardResponse>('/api/llama?mode=chains', { cache: 'no-store' }),
    getJSON<LlamaBoardResponse>('/api/llama?mode=protocols&top=50', { cache: 'no-store' }),
    getJSON<LlamaBoardResponse>('/api/llama?mode=historical&days=180', { cache: 'no-store' }),
  ]);
}
