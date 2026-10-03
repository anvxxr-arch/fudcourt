/**
 * CoinGlass client surface, shared by the API route and any future board.
 *
 * Runtime lives in Go: backend/data/internal/research/coinglass. This module is
 * the TYPING / DISPLAY MIRROR (DR-013) -- the mode table, the param-scoping
 * matrix and the envelope shape, nothing executable. app/api/coinglass/route.ts
 * forwards every status/body verbatim, so nothing here may grow a guard: a second
 * validator is the one thing that could drift from the sidecar's.
 *
 * Upstream: https://capi.coinglass.com -- the www.coinglass.com dashboard's own
 * backend. It is KEYLESS BY DECRYPTION: the body is two rounds of AES-128-ECB +
 * PKCS#7, each gzip'd, and the key is derived from a `v` rotation slot the
 * response carries. The documented open-api-v4.coinglass.com host needs a
 * human-issued CG-API-KEY and is deliberately NOT wired -- a different product,
 * not an alternative transport for these modes.
 *
 * Public surface on :3100:
 *   GET /api/coinglass?mode=<statistics|openInterest|fundingRate|markets>[&symbol=<SYM>][&fresh=1]
 */

export const COINGLASS = 'https://capi.coinglass.com';

/** Read-only modes, in the sidecar's declaration order (its 400 body lists them). */
export const CG_MODES = ['statistics', 'openInterest', 'fundingRate', 'markets'] as const;
export type CgMode = (typeof CG_MODES)[number];

/**
 * Param-scoping matrix: which query params a mode accepts. `mode` and `fresh` are
 * accepted everywhere (`fresh=1` is request policy, not mode data); `symbol` is
 * read by mode=openInterest ONLY. A param a mode does not accept -- including a
 * known param sent to the wrong mode, and any unknown name -- is a 400
 * `unexpected param` from the sidecar, never silently ignored.
 */
export const CG_ACCEPTS: Record<CgMode, readonly string[]> = {
  statistics: ['mode', 'fresh'],
  openInterest: ['mode', 'symbol', 'fresh'],
  fundingRate: ['mode', 'fresh'],
  markets: ['mode', 'fresh'],
};

/** `symbol` bound, echoed for readers. Enforced in Go (`coinglass.SymbolRe`), never here. */
export const CG_SYMBOL_RE = /^[A-Z0-9]{1,20}$/;

/**
 * The sidecar's frozen envelope: provenance on top of upstream's `data`, verbatim.
 *
 * `data` is typed `unknown` on purpose -- the family re-shapes nothing, so any
 * row type here would be a guess about a payload we did not author. Consumers
 * narrow it themselves.
 */
export type CgEnvelope = {
  kind: CgMode;
  upstream: string;
  fetchedAt: number;
  /** the `v` rotation slot that produced this payload's keys (absent when plain JSON) */
  cipher?: string;
  /** false when upstream answered plain JSON (it mixes both, e.g. a refusal) */
  encrypted: boolean;
  upstreamCode?: string;
  upstreamMsg?: string;
  /** present only for an ARRAY payload; ABSENT for an object -- never a 0 */
  upstreamCount?: number;
  data: unknown;
  /** what the shaper did to `data`, in words */
  derived: string;
  [extra: string]: unknown;
};

/** The 400/502 bodies, as the Go side writes them. */
export type CgErrorEnvelope = {
  error: string;
  detail?: string;
  mode?: string;
  /** upstream's own refusal code (502 `upstream refused` only) */
  code?: string;
  modes?: readonly string[];
  got?: string | null;
  param?: string;
};
