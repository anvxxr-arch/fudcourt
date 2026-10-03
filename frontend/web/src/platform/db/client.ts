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
import { pg, toPostgres, DASHBOARD_READS } from '@/platform/db/pg';

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
  const total = netWorthRows[0]?.total;
  return {
    accounts, transactions, journal, ledger, assets, wallets, trades,
    net_worth: typeof total === 'number' ? total : 0,
    period: '9 Sep 2026 – sekarang',
    liabilities: 0,
    pnl: 0,
    cashflow: -850,
  };
}

export { DASHBOARD_READS };
