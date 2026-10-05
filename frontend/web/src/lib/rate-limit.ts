/**
 * Barrel: re-exports the outbound limiter and the inbound limiter so existing
 * importers keep working unchanged. New code may import from
 * `@/lib/rate-limit-outbound` or `@/lib/rate-limit-inbound` directly.
 */
export { limitedFetch, __resetLimiter, __cacheStats } from "./rate-limit-outbound";
export {
  PAGE_BYTES,
  CR_MODE_COST,
  ROUTE_COST,
  DEFAULT_COST,
  HEAVY_ALLOWANCE,
  LIGHT_ALLOWANCE,
  costForRequest,
  WINDOW_MS,
  AUTHED_MULTIPLIER,
  LOCAL_MULTIPLIER,
  MAX_CLIENTS,
  clientKey,
  checkInbound,
  rateHeaders,
  __bucketCount,
  __resetRateLimit,
} from "./rate-limit-inbound";
export type { RateScope, RateDecision } from "./rate-limit-inbound";
