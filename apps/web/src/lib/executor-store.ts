/**
 * executor-store.ts — STORE/WORKER half of the FUDCourt CEX Executor
 * persistence contract (PRD §59, §64–§68, §114). Split from
 * `./executor-persistence`: the store and worker surfaces
 * (`PortfolioRiskSummary`, `ExecutorStore`, `ExecutorWorkerApi`,
 * `ExecutionLock`) are defined ONLY here — record shapes plus the risk
 * profile live in `./executor-records`, the schema name and wire helpers in
 * `./executor-wire`, and `./executor-persistence` re-exports all three so ALL
 * existing `@/lib/executor` importers keep working unchanged.
 * Deep imports (`@/lib/executor-records`, `@/lib/executor-store`,
 * `@/lib/executor-wire`) are forbidden — the `@/lib/executor` barrel is the
 * only entry point across slice boundaries.
 *
 * Record shapes are imported as types from `./executor-records`;
 * request-side shapes from `./executor-request`. Consumers import
 * `@/lib/executor` (the barrel), never this path directly.
 */
import type {
  ChildOrderRecord,
  CredentialRecord,
  DecryptedCredentials,
  ExecutionEventRecord,
  ExecutionRecord,
  FillRecord,
  AuditLogRecord,
  RiskProfile,
} from './executor-records';
import type {
  CredentialHealth,
  ExchangeId,
  ExecutionEventName,
  ExecutionPlan,
  ExecutionStatus,
} from './executor-request';
import type { AccountPermissions } from './executor-venue';
// ---------------------------------------------------------------------------
// Store contract (PRD §59) — `apps/executor/internal/store` implements this.
// Every method is scoped by `userId`; ownership is checked server-side (PRD §108).
// ---------------------------------------------------------------------------
/**
 * Portfolio-level committed risk (PRD §73) and a realized result (PRD §74), both
 * already-committed numbers that a NEW execution must fit inside.
 */
