/**
 * Home markets Indonesia domain: rupiah crosses / IDX indices board,
 * the BI-Rate, and annual structural indicators (`/api/market/indonesia`).
 */
import type { Quote } from './client-markets-quotes';
import type { UpstreamFailure } from './client-markets-macro';

/**
 * The Indonesia board: LIVE rupiah crosses + IDX indices (Yahoo), the BI-Rate
 * (BIS), and annual structural indicators (World Bank).
 */
export const INDONESIA_URL = '/api/market/indonesia';

/** A rupiah/index row: a Yahoo quote plus the group it belongs to and a note. */
export type IndonesiaQuote = Quote & { group: string; note: string };

/** The BI-Rate row. `rate` is percent per annum; `date` is the BIS observation. */
export type IndonesiaPolicy = {
  area: string;
  label: string;
  rate: number | null;
  date: string | null;
  note: string;
};

/**
 * One annual Indonesian indicator. `kind` drives formatting (`usd`/`count` are
 * compacted), and `year` is MANDATORY next to the value — an annual figure shown
 * without its year reads as current when it is not.
 */
export type IndonesiaEconomyRow = {
  id: string;
  name: string;
  group: string;
  kind: string;
  decimals: number;
  value: number | null;
  year: string | null;
  note: string;
};

export type IndonesiaEnvelope = {
  quotes: IndonesiaQuote[];
  policy: IndonesiaPolicy;
  economy: IndonesiaEconomyRow[];
  /**
   * Provenance of the IMF Fiscal Monitor block: which vintage, when it was
   * published, the last fiscal year it can call an outturn, and how many
   * projection years were withheld. Null when the IMF block is unavailable.
   */
  apbn: {
    vintage: string;
    published: string;
    actualThrough: number;
    droppedProjections: number;
  } | null;
  count: number;
  failed: UpstreamFailure[];
  upstream: string[];
  userAgent: string;
  asOf: number;
  derived: string;
};
