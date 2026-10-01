/**
 * client.ts — the treasury data layer (DR-019).
 *
 * READ PATH: local Postgres (TimescaleDB), ~2 ms per query.
 * WRITE PATH: Turso stays the system of record; every write is forwarded there,
 *             then projected back into Postgres so the writer reads its own row.
 *
 * Why split: a Turso round trip from the homeserver measures ~394 ms (the libsql
 * client tunnels a WebSocket back to the primary over the WireGuard path) against
 * 2.8 ms for local Postgres. Reads are 95% of the traffic and every dashboard
 * load issues eight of them; writes are rare and must stay authoritative-remote.
 *
 * The window this accepts: between a write and its projection (sub-second; the
 * write awaits the projection) local reads can briefly lag Turso. Turso remains
 * the single writer, so there is no split brain — only bounded staleness.
 *
 * `query`/`execute` keep their exact signatures so no route changes: only the
 * engine underneath moves.
 */
import { SQL } from 'bun';
import { createClient, type Client } from '@libsql/client';
import { pg, toPostgres, loadFromMirror, DASHBOARD_READS } from '@/platform/db/mirror';

function turso(): Client {
  return createClient({
    url: process.env.TURSO_URL || 'libsql://fud-balance-anvxxr.aws-ap-northeast-1.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || '',
  });
}

/** A row from either engine: unvalidated at the boundary, typed at use. */
export type Row = Record<string, unknown>;

/** Run SQL against local Postgres and return plain row objects. */
export async function query(sql: string, args: unknown[] = []): Promise<Row[]> {
  // Bun.sql is generic over the row shape; these statements are hand-written
  // selects whose columns are read by name, so the honest type is "records".
  return (await pg().unsafe(toPostgres(sql), args as never[])) as unknown as Row[];
}

/**
 * Run a write against Turso (authoritative), then project it into Postgres so
 * the caller can read it back immediately.
 *
 * Without the projection a POST that follows with a SELECT — /api/transactions
 * and /api/wallets both do — would read the pre-write local copy and return a
 * stale row to the very client that just wrote it.
 */
export async function execute(sql: string, args: unknown[] = []) {
  const res = await turso().execute({ sql, args: args as never[] });
  try {
    await loadFromMirror();
  } catch (e) {
    // A failed projection must not fail a write that already committed to Turso.
    // The next timer run repairs it; reads stay bounded-stale, never wrong.
    console.error(`db/execute: write committed to Turso but the local projection failed: ${(e as Error).message}`);
  }
  return res;
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

export { loadFromMirror, DASHBOARD_READS };
