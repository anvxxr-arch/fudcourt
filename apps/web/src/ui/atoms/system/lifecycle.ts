/**
 * atoms/system/lifecycle.ts — the canonical execution lifecycle vocabulary, declared here.
 *
 * WHY IT IS DECLARED HERE AND NOT IMPORTED: `src/ui/` is a presentational leaf. The repo's
 * structure gate (check-structure.py rule 4b) allows `src/ui/` to import only `@/ui` and
 * `@/styles` — a primitive must never reach for `lib/`, because a component library that
 * depends on the domain cannot be reasoned about, reused or tested in isolation.
 *
 * So the vocabulary is MIRRORED, and the mirror is PROVEN. `tests/design-system-atom-tests.ts`
 * imports the engine's `ExecutionStatus` from `@/lib/executor-lifecycle` and asserts the two
 * unions are assignable in both directions — a state added to the engine without updating
 * this file fails the test at compile time, and a state added here without the engine fails
 * it too. That is the same guarantee an import would give, without the dependency.
 *
 * The engine's sources of truth, for reference:
 *   - `src/lib/executor-lifecycle.ts` — `ExecutionStatus`, `EXECUTION_TRANSITIONS`,
 *     `canTransition`, `isTerminalExecution` (PRD §57).
 *   - `src/lib/executor-request-defs.ts` — `ChildOrderStatus` (PRD §58).
 *   - `apps/executor/internal/execution/lifecycle.go` — the Go mirror.
 */

/**
 * Execution lifecycle (PRD §57). Mirrors `ExecutionStatus` in
 * `src/lib/executor-lifecycle.ts`; the assignability test is the contract.
 */
export type ExecutionStatus =
  | 'DRAFT'
  | 'CALCULATED'
  | 'VALIDATED'
  | 'READY'
  | 'RUNNING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'PAUSED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'FAILED'
  | 'RISK_STOPPED'
  | 'EXPIRED'
  | 'RECONCILING'
  | 'STOPPED';

/** Every execution state, in declaration order. The atom's label map is keyed by this. */
export const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'DRAFT',
  'CALCULATED',
  'VALIDATED',
  'READY',
  'RUNNING',
  'PARTIALLY_FILLED',
  'FILLED',
  'PAUSED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'FAILED',
  'RISK_STOPPED',
  'EXPIRED',
  'RECONCILING',
  'STOPPED',
];

/**
 * Child-order lifecycle (PRD §58). Mirrors `ChildOrderStatus` in
 * `src/lib/executor-request-defs.ts`.
 */
export type ChildOrderStatus =
  | 'PLANNED'
  | 'SUBMITTING'
  | 'OPEN'
  | 'PARTIAL'
  | 'FILLED'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

/** Every child-order state, in declaration order. */
export const CHILD_ORDER_STATUSES: readonly ChildOrderStatus[] = [
  'PLANNED',
  'SUBMITTING',
  'OPEN',
  'PARTIAL',
  'FILLED',
  'CANCELLING',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN',
];
