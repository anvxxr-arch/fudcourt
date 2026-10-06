/**
 * executor-records.ts — RECORDS half of the FUDCourt CEX Executor persistence
 * contract (PRD §59–§63, §72). Split from `./executor-persistence`: the table
 * record shapes plus the account risk profile (`RiskProfile`,
 * `DEFAULT_RISK_PROFILE`) are defined ONLY here — the store and worker
 * contracts live in `./executor-store`, the schema name and wire helpers in
 * `./executor-wire`, and `./executor-persistence` re-exports all three so ALL
 * existing `@/lib/executor` importers keep working unchanged.
 * Deep imports (`@/lib/executor-records`, `@/lib/executor-store`,
 * `@/lib/executor-wire`) are forbidden — the `@/lib/executor` barrel is the
 * only entry point across slice boundaries.
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
