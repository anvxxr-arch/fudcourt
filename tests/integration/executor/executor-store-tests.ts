/**
 * Executor store unit tests (PRD §44, §59–§63, §72, §108, §114, §119):
 * OFFLINE — no network, no Postgres, no Valkey, no env mutation beyond
 * `FUDCOURT_EXECUTOR_MASTER_KEY` (saved and restored around the crypto tests).
 *
 * Contract under test: `@/platform/executor/store` — the deterministic core is
 * the pure seams (envelope crypto, profile merge, fill dedup key, row mappers,
 * the embedded DDL). The `store` object itself runs against an in-memory
 * `ExecutorSql` fake injected through `setStoreDbForTests`, which is restored
 * to `null` in `after()` so a later suite in the same process sees the real
 * (Bun-only) client again.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXECUTOR_DDL,
  SQL_STATEMENTS,
  accountRowToRecord,
  childOrderRowToRecord,
  ensureExecutorSchema,
  eventRowToRecord,
  executionRowToRecord,
  fillDedupKey,
  fillRowToRecord,
  masterKeyFromEnv,
  mergeProfile,
  openSecret,
  sealSecret,
  setStoreDbForTests,
  store,
  type ExecutorSql,
} from '@/platform/executor/store';
import {
  canTransition,
  DEFAULT_RISK_PROFILE,
  EXECUTION_TRANSITIONS,
  EXECUTOR_SCHEMA,
  isTerminalExecution,
  type ExecutionStatus,
  type RiskProfile,
} from '@/platform/executor/types';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
/** Valid key, valid length, but not hex — must be rejected by the fail-closed guard. */
const KEY_NOT_HEX = 'z'.repeat(64);
/** Temporal-rotation realistic credentials (a passphrase is only used by some venues). */
const API_KEY = 'AKIA9EXAMPLE0KEY';
const API_SECRET = 's3cr3t/binary+bytes=with-padding';
const PASSPHRASE = 'pass phrase with spaces';
const USER_A = 'user-alice';
const USER_B = 'user-bob';
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const EXEC_A = '33333333-3333-4333-8333-333333333333';
const EXEC_B = '44444444-4444-4444-8444-444444444444';
/** Statuses the store's UPDATE stamps `completed_at` for — PRD §57 terminal set. */
const EXECUTION_TERMINALS: readonly ExecutionStatus[] = ['FILLED', 'FAILED', 'CANCELLED', 'RISK_STOPPED', 'EXPIRED', 'STOPPED'];

/** Tolerance for precision-sensitive comparisons (never float equality). */
const EPS = 1e-9;
function assertClose(actual: number, expected: number, what: string): void {
  assert.ok(Number.isFinite(actual), `${what}: not finite (${actual})`);
  assert.ok(Math.abs(actual - expected) <= EPS * Math.max(1, Math.abs(expected)), `${what}: ${actual} !== ${expected}`);
}

/**
 * The master key the suite was STARTED with. `withMasterKey` restores whatever
 * it found, so a test may assert restoration without assuming the ambient value
 * is absent — it is a real key whenever the suite runs with one exported.
 */
const PRIOR_MASTER_KEY = process.env.FUDCOURT_EXECUTOR_MASTER_KEY;
/** Run `fn` with `FUDCOURT_EXECUTOR_MASTER_KEY` bound, restoring the caller's value. */
function withMasterKey<T>(key: string | undefined, fn: () => T): T {
  const prior = process.env.FUDCOURT_EXECUTOR_MASTER_KEY;
  if (key === undefined) delete process.env.FUDCOURT_EXECUTOR_MASTER_KEY;
  else process.env.FUDCOURT_EXECUTOR_MASTER_KEY = key;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.FUDCOURT_EXECUTOR_MASTER_KEY;
    else process.env.FUDCOURT_EXECUTOR_MASTER_KEY = prior;
  }
}

// --- In-memory ExecutorSql fake ---------------------------------------------
// Models only what the store under test actually needs: the documented
// uniqueness of (account_id, exchange_trade_id) on fills (PRD §62), the
// user_id scoping of the credential/execution reads (PRD §108), and the
// `account_id` that a fill inherits from its owning execution row.
interface CapturedQuery {
  sql: string;
  params: unknown[];
}

class FakeSql implements ExecutorSql {
  readonly queries: CapturedQuery[] = [];
  readonly accounts: Record<string, unknown>[] = [];
  readonly executions: Record<string, unknown>[] = [];
  readonly childOrders: Record<string, unknown>[] = [];
  readonly riskProfiles: Record<string, unknown> = {};
  readonly fills: Record<string, unknown>[] = [];
  readonly audits: Record<string, unknown>[] = [];
  private seq = 0;

  private id(): string {
    this.seq += 1;
    return `fake-uuid-${this.seq}`;
  }

  async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
    this.queries.push({ sql: query, params });
    const [userId, id] = [params[0], params[1]] as [string, string];