export interface PortfolioRiskSummary {
  /**
   * Sum of `current_risk` over live executions, falling back to `planned_risk`
   * for one that has not filled yet (it is still committed risk). Stays `null`
   * when no live execution has a quantifiable risk — an unquantifiable position
   * is reported honestly, never counted as zero.
   */
  openRisk: number | null;
  /** Realized P&L of executions that closed in the window; negative is a loss. */
  realizedPnlToday: number;
  /** Count of live executions contributing to `openRisk`. */
  liveCount: number;
}
export interface ExecutorStore {
  // Credentials (PRD §45–§47)
  createCredential(args: {
    userId: string;
    exchange: ExchangeId;
    label: string;
    credentials: DecryptedCredentials;
    permissions: AccountPermissions;
  }): Promise<CredentialRecord>;
  listCredentials(userId: string): Promise<CredentialRecord[]>;
  getCredential(userId: string, id: string): Promise<CredentialRecord | null>;
  /** The ONLY path to plaintext secrets. Server-side only (PRD §100). */
  revealCredentials(userId: string, id: string): Promise<DecryptedCredentials | null>;
  updateCredentialHealth(userId: string, id: string, health: CredentialHealth): Promise<void>;
  touchCredential(userId: string, id: string, at: number): Promise<void>;
  revokeCredential(userId: string, id: string, at: number): Promise<void>;
  /** Key rotation (PRD §44): re-encrypt all secrets under a new master key. */
  rotateCredentialKeys(newMasterKey: string, oldMasterKey: string): Promise<number>;
  // Executions (PRD §60, §63)
  createExecution(rec: Omit<ExecutionRecord, 'id' | 'createdAt' | 'startedAt' | 'completedAt' | 'cancelledAt' | 'strategyState'> & { plan: ExecutionPlan; strategyState?: unknown }): Promise<ExecutionRecord>;
  /** The immutable creation-time plan (PRD §56/§99) — worker risk math source. */
  getExecutionPlan(executionId: string): Promise<ExecutionPlan | null>;
  getExecution(userId: string, id: string): Promise<ExecutionRecord | null>;
  /** Worker-side read WITHOUT user scoping — the worker is not a user (PRD §68). */
  getExecutionForWorker(id: string): Promise<ExecutionRecord | null>;
  listExecutions(userId: string, opts?: { limit?: number; status?: ExecutionStatus }): Promise<ExecutionRecord[]>;
  /**
   * Portfolio risk rollup for one user (PRD §73/§74): what is ALREADY committed
   * by their live executions, so a new one can be refused before it is created.
   * `openRisk` sums each live execution's CURRENT risk (recalculated after every
   * fill); `realizedLossToday` sums closed executions' realized outcome. Both are
   * derived in SQL so the check cannot race a partially-applied in-memory sum.
   */
  summarizePortfolioRisk(userId: string, sinceMs: number): Promise<PortfolioRiskSummary>;
  updateExecutionStatus(id: string, status: ExecutionStatus, at: number): Promise<void>;
  updateExecutionProgress(id: string, patch: {
    actualQuantity?: number;
    actualNotional?: number;
    averageFillPrice?: number | null;
    actualFees?: number;
    currentRisk?: number | null;
  }): Promise<void>;
  /** Persist the engine's strategy state after every tick (PRD §130). */
  updateExecutionStrategyState(id: string, state: unknown): Promise<void>;
  /** Periodic reconciliation snapshots (PRD §41, §59). */
  insertSnapshot(rec: {
    accountId: string;
    kind: 'balance' | 'position';
    payload: unknown;
    createdAt: number;
  }): Promise<void>;
  // Child orders (PRD §61)
  insertChildOrder(rec: Omit<ChildOrderRecord, 'id'>): Promise<ChildOrderRecord>;
  updateChildOrder(executionId: string, clientOrderId: string, patch: Partial<ChildOrderRecord>): Promise<void>;
  listChildOrders(executionId: string): Promise<ChildOrderRecord[]>;
  // Fills (PRD §62) — insert is idempotent on (accountId, exchangeTradeId).
  insertFill(rec: Omit<FillRecord, 'id'>): Promise<FillRecord | null>;
  listFills(executionId: string): Promise<FillRecord[]>;
  // Events (PRD §63) — immutable, append-only.
  appendEvent(executionId: string, name: ExecutionEventName, payload: Record<string, unknown>, at: number): Promise<ExecutionEventRecord>;
  listEvents(executionId: string): Promise<ExecutionEventRecord[]>;
  // Risk profiles (PRD §72, §119)
  getRiskProfile(userId: string): Promise<RiskProfile>;
  putRiskProfile(userId: string, profile: RiskProfile): Promise<RiskProfile>;
  // Audit (PRD §110)
  audit(rec: Omit<AuditLogRecord, 'id' | 'createdAt'> & { createdAt?: number }): Promise<void>;
  // Runtime scanning (PRD §114): executions a worker must own after restart.
  listRunningExecutions(): Promise<ExecutionRecord[]>;
}
// ---------------------------------------------------------------------------
// Worker contract (PRD §64–§68, §114) — `apps/executor/internal/runtime` implements this.
// ---------------------------------------------------------------------------
export interface ExecutorWorkerApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One scheduler pass; exposed for deterministic tests. */
  tick(): Promise<void>;
  /** Crash recovery (PRD §114). */
  recover(): Promise<void>;
  /**
   * Emergency stop (PRD §75): stop all strategies and cancel managed open
   * orders; never closes positions on its own. Scope: everything when no
   * filter is given, otherwise one user's / one account's executions.
   */
  emergencyStop(args: { userId?: string; accountId?: string }): Promise<{ stopped: number; cancelledOrders: number }>;
}
/** Locking (PRD §65): one worker owns one execution at a time. */
export interface ExecutionLock {
  /** Try to take `execution:{id}:lock`. False when another worker holds it. */
  acquire(executionId: string, workerId: string, ttlMs: number): Promise<boolean>;
  /** Owner-token release: never unlocks someone else's lease. */
  release(executionId: string, workerId: string): Promise<void>;
  /** Extend the lease; false when the lease was lost. */
  heartbeat(executionId: string, workerId: string, ttlMs: number): Promise<boolean>;
}
