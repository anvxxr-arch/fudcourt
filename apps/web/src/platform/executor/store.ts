/**
 * store.ts — Postgres persistence for the executor domain + credential envelope
 * encryption (PRD §59–§63, §95, §110, §44–§45).
 *
 * All I/O targets LOCAL Postgres (`FUDCOURT_PG_URL`) inside the dedicated
 * `executor` schema (`EXECUTOR_SCHEMA`, DR-020). The `public` treasury tables are
 * the Turso->Postgres mirror's write territory and are never touched here.
 *
 * Timestamps are bigint unix MILLISECONDS everywhere (`number` ms on the wire);
 * stored JSON columns round-trip `unknown` opaquely — jsonb keys are never
 * stripped, the plan snapshot must survive byte-shape.
 *
 * Ownership (PRD §108): every user-scoped statement binds `user_id` in its WHERE
 * and a wrong user reads `null`/`[]` — never an error, never a row. The only
 * plaintext path for secrets is `revealCredentials` (PRD §44, §100): user-scoped,
 * never logged, never echoed. Master key absence is FAIL-CLOSED — credential
 * operations throw, plaintext is never stored.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  EXECUTOR_SCHEMA,
  DEFAULT_RISK_PROFILE,
  maskApiKey,
  type AccountPermissions,
  type BalanceBasis,
  type ChildOrderRecord,
  type ChildOrderStatus,
  type CredentialHealth,
  type CredentialRecord,
  type DecryptedCredentials,
  type EntryDefinition,
  type ExchangeId,
  type ExecutionConstraints,
  type ExecutionDefinition,
  type ExecutionEventName,
  type ExecutionEventRecord,
  type ExecutionMode,
  type ExecutionPlan,
  type ExecutionRecord,
  type ExecutionStatus,
  type ExecutionStrategy,
  type ExecutorStore,
  type FillRecord,
  type Intent,
  type MarketType,
  type PriceDefinition,
  type RiskProfile,
  type Side,
  type SizingMode,
  type TakeProfitDefinition,
} from '@/platform/executor/types';

// ---------------------------------------------------------------------------
// Lazy Bun globals (same pattern as platform/db/mirror.ts): Next builds static
// routes in a Node worker with no `bun` module, so the class is looked up at
// call time and only the (erased) type comes from `bun`.
// ---------------------------------------------------------------------------
/** The slice of Bun.sql (and of its transaction handle) this store uses. */
export interface ExecutorSql {
  unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  begin<T>(fn: (tx: ExecutorSql) => Promise<T>): Promise<T>;
}
const BunGlobal = (globalThis as { Bun?: { SQL?: new (url: string, opts?: { max?: number; idleTimeout?: number }) => ExecutorSql } }).Bun;
const PG_OPTS = { max: 8, idleTimeout: 30 };
const PG_URL = process.env.FUDCOURT_PG_URL || 'postgres://fudcourt@127.0.0.1:5433/fudcourt';
let pgClient: ExecutorSql | null = null;
/**
 * The pooled Bun.sql client (lazy; constructing is I/O-free). Bun.sql's `unsafe`
 * and `begin` structurally cover everything this store calls — `ExecutorSql` is
 * that minimum surface (and the offline test seam).
 */
export function pg(): ExecutorSql {
  if (!pgClient) {
    if (!BunGlobal?.SQL) {
      throw new Error('Bun.sql is unavailable: this process is not running under Bun (the fudcourt web unit starts next with `bun --bun`)');
    }
    pgClient = new BunGlobal.SQL(PG_URL, PG_OPTS);
  }
  return pgClient;
}
let dbOverride: ExecutorSql | null = null;
/** Test seam: inject a fake `ExecutorSql` so the store runs offline. */
export function setStoreDbForTests(fake: ExecutorSql | null): void {
  dbOverride = fake;
}
function db(): ExecutorSql {
  if (dbOverride) return dbOverride;
  // Bun.sql structurally supplies `unsafe`/`begin`; those are the only members used.
  const client = pg() as unknown as ExecutorSql;
  return client;
}