    if (query.includes('INSERT INTO executor.exchange_accounts')) {
      const [uid, exchange, label, masked, keyEnc, secretEnc, passEnc, iv, tag, permissions, at] = params;
      const row: Record<string, unknown> = {
        id: this.id(),
        user_id: uid,
        exchange,
        label,
        api_key_masked: masked,
        api_key_encrypted: keyEnc,
        api_secret_encrypted: secretEnc,
        passphrase_encrypted: passEnc,
        iv,
        auth_tag: tag,
        permissions,
        health: 'ACTIVE',
        created_at: at,
        updated_at: at,
        last_used_at: null,
        revoked_at: null,
      };
      this.accounts.push(row);
      return [row] as unknown as T[];
    }
    if (query.includes('SELECT id, api_key_encrypted')) {
      return this.accounts as unknown as T[];
    }
    if (query.includes('SET api_key_encrypted')) {
      // rotateUpdate binds the row id as $1 and the envelope as $2..$6.
      const row = this.accounts.find((a) => a.id === params[0]);
      if (row) {
        row.api_key_encrypted = params[1];
        row.api_secret_encrypted = params[2];
        row.passphrase_encrypted = params[3];
        row.iv = params[4];
        row.auth_tag = params[5];
      }
      return [] as unknown as T[];
    }
    if (query.includes('UPDATE executor.exchange_accounts SET health =')) {
      const row = this.accounts.find((a) => a.user_id === userId && a.id === id);
      if (row) {
        row.health = params[2];
        row.updated_at = params[3];
      }
      return [] as unknown as T[];
    }
    if (query.includes('SELECT * FROM executor.exchange_accounts WHERE user_id = $1 AND id = $2')) {
      return this.accounts.filter((a) => a.user_id === userId && a.id === id) as unknown as T[];
    }
    if (query.includes('SELECT * FROM executor.exchange_accounts WHERE user_id = $1')) {
      return this.accounts.filter((a) => a.user_id === userId) as unknown as T[];
    }
    if (query.includes('SELECT * FROM executor.executions WHERE user_id = $1 AND id = $2')) {
      return this.executions.filter((e) => e.user_id === userId && e.id === id) as unknown as T[];
    }
    if (query.includes('INSERT INTO executor.fills')) {
      // `... SELECT $1, $2, e.account_id, $3, ... FROM executions e WHERE e.id = $1`
      const execution = this.executions.find((e) => e.id === params[0]);
      if (!execution) return [] as unknown as T[]; // the SELECT has no source row
      const accountId = String(execution.account_id);
      const tradeId = String(params[2]);
      // UNIQUE (account_id, exchange_trade_id) → a duplicate yields zero rows.
      const clash = this.fills.some((f) => f.account_id === accountId && f.exchange_trade_id === tradeId);
      if (clash) return [] as unknown as T[];
      const row: Record<string, unknown> = {
        id: this.id(),
        execution_id: params[0],
        child_order_id: params[1],
        account_id: accountId,
        exchange_trade_id: tradeId,
        price: params[3],
        quantity: params[4],
        quote_quantity: params[5],
        fee: params[6],
        fee_asset: params[7],
        timestamp: params[8],
      };
      this.fills.push(row);
      return [row] as unknown as T[];
    }
    if (query.startsWith('CREATE SCHEMA') || query.startsWith('CREATE TABLE') || query.startsWith('CREATE INDEX')) {
      return [] as unknown as T[]; // the bootstrap is idempotent by construction
    }
    if (query.startsWith('UPDATE executor.executions SET status')) {
      // Binds the execution id as $1 (§68); `??=` mirrors the store's COALESCE.
      const execution = this.executions.find((e) => e.id === params[0]);
      if (execution) {
        execution.status = params[1];
        if (params[1] === 'RUNNING') execution.started_at ??= params[2];
        if ((EXECUTION_TERMINALS as readonly string[]).includes(String(params[1]))) execution.completed_at ??= params[2];
        if (params[1] === 'CANCELLED') execution.cancelled_at ??= params[2];
      }
      return [] as unknown as T[];
    }
    if (query.startsWith('UPDATE executor.executions SET actual_quantity')) {
      const execution = this.executions.find((e) => e.id === params[0]);
      if (execution) {
        // Patched columns are bound in declaration order (store.ts builds the
        // SET list the same way), so positional parity is the invariant here.
        const columns = [...query.matchAll(/(\w+) = \$\d+/g)].map((m) => m[1]);
        for (const [i, column] of columns.entries()) {
          execution[camelize(column)] = params[i + 1];
        }
      }
      return [] as unknown as T[];
    }
    if (query.startsWith('UPDATE executor.child_orders SET')) {
      const child = this.childOrders.find(
        (c) => c.execution_id === params[0] && c.client_order_id === params[1],
      );
      if (child) {
        const columns = [...query.matchAll(/(\w+) = \$\d+/g)].map((m) => m[1]);
        for (const [i, column] of columns.entries()) child[camelize(column)] = params[i + 2];
      }
      return [] as unknown as T[];
    }
    if (query.startsWith('SELECT * FROM executor.executions WHERE id = $1')) {
      // The worker read binds the id alone (§68) — params[1] does not exist.
      return this.executions.filter((e) => e.id === params[0]) as unknown as T[];
    }
    if (query.startsWith('INSERT INTO executor.audit_logs')) {
      this.audits.push({ user_id: params[0], action: params[1], target: params[2], payload: params[3], created_at: params[4] });
      return [] as unknown as T[];
    }
    if (query.startsWith('SELECT profile, updated_at FROM executor.risk_profiles')) {
      const profile = this.riskProfiles[userId];
      return (profile === undefined ? [] : [{ profile, updated_at: 1 }]) as unknown as T[];
    }
    throw new Error(`FakeSql: unhandled statement — ${query.slice(0, 90)}`);
  }

  async begin<T>(fn: (tx: ExecutorSql) => Promise<T>): Promise<T> {
    return fn(this);
  }

  seedExecution(id: string, userId: string, accountId: string): void {
    this.executions.push({ id, user_id: userId, account_id: accountId, status: 'RUNNING' });
  }

  /** A row complete enough for `executionRowToRecord` — the worker read path. */
  seedExecutionRow(id: string, userId: string, accountId: string): void {
    const existing = this.executions.findIndex((e) => e.id === id);
    const row: Record<string, unknown> = {
      id, user_id: userId, account_id: accountId, exchange: 'binance', symbol: 'BTC/USDT',
      market_type: 'linear_perp', side: 'buy', intent: 'open', status: 'RUNNING', mode: 'live',
      sizing_mode: 'risk_percent', sizing_value: 1, entry_definition: '{"type":"market"}',
      take_profit_definition: '[]', execution_strategy: 'twap',
      execution_config: '{"type":"twap","durationMs":1800000}', constraints: '{}',
      planned_quantity: 0.01, planned_notional: 1000, actual_quantity: 0, actual_notional: 0,
      actual_fees: 0, created_at: 1700000000000,
    };
    if (existing >= 0) this.executions[existing] = row;
    else this.executions.push(row);
  }

  seedChildOrder(row: Record<string, unknown>): void {
    this.childOrders.push(row);
  }
}

/** snake_case column → the record field the mappers produce. */
function camelize(column: string): string {
  return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Install a fresh fake for one test and return it. */
function useFake(): FakeSql {
  const fake = new FakeSql();
  setStoreDbForTests(fake);
  return fake;
}

function lastQuery(fake: FakeSql): CapturedQuery {
  const q = fake.queries[fake.queries.length - 1];
  assert.ok(q, 'expected the store to have issued a statement');
  return q;
}

// ---------------------------------------------------------------------------
// Credential envelope crypto (PRD §44)
// ---------------------------------------------------------------------------

test('§44: sealSecret/openSecret round-trips UTF-8, binary-ish and empty secrets', () => {
  const secrets = [
    API_KEY,
    API_SECRET, // contains '/', '+', '=' — base64 padding must survive verbatim
    'ключ-Ω-🔑', // multi-byte UTF-8: a byte-length round trip must decode back
    '',
    'x'.repeat(4096),
  ];
  for (const plain of secrets) {
    const sealed = sealSecret(plain, KEY_A);
    assert.equal(sealed.iv.length, 12, 'IV must be the 12-byte GCM nonce');
    assert.equal(sealed.tag.length, 16, 'auth tag must be the 16-byte GCM tag');
    assert.equal(sealed.ciphertext.length, Buffer.byteLength(plain, 'utf8'), 'GCM is a stream cipher: ciphertext length == plaintext byte length');
    assert.equal(openSecret(sealed, KEY_A), plain);
  }
});

test('§44: a wrong key fails closed and never returns (partial) plaintext', () => {
  const sealed = sealSecret(API_SECRET, KEY_A);
  assert.throws(() => openSecret(sealed, KEY_B), /unable to authenticate|Unsupported state/i);
  // One bit flipped in the key must be as fatal as a wholly different key.
  const nearMissKey = `${'a'.repeat(63)}b`;
  assert.equal(nearMissKey.length, 64);
  assert.throws(() => openSecret(sealed, nearMissKey));
  // Same nonce + ciphertext under the wrong key must not open.
  const foreign = sealSecret(API_SECRET, KEY_B);
  assert.throws(() => openSecret({ ...sealed, iv: foreign.iv }, KEY_A));
});

test('§44: tampered ciphertext, tag or truncated IV is rejected by the GCM tag', () => {
  const sealed = sealSecret(API_SECRET, KEY_A);
  const flippedCipher = Buffer.from(sealed.ciphertext);
  flippedCipher[0] ^= 0x01;
  assert.throws(() => openSecret({ ...sealed, ciphertext: flippedCipher }, KEY_A));

  const flippedTag = Buffer.from(sealed.tag);
  flippedTag[0] ^= 0x01;
  assert.throws(() => openSecret({ ...sealed, tag: flippedTag }, KEY_A));

  assert.throws(() => openSecret({ ...sealed, iv: sealed.iv.subarray(0, 8) }, KEY_A));
  assert.throws(() => openSecret({ ...sealed, ciphertext: sealed.ciphertext.subarray(1) }, KEY_A));
});

test('§44: two seals of the same plaintext under the same key never share a nonce', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 64; i += 1) {
    const sealed = sealSecret(API_SECRET, KEY_A);
    seen.add(sealed.iv.toString('hex'));
    // Deterministic payload ⇒ the only thing that can differ is the nonce.
    assert.equal(openSecret(sealed, KEY_A), API_SECRET);
  }
  assert.equal(seen.size, 64, 'a reused GCM nonce would leak the keystream — every seal needs a fresh IV');
  const a = sealSecret(API_SECRET, KEY_A);
  const b = sealSecret(API_SECRET, KEY_A);
  assert.notEqual(a.iv.toString('hex'), b.iv.toString('hex'));
  assert.notEqual(a.ciphertext.toString('hex'), b.ciphertext.toString('hex'));
  assert.notEqual(a.tag.toString('hex'), b.tag.toString('hex'));
});

