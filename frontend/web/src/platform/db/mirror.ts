/**
 * mirror.ts — project the Turso read model into local Postgres (DR-019).
 *
 * Turso stays the system of record; this is a one-way, idempotent projection:
 *   Turso (SQLite/libsql)  ->  Postgres + TimescaleDB (local, read-optimised)
 *
 * Measured reason: a Turso round trip from this homeserver is ~394 ms, a local
 * Postgres round trip is 2.8 ms; the app's eight-query dashboard read drops from
 * ~94 ms (single SELECT) to ~2 ms.
 *
 * It lives in platform/ and not in scripts/ because the write path calls it:
 * after a local write the route must be able to read its own row back, so the
 * projection has to be awaitable in-process, not only a CLI.
 *
 * Invariants:
 *  - Idempotent: every table is upserted by primary key. Running it twice
 *    changes nothing, so a timer, a write, and a manual CLI run can overlap.
 *  - Read-then-write: every source table is read before any local write, so a
 *    Turso failure aborts before touching Postgres. A Turso outage must never
 *    empty the read model.
 *  - Reads of the eight source tables run concurrently, as do the writes: the
 *    round trips are independent, and serialising them turned a ~0.5 s
 *    projection into ~3 s on the write path.
 *  - Snapshot tables: every distinct `assets.updated_at` observation lands in the
 *    `asset_history` hypertable (sync-live.py inserts a fresh assets row per run
 *    rather than upserting), keyed so re-runs collapse.
 */
import type { SQL } from 'bun';
import { createClient, type Client } from '@libsql/client';

/**
 * The Postgres client class, resolved off the global rather than imported.
 *
 * `import { SQL } from 'bun'` type-checks and runs under `bun --bun` (the systemd
 * unit), but Next collects page data for static routes in a Node worker that has
 * no `bun` module — the build died with "Failed to load external module bun:
 * Cannot find module 'bun'" while collecting /api/coins. Both runtimes expose the
 * global, so the class is looked up at call time and the type comes from the
 * erased type-only import.
 */
const BunGlobal = (globalThis as { Bun?: { SQL?: new (url: string, opts?: { max?: number; idleTimeout?: number }) => SQL } }).Bun;
const PG_OPTS = { max: 8, idleTimeout: 30 };

const PG_URL = process.env.FUDCOURT_PG_URL || 'postgres://fudcourt@127.0.0.1:5432/fudcourt';

type Table = { name: string; cols: string[]; pk: string[] };

// Mirrors database/schema/schema.sql (+ the columns sync-live.py appends). `id` columns are
// carried so the sequence can be advanced past the imported ids.
const TABLES: Table[] = [
  { name: 'accounts', cols: ['code', 'name', 'type', 'statement'], pk: ['code'] },
  { name: 'assets', cols: ['id', 'chain', 'asset', 'quantity', 'value_usd', 'share_pct', 'wallet', 'updated_at'], pk: ['id'] },
  { name: 'journal', cols: ['id', 'date', 'entry_code', 'debit_account', 'credit_account', 'memo', 'amount', 'status', 'created_at'], pk: ['id'] },
  { name: 'ledger', cols: ['id', 'account_code', 'account_name', 'side', 'balance', 'currency'], pk: ['id'] },
  { name: 'trades', cols: ['id', 'date', 'venue', 'symbol', 'side', 'quantity', 'price', 'pnl', 'status'], pk: ['id'] },
  { name: 'transactions', cols: ['id', 'date', 'chain', 'asset', 'event', 'amount_usd', 'direction', 'hash', 'url', 'source', 'created_at', 'memo', 'wallet_to', 'venue_id', 'trade_id'], pk: ['id'] },
  { name: 'venues', cols: ['id', 'name', 'type'], pk: ['id'] },
  { name: 'wallets', cols: ['address', 'label', 'chain', 'monitored', 'created_at', 'alias', 'emoji', 'color', 'notes'], pk: ['address'] },
];

/**
 * The dashboard's read set, in ONE place.
 *
 * `getAll()` runs it, and scripts/tools/parity-pg.ts runs the identical list
 * against Turso and Postgres — a copy of these strings in the harness is how a
 * stale tiebreaker slipped past the first parity run, so there is deliberately
 * no second copy.
 *
 * Every ordering ends in a total-order tiebreaker (`id`, `address`, `asset`):
 * SQLite's rowid makes an ORDER BY on a non-unique column deterministic by
 * insertion order, Postgres leaves ties unspecified. Without the tiebreaker the
 * same query returns a different row order per engine.
 */
export const DASHBOARD_READS = {
  accounts: 'SELECT * FROM accounts ORDER BY code',
  transactions: 'SELECT * FROM transactions ORDER BY date DESC, id DESC',
  journal: 'SELECT * FROM journal ORDER BY date DESC, id DESC',
  ledger: 'SELECT * FROM ledger ORDER BY account_code',
  assets: 'SELECT * FROM assets ORDER BY value_usd DESC, id DESC',
  wallets: 'SELECT * FROM wallets ORDER BY label, address',
  trades: 'SELECT * FROM trades ORDER BY date DESC, id DESC LIMIT 20',
  netWorth: 'SELECT SUM(value_usd) as total FROM assets',
} as const;

let pgClient: SQL | null = null;

/**
 * The pooled Postgres client. Bun.sql is a lazy pooled client: the first query
 * opens a connection, so constructing this is free of I/O and safe at module
 * scope. It throws only where it is actually needed — a caller that runs only
 * under Bun.
 */
export function pg(): SQL {
  if (!pgClient) {
    if (!BunGlobal?.SQL) {
      throw new Error('Bun.sql is unavailable: this process is not running under Bun (the fudcourt web unit starts next with `bun --bun`)');
    }
    pgClient = new BunGlobal.SQL(PG_URL, PG_OPTS);
  }
  return pgClient;
}

