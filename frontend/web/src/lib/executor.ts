/**
 * executor.ts — BARREL for the FUDCourt CEX Executor wire contract (PRD §48–§56,
 * §57–§63). The contract lives in `./executor-request` (intent → plan → preview)
 * and `./executor-response` (engine / venue / persistence / worker); this file
 * re-exports everything so ALL existing `@/lib/executor` importers keep working
 * unchanged. Deep imports (`@/lib/executor-request`, `@/lib/executor-response`)
 * are forbidden — the barrel is the only entry point across slice boundaries.
 */
export * from './executor-request';
export * from './executor-response';