test('§44: the stored envelope never contains the plaintext (or its fragments)', () => {
  const sealed = sealSecret(API_SECRET, KEY_A);
  const blob = Buffer.concat([sealed.iv, sealed.tag, sealed.ciphertext]);
  const asText = blob.toString('utf8');
  const asHex = blob.toString('hex');
  assert.ok(!asText.includes(API_SECRET), 'plaintext present in the blob');
  assert.ok(!asHex.includes(Buffer.from(API_SECRET, 'utf8').toString('hex')), 'plaintext present in the blob (hex)');
  assert.ok(!asText.includes(API_KEY), 'a different secret leaked into this envelope');
  // The masked form the UI is allowed to show (§109) must not be recoverable either.
  assert.ok(!asText.includes(`${API_KEY.slice(0, 3)}...${API_KEY.slice(-3)}`));
});

test('§44: a non-32-byte or non-hex key is refused before any crypto runs', () => {
  for (const bad of [KEY_NOT_HEX, '', 'ab'.repeat(31), 'ab'.repeat(33), KEY_A.slice(0, 63), KEY_A + 'a']) {
    assert.throws(() => sealSecret(API_SECRET, bad), /key must be 64 hex chars/);
    assert.throws(() => openSecret(sealSecret(API_SECRET, KEY_A), bad), /key must be 64 hex chars/);
  }
});

test('§44: masterKeyFromEnv is fail-closed — absent or malformed ⇒ throw, never a fallback key', () => {
  withMasterKey(undefined, () => assert.throws(() => masterKeyFromEnv(), /fail-closed|malformed/));
  withMasterKey('', () => assert.throws(() => masterKeyFromEnv()));
  withMasterKey('abc', () => assert.throws(() => masterKeyFromEnv()));
  withMasterKey(KEY_NOT_HEX, () => assert.throws(() => masterKeyFromEnv()));
  withMasterKey('a'.repeat(63), () => assert.throws(() => masterKeyFromEnv()));
  // Uppercase hex is a valid 32-byte key.
  withMasterKey('A1B2C3D4'.repeat(8), () => assert.equal(masterKeyFromEnv(), 'A1B2C3D4'.repeat(8)));
  withMasterKey(KEY_A, () => assert.equal(masterKeyFromEnv(), KEY_A));
  // Restored to whatever the ambient environment had — `undefined` in a clean
  // run, a real key when the suite runs with one exported (CI, E2E shell).
  // Asserting `undefined` would fail on the outer value.
  assert.equal(process.env.FUDCOURT_EXECUTOR_MASTER_KEY, PRIOR_MASTER_KEY, 'the env must be restored for the other suites');
});

// ---------------------------------------------------------------------------
// Fill dedup key (PRD §62)
// ---------------------------------------------------------------------------

test('§62: fillDedupKey is stable for one (account, trade) and separates either component', () => {
  const base = fillDedupKey(ACCOUNT_A, '99887766');
  assert.equal(fillDedupKey(ACCOUNT_A, '99887766'), base, 'the same fill must always produce the same key');
  assert.notEqual(fillDedupKey(ACCOUNT_B, '99887766'), base, 'the same trade id on another account is another fill');
  assert.notEqual(fillDedupKey(ACCOUNT_A, '99887767'), base, 'a different trade id is another fill');
  // Case-sensitive: venue trade ids are opaque strings, never normalised.
  assert.notEqual(fillDedupKey(ACCOUNT_A, 'trade-1'), fillDedupKey(ACCOUNT_A, 'TRADE-1'));
  assert.notEqual(fillDedupKey(ACCOUNT_A, ' 99887766'), base, 'whitespace must not be trimmed away into a collision');
});

test('§62: fillDedupKey never collides across accounts or trades (uuid-shaped sweep)', () => {
  const accounts = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const trades = ['1', '2', '10', '1000000000000', '0', '-1', 'trade-1'];
  const keys = new Set<string>();
  for (const account of accounts) {
    for (const trade of trades) keys.add(fillDedupKey(account, trade));
  }
  assert.equal(keys.size, accounts.length * trades.length, 'a dedup key collision would drop a real fill (§62)');
});

// ---------------------------------------------------------------------------
// DDL (PRD §59) — the schema the store bootstraps
// ---------------------------------------------------------------------------

test('§59: EXECUTOR_DDL is non-empty and creates every executor table', () => {
  assert.ok(EXECUTOR_DDL.length > 0);
  const tables = [
    'exchange_accounts', 'executions', 'execution_plans', 'child_orders',
    'fills', 'execution_events', 'balance_snapshots', 'positions_snapshots',
    'risk_profiles', 'audit_logs',
  ];
  for (const table of tables) {
    assert.ok(
      EXECUTOR_DDL.includes(`CREATE TABLE IF NOT EXISTS ${EXECUTOR_SCHEMA}.${table}`),
      `missing table ${EXECUTION_SCHEMA_PREFIX()}.${table}`,
    );
  }
  assert.ok(EXECUTOR_DDL.includes(`CREATE SCHEMA IF NOT EXISTS ${EXECUTOR_SCHEMA};`));
});

function EXECUTION_SCHEMA_PREFIX(): string {
  return EXECUTOR_SCHEMA;
}


/**
 * REGRESSION (§127): `createExecution` inserts `id = null` and lets Postgres
 * generate it via `gen_random_uuid()`. A bare `id uuid PRIMARY KEY` column —
 * one missing DEFAULT — makes EVERY execution insert fail with a not-null
 * violation on a fresh database, while every offline test still passes.
 * So: any table the store inserts a server-generated id into must declare one.
 */
test('§127: every table the store inserts a generated id into declares a uuid default', () => {
  const generated = ['executions', 'child_orders', 'fills'];
  for (const table of generated) {
    const block = new RegExp(
      `CREATE TABLE IF NOT EXISTS ${EXECUTOR_SCHEMA}\\.${table} \\(([^]*?)\\n\\);`,
      's',
    ).exec(EXECUTOR_DDL);
    assert.ok(block, `missing table ${table}`);
    assert.match(
      block[1],
      /id\s+uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/,
      `${table}.id has no DEFAULT gen_random_uuid() — an insert passing NULL will violate NOT NULL`,
    );
  }
});
test('§59: every DDL object lives in the executor schema and every statement is idempotent', () => {
  assert.ok(!/\bpublic\./.test(EXECUTOR_DDL), 'the executor must never touch the mirror-pruned public schema (DR-020)');
  const statements = EXECUTOR_DDL.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  assert.ok(statements.length > 10, `expected the full bootstrap, got ${statements.length} statements`);
  for (const statement of statements) {
    assert.match(statement, /^CREATE (SCHEMA|TABLE|INDEX) IF NOT EXISTS /, `non-idempotent statement: ${statement.slice(0, 60)}`);
    if (statement.startsWith('CREATE INDEX')) {
      // Unqualified index names are schema-local in Postgres, but only when the
      // search_path is right — assert the table they attach to is qualified.
      assert.match(statement, new RegExp(`ON ${EXECUTION_SCHEMA_PREFIX()}\\.`));
    }
  }
});

test('§59: timestamps are bigint millisecond columns, never timestamptz (exact round trip)', () => {
  // A timestamptz column would silently lose the millisecond wire values the
  // domain types carry (`number` ms) or need a timezone-free parse.
  assert.ok(!/timestamp\s+with(out)?\s+time zone/i.test(EXECUTOR_DDL), 'timestamptz leaked into the executor schema');
  const bigintColumns = EXECUTOR_DDL.match(/\b(created_at|updated_at|timestamp|submitted_at|filled_at|started_at|completed_at|cancelled_at|last_used_at|revoked_at)\s+bigint/g);
  assert.ok(bigintColumns && bigintColumns.length >= 12, `expected ms columns to be bigint (found ${bigintColumns ? bigintColumns.length : 0})`);
});

test('§59: the DDL uniqueness constraints are the ones the SQL statements conflict on', () => {
  // §62: fills are idempotent on (account_id, exchange_trade_id) — the table
  // constraint and `insertFill`'s ON CONFLICT target must not drift apart.
  assert.match(EXECUTOR_DDL, /UNIQUE \(account_id, exchange_trade_id\)/);
  assert.deepEqual([...SQL_STATEMENTS.insertFill.dedupConflict], ['account_id', 'exchange_trade_id']);
  assert.match(SQL_STATEMENTS.insertFill.sql, /ON CONFLICT \(account_id, exchange_trade_id\) DO NOTHING/);
  // §66: the client order id is the child-order idempotency key per execution.
  assert.match(EXECUTOR_DDL, /UNIQUE \(execution_id, client_order_id\)/);
});

