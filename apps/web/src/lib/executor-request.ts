/**
 * executor-request.ts — BARREL for the REQUEST/PREVIEW half of the FUDCourt CEX
 * Executor wire contract (PRD §48–§56, §57–§63). Request enums, definitions,
 * and `ExecutionRequest` live in `./executor-request-defs`; the risk-engine
 * surface, `ExecutionPlan`, and `PreviewResult` in `./executor-risk-plan`.
 * Lifecycle (`./executor-lifecycle`) and sizing (`./executor-sizing`) shapes
 * are re-exported through the sub-modules so every consumer keeps importing
 * `@/lib/executor` (the barrel) and nothing else across slice boundaries.
 * Deep imports (`@/lib/executor-request-defs`, `@/lib/executor-risk-plan`)
 * are forbidden — the `@/lib/executor` barrel is the only entry point.
 * Single-source rule: shared constants (`EXECUTION_TRANSITIONS`,
 * `canTransition`, `isTerminalExecution`) are defined ONLY in
 * `./executor-lifecycle`, sizing shapes ONLY in `./executor-sizing`,
 * request defs ONLY in `./executor-request-defs`, risk/plan shapes ONLY in
 * `./executor-risk-plan` — this file and the barrel re-export, never redefine.
 *
 * The Go service `apps/executor` owns the runtime; field renames on
 * either side are coupled by `parity-matrix.md` row 1. Money math (PRD §71):
 * NO float arithmetic on quantities/prices in the engines — `decimal.js` is the
 * required arithmetic; `number` here is the WIRE type.
 */
export * from './executor-lifecycle';
export * from './executor-sizing';
export * from './executor-request-defs';
export * from './executor-risk-plan';