// ---------------------------------------------------------------------------
// DDL — kept byte-equivalent to the tracked database/schema/executor-schema.sql (commentary
// lines excluded); no separate migration runner exists.
// ---------------------------------------------------------------------------
export const EXECUTOR_DDL = `CREATE SCHEMA IF NOT EXISTS executor;
CREATE TABLE IF NOT EXISTS executor.exchange_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text NOT NULL,
  exchange              text NOT NULL,
  label                 text NOT NULL,
  api_key_masked        text NOT NULL,
  api_key_encrypted     bytea NOT NULL,
  api_secret_encrypted  bytea NOT NULL,
  passphrase_encrypted  bytea,
  iv                    bytea NOT NULL,
  auth_tag              bytea NOT NULL,
  permissions           jsonb NOT NULL DEFAULT '{}'::jsonb,
  health                text NOT NULL DEFAULT 'UNKNOWN',
  created_at            bigint NOT NULL,
  updated_at            bigint NOT NULL,
  last_used_at          bigint,
  revoked_at            bigint
);
CREATE INDEX IF NOT EXISTS exchange_accounts_user_idx ON executor.exchange_accounts (user_id);
CREATE TABLE IF NOT EXISTS executor.executions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text NOT NULL,
  account_id            uuid NOT NULL REFERENCES executor.exchange_accounts (id),
  exchange              text NOT NULL,
  symbol                text NOT NULL,
  market_type           text NOT NULL,
  side                  text NOT NULL,
  intent                text NOT NULL,
  status                text NOT NULL,
  mode                  text NOT NULL,
  sizing_mode           text NOT NULL,
  sizing_value          double precision NOT NULL,
  risk_budget           double precision,
  risk_basis            text,
  entry_definition      jsonb NOT NULL,
  stop_definition       jsonb,
  take_profit_definition jsonb NOT NULL DEFAULT '[]'::jsonb,
  execution_strategy    text NOT NULL,
  execution_config      jsonb NOT NULL,
  constraints           jsonb NOT NULL DEFAULT '{}'::jsonb,
  planned_quantity      double precision NOT NULL,
  planned_notional      double precision NOT NULL,
  actual_quantity       double precision NOT NULL,
  actual_notional       double precision NOT NULL,
  average_fill_price    double precision,
  estimated_fees        double precision,
  actual_fees           double precision NOT NULL,
  planned_risk          double precision,
  current_risk          double precision,
  risk_policy           text,
  strategy_state        jsonb,
  created_at            bigint NOT NULL,
  started_at            bigint,
  completed_at          bigint,
  cancelled_at          bigint
);
CREATE INDEX IF NOT EXISTS executions_user_created_idx ON executor.executions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executions_status_idx ON executor.executions (status);
CREATE TABLE IF NOT EXISTS executor.execution_plans (
  execution_id uuid PRIMARY KEY REFERENCES executor.executions (id),
  plan         jsonb NOT NULL,
  created_at   bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS executor.child_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      uuid NOT NULL REFERENCES executor.executions (id),
  exchange_order_id text,
  client_order_id   text NOT NULL,
  symbol            text NOT NULL,
  side              text NOT NULL,
  type              text NOT NULL,
  price             double precision,
  quantity          double precision NOT NULL,
  filled_quantity   double precision NOT NULL DEFAULT 0,
  status            text NOT NULL,
  is_exit           boolean NOT NULL DEFAULT false,
  submitted_at      bigint,
  updated_at        bigint NOT NULL,
  filled_at         bigint,
  UNIQUE (execution_id, client_order_id)
);
CREATE INDEX IF NOT EXISTS child_orders_execution_idx ON executor.child_orders (execution_id);
CREATE TABLE IF NOT EXISTS executor.fills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      uuid NOT NULL REFERENCES executor.executions (id),
  child_order_id    uuid REFERENCES executor.child_orders (id),
  account_id        uuid NOT NULL REFERENCES executor.exchange_accounts (id),
  exchange_trade_id text NOT NULL,
  price             double precision NOT NULL,
  quantity          double precision NOT NULL,
  quote_quantity    double precision NOT NULL,
  fee               double precision NOT NULL,
  fee_asset         text NOT NULL,
  timestamp         bigint NOT NULL,
  UNIQUE (account_id, exchange_trade_id)
);
CREATE INDEX IF NOT EXISTS fills_execution_idx ON executor.fills (execution_id);
CREATE TABLE IF NOT EXISTS executor.execution_events (
  id           bigserial PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES executor.executions (id),
  name         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_events_execution_idx ON executor.execution_events (execution_id, id);
CREATE TABLE IF NOT EXISTS executor.balance_snapshots (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES executor.exchange_accounts (id),
  payload    jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS balance_snapshots_account_idx ON executor.balance_snapshots (account_id, created_at DESC);
CREATE TABLE IF NOT EXISTS executor.positions_snapshots (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES executor.exchange_accounts (id),
  payload    jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_snapshots_account_idx ON executor.positions_snapshots (account_id, created_at DESC);
CREATE TABLE IF NOT EXISTS executor.risk_profiles (
  user_id    text PRIMARY KEY,
  profile    jsonb NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS executor.audit_logs (
  id         bigserial PRIMARY KEY,
  user_id    text,
  action     text NOT NULL,
  target     text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON executor.audit_logs (user_id, id);
`;
let schemaReady = false;
/**
 * Idempotent bootstrap: the worker and the API route call this once at startup.
 * The DDL is all `IF NOT EXISTS`, run one statement at a time (the extended
 * query protocol refuses multi-statement strings).
 */
export async function ensureExecutorSchema(sql?: ExecutorSql): Promise<void> {
  if (schemaReady && !sql) return;
  const conn = sql ?? db();
  await conn.unsafe(`CREATE SCHEMA IF NOT EXISTS ${EXECUTOR_SCHEMA}`);
  for (const statement of EXECUTOR_DDL.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0)) {
    await conn.unsafe(statement);
  }
  if (!sql) schemaReady = true;
}