test('§59: the embedded DDL matches the tracked database/schema/executor-schema.sql (no silent drift)', () => {
  // process.cwd() is frontend/web (test:shapers runs there), so the repo root is
  // two levels up — same convention as frontend/web/tests/shaper-tests.ts.
  const tracked = readFileSync(join(process.cwd(), '..', '..', 'database', 'schema', 'executor-schema.sql'), 'utf8');
  const normalize = (text: string): string =>
    text
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith('--'))
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
  assert.equal(normalize(EXECUTOR_DDL), normalize(tracked), 'store.ts EXECUTOR_DDL and database/schema/executor-schema.sql drifted apart');
});

test('§59: ensureExecutorSchema creates the schema first and sends one statement per round trip', async () => {
  const fake = useFake();
  await ensureExecutorSchema(fake);
  assert.ok(fake.queries.length > 10);
  assert.equal(fake.queries[0].sql, `CREATE SCHEMA IF NOT EXISTS ${EXECUTOR_SCHEMA}`);
  for (const q of fake.queries) {
    assert.ok(!q.sql.includes(';'), 'the extended query protocol refuses multi-statement strings');
    assert.match(q.sql, /IF NOT EXISTS/, 'a replayed bootstrap must be a no-op');
  }
  // Idempotent replay: running it twice against the same client is safe.
  const before = fake.queries.length;
  await ensureExecutorSchema(fake);
  assert.equal(fake.queries.length, before * 2);
});

// ---------------------------------------------------------------------------
// Risk profile merge (PRD §72, §88, §119)
// ---------------------------------------------------------------------------

test('§72: mergeProfile returns the defaults when nothing is stored', () => {
  assert.deepEqual(mergeProfile(null), DEFAULT_RISK_PROFILE);
  assert.deepEqual(mergeProfile(undefined), DEFAULT_RISK_PROFILE);
  assert.deepEqual(mergeProfile({}), DEFAULT_RISK_PROFILE);
  // A stored profile with no own keys must not degrade any default.
  const merged = mergeProfile({});
  for (const key of Object.keys(DEFAULT_RISK_PROFILE)) {
    assert.deepEqual(merged[key as keyof RiskProfile], DEFAULT_RISK_PROFILE[key as keyof RiskProfile], `${key} lost`);
  }
});

test('§72: stored values override the defaults and every other default survives', () => {
  const merged = mergeProfile({ defaultRiskMode: 'risk_usd', defaultRisk: 250, maxLeverage: 3 });
  assert.equal(merged.defaultRiskMode, 'risk_usd');
  assertClose(merged.defaultRisk, 250, 'defaultRisk');
  assert.equal(merged.maxLeverage, 3);
  // Untouched keys fall back — a partial profile is not a wholesale reset.
  assert.equal(merged.maxRiskPerTradePct, DEFAULT_RISK_PROFILE.maxRiskPerTradePct);
  assert.equal(merged.maxOpenRiskPct, DEFAULT_RISK_PROFILE.maxOpenRiskPct);
  assert.equal(merged.maxDailyLossPct, DEFAULT_RISK_PROFILE.maxDailyLossPct);
  assert.equal(merged.defaultMarginMode, DEFAULT_RISK_PROFILE.defaultMarginMode);
  assert.equal(merged.defaultExecutionUrgency, DEFAULT_RISK_PROFILE.defaultExecutionUrgency);
});

test('§72: mergeProfile never drops a default key and never mutates DEFAULT_RISK_PROFILE', () => {
  const mutated = mergeProfile({ defaultRisk: 999, maxRiskPerTradePct: 50 });
  assertClose(mutated.defaultRisk, 999, 'stored defaultRisk');
  assertClose(mutated.maxRiskPerTradePct, 50, 'stored maxRiskPerTradePct');
  assertClose(DEFAULT_RISK_PROFILE.defaultRisk, 1, 'DEFAULT_RISK_PROFILE.defaultRisk was mutated');
  assertClose(DEFAULT_RISK_PROFILE.maxRiskPerTradePct, 2, 'DEFAULT_RISK_PROFILE.maxRiskPerTradePct was mutated');
  // A later merge with an empty profile must see pristine defaults.
  assert.deepEqual(mergeProfile({}), DEFAULT_RISK_PROFILE);
  assert.deepEqual(Object.keys(mergeProfile({})).sort(), Object.keys(DEFAULT_RISK_PROFILE).sort());
});

// ---------------------------------------------------------------------------
// Row mappers (raw snake_case row → frozen record)
// ---------------------------------------------------------------------------

test('§45/§109: accountRowToRecord maps the credential row, parses jsonb and keeps nulls null', () => {
  const record = accountRowToRecord({
    id: ACCOUNT_A,
    user_id: USER_A,
    exchange: 'binance',
    label: 'main',
    api_key_masked: `${API_KEY.slice(0, 3)}...${API_KEY.slice(-3)}`,
    // jsonb arrives as a string on the wire and as an object from some drivers.
    permissions: '{"read":true,"spotTrade":true,"futuresTrade":false,"withdraw":null}',
    health: 'INVALID',
    created_at: '1700000000000',
    updated_at: '1700000060000',
    last_used_at: null,
    revoked_at: null,
  });
  assert.equal(record.id, ACCOUNT_A);
  assert.equal(record.userId, USER_A);
  assert.equal(record.exchange, 'binance');
  assert.equal(record.label, 'main');
  assert.equal(record.apiKeyMasked, 'AKI...KEY');
  assert.deepEqual(record.permissions, { read: true, spotTrade: true, futuresTrade: false, withdraw: null });
  assert.equal(record.health, 'INVALID');
  assertClose(record.createdAt, 1700000000000, 'createdAt');
  assertClose(record.updatedAt, 1700000060000, 'updatedAt');
  assert.equal(record.lastUsedAt, null, 'a never-used credential is null, never 0');
  assert.equal(record.revokedAt, null, 'a live credential is not revoked');
  // No field may leak undefined into a record the worker reads.
  for (const [key, value] of Object.entries(record)) assert.notEqual(value, undefined, `${key} is undefined`);
  // A driver that already parsed the jsonb must produce the same shape.
  const parsed = accountRowToRecord({
    id: ACCOUNT_A, user_id: USER_A, exchange: 'mexc', label: 'l', api_key_masked: 'a...z',
    permissions: { read: false, spotTrade: null, futuresTrade: null, withdraw: false },
    health: 'ACTIVE', created_at: 1, updated_at: 2, last_used_at: 3, revoked_at: 4,
  });
  assert.equal(parsed.permissions.read, false);
  assertClose(parsed.lastUsedAt as number, 3, 'lastUsedAt');
  assertClose(parsed.revokedAt as number, 4, 'revokedAt');
});

test('§45: an absent or corrupt permissions/health column degrades safely, never to a crash', () => {
  const missing = accountRowToRecord({ id: ACCOUNT_A, user_id: USER_A, exchange: 'bybit', label: 'l', api_key_masked: 'a...z', created_at: 1, updated_at: 2 });
  assert.equal(missing.health, 'UNKNOWN', 'an unknown health must not read as ACTIVE');
  assert.equal(missing.permissions.read, true);
  assert.equal(missing.lastUsedAt, null);
  assert.equal(missing.revokedAt, null);
  // A truncated jsonb value falls back instead of throwing mid-recovery (§114).
  const corrupt = accountRowToRecord({ id: ACCOUNT_A, user_id: USER_A, exchange: 'bybit', label: 'l', api_key_masked: 'a...z', permissions: '{"read":', health: null, created_at: 1, updated_at: 2 });
  assert.equal(corrupt.permissions.read, true);
  assert.equal(corrupt.health, 'UNKNOWN');
});

