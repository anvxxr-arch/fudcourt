#!/usr/bin/env bun
/**
 * parity-pg.ts — prove the local read model equals Turso (DR-019).
 *
 * Runs the app's own DASHBOARD_READS against both engines and compares row for
 * row. This is the gate that keeps the projection honest: the app reads local
 * Postgres, but Turso is the system of record, so any drift in the loader,
 * a translated statement, or an ordering is a wrong number on the board.
 *
 * Usage: bun run scripts/verify/parity-pg.ts
 * Exit 1 on any mismatch, so it can gate a timer or CI.
 */
import { query, DASHBOARD_READS } from '@/platform/db/client';
import { createClient } from '@libsql/client';

const turso = createClient({
  url: process.env.TURSO_URL || 'libsql://fud-balance-anvxxr.aws-ap-northeast-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

// Compare numeric values at 1e-9: SQLite REAL is an IEEE double and Postgres
// double precision is the same width, but SUM() may accumulate in a different
// order, so exact float equality is not a meaningful gate.
const norm = (rows: Record<string, unknown>[]) =>
  JSON.stringify(rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v]))));

let failed = 0;
for (const [name, sql] of Object.entries(DASHBOARD_READS)) {
  const local = (await query(sql)) as Record<string, unknown>[];
  const remote = ((await turso.execute(sql)).rows as unknown as Record<string, unknown>[]);
  if (norm(local) === norm(remote)) {
    console.log(`ok   ${name.padEnd(13)} rows=${local.length}`);
  } else {
    failed++;
    console.log(`FAIL ${name.padEnd(13)} local=${norm(local).slice(0, 200)}\n     turso=${norm(remote).slice(0, 200)}`);
  }
}

await turso.close();
if (failed > 0) {
  console.log(`PARITY_FAIL ${failed}/${Object.keys(DASHBOARD_READS).length} query(ies) differ`);
  process.exit(1);
}
console.log(`PARITY_OK (${Object.keys(DASHBOARD_READS).length} queries identical)`);
process.exit(0);
