/**
 * executor-response.ts — BARREL for the response half of the FUDCourt CEX
 * Executor wire contract (PRD §48–§56, §57–§63). The engine and
 * exchange-adapter surfaces live in `./executor-venue`; persistence records,
 * risk profile, store, worker, and wire helpers in
 * `./executor-persistence`. This file re-exports everything so ALL existing
 * `@/lib/executor` importers keep working unchanged. Deep imports
 * (`@/lib/executor-venue`, `@/lib/executor-persistence`) are forbidden — the
 * `@/lib/executor` barrel is the only entry point across slice boundaries.
 */
export * from './executor-venue';
export * from './executor-persistence';