test('§60/§63: executionRowToRecord maps the execution row — numbers coerced, jsonb parsed, nulls null', () => {
  const record = executionRowToRecord({
    id: EXEC_A,
    user_id: USER_A,
    account_id: ACCOUNT_A,
    exchange: 'binance',
    symbol: 'BTC/USDT',
    market_type: 'linear_perp',
    side: 'buy',
    intent: 'open',
    status: 'RUNNING',
    mode: 'live',
    sizing_mode: 'risk_percent',
    sizing_value: '1.5',
    risk_budget: '250.25',
    risk_basis: 'spot_equity',
    entry_definition: '{"type":"limit","price":100000.25,"postOnly":true}',
    stop_definition: '{"price":98000.5}',
    take_profit_definition: '[{"price":110000},{"price":120000,"fraction":0.25}]',
    execution_strategy: 'twap',
    execution_config: '{"type":"twap","durationMs":1800000,"slices":12}',
    constraints: '{"maxSlippageBps":15,"maxPrice":101000}',
    planned_quantity: '0.01',
    planned_notional: '1000.25',
    actual_quantity: '0.004',
    actual_notional: '400.1',
    average_fill_price: '100000.5',
    estimated_fees: '0.5',
    actual_fees: '0.25',
    planned_risk: '20.5',
    current_risk: '10.25',
    strategy_state: '{"phase":"entry","sliceIndex":3}',
    created_at: '1700000000000',
    started_at: '1700000001000',
    completed_at: null,
    cancelled_at: null,
  });
  assert.equal(record.id, EXEC_A);
  assert.equal(record.userId, USER_A);
  assert.equal(record.accountId, ACCOUNT_A);
  assert.equal(record.marketType, 'linear_perp');
  assert.equal(record.status, 'RUNNING');
  assert.equal(record.mode, 'live');
  assert.equal(record.sizingMode, 'risk_percent');
  assertClose(record.sizingValue, 1.5, 'sizingValue');
  assertClose(record.riskBudget as number, 250.25, 'riskBudget');
  assert.equal(record.riskBasis, 'spot_equity');
  assert.deepEqual(record.entryDefinition, { type: 'limit', price: 100000.25, postOnly: true });
  assert.deepEqual(record.stopDefinition, { price: 98000.5 });
  assert.deepEqual(record.takeProfitDefinition, [{ price: 110000 }, { price: 120000, fraction: 0.25 }]);
  assert.equal(record.executionStrategy, 'twap');
  assert.deepEqual(record.executionConfig, { type: 'twap', durationMs: 1800000, slices: 12 });
  assert.deepEqual(record.constraints, { maxSlippageBps: 15, maxPrice: 101000 });
  assert.deepEqual(record.strategyState, { phase: 'entry', sliceIndex: 3 });
  assertClose(record.plannedQuantity, 0.01, 'plannedQuantity');
  assertClose(record.plannedNotional, 1000.25, 'plannedNotional');
  assertClose(record.actualQuantity, 0.004, 'actualQuantity');
  assertClose(record.actualNotional, 400.1, 'actualNotional');
  assertClose(record.averageFillPrice as number, 100000.5, 'averageFillPrice');
  assertClose(record.estimatedFees as number, 0.5, 'estimatedFees');
  assertClose(record.actualFees, 0.25, 'actualFees');
  assertClose(record.plannedRisk as number, 20.5, 'plannedRisk');
  assertClose(record.currentRisk as number, 10.25, 'currentRisk');
  assertClose(record.createdAt, 1700000000000, 'createdAt');
  assertClose(record.startedAt as number, 1700000001000, 'startedAt');
  assert.equal(record.completedAt, null, 'a running execution has no completed_at');
  assert.equal(record.cancelledAt, null, 'a running execution is not cancelled');
  for (const [key, value] of Object.entries(record)) assert.notEqual(value, undefined, `${key} is undefined`);
});

test('§60: a NULL numeric column stays null — never 0 — while a real 0 stays 0', () => {
  const row: Record<string, unknown> = {
    id: EXEC_A, user_id: USER_A, account_id: ACCOUNT_A, exchange: 'binance', symbol: 'BTC/USDT',
    market_type: 'spot', side: 'sell', intent: 'close', status: 'DRAFT', mode: 'paper',
    sizing_mode: 'allocation_usd', sizing_value: 1000, planned_quantity: 0, planned_notional: 0,
    actual_quantity: 0, actual_notional: 0, actual_fees: 0, created_at: 1700000000000,
    // An explicit SQL NULL on every optional numeric/timestamp column.
    risk_budget: null, average_fill_price: null, estimated_fees: null,
    planned_risk: null, current_risk: null, risk_basis: null,
    started_at: null, completed_at: null, cancelled_at: null,
  };
  const record = executionRowToRecord(row);
  for (const key of ['riskBudget', 'averageFillPrice', 'estimatedFees', 'plannedRisk', 'currentRisk', 'startedAt', 'completedAt', 'cancelledAt'] as const) {
    assert.equal(record[key], null, `${key} must be null, not ${String(record[key])}`);
    assert.notEqual(record[key], 0, `${key} must not be coerced to 0`);
  }
  assert.equal(record.riskBasis, null);
  // A zero average fill price is a REAL value (a fee-only fill), not "missing".
  const zeroed = executionRowToRecord({ ...row, average_fill_price: '0', risk_budget: '0', current_risk: 0 });
  assertClose(zeroed.averageFillPrice as number, 0, 'averageFillPrice=0');
  assertClose(zeroed.riskBudget as number, 0, 'riskBudget=0');
  assertClose(zeroed.currentRisk as number, 0, 'currentRisk=0');
  assert.notEqual(zeroed.averageFillPrice, null);
});

test('§60: absent jsonb columns take their documented fallbacks, corrupt jsonb degrades to them', () => {
  const bare = {
    id: EXEC_A, user_id: USER_A, account_id: ACCOUNT_A, exchange: 'binance', symbol: 'BTC/USDT',
    market_type: 'spot', side: 'buy', intent: 'open', status: 'DRAFT', mode: 'paper',
    sizing_mode: 'allocation_usd', sizing_value: 1000, planned_quantity: 0, planned_notional: 0,
    actual_quantity: 0, actual_notional: 0, actual_fees: 0, created_at: 1,
  };
  const record = executionRowToRecord(bare);
  // Arrays fall back to [] and objects to {} so callers can iterate without a guard…
  assert.deepEqual(record.takeProfitDefinition, []);
  assert.deepEqual(record.constraints, {});
  assert.deepEqual(record.entryDefinition, { type: 'market' });
  assert.deepEqual(record.executionConfig, { type: 'market' });
  // …while an explicitly absent object that means "none" stays null.
  assert.equal(record.stopDefinition, null, 'no stop configured must be null, not {}');
  assert.equal(record.strategyState, null, 'no strategy state yet must be null, not {}');
  // Truncated jsonb (crash during a write) must not take the worker down.
  const corrupt = executionRowToRecord({ ...bare, take_profit_definition: '[{"price":', entry_definition: '{oops', constraints: 'null-ish', strategy_state: '{"a"' });
  assert.deepEqual(corrupt.takeProfitDefinition, []);
  assert.deepEqual(corrupt.entryDefinition, { type: 'market' });
  assert.deepEqual(corrupt.constraints, {});
});

