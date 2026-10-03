/**
 * CoinAnk client surface, shared by the API route and any future board.
 *
 * Runtime lives in Go: backend/data/internal/research/coinank. This module is the
 * TYPING / DISPLAY MIRROR (DR-013) -- the mode table, the interval allowlist, the
 * param-scoping matrix and the envelope shape, nothing executable.
 * app/api/coinank/route.ts forwards every status/body verbatim, so nothing here
 * may grow a guard: a second validator is the one thing that could drift from the
 * sidecar's.
 *
 * Upstream: https://api.coinank.com -- the coinank.com dashboard's own backend. It
 * is KEYLESS BY A COMPUTED SIGNATURE: the `coinank-apikey` header is derived in
 * the browser bundle from a public uuid constant and the clock (see
 * backend/data/internal/research/coinank/sign.go). The documented
 * open-api.coinank.com host needs a paid VIP key and is deliberately NOT wired.
 *
 * EVERY MODE IS CURRENTLY DARK: upstream refuses all five with HTTP 502
 * `{"code":"403","detail":"CoinAnk refused the request: please sub api to get data"}`.
 * The family ships wired-but-dark on purpose (DR-038) -- the route and the mirror
 * are correct; the upstream wall is what is missing.
 *
 * Public surface on :3100:
 *   GET /api/coinank?mode=<fundingRate|liquidation|longShort|etf|whales>[&interval=<I>][&fresh=1]
 */

export const COINANK = 'https://api.coinank.com';

/** Read-only modes, in the sidecar's declaration order (its 400 body lists them). */
export const CN_MODES = ['fundingRate', 'liquidation', 'longShort', 'etf', 'whales'] as const;
export type CnMode = (typeof CN_MODES)[number];

/**
 * The `interval` values mode=liquidation accepts, in the order the 400 body lists
 * them. This is an ALLOWLIST because CoinAnk does not reject a bad interval -- it
 * ANSWERS one: an unsupported value comes back HTTP 200 with the same exchange
 * rows and `totalTurnover=0` on every row, indistinguishable from "no
 * liquidations occurred". Refusing locally is what makes that fabricated zero
 * unreachable. Enforced in Go (`coinank.Intervals`), never here.
 */
export const CN_INTERVALS = ['1h', '2h', '4h', '6h', '12h', '1d'] as const;
export type CnInterval = (typeof CN_INTERVALS)[number];

/** What an omitted `interval` resolves to upstream (measured: byte-identical to interval=1h). */
export const CN_DEFAULT_INTERVAL: CnInterval = '1h';

/**
 * Param-scoping matrix: which query params a mode accepts. `mode` and `fresh` are
 * accepted everywhere; `interval` is read by mode=liquidation ONLY. A param a mode
 * does not accept -- including a known param sent to the wrong mode, and any
 * unknown name -- is a 400 `unexpected param` from the sidecar, never ignored.
 */
export const CN_ACCEPTS: Record<CnMode, readonly string[]> = {
  fundingRate: ['mode', 'fresh'],
  liquidation: ['mode', 'interval', 'fresh'],
  longShort: ['mode', 'fresh'],
  etf: ['mode', 'fresh'],
  whales: ['mode', 'fresh'],
};

/**
 * The sidecar's frozen envelope: provenance on top of upstream's `data`, verbatim.
 *
 * `data` is typed `unknown` on purpose -- the family re-shapes nothing, so any row
 * type here would be a guess about a payload we did not author.
 */
export type CnEnvelope = {
  kind: CnMode;
  upstream: string;
  fetchedAt: number;
  /** how the request was authorised: the computed client signature, no issued key */
  auth: string;
  /** the effective interval, echoed for modes that take one (liquidation) */
  interval?: string;
  upstreamCode?: string;
  upstreamMsg?: string;
  /** present only for an ARRAY payload; ABSENT for an object (mode=whales) -- never a 0 */
  upstreamCount?: number;
  data: unknown;
  derived: string;
  [extra: string]: unknown;
};

/** The 400/405/502 bodies, as the Go side writes them. */
export type CnErrorEnvelope = {
  error: string;
  detail?: string;
  mode?: string;
  code?: string;
  modes?: readonly string[];
  intervals?: readonly string[];
  got?: string | null;
  param?: string;
};
