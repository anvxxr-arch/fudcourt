/**
 * executor-lifecycle.ts — execution lifecycle single source of truth (PRD §57).
 * Split from `./executor-request`: `ExecutionStatus`, `EXECUTION_TRANSITIONS`,
 * `canTransition`, and `isTerminalExecution` are defined ONLY here —
 * `executor-request.ts`, `executor-response.ts`, and the `@/lib/executor` barrel
 * re-export, never redefine.
 */

/** Execution lifecycle (PRD §57). */
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

/**
 * Execution lifecycle table (PRD §57) — ONE truth for API intents and worker
 * transitions alike. Terminal states accept nothing.
 */
export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  DRAFT: ['CALCULATED', 'CANCELLED', 'FAILED'],
  CALCULATED: ['VALIDATED', 'FAILED', 'CANCELLED'],
  VALIDATED: ['READY', 'FAILED', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['PARTIALLY_FILLED', 'FILLED', 'PAUSED', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'RISK_STOPPED', 'EXPIRED', 'RECONCILING', 'STOPPED'],
  PARTIALLY_FILLED: ['RUNNING', 'FILLED', 'PAUSED', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'RISK_STOPPED', 'EXPIRED', 'RECONCILING', 'STOPPED'],
  PAUSED: ['RUNNING', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'RISK_STOPPED', 'STOPPED'],
  CANCEL_REQUESTED: ['CANCELLED', 'FAILED', 'PARTIALLY_FILLED'],
  RECONCILING: ['RUNNING', 'PARTIALLY_FILLED', 'PAUSED', 'CANCELLED', 'FAILED', 'RISK_STOPPED', 'STOPPED'],
  FILLED: [],
  CANCELLED: [],
  FAILED: [],
  RISK_STOPPED: [],
  EXPIRED: [],
  STOPPED: [],
};

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return (EXECUTION_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalExecution(status: ExecutionStatus): boolean {
  return (EXECUTION_TRANSITIONS[status] ?? []).length === 0;
}
