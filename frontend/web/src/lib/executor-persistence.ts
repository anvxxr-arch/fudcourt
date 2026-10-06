/**
 * executor-persistence.ts — PERSISTENCE half of the FUDCourt CEX Executor
 * response contract (PRD §59–§63, §72, §64–§68, §114). Split from
 * `./executor-response`: this module owns the persistence records, risk
 * profile, store, and worker surfaces plus the wire helpers
 * (`EXECUTOR_SCHEMA`, `clientOrderId`, `maskApiKey`, `venueKey`,
 * `DEFAULT_RISK_PROFILE`).
 *
 * Venue shapes are imported as types from `./executor-venue`; request-side
 * shapes from `./executor-request`. Consumers import `@/lib/executor` (the
 * barrel), never this path directly.
 */
import type {
  BalanceBasis,
  ChildOrderStatus,
  CredentialHealth,
  EntryDefinition,
  ExchangeId,
  ExecutionConstraints,
  ExecutionDefinition,
  ExecutionEventName,
  ExecutionMode,
  ExecutionPlan,
  ExecutionStatus,
  ExecutionStrategy,
  ExecutionUrgency,
  Intent,
  MarginMode,
  MarketType,
  PriceDefinition,
  Side,
  SizingMode,
  TakeProfitDefinition,
  VenueKey,
} from './executor-request';
import type { AccountPermissions } from './executor-venue';

// ---------------------------------------------------------------------------
// Persistence shapes (PRD §59–§63) — snake_case columns, camelCase domain objects.
// ---------------------------------------------------------------------------

export interface CredentialRecord {
  id: string;
  userId: string;
  exchange: ExchangeId;
  label: string;
  /** Masked `abc...xyz` only — never the full key (PRD §109). */
  apiKeyMasked: string;
  permissions: AccountPermissions;
  health: CredentialHealth;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** Decrypted secrets — NEVER leaves `backend/workers/executor/internal/store` (PRD §44, §108). */
export interface DecryptedCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string | null;
}

export interface ExecutionRecord {
  id: string;
  userId: string;
  accountId: string;
  exchange: ExchangeId;
  symbol: string;
  marketType: MarketType;
  side: Side;
  intent: Intent;
  status: ExecutionStatus;
  mode: ExecutionMode;
  sizingMode: SizingMode;
  sizingValue: number;
  riskBudget: number | null;
  riskBasis: BalanceBasis | null;
  entryDefinition: EntryDefinition;
  stopDefinition: PriceDefinition | null;
  takeProfitDefinition: TakeProfitDefinition[];
  executionStrategy: ExecutionStrategy;
  executionConfig: ExecutionDefinition;
  constraints: ExecutionConstraints;
  plannedQuantity: number;
  plannedNotional: number;
  actualQuantity: number;
  actualNotional: number;
  averageFillPrice: number | null;
  estimatedFees: number | null;
  actualFees: number;
  plannedRisk: number | null;
  currentRisk: number | null;
  /**
   * Opaque engine state (JSON round-trippable). NOT authoritative across a
   * lost write — the exchange is (PRD §95/§114) — but authoritative enough to
   * resume a strategy without re-deriving its schedule from process memory
   * (PRD §130: process memory must never be the only copy).
   */
  strategyState: unknown;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
}

export interface ChildOrderRecord {
  id: string;
  executionId: string;
  exchangeOrderId: string | null;
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: string;
  price: number | null;
  quantity: number;
  filledQuantity: number;
  status: ChildOrderStatus;
  isExit: boolean;
  submittedAt: number | null;
  updatedAt: number;
  filledAt: number | null;
}

export interface FillRecord {
  id: string;
  executionId: string;
  childOrderId: string | null;
  /** Dedup key part 1 (PRD §62). */
  exchangeTradeId: string;
  price: number;
  quantity: number;
  quoteQuantity: number;
  fee: number;
  feeAsset: string;
  timestamp: number;
}

export interface ExecutionEventRecord {
  id: string;
  executionId: string;
  name: ExecutionEventName;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface AuditLogRecord {
  id: string;
  userId: string | null;
  action: string;
  target: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}
// ---------------------------------------------------------------------------
// Risk profile (PRD §72, §88, §119) — account-level safety rules.
// ---------------------------------------------------------------------------

export interface RiskProfile {
  defaultRiskMode: 'risk_usd' | 'risk_percent';
  defaultRisk: number;
  /** Hard cap per trade (percent of the risk basis). Enforced at creation. */
  maxRiskPerTradePct: number;

  /**
   * Portfolio ceiling on COMMITTED risk (PRD §73): the sum of current risk over
   * live executions plus a new opening may not exceed this share of total
   * exchange equity. Enforced at creation — a breach is refused, never resized.
   */
  maxOpenRiskPct: number;
  /**
   * Daily realized-loss ceiling (PRD §74). Once the day's realized P&L reaches
   * -this% of equity, new OPENINGS are blocked; closing and reducing stay
   * allowed, so the guard can never trap a user in the risk it exists to bound.
   */
  maxDailyLossPct: number;
  maxLeverage: number;
  defaultMarginMode: MarginMode;
  defaultExecutionUrgency: ExecutionUrgency;
}

export const DEFAULT_RISK_PROFILE: RiskProfile = {
  defaultRiskMode: 'risk_percent',
  defaultRisk: 1,
  maxRiskPerTradePct: 2,
  maxOpenRiskPct: 5,
  maxDailyLossPct: 5,
  maxLeverage: 10,
  defaultMarginMode: 'isolated',
  defaultExecutionUrgency: 'balanced',
};
// ---------------------------------------------------------------------------
// Store contract (PRD §59) — `backend/workers/executor/internal/store` implements this.
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
// Worker contract (PRD §64–§68, §114) — `backend/workers/executor/internal/runtime` implements this.
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