test('§61: childOrderRowToRecord maps snake_case and preserves null for un-submitted legs', () => {
  const unsubmittedRow: Record<string, unknown> = {
    id: 'child-1',
    execution_id: EXEC_A,
    exchange_order_id: null, // not yet acknowledged by the venue (§61)
    client_order_id: `fud_${EXEC_A}_1`,
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'LIMIT',
    price: '100000.25',
    quantity: '0.005',
    filled_quantity: '0.002',
    status: 'PARTIAL',
    is_exit: false,
    submitted_at: null,
    updated_at: '1700000002000',
    filled_at: null,
  };
  const record = childOrderRowToRecord(unsubmittedRow);
  assert.equal(record.id, 'child-1');
  assert.equal(record.executionId, EXEC_A);
  assert.equal(record.exchangeOrderId, null, 'an unsubmitted leg has no venue order id — not "" or 0');
  assert.equal(record.clientOrderId, `fud_${EXEC_A}_1`);
  assertClose(record.price as number, 100000.25, 'price');
  assertClose(record.quantity, 0.005, 'quantity');
  assertClose(record.filledQuantity, 0.002, 'filledQuantity');
  assert.equal(record.status, 'PARTIAL');
  assert.equal(record.isExit, false);
  assert.equal(record.submittedAt, null);
  assert.equal(record.filledAt, null);
  assertClose(record.updatedAt, 1700000002000, 'updatedAt');

  const acknowledged = childOrderRowToRecord({
    ...unsubmittedRow,
    exchange_order_id: '99887766',
    is_exit: true,
    submitted_at: '1700000003000',
    filled_at: '1700000004000',
  });
  assert.equal(acknowledged.exchangeOrderId, '99887766');
  assert.equal(acknowledged.isExit, true, 'a protective exit leg must be distinguishable');
  assertClose(acknowledged.submittedAt as number, 1700000003000, 'submittedAt');
  assertClose(acknowledged.filledAt as number, 1700000004000, 'filledAt');
});

test('§62: fillRowToRecord maps the fill row and keeps an unattributed child order null', () => {
  const record = fillRowToRecord({
    id: 'fill-1',
    execution_id: EXEC_A,
    child_order_id: null, // §62: a venue fill can arrive with no matching child order
    exchange_trade_id: '99887766',
    price: '100000.25',
    quantity: '0.002',
    quote_quantity: '200.0005',
    fee: '0.05',
    fee_asset: 'USDT',
    timestamp: '1700000005000',
  });
  assert.equal(record.id, 'fill-1');
  assert.equal(record.executionId, EXEC_A);
  assert.equal(record.childOrderId, null);
  assert.equal(record.exchangeTradeId, '99887766');
  assertClose(record.price, 100000.25, 'price');
  assertClose(record.quantity, 0.002, 'quantity');
  assertClose(record.quoteQuantity, 200.0005, 'quoteQuantity');
  assertClose(record.fee, 0.05, 'fee');
  assert.equal(record.feeAsset, 'USDT');
  assertClose(record.timestamp, 1700000005000, 'timestamp');
  // A zero fee (maker rebate / BNB discount) is a real value, not "missing".
  const free = fillRowToRecord({ ...fillRowToRecord({ id: 'f', execution_id: EXEC_A, child_order_id: 'c', exchange_trade_id: '1', price: 0, quantity: 0, quote_quantity: 0, fee: 0, fee_asset: 'BNB', timestamp: 1 }), fee: '0' });
  assertClose(free.fee, 0, 'fee=0');
  assertClose(free.price, 0, 'price=0');
  assertClose(free.timestamp, 1, 'timestamp=1');
});

test('§63: eventRowToRecord parses the jsonb payload and stringifies the bigserial id', () => {
  const record = eventRowToRecord({
    id: 42, // bigserial → the record carries a string, never a lossy number cast
    execution_id: EXEC_A,
    name: 'EXECUTION_CREATED',
    payload: '{"riskBudget":250,"notes":"ok"}',
    created_at: '1700000000000',
  });
  assert.equal(record.id, '42');
  assert.equal(record.executionId, EXEC_A);
  assert.equal(record.name, 'EXECUTION_CREATED');
  assert.deepEqual(record.payload, { riskBudget: 250, notes: 'ok' });
  assertClose(record.createdAt, 1700000000000, 'createdAt');
  // An empty payload column is an object, so the event log never carries null.
  assert.deepEqual(eventRowToRecord({ id: 43, execution_id: EXEC_A, name: 'PLAN_CREATED', payload: null, created_at: 1 }).payload, {});
  assert.deepEqual(eventRowToRecord({ id: 44, execution_id: EXEC_A, name: 'PLAN_CREATED', created_at: 1 }).payload, {});
  // A large bigserial beyond 2^53 must not be truncated into a number.
  assert.equal(eventRowToRecord({ id: '9007199254740993', execution_id: EXEC_A, name: 'PLAN_CREATED', payload: '{}', created_at: 1 }).id, '9007199254740993');
});

// ---------------------------------------------------------------------------
// Ownership (PRD §108) — every user-scoped statement binds user_id
// ---------------------------------------------------------------------------