// ---------------------------------------------------------------------------
// Credential envelope crypto (PRD §44): AES-256-GCM, per-secret 12-byte IV.
// ---------------------------------------------------------------------------
const MASTER_KEY_RE = /^[0-9a-fA-F]{64}$/;
/** Env master key, read lazily; absent/invalid => credential ops throw. */
export function masterKeyFromEnv(): string {
  const raw = process.env.FUDCOURT_EXECUTOR_MASTER_KEY || '';
  if (!MASTER_KEY_RE.test(raw)) {
    throw new Error(
      'FUDCOURT_EXECUTOR_MASTER_KEY missing or malformed (64 hex chars = 32 bytes required) — credential operations are fail-closed',
    );
  }
  return raw;
}
export interface SealedSecret {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}
/** Pure encrypt-one-secret. Unique IV per call (never reuse a GCM nonce). */
export function sealSecret(plain: string, keyHex: string): SealedSecret {
  if (!MASTER_KEY_RE.test(keyHex)) throw new Error('sealSecret: key must be 64 hex chars (32 bytes)');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}
/** Pure decrypt-one-secret. Wrong key or tampered ciphertext throws (GCM tag). */
export function openSecret(blob: SealedSecret, keyHex: string): string {
  if (!MASTER_KEY_RE.test(keyHex)) throw new Error('openSecret: key must be 64 hex chars (32 bytes)');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), blob.iv);
  decipher.setAuthTag(blob.tag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Pure seams (offline-tested): profile merge, fill dedup key, row mappers.
// ---------------------------------------------------------------------------
/** Stored risk profile over the defaults — stored fields win, missing fall back. */
export function mergeProfile(stored: Partial<RiskProfile> | null | undefined): RiskProfile {
  return { ...DEFAULT_RISK_PROFILE, ...(stored ?? {}) };
}
/** The fills UNIQUE key (PRD §62): one exchange trade id per account. */
export function fillDedupKey(accountId: string, exchangeTradeId: string): string {
  return `${accountId}:${exchangeTradeId}`;
}
// jsonb/numeric mapping: absent jsonb array -> [] (never null), absent jsonb
// object -> {}, and a NULL numeric column stays null (never 0 — a zero average
// fill price and a missing one mean very different things downstream).
function nullableNum(v: unknown): number | null {
  return v == null ? null : Number(v);
}
function json<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

export function accountRowToRecord(r: Record<string, unknown>): CredentialRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    exchange: r.exchange as ExchangeId,
    label: String(r.label),
    apiKeyMasked: String(r.api_key_masked),
    permissions: json<AccountPermissions>(r.permissions, { read: true, spotTrade: false, futuresTrade: false, withdraw: false }),
    health: (r.health ?? 'UNKNOWN') as CredentialHealth,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastUsedAt: nullableNum(r.last_used_at),
    revokedAt: nullableNum(r.revoked_at),
  };
}
export function executionRowToRecord(r: Record<string, unknown>): ExecutionRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    accountId: String(r.account_id),
    exchange: r.exchange as ExchangeId,
    symbol: String(r.symbol),
    marketType: r.market_type as MarketType,
    side: r.side as Side,
    intent: r.intent as Intent,
    status: r.status as ExecutionStatus,
    mode: r.mode as ExecutionMode,
    sizingMode: r.sizing_mode as SizingMode,
    sizingValue: Number(r.sizing_value),
    riskBudget: nullableNum(r.risk_budget),
    riskBasis: r.risk_basis as BalanceBasis | null,
    entryDefinition: json<EntryDefinition>(r.entry_definition, { type: 'market' }),
    stopDefinition: json<PriceDefinition | null>(r.stop_definition, null),
    takeProfitDefinition: json<TakeProfitDefinition[]>(r.take_profit_definition, []),
    executionStrategy: r.execution_strategy as ExecutionStrategy,
    executionConfig: json<ExecutionDefinition>(r.execution_config, { type: 'market' }),
    constraints: json<ExecutionConstraints>(r.constraints, {}),
    plannedQuantity: Number(r.planned_quantity),
    plannedNotional: Number(r.planned_notional),
    actualQuantity: Number(r.actual_quantity),
    actualNotional: Number(r.actual_notional),
    averageFillPrice: nullableNum(r.average_fill_price),
    estimatedFees: nullableNum(r.estimated_fees),
    actualFees: Number(r.actual_fees),
    plannedRisk: nullableNum(r.planned_risk),
    currentRisk: nullableNum(r.current_risk),
    strategyState: json<unknown>(r.strategy_state, null),
    createdAt: Number(r.created_at),
    startedAt: nullableNum(r.started_at),
    completedAt: nullableNum(r.completed_at),
    cancelledAt: nullableNum(r.cancelled_at),
  };
}
export function childOrderRowToRecord(r: Record<string, unknown>): ChildOrderRecord {
  return {
    id: String(r.id),
    executionId: String(r.execution_id),
    exchangeOrderId: r.exchange_order_id == null ? null : String(r.exchange_order_id),
    clientOrderId: String(r.client_order_id),
    symbol: String(r.symbol),
    side: r.side as Side,
    type: String(r.type),
    price: nullableNum(r.price),
    quantity: Number(r.quantity),
    filledQuantity: Number(r.filled_quantity),
    status: r.status as ChildOrderStatus,
    isExit: Boolean(r.is_exit),
    submittedAt: nullableNum(r.submitted_at),
    updatedAt: Number(r.updated_at),
    filledAt: nullableNum(r.filled_at),
  };
}
export function fillRowToRecord(r: Record<string, unknown>): FillRecord {
  return {
    id: String(r.id),
    executionId: String(r.execution_id),
    childOrderId: r.child_order_id == null ? null : String(r.child_order_id),
    exchangeTradeId: String(r.exchange_trade_id),
    price: Number(r.price),
    quantity: Number(r.quantity),
    quoteQuantity: Number(r.quote_quantity),
    fee: Number(r.fee),
    feeAsset: String(r.fee_asset),
    timestamp: Number(r.timestamp),
  };
}
export function eventRowToRecord(r: Record<string, unknown>): ExecutionEventRecord {
  return {
    id: String(r.id),
    executionId: String(r.execution_id),
    name: r.name as ExecutionEventName,
    payload: json<Record<string, unknown>>(r.payload, {}),
    createdAt: Number(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// Statements. User-scoped statements bind `user_id` as placeholder $1
// (`scopeParam`) so PRD §108 ownership is pinned by tests and code alike.
// ---------------------------------------------------------------------------
const T = EXECUTOR_SCHEMA;
export const SQL_STATEMENTS = {
  getCredential: { sql: `SELECT * FROM ${T}.exchange_accounts WHERE user_id = $1 AND id = $2`, scopeParam: 1 },
  listCredentials: { sql: `SELECT * FROM ${T}.exchange_accounts WHERE user_id = $1 ORDER BY created_at DESC, id`, scopeParam: 1 },
  revealCredential: { sql: `SELECT * FROM ${T}.exchange_accounts WHERE user_id = $1 AND id = $2`, scopeParam: 1 },
  updateCredentialHealth: { sql: `UPDATE ${T}.exchange_accounts SET health = $3, updated_at = $4 WHERE user_id = $1 AND id = $2`, scopeParam: 1 },
  touchCredential: { sql: `UPDATE ${T}.exchange_accounts SET last_used_at = $3, updated_at = $3 WHERE user_id = $1 AND id = $2`, scopeParam: 1 },
  revokeCredential: { sql: `UPDATE ${T}.exchange_accounts SET revoked_at = $3, updated_at = $3, health = 'REVOKED' WHERE user_id = $1 AND id = $2`, scopeParam: 1 },
  getExecution: { sql: `SELECT * FROM ${T}.executions WHERE user_id = $1 AND id = $2`, scopeParam: 1 },
  listExecutions: { sql: `SELECT * FROM ${T}.executions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, scopeParam: 1 },
  listExecutionsByStatus: { sql: `SELECT * FROM ${T}.executions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC LIMIT $3`, scopeParam: 1 },
  getExecutionForWorker: { sql: `SELECT * FROM ${T}.executions WHERE id = $1` },
  getExecutionPlan: { sql: `SELECT plan FROM ${T}.execution_plans WHERE execution_id = $1` },
  // NOT user-scoped on purpose: crash recovery is a worker concern (PRD §114)
  // and the worker is not a user (PRD §68).
  listRunningExecutions: {
    sql: `SELECT * FROM ${T}.executions WHERE status IN ('RUNNING', 'PARTIALLY_FILLED', 'RECONCILING') ORDER BY created_at, id`,
  },
  // Portfolio risk rollup (PRD §73/§74). ONE statement, both aggregates, so the
  // open-risk ceiling and the daily-loss guard read a single consistent snapshot
  // instead of two queries that could straddle a concurrent fill.
  //
  // Realized P&L per closed execution = exit-leg proceeds minus average entry
  // price times exited quantity, minus every fee on the execution. Only rows
  // with a known `average_fill_price` contribute: an execution with no fills has
  // no fees and no proceeds, so excluding it is exact, not an approximation.
  summarizePortfolioRisk: {
    sql: `SELECT
      COALESCE((SELECT SUM(COALESCE(e.current_risk, e.planned_risk))
        FROM ${T}.executions e
        WHERE e.user_id = $1 AND e.status IN ('READY', 'RUNNING', 'PARTIALLY_FILLED', 'PAUSED', 'RECONCILING')), 0) AS open_risk,
      (SELECT COUNT(*) FROM ${T}.executions e2
        WHERE e2.user_id = $1 AND e2.status IN ('READY', 'RUNNING', 'PARTIALLY_FILLED', 'PAUSED', 'RECONCILING')) AS live_count,
      COALESCE((SELECT SUM(g.exit_value - g.exit_qty * e3.average_fill_price - g.fees)
        FROM ${T}.executions e3
        JOIN (
          SELECT c.execution_id,
            SUM(CASE WHEN c.is_exit THEN f.quantity ELSE 0 END) AS exit_qty,
            SUM(CASE WHEN c.is_exit THEN f.price * f.quantity ELSE 0 END) AS exit_value,
            SUM(f.fee) AS fees
          FROM ${T}.fills f
          JOIN ${T}.child_orders c ON c.id = f.child_order_id
          GROUP BY c.execution_id
        ) g ON g.execution_id = e3.id
        WHERE e3.user_id = $1 AND e3.completed_at IS NOT NULL AND e3.completed_at >= $2
          AND e3.average_fill_price IS NOT NULL), 0) AS realized_pnl`,
    scopeParam: 1,
  },
  insertChildOrder: {
    sql: `INSERT INTO ${T}.child_orders (execution_id, exchange_order_id, client_order_id, symbol, side, type, price, quantity, filled_quantity, status, is_exit, submitted_at, updated_at, filled_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
  },
  listChildOrders: { sql: `SELECT * FROM ${T}.child_orders WHERE execution_id = $1 ORDER BY submitted_at, id` },
  // account_id is taken from the owning execution (FillRecord carries no
  // accountId in the frozen contract) and `ON CONFLICT DO NOTHING` yields zero
  // rows on the dedup hit, so insertFill resolves null (PRD §62 idempotency).
  insertFill: {
    sql: `INSERT INTO ${T}.fills (execution_id, child_order_id, account_id, exchange_trade_id, price, quantity, quote_quantity, fee, fee_asset, timestamp) SELECT $1, $2, e.account_id, $3, $4, $5, $6, $7, $8, $9 FROM ${T}.executions e WHERE e.id = $1 ON CONFLICT (account_id, exchange_trade_id) DO NOTHING RETURNING *`,
    dedupConflict: ['account_id', 'exchange_trade_id'],
  },
  listFills: { sql: `SELECT * FROM ${T}.fills WHERE execution_id = $1 ORDER BY timestamp, id` },
  appendEvent: {
    sql: `INSERT INTO ${T}.execution_events (execution_id, name, payload, created_at) VALUES ($1, $2, $3, $4) RETURNING *`,
  },
  listEvents: { sql: `SELECT * FROM ${T}.execution_events WHERE execution_id = $1 ORDER BY id` },
  getRiskProfile: { sql: `SELECT profile, updated_at FROM ${T}.risk_profiles WHERE user_id = $1`, scopeParam: 1 },
  putRiskProfile: {
    sql: `INSERT INTO ${T}.risk_profiles (user_id, profile, updated_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = EXCLUDED.updated_at RETURNING profile`,
    scopeParam: 1,
  },
  insertBalanceSnapshot: { sql: `INSERT INTO ${T}.balance_snapshots (account_id, payload, created_at) VALUES ($1, $2, $3)` },
  insertPositionSnapshot: { sql: `INSERT INTO ${T}.positions_snapshots (account_id, payload, created_at) VALUES ($1, $2, $3)` },
  insertAudit: { sql: `INSERT INTO ${T}.audit_logs (user_id, action, target, payload, created_at) VALUES ($1, $2, $3, $4, $5)`, scopeParam: 1 },
  rotateAccounts: { sql: `SELECT id, api_key_encrypted, api_secret_encrypted, passphrase_encrypted, iv, auth_tag FROM ${T}.exchange_accounts` },
  rotateUpdate: { sql: `UPDATE ${T}.exchange_accounts SET api_key_encrypted = $2, api_secret_encrypted = $3, passphrase_encrypted = $4, iv = $5, auth_tag = $6 WHERE id = $1` },
} as const;

// ---------------------------------------------------------------------------
// Envelope helpers over the row layout (iv/auth_tag carry 12-byte IV + 16-byte
// tag per secret, in column order: api_key, api_secret, [passphrase]).
// ---------------------------------------------------------------------------
const IV_LEN = 12;
const TAG_LEN = 16;
interface Envelope {
  apiKeyEnc: Buffer;
  apiSecretEnc: Buffer;
  passphraseEnc: Buffer | null;
  iv: Buffer;
  authTag: Buffer;
}
interface EnvelopeRow {
  id: string;
  api_key_encrypted: Uint8Array;
  api_secret_encrypted: Uint8Array;
  passphrase_encrypted: Uint8Array | null;
  iv: Uint8Array;
  auth_tag: Uint8Array;
}
function sealCredentials(creds: DecryptedCredentials, keyHex: string): Envelope {
  const parts: SealedSecret[] = [sealSecret(creds.apiKey, keyHex), sealSecret(creds.apiSecret, keyHex)];
  if (creds.passphrase != null) parts.push(sealSecret(creds.passphrase, keyHex));
  return {
    apiKeyEnc: parts[0].ciphertext,
    apiSecretEnc: parts[1].ciphertext,
    passphraseEnc: parts.length > 2 ? parts[2].ciphertext : null,
    iv: Buffer.concat(parts.map((p) => p.iv)),
    authTag: Buffer.concat(parts.map((p) => p.tag)),
  };
}
function openCredentials(row: EnvelopeRow, keyHex: string): DecryptedCredentials {
  const iv = Buffer.from(row.iv);
  const tag = Buffer.from(row.auth_tag);
  const hasPass = row.passphrase_encrypted != null;
  const count = hasPass ? 3 : 2;
  if (iv.length !== count * IV_LEN || tag.length !== count * TAG_LEN) {
    throw new Error('credential envelope layout does not match the stored secret count');
  }
  const cts = [Buffer.from(row.api_key_encrypted), Buffer.from(row.api_secret_encrypted)];
  if (hasPass) cts.push(Buffer.from(row.passphrase_encrypted as Uint8Array));
  return {
    apiKey: openSecret({ iv: iv.subarray(0, IV_LEN), tag: tag.subarray(0, TAG_LEN), ciphertext: cts[0] }, keyHex),
    apiSecret: openSecret({ iv: iv.subarray(IV_LEN, 2 * IV_LEN), tag: tag.subarray(TAG_LEN, 2 * TAG_LEN), ciphertext: cts[1] }, keyHex),
    passphrase: hasPass
      ? openSecret({ iv: iv.subarray(2 * IV_LEN, 3 * IV_LEN), tag: tag.subarray(2 * TAG_LEN, 3 * TAG_LEN), ciphertext: cts[2] }, keyHex)
      : null,
  };
}
function nowMs(at?: number): number {
  return at ?? Date.now();
}
// risk_policy has no field on the frozen ExecutionRecord but does have a column
// (PRD §37 rides along on create); read it structurally so a caller that carries
// it persists it without this store widening the contract.
function riskPolicyOf(rec: object): string | null {
  if (!('riskPolicy' in rec) || rec.riskPolicy == null) return null;
  return String(rec.riskPolicy);
}

// ---------------------------------------------------------------------------
// The store (PRD §59). Everything runs through parameterized `sql.unsafe`.
// ---------------------------------------------------------------------------
export const store: ExecutorStore = {
  // --- Credentials (PRD §45–§47) -------------------------------------------
  async createCredential({ userId, exchange, label, credentials, permissions }) {
    const keyHex = masterKeyFromEnv();
    const env = sealCredentials(credentials, keyHex);
    const at = nowMs();
    const rows = await db().unsafe(
      `INSERT INTO ${T}.exchange_accounts (user_id, exchange, label, api_key_masked, api_key_encrypted, api_secret_encrypted, passphrase_encrypted, iv, auth_tag, permissions, health, created_at, updated_at, last_used_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11, $11, NULL, NULL) RETURNING *`,
      [
        userId, exchange, label, maskApiKey(credentials.apiKey),
        env.apiKeyEnc, env.apiSecretEnc, env.passphraseEnc, env.iv, env.authTag,
        JSON.stringify(permissions), at,
      ],
    );
    return accountRowToRecord(rows[0]);
  },

  async listCredentials(userId) {
    const rows = await db().unsafe(SQL_STATEMENTS.listCredentials.sql, [userId]);
    return rows.map(accountRowToRecord);
  },

  async getCredential(userId, id) {
    const rows = await db().unsafe(SQL_STATEMENTS.getCredential.sql, [userId, id]);
    return rows[0] ? accountRowToRecord(rows[0]) : null;
  },

  /** The ONLY plaintext path (PRD §44/§100). User-scoped; never logged. */
  async revealCredentials(userId, id) {
    const keyHex = masterKeyFromEnv();
    const rows = await db().unsafe<EnvelopeRow>(SQL_STATEMENTS.revealCredential.sql, [userId, id]);
    return rows[0] ? openCredentials(rows[0], keyHex) : null;
  },

  async updateCredentialHealth(userId, id, health) {
    await db().unsafe(SQL_STATEMENTS.updateCredentialHealth.sql, [userId, id, health, nowMs()]);
  },

  async touchCredential(userId, id, at) {
    await db().unsafe(SQL_STATEMENTS.touchCredential.sql, [userId, id, nowMs(at)]);
  },

  async revokeCredential(userId, id, at) {
    await db().unsafe(SQL_STATEMENTS.revokeCredential.sql, [userId, id, nowMs(at)]);
  },

  /**
   * Key rotation (PRD §44): re-encrypt every row under `newMasterKey`. Rows
   * already sealed with the new key pass through unchanged (idempotent rerun);
   * a row decryptable under neither key aborts the rotation loudly. Secrets
   * exist in memory only for the duration of the per-row transform.
   */
  async rotateCredentialKeys(newMasterKey, oldMasterKey) {
    const rows = await db().unsafe<EnvelopeRow>(SQL_STATEMENTS.rotateAccounts.sql);
    let count = 0;
    for (const row of rows) {
      let creds: DecryptedCredentials | null = null;
      for (const key of [oldMasterKey, newMasterKey]) {
        try {
          creds = openCredentials(row, key);
          break;
        } catch {
          // wrong key for this row — try the next
        }
      }
      if (!creds) throw new Error(`credential rotation failed: row ${row.id} decrypts under neither key`);
      const env = sealCredentials(creds, newMasterKey);
      await db().unsafe(SQL_STATEMENTS.rotateUpdate.sql, [row.id, env.apiKeyEnc, env.apiSecretEnc, env.passphraseEnc, env.iv, env.authTag]);
      count += 1;
    }
    return count;
  },

  // --- Executions (PRD §60, §63) -------------------------------------------
  /**
   * Writes the execution row + the immutable plan snapshot + the
   * EXECUTION_CREATED/PLAN_CREATED events in ONE transaction (PRD §56/§99/§63):
   * a half-created execution would break worker recovery's assumptions.
   */
  async createExecution(rec) {
    const at = nowMs();
    const strategyState = rec.strategyState;
    const inserted = await db().begin(async (tx) => {
      const rows = await tx.unsafe(
        `INSERT INTO ${T}.executions (user_id, account_id, exchange, symbol, market_type, side, intent, status, mode, sizing_mode, sizing_value, risk_budget, risk_basis, entry_definition, stop_definition, take_profit_definition, execution_strategy, execution_config, constraints, planned_quantity, planned_notional, actual_quantity, actual_notional, average_fill_price, estimated_fees, actual_fees, planned_risk, current_risk, risk_policy, strategy_state, created_at, started_at, completed_at, cancelled_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, NULL, NULL, NULL) RETURNING *`,
        [
          rec.userId, rec.accountId, rec.exchange, rec.symbol, rec.marketType, rec.side, rec.intent,
          rec.status, rec.mode, rec.sizingMode, rec.sizingValue, rec.riskBudget, rec.riskBasis,
          JSON.stringify(rec.entryDefinition), JSON.stringify(rec.stopDefinition ?? null),
          JSON.stringify(rec.takeProfitDefinition), rec.executionStrategy,
          JSON.stringify(rec.executionConfig), JSON.stringify(rec.constraints),
          // `actual_quantity`/`actual_notional` are NOT NULL with no default: a
          // freshly created execution has honestly filled ZERO, and "no fills yet"
          // is 0 — not an unknown, and not NULL.
          rec.plannedQuantity, rec.plannedNotional, rec.actualQuantity ?? 0, rec.actualNotional ?? 0,
          rec.averageFillPrice, rec.estimatedFees, rec.actualFees, rec.plannedRisk, rec.currentRisk,
          riskPolicyOf(rec), strategyState === undefined ? null : JSON.stringify(strategyState), at,
        ],
      );
      // The id comes back from the INSERT (gen_random_uuid), so the plan and the
      // event rows below can be keyed to it without a second lookup.
      const id = rows[0].id;
      await tx.unsafe(`INSERT INTO ${T}.execution_plans (execution_id, plan, created_at) VALUES ($1, $2, $3)`, [id, JSON.stringify(rec.plan), at]);
      await tx.unsafe(
        `INSERT INTO ${T}.execution_events (execution_id, name, payload, created_at) VALUES ($1, 'EXECUTION_CREATED', '{}'::jsonb, $2), ($1, 'PLAN_CREATED', '{}'::jsonb, $2)`,
        [id, at],
      );
      return rows;
    });
    return executionRowToRecord(inserted[0]);
  },

  /** Immutable creation-time plan (PRD §56/§99); the jsonb passes through unmangled. */
  async getExecutionPlan(executionId) {
    const rows = await db().unsafe(SQL_STATEMENTS.getExecutionPlan.sql, [executionId]);
    return rows[0] ? json<ExecutionPlan | null>(rows[0].plan, null) : null;
  },

  async getExecution(userId, id) {
    const rows = await db().unsafe(SQL_STATEMENTS.getExecution.sql, [userId, id]);
    return rows[0] ? executionRowToRecord(rows[0]) : null;
  },

  /** Worker-side read, deliberately unscoped (PRD §68/§114). */
  async getExecutionForWorker(id) {
    const rows = await db().unsafe(SQL_STATEMENTS.getExecutionForWorker.sql, [id]);
    return rows[0] ? executionRowToRecord(rows[0]) : null;
  },

  async listExecutions(userId, opts) {
    const limit = Math.max(1, Math.trunc(opts?.limit ?? 100));
    const status = opts?.status;
    const rows =
      status === undefined
        ? await db().unsafe(SQL_STATEMENTS.listExecutions.sql, [userId, limit])
        : await db().unsafe(SQL_STATEMENTS.listExecutionsByStatus.sql, [userId, status, limit]);
    return rows.map(executionRowToRecord);
  },

  async updateExecutionStatus(id, status, at) {
    // started/completed/cancelled derive from the transition (PRD §60); columns
    // outside the SET list can never be wiped by a status change.
    const ts = nowMs(at);
    await db().unsafe(
      `UPDATE ${T}.executions SET status = $2, started_at = COALESCE(started_at, CASE WHEN $2 = 'RUNNING' THEN $3 END), completed_at = CASE WHEN $2 IN ('FILLED', 'FAILED', 'CANCELLED', 'RISK_STOPPED', 'EXPIRED', 'STOPPED') THEN COALESCE(completed_at, $3) ELSE completed_at END, cancelled_at = CASE WHEN $2 = 'CANCELLED' THEN COALESCE(cancelled_at, $3) ELSE cancelled_at END WHERE id = $1`,
      [id, status, ts],
    );
  },

  async updateExecutionProgress(id, patch) {
    const set: string[] = [];
    const vals: unknown[] = [id];
    const add = (col: string, v: unknown): void => {
      vals.push(v);
      set.push(`${col} = $${vals.length}`);
    };
    if (patch.actualQuantity !== undefined) add('actual_quantity', patch.actualQuantity);
    if (patch.actualNotional !== undefined) add('actual_notional', patch.actualNotional);
    if (patch.averageFillPrice !== undefined) add('average_fill_price', patch.averageFillPrice);
    if (patch.actualFees !== undefined) add('actual_fees', patch.actualFees);
    if (patch.currentRisk !== undefined) add('current_risk', patch.currentRisk);
    if (set.length === 0) return;
    await db().unsafe(`UPDATE ${T}.executions SET ${set.join(', ')} WHERE id = $1`, vals);
  },

  async updateExecutionStrategyState(id, state) {
    await db().unsafe(`UPDATE ${T}.executions SET strategy_state = $2 WHERE id = $1`, [id, state == null ? null : JSON.stringify(state)]);
  },

  async insertSnapshot(rec) {
    const stmt = rec.kind === 'balance' ? SQL_STATEMENTS.insertBalanceSnapshot : SQL_STATEMENTS.insertPositionSnapshot;
    await db().unsafe(stmt.sql, [rec.accountId, JSON.stringify(rec.payload), nowMs(rec.createdAt)]);
  },

  // --- Child orders (PRD §61) ----------------------------------------------
  async insertChildOrder(rec) {
    const rows = await db().unsafe(SQL_STATEMENTS.insertChildOrder.sql, [
      rec.executionId, rec.exchangeOrderId, rec.clientOrderId, rec.symbol, rec.side, rec.type,
      rec.price, rec.quantity, rec.filledQuantity, rec.status, rec.isExit,
      rec.submittedAt, nowMs(rec.updatedAt), rec.filledAt,
    ]);
    return childOrderRowToRecord(rows[0]);
  },

  /** Present keys update, absent/undefined keys are left alone; null clears. */
  async updateChildOrder(executionId, clientOrderId, patch) {
    const set: string[] = [];
    const vals: unknown[] = [executionId, clientOrderId];
    const add = (col: string, v: unknown): void => {
      if (v === undefined) return;
      vals.push(v);
      set.push(`${col} = $${vals.length}`);
    };
    add('exchange_order_id', patch.exchangeOrderId);
    add('symbol', patch.symbol);
    add('side', patch.side);
    add('type', patch.type);
    add('price', patch.price);
    add('quantity', patch.quantity);
    add('filled_quantity', patch.filledQuantity);
    add('status', patch.status);
    add('is_exit', patch.isExit);
    add('submitted_at', patch.submittedAt);
    add('updated_at', patch.updatedAt == null ? undefined : nowMs(patch.updatedAt));
    add('filled_at', patch.filledAt);
    if (set.length === 0) return;
    await db().unsafe(`UPDATE ${T}.child_orders SET ${set.join(', ')} WHERE execution_id = $1 AND client_order_id = $2`, vals);
  },

  async listChildOrders(executionId) {
    const rows = await db().unsafe(SQL_STATEMENTS.listChildOrders.sql, [executionId]);
    return rows.map(childOrderRowToRecord);
  },

  // --- Fills (PRD §62) -----------------------------------------------------
  /** Idempotent on (account_id, exchange_trade_id): a dedup hit resolves null. */
  async insertFill(rec) {
    const rows = await db().unsafe(SQL_STATEMENTS.insertFill.sql, [
      rec.executionId, rec.childOrderId, rec.exchangeTradeId,
      rec.price, rec.quantity, rec.quoteQuantity, rec.fee, rec.feeAsset, rec.timestamp,
    ]);
    return rows[0] ? fillRowToRecord(rows[0]) : null;
  },

  async listFills(executionId) {
    const rows = await db().unsafe(SQL_STATEMENTS.listFills.sql, [executionId]);
    return rows.map(fillRowToRecord);
  },

  // --- Events (PRD §63): append-only, no update method exists ---------------
  async appendEvent(executionId, name, payload, at) {
    const rows = await db().unsafe(SQL_STATEMENTS.appendEvent.sql, [executionId, name, JSON.stringify(payload), nowMs(at)]);
    return eventRowToRecord(rows[0]);
  },

  async listEvents(executionId) {
    const rows = await db().unsafe(SQL_STATEMENTS.listEvents.sql, [executionId]);
    return rows.map(eventRowToRecord);
  },

  // --- Risk profiles (PRD §72, §88, §119) -----------------------------------
  /** Absent row or absent keys fall back to DEFAULT_RISK_PROFILE. */
  async getRiskProfile(userId) {
    const rows = await db().unsafe(SQL_STATEMENTS.getRiskProfile.sql, [userId]);
    return mergeProfile(rows[0] ? json<Partial<RiskProfile>>(rows[0].profile, {}) : null);
  },

  async putRiskProfile(userId, profile) {
    const rows = await db().unsafe(SQL_STATEMENTS.putRiskProfile.sql, [userId, JSON.stringify(profile), nowMs()]);
    return mergeProfile(json<Partial<RiskProfile>>(rows[0].profile, {}));
  },

  // --- Audit (PRD §110) -----------------------------------------------------
  async audit(rec) {
    await db().unsafe(SQL_STATEMENTS.insertAudit.sql, [rec.userId, rec.action, rec.target, JSON.stringify(rec.payload), nowMs(rec.createdAt)]);
  },

  // --- Worker recovery scan (PRD §114) --------------------------------------
  /** NOT user-scoped: recovery is a worker concern (see SQL_STATEMENTS note). */
  async listRunningExecutions() {
    const rows = await db().unsafe(SQL_STATEMENTS.listRunningExecutions.sql);
    return rows.map(executionRowToRecord);
  },

  // --- Portfolio risk (PRD §73/§74) ------------------------------------------
  /**
   * What the user has ALREADY committed, so a new execution can be refused
   * before it exists. `sinceMs` bounds the realized-loss window (§74).
   */
  async summarizePortfolioRisk(userId, sinceMs) {
    const rows = await db().unsafe(SQL_STATEMENTS.summarizePortfolioRisk.sql, [userId, sinceMs]);
    const row = rows[0];
    return {
      // A live execution with no quantifiable risk (no stop ⇒ no bounded risk,
      // PRD §38) still represents exposure, so `openRisk` stays a number here
      // and the CALLER decides how to treat an unbounded leg (§73 is a sum over
      // bounded risk; it must not read as "the book is empty").
      openRisk: Number(row.open_risk ?? 0),
      realizedPnlToday: Number(row.realized_pnl ?? 0),
      liveCount: Number(row.live_count ?? 0),
    };
  },
};
