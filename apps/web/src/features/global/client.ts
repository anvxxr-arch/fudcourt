/**
 * The global market pulse's client — the three CoinMarketCap reads, typed.
 *
 * TYPING / DISPLAY MIRROR ONLY. All three reads go through the collapsed API
 * gateway (`app/(frontend)/api/[...path]/route.ts`), which forwards verbatim to
 * the `:3101` Go sidecar (`/api/cmc`); that sidecar owns every validation (the
 * `mode` table, the `start`/`limit` bounds, the upstream decrypt). This file
 * must never grow a guard or a validator: a second one is the only thing that
 * could drift from the sidecar's, the same rule `features/risk/client.ts`
 * records for its family.
 *
 * What it does own: the envelope shape the board renders with, the slice it
 * asks for (stated, so the board can never imply it sees the whole market), and
 * the reading of a FAILED upstream — each source resolves to `{data, error}`
 * so a failure on one read is rendered as that read's error, never as an empty
 * table.
 */
import { getJSON } from '@/lib/fetch';
import type { CmcExchangesData, CmcGlobalData, CmcListingData } from './model';

/** The rows requested per ranked page. The board states this slice. */
export const CMC_LISTING_LIMIT = 25;
/** The venues requested. The board states this slice. */
export const CMC_EXCHANGE_LIMIT = 25;
/** 1-based first position of the requested window; the board derives rank from it. */
export const CMC_START = 1;

/**
 * The `:3101` coinmarketcap envelope, verbatim. `data`'s shape depends on
 * `mode`; `start`/`limit` echo the requested window, `upstreamCount` rides the
 * array modes, and `totalCount` (a STRING) lives inside the listing `data`.
 */
export type CmcEnvelope<T> = {
  kind: string;
  upstream: string;
  fetchedAt: number;
  auth: string;
  start?: number;
  limit?: number;
  upstreamCode: number;
  upstreamMsg: string;
  upstreamCount?: number;
  data: T;
  derived: string;
};

/** All three reads, each with its own failure — a half-read board is a stated half. */
export type GlobalSources = {
  global: CmcEnvelope<CmcGlobalData> | null;
  globalError: string | null;
  listing: CmcEnvelope<CmcListingData> | null;
  listingError: string | null;
  exchanges: CmcEnvelope<CmcExchangesData> | null;
  exchangesError: string | null;
};

/** Collapse one promise into the `{data, error}` shape the board renders. */
function settle<T>(url: string, signal?: AbortSignal): Promise<{ data: T | null; error: string | null }> {
  return getJSON<T>(url, { signal, cache: 'no-store' }).then(
    (data) => ({ data, error: null as string | null }),
    (e) => ({ data: null, error: e instanceof Error ? e.message : String(e) })
  );
}

/**
 * Read all three upstreams. A failure on one is NOT a failure of the others:
 * the envelope names which read broke and the board renders that read as an
 * error rather than as an empty table, because "no rows" and "the read failed"
 * are different claims.
 */
export async function fetchGlobalSources(signal?: AbortSignal): Promise<GlobalSources> {
  const [global, listing, exchanges] = await Promise.all([
    settle<CmcEnvelope<CmcGlobalData>>('/api/coinmarketcap?mode=global', signal),
    settle<CmcEnvelope<CmcListingData>>(
      `/api/coinmarketcap?mode=listing&start=${CMC_START}&limit=${CMC_LISTING_LIMIT}`,
      signal
    ),
    settle<CmcEnvelope<CmcExchangesData>>(
      `/api/coinmarketcap?mode=exchanges&start=${CMC_START}&limit=${CMC_EXCHANGE_LIMIT}`,
      signal
    ),
  ]);
  return {
    global: global.data,
    globalError: global.error,
    listing: listing.data,
    listingError: listing.error,
    exchanges: exchanges.data,
    exchangesError: exchanges.error,
  };
}
