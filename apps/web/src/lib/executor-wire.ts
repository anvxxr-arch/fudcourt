/**
 * executor-wire.ts — SCHEMA/WIRE half of the FUDCourt CEX Executor persistence
 * contract (PRD §49, §66, §109). Split from `./executor-persistence`: the
 * store schema name (`EXECUTOR_SCHEMA`) and the wire helpers
 * (`clientOrderId`, `maskApiKey`, `venueKey`) are defined ONLY here — record
 * shapes plus the risk profile live in `./executor-records`, the store and
 * worker contracts in `./executor-store`, and `./executor-persistence`
 * re-exports all three so ALL existing `@/lib/executor` importers keep
 * working unchanged.
 * Deep imports (`@/lib/executor-records`, `@/lib/executor-store`,
 * `@/lib/executor-wire`) are forbidden — the `@/lib/executor` barrel is the
 * only entry point across slice boundaries.
 *
 * Request-side shapes are imported as types from `./executor-request`.
 * Consumers import `@/lib/executor` (the barrel), never this path directly.
 */
import type {
  ExchangeId,
  MarketType,
  VenueKey,
} from './executor-request';
// ---------------------------------------------------------------------------
// Store schema name + wire helpers
// ---------------------------------------------------------------------------
/** All executor tables live in this dedicated Postgres schema (DR-020). */
export const EXECUTOR_SCHEMA = 'executor';
/** Client order id format (PRD §66): `fud_{executionId}_{sequence}`. */
export function clientOrderId(executionId: string, sequence: number): string {
  return `fud_${executionId}_${sequence}`;
}
/** Mask an API key for display: `abc...xyz` (PRD §109). */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-3)}`;
}
/** Venue key (PRD §49). */
export function venueKey(exchange: ExchangeId, marketType: MarketType, symbol: string): VenueKey {
  return `${exchange}:${marketType}:${symbol}`;
}
