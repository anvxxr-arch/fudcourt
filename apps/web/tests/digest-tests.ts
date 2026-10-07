/**
 * Weekly treasury digest tests (F12): run OFFLINE — no network, no clock, no
 * database (the read is injected as a `QueryFn`).
 *
 * Contract under test (lib/digest.ts):
 *  - the reader SESSIONIZES `asset_history` with the same 60-second gap rule the
 *    private board and the public proof use, so every surface agrees on what one
 *    sync run is. Rows further apart than the gap are different runs;
 *  - `buildDigest` REFUSES rather than narrate a change it cannot stand behind:
 *    an empty window has no week to narrate, a SINGLE observation cannot state a
 *    change, and a book with no priced holding at either end has no value to
 *    report. Each refusal carries a stated reason — never a zero;
 *  - the change is measured FIRST-to-LAST, and every published figure carries
 *    its COVERAGE (`priced N of M holdings`), so a partial book can never read
 *    as the whole one;
 *  - an unpriced holding is NAMED, never counted as zero;
 *  - `changePct` is null when the window opened on a zero-valued book (no base
 *    to divide by) — the honest answer, not `Infinity`.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDigest,
  digestExcerpt,
  digestOutline,
  digestSlug,
  digestTitle,
  readWeeklySnapshots,
  snapshotRuns,
  RUN_GAP_MS,
  type DigestPublished,
  type HistoryRow,
  type QueryFn,
  type DigestSnapshot,
} from '@/lib/digest';

/** A history row at `t` seconds, one holding. */
const row = (tSec: number, chain: string, asset: string, valueUsd: number | null, quantity = 1): HistoryRow => ({
  ts: new Date(Date.UTC(2026, 9, 1, 0, 0, tSec)).toISOString(),
  chain,
  asset,
  quantity,
  valueUsd,
});

/** A snapshot with one chain, `totalUsd`, and no unpriced holdings. */
const snap = (asOfSec: number, chain: string, totalUsd: number, holdings = 1, unpriced: string[] = []): DigestSnapshot => ({
  asOf: new Date(Date.UTC(2026, 9, 1, 0, 0, asOfSec)).toISOString(),
  totalUsd,
  holdings: holdings + unpriced.length,
  priced: holdings,
  unpriced,
  slices: totalUsd === 0 ? [] : [{ chain, valueUsd: totalUsd }],
});

test('snapshotRuns: rows within the 60s gap are ONE run; a larger gap starts a new one', () => {
  const runs = snapshotRuns([
    row(0, 'ethereum', 'ETH', 100),
    row(10, 'ethereum', 'USDC', 50), // same run
    row(10 + RUN_GAP_MS / 1000 + 1, 'ethereum', 'ETH', 110), // new run
    row(10 + RUN_GAP_MS / 1000 + 5, 'ethereum', 'USDC', 55), // same as previous
  ]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].totalUsd, 150);
  assert.equal(runs[0].holdings, 2);
  assert.equal(runs[1].totalUsd, 165);
});

test('snapshotRuns: a run aggregates per-chain over the PRICED holdings and names the unpriced', () => {
  const runs = snapshotRuns([
    row(0, 'ethereum', 'ETH', 100),
    row(0, 'solana', 'SOL', 40),
    row(0, 'solana', 'SPL:AS7iM1', null), // unpriced
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].totalUsd, 140);
  assert.equal(runs[0].priced, 2);
  assert.equal(runs[0].holdings, 3);
  assert.deepEqual(runs[0].unpriced, ['solana/SPL:AS7iM1']);
  // slices sorted by value desc
  assert.deepEqual(runs[0].slices, [
    { chain: 'ethereum', valueUsd: 100 },
    { chain: 'solana', valueUsd: 40 },
  ]);
});

test('buildDigest: an empty window refuses — there is no week to narrate', () => {
  const d = buildDigest([]);
  assert.equal(d.published, false);
  assert.match(d.published === false ? d.reason : '', /no observation/);
});

test('buildDigest: a SINGLE observation refuses — a change cannot be stated from one point', () => {
  const d = buildDigest([snap(0, 'ethereum', 100)]);
  assert.equal(d.published, false);
  assert.match(d.published === false ? d.reason : '', /single observation/);
});

test('buildDigest: a book with no priced holding at either end refuses, and names the unpriced rows', () => {
  const d = buildDigest([snap(0, 'solana', 0, 0, ['solana/SPL:AS7iM1']), snap(600, 'solana', 0, 0, ['solana/SPL:AS7iM1'])]);
  assert.equal(d.published, false);
  assert.match(d.published === false ? d.reason : '', /no priced holding/);
  assert.deepEqual(d.published === false ? d.skipped : [], ['solana/SPL:AS7iM1']);
});

