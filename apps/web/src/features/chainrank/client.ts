/**
 * ChainRank client surface, shared by the API route and the UI.
 *
 * Reverse-engineered from https://www.chainrank.fyi bundles on 2026-09-27
 * (see scripts/verify/verify-chainrank.py for the executable contract).
 *
 * Kept out of app/api/chainrank/route.ts for the same reason as lib/dex.ts:
 * a Next.js route module may only export the known segment config.
 *
 * First-party surface, measured (not guessed):
 *   GET  /api/stats                -> stats envelope
 *   GET  /api/listings?page&pageSize -> {rows,page,pageSize,total,totalPages}
 *   POST /api/click                {listingId, sessionId}   increments a listing's clicks
 *   POST /api/presence             {sessionId}              anonymous heartbeat
 *   POST /api/claim/quote          {target, usdCents, chain, tokenAddress, fromAddress, metadata} -> creates a paymentId
 *   POST /api/claim/confirm        {paymentId, txHash, fromAddress, ...} settles it on-chain
 *   POST /api/upload               multipart file -> {url}
 *
 * Not ours: /api/early_access_features, /api/product_tours, /api/web_experiments,
 * /api/surveys/ are PostHog SDK paths (token= is a PostHog project token), and
 * the /v1/convert|onramp strings belong to the payment SDK -- neither is a
 * chainrank route.
 *
 * Write endpoints are documented here but intentionally NOT proxied: each has a
 * real side effect on someone else's production service (their click counters,
 * a pending payment row, their CDN). The UI and proxy expose only reads.
 */

export const CHAINRANK = 'https://www.chainrank.fyi';

/** Read-only modes. Writes stay undocumented-by-code on purpose. */
export const CR_MODES = ['stats', 'listings'] as const;
export type CrMode = (typeof CR_MODES)[number];

/** A board row. Measured: every field below was present on the live row;
 *  upstream adds fields freely, so the type stays permissive at the edges. */
export type ChainrankRow = {
  id: string;
  key: string;
  /** 'handle' (x.com/...) or 'url' */
  kind: string;
  url: string;
  handle?: string | null;
  title: string;
  description?: string | null;
  logoUrl?: string | null;
  /** cents of USDC raised */
  totalUsdCents: number;
  clicks: number;
  ownerAddress?: string | null;
  lastPaidAt?: string | null;
  createdAt?: string;
  rank: number;
};

export type ChainrankPage = {
  rows: ChainrankRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type ChainrankStats = {
  online: number;
  totalClicks: number;
  listings: number;
  totalUsdCents: number;
  topUsdCents: number;
  claimTopCents: number;
};

/** Upstream's measured pagination semantics -- echoed here as documentation,
 *  enforced nowhere: the proxy relays page/pageSize untouched so the response
 *  is upstream's own clamping, never ours.
 *    page    0 / -1 / 'abc' -> upstream answers page=1 (silent clamp, measured)
 *    pageSize 0             -> upstream answers pageSize=50 (default)
 *    pageSize 1000          -> upstream answers pageSize=200 (cap) */
export const CR_PAGE_DEFAULT = 1;
export const CR_PAGE_SIZE_DEFAULT = 50;
export const CR_PAGE_SIZE_MAX = 200;

/* ---------------------------------------------------------------------------
 * TYPING / DISPLAY MIRROR ONLY (DR-013).
 *
 * The runtime lives in Go: apps/apicalls/internal/chainrank owns the mode table,
 * the upstream URL construction, the shape check, the cache and the refusal
 * messages. app/api/chainrank/route.ts validates nothing and forwards every
 * status/body verbatim, so nothing below may grow a guard: a second validator is
 * the one thing that could drift from the sidecar's (the rule lib/khala.ts,
 * lib/llama.ts and lib/news.ts record).
 *
 * The two envelope shapes are the ones the row types above already describe, with
 * the three labels the Go side stamps on top.
 * ------------------------------------------------------------------------- */

/** `chainrank.Stats` envelope: upstream's counters plus our labels. */
export type ChainrankStatsEnvelope = {
  // Our labels (Go stamps exactly these three):
  kind: 'stats';
  upstream: string;
  fetchedAt: number;
  // Upstream's own fields, spread verbatim — the board renders them as sent:
  online: number;
  totalClicks: number;
  listings: number;
  totalUsdCents: number;
  topUsdCents: number;
  claimTopCents: number;
  [extra: string]: unknown;
};

/** `chainrank.Listings` envelope: upstream's page + rows plus our labels. */
export type ChainrankListingsEnvelope = {
  kind: 'listings';
  upstream: string;
  fetchedAt: number;
  rows: ChainrankRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  [extra: string]: unknown;
};

/** Both modes' 400/405/429/5xx bodies, as the Go side writes them. */
export type ChainrankErrorEnvelope = { error: string; detail?: string };
