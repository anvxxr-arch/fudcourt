/**
 * executor-persistence.ts — BARREL for the PERSISTENCE half of the FUDCourt CEX
 * Executor response contract (PRD §59–§63, §72, §64–§68, §114). Persistence
 * records plus the risk profile live in `./executor-records`; the store and
 * worker contracts in `./executor-store`; the schema name and wire helpers
 * (`EXECUTOR_SCHEMA`, `clientOrderId`, `maskApiKey`, `venueKey`) in
 * `./executor-wire`. This file re-exports everything so ALL existing
 * `@/lib/executor` importers keep working unchanged. Deep imports
 * (`@/lib/executor-records`, `@/lib/executor-store`, `@/lib/executor-wire`)
 * are forbidden — the `@/lib/executor` barrel is the only entry point across
 * slice boundaries. Single-source rule: record shapes and `RiskProfile` /
 * `DEFAULT_RISK_PROFILE` are defined ONLY in `./executor-records`, store /
 * worker surfaces ONLY in `./executor-store`, schema and wire helpers ONLY
 * in `./executor-wire` — this file and the barrel re-export, never redefine.
 *
 * Consumers import `@/lib/executor` (the barrel), never this path directly.
 */
export * from './executor-records';
export * from './executor-store';
export * from './executor-wire';