test('§108: every statement that names user_id binds the caller as $1 and declares scopeParam 1', () => {
  // Every user_id-carrying statement must scope by the caller and say so
  // (`scopeParam`), so the scoping is auditable in one place. Keyed-by-id reads
  // (child orders, fills, events, plan) and the worker scans never name user_id
  // — the former are reached only after an owned `getExecution`, the latter
  // belong to a worker that is not a user (§68/§114).
  const workerScans: readonly string[] = ['getExecutionForWorker', 'listRunningExecutions'];
  let checked = 0;
  for (const [name, stmt] of Object.entries(SQL_STATEMENTS)) {
    if (workerScans.includes(name)) {
      assert.ok(!stmt.sql.includes('user_id'), `${name} is a worker scan and must not be user-scoped`);
      continue;
    }
    if (!stmt.sql.includes('user_id')) continue; // keyed by execution id, not by user
    assert.ok(
      /user_id = \$1|VALUES \(\$1/.test(stmt.sql),
      `${name} names user_id without binding the caller as \$1`,
    );
    assert.ok('scopeParam' in stmt && stmt.scopeParam === 1, `${name} must declare scopeParam 1`);
    checked += 1;
  }
  assert.equal(checked, 13, 'a user-request statement lost its declared user scope');
  // Ownership is never left to application code alone: the credential UPDATE
  // paths carry user_id in their WHERE clause, not just in the SELECT before.
  for (const name of ['updateCredentialHealth', 'touchCredential', 'revokeCredential']) {
    const stmt = SQL_STATEMENTS[name as keyof typeof SQL_STATEMENTS] as { sql: string };
    assert.match(stmt.sql, /^UPDATE executor\.exchange_accounts SET .* WHERE user_id = \$1 AND id = \$2$/, `${name} can write across users`);
  }
  // §114: recovery must see the live statuses and nothing else.
  assert.match(SQL_STATEMENTS.listRunningExecutions.sql, /status IN \('RUNNING', 'PARTIALLY_FILLED', 'RECONCILING'\)/);
});

test('§108: store.getExecution binds the caller as user_id and returns null for a foreign user', async () => {
  const fake = useFake();
  fake.seedExecution(EXEC_A, USER_A, ACCOUNT_A);
  fake.seedExecution(EXEC_B, USER_B, ACCOUNT_B);
  const owner = await store.getExecution(USER_A, EXEC_A);
  assert.ok(owner, 'the owner must read their own execution');
  assert.equal(owner.id, EXEC_A);
  assert.equal(owner.userId, USER_A);
  assert.deepEqual(lastQuery(fake).params, [USER_A, EXEC_A], 'user_id must be the first bind parameter');

  const foreign = await store.getExecution(USER_B, EXEC_A);
  assert.equal(foreign, null, 'another user must read null, never a row and never an error');
  const missing = await store.getExecution(USER_A, 'no-such-execution');
  assert.equal(missing, null, 'an unknown id is null, not an error');

  // The worker read is deliberately unscoped (§68): the worker is not a user,
  // and it must still recover an execution by id alone.
  fake.seedExecutionRow(EXEC_A, USER_A, ACCOUNT_A);
  const viaWorker = await store.getExecutionForWorker(EXEC_A);
  assert.ok(viaWorker, 'the worker must still be able to recover a running execution');
  assert.equal(viaWorker.id, EXEC_A);
  assert.equal(lastQuery(fake).params.length, 1, 'the worker read binds the id alone — no user');
});

// ---------------------------------------------------------------------------
// Fill idempotency through the store (PRD §62)
// ---------------------------------------------------------------------------

test('§62: insertFill stores one row per (account, exchange trade id); the replay resolves null', async () => {
  const fake = useFake();
  fake.seedExecution(EXEC_A, USER_A, ACCOUNT_A);
  const fill = {
    executionId: EXEC_A,
    childOrderId: 'child-1',
    exchangeTradeId: '99887766',
    price: 100000.25,
    quantity: 0.002,
    quoteQuantity: 200.0005,
    fee: 0.05,
    feeAsset: 'USDT',
    timestamp: 1700000005000,
  };
  const first = await store.insertFill(fill);
  assert.ok(first, 'the first insert must return the stored fill');
  assert.equal(first.exchangeTradeId, '99887766');
  assertClose(first.price, 100000.25, 'price');
  assertClose(first.quoteQuantity, 200.0005, 'quoteQuantity');
  // account_id is taken from the owning execution, never from the caller.
  assert.equal(fake.fills.length, 1);
  assert.equal(fake.fills[0].account_id, ACCOUNT_A);

  const replay = await store.insertFill(fill);
  assert.equal(replay, null, 'a replayed trade id must resolve null (idempotent), not double-count quantity');
  assert.equal(fake.fills.length, 1, 'the replay must not add a row');
});

test('§62: the dedup key is the ACCOUNT, so the same trade id on another account is a new fill', async () => {
  const fake = useFake();
  fake.seedExecution(EXEC_A, USER_A, ACCOUNT_A);
  fake.seedExecution(EXEC_B, USER_B, ACCOUNT_B);
  const base = { childOrderId: null, price: 100000, quantity: 0.001, quoteQuantity: 100, fee: 0.04, feeAsset: 'USDT', timestamp: 1700000005000 };
  const accountA = await store.insertFill({ ...base, executionId: EXEC_A, exchangeTradeId: '42' });
  assert.ok(accountA);
  // Same account, different execution, same venue trade id ⇒ still the same fill.
  fake.seedExecution('55555555-5555-4555-8555-555555555555', USER_A, ACCOUNT_A);
  const sameAccount = await store.insertFill({ ...base, executionId: '55555555-5555-4555-8555-555555555555', exchangeTradeId: '42' });
  assert.equal(sameAccount, null, 'dedup is per (account_id, exchange_trade_id), not per execution');
  // Different account ⇒ a genuinely different fill.
  const accountB = await store.insertFill({ ...base, executionId: EXEC_B, exchangeTradeId: '42' });
  assert.ok(accountB, 'the same trade id on another account must NOT be swallowed');
  assert.equal(accountB.executionId, EXEC_B);
  assert.equal(fake.fills.length, 2);
  // A different trade id on the same account is also its own fill.
  const other = await store.insertFill({ ...base, executionId: EXEC_A, exchangeTradeId: '43' });
  assert.ok(other);
  assert.equal(fake.fills.length, 3);
});

// ---------------------------------------------------------------------------
// Credential persistence + envelope layout (PRD §44, §45, §100)
// ---------------------------------------------------------------------------

test('§44/§109: createCredential persists only the masked key; the plaintext never reaches a column', async () => {
  const fake = useFake();
  const record = await withMasterKey(KEY_A, () =>
    store.createCredential({
      userId: USER_A,
      exchange: 'binance',
      label: 'main',
      credentials: { apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE },
      permissions: { read: true, spotTrade: true, futuresTrade: false, withdraw: false },
    }),
  );
  assert.equal(record.userId, USER_A);
  assert.equal(record.exchange, 'binance');
  assert.equal(record.apiKeyMasked, 'AKI...KEY');
  assert.equal(record.health, 'ACTIVE');
  assert.equal(record.lastUsedAt, null);

  const stored = fake.accounts[0];
  const serialized = JSON.stringify(stored, (k, v) => (Buffer.isBuffer(v) ? v.toString('base64') : v));
  for (const secret of [API_KEY, API_SECRET, PASSPHRASE]) {
    assert.ok(!serialized.includes(secret), `${secret.slice(0, 6)}… leaked into the stored row`);
  }
  // Envelope layout: 3 secrets ⇒ 3 × 12-byte IVs and 3 × 16-byte tags (api_key, api_secret, passphrase).
  assert.equal((stored.iv as Buffer).length, 36);
  assert.equal((stored.auth_tag as Buffer).length, 48);
  assert.ok((stored.passphrase_encrypted as Buffer).length > 0);
  assert.deepEqual(JSON.parse(String(stored.permissions)), { read: true, spotTrade: true, futuresTrade: false, withdraw: false });
});

test('§44/§100: revealCredentials is the only plaintext path — and it is user-scoped', async () => {
  const fake = useFake();
  const created = await withMasterKey(KEY_A, () =>
    store.createCredential({
      userId: USER_A,
      exchange: 'bybit',
      label: 'perps',
      credentials: { apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE },
      permissions: { read: true, spotTrade: null, futuresTrade: true, withdraw: false },
    }),
  );
  const revealed = await withMasterKey(KEY_A, () => store.revealCredentials(USER_A, created.id));
  assert.ok(revealed);
  assert.deepEqual(revealed, { apiKey: API_KEY, apiSecret: API_SECRET, passphrase: PASSPHRASE });
  assert.equal(lastQuery(fake).params[0], USER_A, 'reveal must bind user_id first');

  const foreign = await withMasterKey(KEY_A, () => store.revealCredentials(USER_B, created.id));
  assert.equal(foreign, null, 'another user must never receive plaintext');

  // A credential stored without a passphrase round-trips with `passphrase: null`
  // and a 2-secret envelope (§44 layout follows the secret count).
  const noPass = await withMasterKey(KEY_A, () =>
    store.createCredential({ userId: USER_A, exchange: 'mexc', label: 'spot', credentials: { apiKey: API_KEY, apiSecret: API_SECRET, passphrase: null }, permissions: { read: true, spotTrade: true, futuresTrade: null, withdraw: false } }),
  );
  assert.equal((fake.accounts[1].iv as Buffer).length, 24);
  assert.equal((fake.accounts[1].auth_tag as Buffer).length, 32);
  assert.equal(fake.accounts[1].passphrase_encrypted, null);
  assert.deepEqual(await withMasterKey(KEY_A, () => store.revealCredentials(USER_A, noPass.id)), { apiKey: API_KEY, apiSecret: API_SECRET, passphrase: null });
});

test('§44: without a master key, credential operations fail closed instead of storing plaintext', async () => {
  const fake = useFake();
  await assert.rejects(
    withMasterKey(undefined, () =>
      store.createCredential({ userId: USER_A, exchange: 'binance', label: 'main', credentials: { apiKey: API_KEY, apiSecret: API_SECRET, passphrase: null }, permissions: { read: true, spotTrade: false, futuresTrade: false, withdraw: false } }),
    ),
    /fail-closed|malformed/,
  );
  assert.equal(fake.accounts.length, 0, 'a fail-closed create must not leave a half-written credential');
  assert.equal(fake.queries.length, 0, 'no statement may run without a master key');
});

test('§44: rotateCredentialKeys re-encrypts under the new key and aborts on an undecryptable row', async () => {
  const fake = useFake();
  await withMasterKey(KEY_A, () =>
    store.createCredential({ userId: USER_A, exchange: 'binance', label: 'a', credentials: { apiKey: API_KEY, apiSecret: API_SECRET, passphrase: null }, permissions: { read: true, spotTrade: false, futuresTrade: false, withdraw: false } }),
  );
  await withMasterKey(KEY_B, () =>
    store.createCredential({ userId: USER_B, exchange: 'binance', label: 'b', credentials: { apiKey: 'OTHERKEY123', apiSecret: 'other-secret', passphrase: null }, permissions: { read: true, spotTrade: false, futuresTrade: false, withdraw: false } }),
  );
  const oldId = String(fake.accounts[0].id);
  const newId = String(fake.accounts[1].id);

  // Both keys are offered, so a row already on the new key passes through (§44).
  const rotated = await withMasterKey(KEY_A, () => store.rotateCredentialKeys(KEY_A, KEY_B));
  assert.equal(rotated, 2);
  assert.deepEqual(await withMasterKey(KEY_A, () => store.revealCredentials(USER_A, oldId)), { apiKey: API_KEY, apiSecret: API_SECRET, passphrase: null });
  assert.deepEqual(await withMasterKey(KEY_A, () => store.revealCredentials(USER_B, newId)), { apiKey: 'OTHERKEY123', apiSecret: 'other-secret', passphrase: null });

  // A row sealed with neither key stops the rotation loudly — never silently dropped.
  fake.accounts[1].iv = sealSecret('other-secret', 'c'.repeat(64)).iv;
  await assert.rejects(withMasterKey(KEY_A, () => store.rotateCredentialKeys(KEY_A, KEY_B)), /decrypts under neither key/);
});

// ---------------------------------------------------------------------------
// Status / progress writes (PRD §60) and the child-order update (PRD §61)
// ---------------------------------------------------------------------------

test('§57/§60: updateExecutionStatus binds the status as a parameter and stamps the derived timestamps', async () => {
  const fake = useFake();
  fake.seedExecution(EXEC_A, USER_A, ACCOUNT_A);
  await store.updateExecutionStatus(EXEC_A, 'FILLED', 1700000010000);
  const q = lastQuery(fake);
  assert.deepEqual(q.params, [EXEC_A, 'FILLED', 1700000010000]);
  // The written status is bound as $2 and assigned from that parameter — a
  // caller-supplied value can never reach the SQL text.
  assert.match(q.sql, /^UPDATE executor\.executions SET status = \$2,/);
  assert.ok(!q.sql.includes(`${EXEC_A}`), 'the execution id must be a bind parameter, not SQL text');
  // Every terminal status in the lifecycle table must stamp completed_at; a
  // status added to the table without the CASE would silently never close out.
  const terminal = (Object.keys(EXECUTION_TRANSITIONS) as ExecutionStatus[]).filter((s) => EXECUTION_TRANSITIONS[s].length === 0);
  assert.ok(terminal.length >= 6, `expected the terminal set, got ${terminal.join(',')}`);
  for (const status of terminal) {
    assert.ok(q.sql.includes(`'${status}'`), `${status} is terminal but its completed_at CASE is missing`);
  }
  assert.match(q.sql, /WHEN \$2 = 'RUNNING' THEN \$3/, 'started_at must be derived from the RUNNING transition');
  assert.match(q.sql, /WHEN \$2 = 'CANCELLED' THEN COALESCE\(cancelled_at/, 'cancelled_at must be derived from the CANCELLED transition');
  assert.match(q.sql, /COALESCE\(started_at/, 'an existing started_at must never be overwritten');
  // The write is by id alone (§68): the worker owns the lifecycle transition.
  assert.match(q.sql, /WHERE id = \$1$/);

  // A RUNNING transition stamps started_at; a later terminal one stamps
  // completed_at without erasing the start.
  await store.updateExecutionStatus(EXEC_A, 'RUNNING', 1700000005000);
  await store.updateExecutionStatus(EXEC_A, 'FILLED', 1700000010000);
  const stored = fake.executions.find((e) => e.id === EXEC_A);
  assert.equal(stored.status, 'FILLED');
  assert.equal(stored.started_at, 1700000005000, 'the original started_at must survive the terminal write');
  assert.equal(stored.completed_at, 1700000010000);
});

test('§60: an empty progress patch issues no statement; a partial patch touches only its own columns', async () => {
  const fake = useFake();
  await store.updateExecutionProgress(EXEC_A, {});
  assert.equal(fake.queries.length, 0, 'a no-op patch must not write');
  await store.updateExecutionProgress(EXEC_A, { actualQuantity: 0.004, averageFillPrice: null, currentRisk: 0 });
  const q = lastQuery(fake);
  assert.deepEqual(q.params, [EXEC_A, 0.004, null, 0], 'absent keys must not be bound');
  assert.match(q.sql, /^UPDATE executor\.executions SET actual_quantity = \$2, average_fill_price = \$3, current_risk = \$4 WHERE id = \$1$/);
  // `null` here CLEARS the column (the record keeps "no average yet"); columns
  // outside the patch are untouched rather than reset to a default.
  assert.ok(!q.sql.includes('actual_fees'), 'actual_fees must not be rewritten by a progress patch');
  assert.ok(!q.sql.includes('estimated_fees'));
});

test('§61: updateChildOrder updates present keys only and is scoped to execution + client order id', async () => {
  const fake = useFake();
  await store.updateChildOrder(EXEC_A, `fud_${EXEC_A}_1`, {});
  assert.equal(fake.queries.length, 0, 'an empty patch must not write');
  await store.updateChildOrder(EXEC_A, `fud_${EXEC_A}_1`, { status: 'OPEN', exchangeOrderId: '99887766' });
  const q = lastQuery(fake);
  assert.deepEqual(q.params, [EXEC_A, `fud_${EXEC_A}_1`, '99887766', 'OPEN']);
  assert.match(q.sql, /SET exchange_order_id = \$3, status = \$4 WHERE execution_id = \$1 AND client_order_id = \$2/);
  assert.ok(!q.sql.includes('filled_quantity'), 'absent keys must be left alone, not zeroed');
  assert.ok(!q.sql.includes('filled_at'));
  // Updating one leg of an execution must never touch its siblings.
  assert.match(q.sql, /client_order_id = \$2/);
});

test('§110: store.audit binds the acting user as the first parameter, with an explicit timestamp', async () => {
  const fake = useFake();
  const at = 1700000099000;
  await store.audit({ userId: USER_A, action: 'credential_tested', target: ACCOUNT_A, payload: { ok: true }, createdAt: at });
  const q = lastQuery(fake);
  assert.deepEqual(q.params, [USER_A, 'credential_tested', ACCOUNT_A, '{"ok":true}', at]);
  assert.match(q.sql, /^INSERT INTO executor\.audit_logs \(user_id, action, target, payload, created_at\)/);
  // An omitted timestamp still lands as a real ms value, never undefined.
  await store.audit({ userId: USER_B, action: 'execution_created', target: EXEC_A, payload: {} });
  const stamped = lastQuery(fake);
  assert.equal(typeof stamped.params[4], 'number');
  assert.ok(Number.isFinite(stamped.params[4] as number));
  assert.ok((stamped.params[4] as number) > 0);
});

test('§57: the lifecycle table accepts nothing out of a terminal status', () => {
  const statuses = Object.keys(EXECUTION_TRANSITIONS) as ExecutionStatus[];
  const terminal = statuses.filter((s) => EXECUTION_TRANSITIONS[s].length === 0);
  assert.deepEqual([...terminal].sort(), [...EXECUTION_TERMINALS].sort());
  for (const status of terminal) {
    for (const to of statuses) {
      assert.equal(canTransition(status, to), false, `${status} → ${to} must be refused: a closed execution never reopens`);
    }
    assert.equal(isTerminalExecution(status), true);
  }
  // And the lifecycle never skips forward: DRAFT cannot jump straight to RUNNING.
  assert.equal(canTransition('DRAFT', 'RUNNING'), false);
  assert.equal(canTransition('VALIDATED', 'RUNNING'), false);
  assert.equal(canTransition('READY', 'RUNNING'), true);
  // Every live status must offer an escape hatch (cancel/fail) — an execution
  // that can only be killed by a halt is a §37 risk-policy hole.
  for (const status of statuses.filter((s) => !terminal.includes(s))) {
    const next = EXECUTION_TRANSITIONS[status];
    assert.ok(
      next.includes('CANCELLED') || next.includes('FAILED'),
      `${status} has no way to abort`,
    );
  }
});

// ---------------------------------------------------------------------------
// Risk profile round trip through the store (PRD §72, §119)
// ---------------------------------------------------------------------------

test('§72: getRiskProfile falls back to the defaults when the user has no stored row', async () => {
  const fake = useFake();
  // No risk_profiles row exists in the fake at all.
  const profile = await store.getRiskProfile(USER_A);
  assert.deepEqual(profile, DEFAULT_RISK_PROFILE);
  assert.equal(lastQuery(fake).params[0], USER_A, 'the profile read must be user-scoped');
});

after(() => {
  // Never leak the injected client into another suite in this process.
  setStoreDbForTests(null);
});