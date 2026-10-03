/**
 * CoinMarketCap client surface, shared by the API route and any future board.
 *
 * Runtime lives in Go: backend/data/internal/research/coinmarketcap. This module
 * is the TYPING / DISPLAY MIRROR (DR-013) -- the mode table, the param-scoping
 * matrix, the pagination bounds and the envelope shape, nothing executable.
 * app/api/coinmarketcap/route.ts forwards every status/body verbatim, so nothing
 * here may grow a guard: a second validator is the one thing that could drift from
 * the sidecar's.
 *
 * Upstream: https://api.coinmarketcap.com/data-api/v3 -- the coinmarketcap.com
 * dashboard's own backend. It is KEYLESS BY HAVING NO CREDENTIAL AT ALL: no key,
 * no signature, no ciphertext, so the fetch is a plain GET. The documented
 * pro-api.coinmarketcap.com host needs an issued X-CMC_PRO_API_KEY and is
 * deliberately NOT wired -- a different product, not an alternative transport.
 *
 * A REFUSAL IS HTTP 200. CoinMarketCap signals a refusal as `status.error_code !=
 * "0"` on a 200, so the sidecar maps it to a 502 carrying upstream's own code and
 * message. And `limit=0` is a SUCCESS envelope carrying an EMPTY list, which is
 * why the pagination bounds below are validated locally BEFORE any request.
 *
 * Public surface on :3100:
 *   GET /api/coinmarketcap?mode=<listing|global|marketPairs|exchanges>[&slug=<S>][&start=<n>][&limit=<n>][&fresh=1]
 */

export const COINMARKETCAP = 'https://api.coinmarketcap.com/data-api/v3';

/** Read-only modes, in the sidecar's declaration order (its 400 body lists them). */
export const CMC_MODES = ['listing', 'global', 'marketPairs', 'exchanges'] as const;
export type CmcMode = (typeof CMC_MODES)[number];

/**
 * Param-scoping matrix: which query params a mode accepts. `mode` and `fresh` are
 * accepted everywhere; `slug` is read by mode=marketPairs ONLY, `start`/`limit` by
 * the paginated modes (all but `global`). A param a mode does not accept --
 * including a known param sent to the wrong mode, and any unknown name -- is a 400
 * `unexpected param` from the sidecar. Upstream silently IGNORES an unrecognised
 * param, so accepting one would be a lie about what was honoured.
 */
export const CMC_ACCEPTS: Record<CmcMode, readonly string[]> = {
  listing: ['mode', 'start', 'limit', 'fresh'],
  global: ['mode', 'fresh'],
  marketPairs: ['mode', 'slug', 'start', 'limit', 'fresh'],
  exchanges: ['mode', 'start', 'limit', 'fresh'],
};

/**
 * Pagination bounds, echoed for readers. Enforced in Go before any fetch, never
 * here. `limit=0` is refused because upstream answers it with a SUCCESS envelope
 * carrying an EMPTY list -- a pass-through would render it as a confident empty
 * board. `limit=99999` is refused because upstream would answer a ~9.6 MB body.
 */
export const CMC_LIMIT_MIN = 1;
export const CMC_LIMIT_MAX = 1000;
export const CMC_LIMIT_DEFAULT = 100;
export const CMC_START_MIN = 1;
export const CMC_START_MAX = 100000;
export const CMC_START_DEFAULT = 1;

/**
 * The sidecar's frozen envelope: provenance on top of upstream's `data`, verbatim.
 *
 * `data` is typed `unknown` on purpose -- the family re-shapes nothing, so any row
 * type here would be a guess about a payload we did not author.
 */
export type CmcEnvelope = {
  kind: CmcMode;
  upstream: string;
  fetchedAt: number;
  /** how the request was authorised: no credential at all */
  auth: string;
  /** the coin slug, echoed for mode=marketPairs (the row set is scoped to it) */
  slug?: string;
  /** the EFFECTIVE pagination for the paginated modes, echoed (the handler defaults them) */
  start?: number;
  limit?: number;
  upstreamCode?: string;
  upstreamMsg?: string;
  /** present only for an ARRAY payload; ABSENT for an object (mode=global) -- never a 0 */
  upstreamCount?: number;
  data: unknown;
  derived: string;
  [extra: string]: unknown;
};

/** The 400/405/502 bodies, as the Go side writes them. */
export type CmcErrorEnvelope = {
  error: string;
  detail?: string;
  mode?: string;
  code?: string;
  modes?: readonly string[];
  got?: string | null;
  param?: string;
};