let tursoClient: Client | null = null;
function turso(): Client {
  if (!tursoClient) {
    tursoClient = createClient({
      url: process.env.TURSO_URL || 'libsql://fud-balance-anvxxr.aws-ap-northeast-1.turso.io',
      authToken: process.env.TURSO_AUTH_TOKEN || '',
    });
  }
  return tursoClient;
}

/** Rows written by the last projection, per table. */
export type LoadReport = Record<string, number>;

/**
 * Project every table from Turso into Postgres. Resolves to the per-table row
 * counts, so callers can log or assert parity. Throws (before writing anything)
 * if the source read fails.
 */
export async function loadFromMirror(): Promise<LoadReport> {
  const sql = pg();
  const t0 = turso();

  // 1. Read ALL sources concurrently, before any local write.
  const read = await Promise.all(
    TABLES.map(async (t) => {
      const r = await t0.execute(`SELECT ${t.cols.join(', ')} FROM ${t.name}`);
      return [t.name, r.rows as unknown as Record<string, unknown>[]] as const;
    }),
  );
  const source = Object.fromEntries(read);

  // 2. Upsert, concurrently. No foreign keys exist in the source schema, so the
  //    tables are independent.
  const report: LoadReport = {};
  await Promise.all(
    TABLES.map(async (t) => {
      const rows = source[t.name];
      report[t.name] = rows.length;
      if (rows.length === 0) return;

      const values = rows.map((row) => t.cols.map((c) => row[c] ?? null));
      const placeholders = values
        .map((_, i) => `(${t.cols.map((_, j) => `$${i * t.cols.length + j + 1}`).join(', ')})`)
        .join(', ');
      const colList = t.cols.map((c) => `"${c}"`).join(', ');
      const updates = t.cols
        .filter((c) => !t.pk.includes(c))
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ');
      await sql.unsafe(
        `INSERT INTO ${t.name} (${colList}) VALUES ${placeholders}
         ON CONFLICT (${t.pk.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ${updates}`,
        values.flat() as never[],
      );

      // The mirror is also a PRUNER. `sync-live.py` runs `DELETE FROM assets`
      // followed by fresh INSERTs, so rows are replaced wholesale and their ids
      // advance every run; upserting alone would keep every previous batch and
      // double the net worth (measured: 170.42 -> 340.84). Deleting what the
      // source no longer has is what makes this a mirror rather than an
      // accumulator, and it is a no-op for the append-only tables.
      //
      // Placeholders are built inline rather than passing the array as one
      // parameter: Bun.sql spreads a JS array into separate bind values, so
      // `unnest($1::text[])` received the comma-joined string and Postgres
      // rejected it as a malformed array literal.
      const [pk] = t.pk;
      const keys = rows.map((r) => String(r[pk]));
      await sql.unsafe(
        // `::text` on both sides: the primary keys are a mix of integer (`id`)
        // and text (`address`, `code`), and one statement has to fit all of them.
        `DELETE FROM ${t.name} WHERE "${pk}"::text NOT IN (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        keys as never[],
      );

      // Advance the identity sequence past the imported ids — only when the
      // column really is an identity. `venues.id` is a text slug, and pg_get_
      // serial_sequence returns NULL for it (GREATEST/COALESCE on text would
      // fail with a type error).
      if (t.cols.includes('id')) {
        const [seq] = await sql.unsafe<{ seq: string | null }[]>(
          `SELECT pg_get_serial_sequence('${t.name}', 'id') AS seq`,
        );
        if (seq.seq) {
          await sql.unsafe(
            `SELECT setval('${seq.seq}', GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${t.name}), 1))`,
          );
        }
      }
    }),
  );

  // 3. Asset snapshots into the hypertable, then 90-day retention. Retention is
  //    a DELETE rather than add_retention_policy(): that API is Timescale
  //    License, not Apache-2, and this build refuses it.
  await sql.unsafe(`
    INSERT INTO asset_history (ts, chain, asset, wallet, quantity, value_usd, share_pct)
    SELECT COALESCE(NULLIF(a.updated_at, '')::timestamptz, now()), a.chain, a.asset, a.wallet,
           a.quantity, a.value_usd, a.share_pct
    FROM assets a
    WHERE a.updated_at IS NOT NULL
    ON CONFLICT (ts, chain, asset, (coalesce(wallet, ''))) DO UPDATE SET
      quantity = EXCLUDED.quantity, value_usd = EXCLUDED.value_usd, share_pct = EXCLUDED.share_pct`);
  await sql.unsafe(`DELETE FROM asset_history WHERE ts < now() - interval '90 days'`);
  await sql.unsafe(`DELETE FROM price_history WHERE ts < now() - interval '90 days'`);

  return report;
}

/**
 * Translate SQLite dialect to Postgres dialect.
 *
 * The app's statements are small and hand-written; only two constructs differ:
 * positional `?` placeholders (Postgres numbers them $1..$n — a bare `?` is
 * invalid) and `ORDER BY rowid` (SQLite's implicit insertion-order column).
 *
 * `rowid` maps to `id`: every table that uses it has an INTEGER PRIMARY KEY,
 * which IS the rowid in SQLite, so this preserves the exact ordering rather
 * than merely a stable one. `ctid` would be the physical-position analogue, but
 * it changes under UPDATE (an updated row moves to the heap tail), which would
 * silently reorder the wallets list after an edit.
 */
export function toPostgres(sql: string): string {
  let n = 0;
  return sql
    .replace(/\bORDER BY rowid\b/gi, 'ORDER BY id')
    .replace(/\?/g, () => `$${++n}`);
}