test('buildDigest: measures first-to-last and states its coverage', () => {
  const d = buildDigest([snap(0, 'ethereum', 100), snap(600, 'ethereum', 150)]);
  assert.equal(d.published, true);
  const p = d as DigestPublished;
  assert.equal(p.startUsd, 100);
  assert.equal(p.endUsd, 150);
  assert.equal(p.changeUsd, 50);
  assert.equal(p.changePct, 50);
  assert.equal(p.runs, 2);
  assert.match(p.coverage, /priced 1 of 1 holdings/);
});

test('buildDigest: changePct is NULL when the window opened on a zero-valued book', () => {
  // first run priced at 0 but with a holding, second priced — no base to divide by
  const d = buildDigest([snap(0, 'ethereum', 0, 1), snap(600, 'ethereum', 80)]);
  const p = d as DigestPublished;
  assert.equal(p.published, true);
  assert.equal(p.changeUsd, 80);
  assert.equal(p.changePct, null, 'a zero base must not produce Infinity');
});

test('buildDigest: chainMoves carry both ends, and a chain absent at the start reads "new" (null pct)', () => {
  const first: DigestSnapshot = { asOf: snap(0, 'ethereum', 100).asOf, totalUsd: 100, holdings: 1, priced: 1, unpriced: [], slices: [{ chain: 'ethereum', valueUsd: 100 }] };
  const last: DigestSnapshot = { asOf: snap(600, 'ethereum', 120).asOf, totalUsd: 160, holdings: 2, priced: 2, unpriced: [], slices: [{ chain: 'ethereum', valueUsd: 120 }, { chain: 'solana', valueUsd: 40 }] };
  const d = buildDigest([first, last]) as DigestPublished;
  const sol = d.chainMoves.find((m) => m.chain === 'solana')!;
  assert.equal(sol.startUsd, 0);
  assert.equal(sol.endUsd, 40);
  assert.equal(sol.changePct, null);
  const eth = d.chainMoves.find((m) => m.chain === 'ethereum')!;
  assert.equal(eth.changeUsd, 20);
  assert.equal(eth.changePct, 20);
});

test('buildDigest: an unpriced holding is NAMED and the coverage reflects the whole book', () => {
  const d = buildDigest([
    snap(0, 'ethereum', 100, 1, ['solana/SPL:AS7iM1']),
    snap(600, 'ethereum', 100, 1, ['solana/SPL:AS7iM1']),
  ]) as DigestPublished;
  assert.deepEqual(d.unpriced, ['solana/SPL:AS7iM1']);
  assert.match(d.coverage, /priced 1 of 2 holdings/);
  assert.match(d.derived, /never counted as zero/);
});

test('slug / title / excerpt are derived from the window end', () => {
  const d = buildDigest([snap(0, 'ethereum', 100), snap(600, 'ethereum', 150)]) as DigestPublished;
  assert.match(digestSlug(d), /^weekly-treasury-digest-\d{4}-\d{2}-\d{2}$/);
  assert.match(digestTitle(d), /week ending \d{4}-\d{2}-\d{2}$/);
  const ex = digestExcerpt(d);
  assert.ok(ex.length <= 300, 'excerpt must fit the collection cap');
  assert.match(ex, /\$150\.00/);
  assert.match(ex, /up \$50\.00/);
});

test('digestOutline: states the week, the by-chain moves, and what the total covers', () => {
  const d = buildDigest([snap(0, 'ethereum', 100), snap(600, 'ethereum', 150)]) as DigestPublished;
  const headings = digestOutline(d).map((s) => s.heading);
  assert.deepEqual(headings, ['The week in one line', 'By chain', 'What this covers — and what it does not']);
  assert.match(digestOutline(d)[1].body[0], /ethereum: \$100\.00 → \$150\.00/);
});

test('readWeeklySnapshots: reads a rolling window and maps rows to snapshots', async () => {
  let seenSql = '';
  let seenArgs: unknown[] = [];
  const q: QueryFn = async (sql, args) => {
    seenSql = sql;
    seenArgs = args ?? [];
    return [
      { ts: new Date(Date.UTC(2026, 9, 1, 0, 0, 0)).toISOString(), chain: 'ethereum', asset: 'ETH', quantity: 1, value_usd: 100 },
      { ts: new Date(Date.UTC(2026, 9, 1, 0, 0, 0)).toISOString(), chain: 'ethereum', asset: 'USDC', quantity: 10, value_usd: 10 },
      { ts: new Date(Date.UTC(2026, 9, 1, 0, 0, 600)).toISOString(), chain: 'ethereum', asset: 'ETH', quantity: 1, value_usd: 120 },
    ];
  };
  const snaps = await readWeeklySnapshots(q, 7);
  assert.match(seenSql, /FROM asset_history/);
  assert.match(seenSql, /make_interval\(days => \$1\)/);
  assert.deepEqual(seenArgs, [7]);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].totalUsd, 110);
  assert.equal(snaps[1].totalUsd, 120);
});
