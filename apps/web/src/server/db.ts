/**
 * pg.ts — the Postgres data layer (DR-040).
 *
 * Postgres+TimescaleDB is the SINGLE system of record. Every read and every
 * write in the app goes through here, straight to `FUDCOURT_PG_URL`; there is no
 * remote mirror and no second store (DR-040, superseding the DR-019 split).
 *
 * It owns three things:
 *  - `pg()`: the pooled client (Bun.sql, ~2 ms per local round trip).
 *  - `toPostgres()`: the SQLite->Postgres dialect translation the hand-written
 *    route statements still need (`?` placeholders, `ORDER BY rowid`).
 *  - `DASHBOARD_READS`: the dashboard's read set, in ONE place, so `getAll()`
 *    and every route read the same strings.
 *
 * `assets` snapshots are NOT taken here: a database TRIGGER (`assets_snapshot`
 * in `database/schema/pg-schema.sql`) appends every `assets` insert to the
 * `asset_history` hypertable, so every writer — the sync, a route, an operator
 * — lands in the time series identically, with no code on this side.
 */
import 'server-only';
import type { SQL } from 'bun';

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

/**
 * The dashboard's read set, in ONE place.
 *
 * `getAll()` runs it; the routes and any harness reuse these exact strings, so
 * there is deliberately no second copy to drift.
 *
 * Every ordering ends in a total-order tiebreaker (`id`, `address`, `asset`):
 * Postgres leaves ties unspecified, so without the tiebreaker the same query
 * returns a different row order run to run.
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

/**
 * client.ts — the treasury data layer (DR-040).
 *
 * Postgres+TimescaleDB is the SINGLE system of record. Reads and writes both go
 * to local Postgres (`FUDCOURT_PG_URL`), ~2 ms per query; there is no remote
 * mirror and no second store. The DR-019 split (Turso system of record + local
 * Postgres read model) was collapsed by DR-040 because the app already wrote
 * Postgres and the projection could prune a UI write.
 *
 * `query`/`execute` keep their exact signatures so no route changes: only the
 * engine underneath moved.
 */

/** A row: unvalidated at the boundary, typed at use. */
export type Row = Record<string, unknown>;

/** Run SQL against local Postgres and return plain row objects. */
export async function query(sql: string, args: unknown[] = []): Promise<Row[]> {
  // Bun.sql is generic over the row shape; these statements are hand-written
  // selects whose columns are read by name, so the honest type is "records".
  return (await pg().unsafe(toPostgres(sql), args as never[])) as unknown as Row[];
}

/**
 * Run a write against local Postgres. Same engine and dialect as `query`; the
 * separate name is kept so a caller reads as a write, not a read.
 */
export async function execute(sql: string, args: unknown[] = []) {
  return pg().unsafe(toPostgres(sql), args as never[]);
}

export async function getAll() {
  const names = Object.keys(DASHBOARD_READS) as (keyof typeof DASHBOARD_READS)[];
  const rows = await Promise.all(names.map((n) => query(DASHBOARD_READS[n])));
  const [accounts, transactions, journal, ledger, assets, wallets, trades, netWorthRows] = rows;
  const total = Number(netWorthRows[0]?.total ?? 0);
  return {
    accounts, transactions, journal, ledger, assets, wallets, trades,
    net_worth: Number.isFinite(total) ? total : 0,
  };
}

