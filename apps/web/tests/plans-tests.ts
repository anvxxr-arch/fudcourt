/**
 * The paper-plan ledger model tests: run OFFLINE, no network, no clock, no DOM.
 *
 * Contract under test (`src/features/plans/model.ts`):
 *  - a figure the plan does not carry renders the em-dash `—`, never `0` — a `0`
 *    is a measurement the pipeline did not make (the never-fake rule);
 *  - the headline's counts describe the SLICE it was given, and `total` is the
 *    route's own count carried through verbatim — never recomputed as
 *    `plans.length`, which would hide the route's cap;
 *  - `rewardRisk` is `null` when any leg is missing or the risk leg is zero — a
 *    ratio with no denominator is not a number;
 *  - `planTime` never rounds a timestamp into a claim: a malformed string is
 *    returned as-is rather than parsed into a wrong instant.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTime, pct, readPlansBoard, rewardRisk, score, usd, type SignalPlan } from '@/features/plans/model';

/** A complete plan; override one field to probe a single rule. */
const plan = (over: Partial<SignalPlan> = {}): SignalPlan => ({
  chain: 'robinhood',
  mint: 'mint000000000000000000000000000000000000',
  symbol: 'PEPE',
  decision: 'surfaced',
  score: 88.5,
  entry_usd: 1,
  stop_usd: 0.75,
  target_usd: 1.5,
  quantity: 100,
  notional_usd: 100,
  risk_usd: 1,
  risk_pct: 1,
  equity_usd: 141.85,
  stop_pct: 25,
  capped: false,
  mode: 'paper',
  status: 'planned',
  reason: null,
  planned_at: '2026-10-08T05:40:00.000Z',
  ...over,
});

test('plans: the headline counts the slice, and carries the route total verbatim', () => {
  const rows = [plan(), plan({ symbol: 'WIF' }), plan({ symbol: 'BONK', status: 'skipped', capped: true })];
  const board = readPlansBoard({ plans: rows, total: 9000 });
  assert.equal(board.shown, 3, 'shown is the rows received');
  assert.equal(board.total, 9000, 'total is the route count, never recomputed from the slice');
  assert.equal(board.planned, 2);
  assert.equal(board.skipped, 1);
  assert.equal(board.symbols, 3);
  assert.equal(board.capped, 1);
  assert.deepEqual(board.chains, ['robinhood']);
});

test('plans: an empty ledger is a fact about the pipeline, not a failed read', () => {
  const board = readPlansBoard({ plans: [], total: 0 });
  assert.equal(board.shown, 0);
  assert.equal(board.total, 0);
  assert.equal(board.equityUsd, null, 'no rows means no equity snapshot — null, never 0');
  assert.equal(board.newestAt, null);
  assert.deepEqual(board.chains, []);
});

test('plans: the equity snapshot is the first non-null, and absent stays null', () => {
  assert.equal(readPlansBoard({ plans: [plan({ equity_usd: null }), plan({ equity_usd: 200 })], total: 2 }).equityUsd, 200);
  assert.equal(readPlansBoard({ plans: [plan({ equity_usd: null })], total: 1 }).equityUsd, null);
});

test('plans: newest and oldest are the extremes of planned_at, not the first/last row', () => {
  const board = readPlansBoard({
    plans: [
      plan({ planned_at: '2026-10-08T05:40:00.000Z' }),
      plan({ planned_at: '2026-10-07T00:00:00.000Z' }),
      plan({ planned_at: '2026-10-08T09:00:00.000Z' }),
    ],
    total: 3,
  });
  assert.equal(board.newestAt, '2026-10-08T09:00:00.000Z');
  assert.equal(board.oldestAt, '2026-10-07T00:00:00.000Z');
});

test('plans: a symbol-less plan falls back to its mint for the distinct count', () => {
  const board = readPlansBoard({
    plans: [plan({ symbol: null, mint: 'aaa' }), plan({ symbol: null, mint: 'bbb' }), plan({ symbol: 'PEPE', mint: 'ccc' })],
    total: 3,
  });
  assert.equal(board.symbols, 3, 'two mints and one symbol are three distinct identities');
});

test('plans: an absent figure is the em dash, and a real zero is a value', () => {
  assert.equal(usd(null), '—');
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(141.85), '$141.85');
  assert.equal(usd(0.0042), '$0.00420000', 'sub-cent precision follows the house fmtPrice convention (8dp below 0.01), never rounding to $0.00');
  // The plans table carries entries as small as 1.485e-07; an 8-dp fixed format
  // would print those as $0.00000000, asserting a price the plan does not have.
  assert.equal(usd(1.485e-7), '$0.0000001485', 'a sub-1e-6 figure keeps enough precision to never read as zero');
  assert.equal(pct(null), '—');
  assert.equal(pct(0), '0%');
  assert.equal(pct(25), '25%');
  assert.equal(score(null), '—');
  assert.equal(score(0), '0');
  assert.equal(score(88.5), '88.5');
});

test('plans: reward:risk is null when any leg is missing, never a substituted ratio', () => {
  assert.equal(rewardRisk(plan()), 2, '(1.5 − 1) / (1 − 0.75) = 2');
  assert.equal(rewardRisk(plan({ target_usd: null })), null);
  assert.equal(rewardRisk(plan({ stop_usd: null })), null);
  assert.equal(rewardRisk(plan({ entry_usd: null })), null);
});

test('plans: a zero risk leg yields no ratio, not Infinity', () => {
  assert.equal(rewardRisk(plan({ entry_usd: 1, stop_usd: 1 })), null);
});

test('plans: a short plan (stop above entry) still reads a positive ratio', () => {
  assert.equal(rewardRisk(plan({ entry_usd: 1, stop_usd: 1.25, target_usd: 0.5 })), 2);
});

test('plans: a timestamp renders MM-DD HH:MM (UTC), and a malformed one stays literal', () => {
  assert.equal(planTime('2026-10-08T05:40:00.000Z'), '10-08 05:40');
  assert.equal(planTime(null), '—');
  assert.equal(planTime('not-a-date'), 'not-a-date', 'a malformed timestamp is never parsed into a wrong instant');
});
