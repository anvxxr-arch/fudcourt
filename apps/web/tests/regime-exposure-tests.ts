/**
 * Macro regime × portfolio exposure tests (plan Phase 13, stages 16–17): run
 * OFFLINE, no network, no clock, no database.
 *
 * Contract under test (features/economy/model-regime-exposure.ts):
 *  - a holding is scored through the regime's OWN class table, by an explicit
 *    binding. A stablecoin is USD-class because it is a claim on a dollar; a
 *    tokenised gold claim is gold; bitcoin is the crypto-risk class. A symbol
 *    that matches no explicit binding still lands in a class, but its row says
 *    `assumed: true` — the assumption is shown, not hidden. These cases are the
 *    ones that matter, because the alternative (guessing a class from a name, or
 *    blessing every unrecognised token as cash) is confidently wrong;
 *  - a holding whose value is unknown makes the book total UNKNOWN, so every
 *    share is null and the holding is named in `skipped`. A share computed over
 *    a partial total is a lie about the book's composition — the exact failure
 *    this refusal exists to prevent;
 *  - a zero or negative value, and a holding whose class the weight table does
 *    not score, are each NAMED in `skipped` with a reason, never dropped and
 *    never counted as zero;
 *  - `classes` lists every class the table scores, INCLUDING the empty ones, so
 *    the board can show a zero rather than omit the row;
 *  - `alignment` is the value-weighted mean of the class scores over the valued
 *    holdings, and `coverage` is the value share that mapped to a scored class.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPOSURE_RULE,
  classifyHolding,
  exposureOverlay,
  type ImpactRow,
} from '@/features/economy/model';

/** A fixed weight table, in the table's own order and units. */
const IMPACTS: ImpactRow[] = [
  { asset: 'btc', label: 'Bitcoin', stance: 'bearish', score: -1, contributions: [] },
  { asset: 'gold', label: 'Gold', stance: 'bullish', score: 1, contributions: [] },
  { asset: 'usd', label: 'US Dollar', stance: 'strongly bullish', score: 2.5, contributions: [] },
  { asset: 'bonds', label: 'Bonds', stance: 'neutral', score: 0, contributions: [] },
  { asset: 'equity', label: 'Equities', stance: 'bullish', score: 0.9, contributions: [] },
];

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

test('classifyHolding: explicit bindings are not assumptions', () => {
  assert.deepEqual(classifyHolding('USDT'), { klass: 'usd', assumed: false });
  assert.deepEqual(classifyHolding('usdc'), { klass: 'usd', assumed: false }, 'case-insensitive');
  assert.deepEqual(classifyHolding('  dai '), { klass: 'usd', assumed: false }, 'trimmed');
  assert.deepEqual(classifyHolding('BTC'), { klass: 'btc', assumed: false });
  assert.deepEqual(classifyHolding('WBTC'), { klass: 'btc', assumed: false });
  assert.deepEqual(classifyHolding('XAUT'), { klass: 'gold', assumed: false });
  assert.deepEqual(classifyHolding('PAXG'), { klass: 'gold', assumed: false });
});

test('classifyHolding: an unlisted symbol falls through to crypto-risk, and SAYS so', () => {
  assert.deepEqual(classifyHolding('PEPE'), { klass: 'btc', assumed: true });
  assert.deepEqual(classifyHolding('SOMENEWCOIN'), { klass: 'btc', assumed: true });
  // A stablecoin that is NOT in the explicit set must not be silently blessed
  // as cash — it falls through like any other token, with the flag set.
  assert.deepEqual(classifyHolding('NOTAREALUSD'), { klass: 'btc', assumed: true });
});

test('exposureOverlay: shares, alignment and coverage over a mostly-cash book', () => {
  const ex = exposureOverlay(
    [
      { asset: 'USDT', value_usd: 100 },
      { asset: 'USDC', value_usd: 37 },
      { asset: 'ETH', value_usd: 3 },
      { asset: 'BTC', value_usd: 1 },
      { asset: 'PEPE', value_usd: 1 },
    ],
    IMPACTS
  );

  assert.equal(ex.total_usd, 142);
  assert.equal(ex.mapped_usd, 142, 'every holding mapped to a scored class');
  assert.ok(near(ex.coverage as number, 1));

  const usd = ex.classes.find((c) => c.asset === 'usd')!;
  const btc = ex.classes.find((c) => c.asset === 'btc')!;
  const gold = ex.classes.find((c) => c.asset === 'gold')!;
  assert.equal(usd.value_usd, 137);
  assert.ok(near(usd.share as number, 137 / 142));
  assert.deepEqual(usd.holdings, ['USDT', 'USDC'], 'largest first');
  assert.equal(btc.value_usd, 5);
  assert.deepEqual(btc.holdings[0], 'ETH', 'largest first within the class');
  assert.equal(gold.value_usd, 0, 'an empty class is present with a zero, not omitted');
  assert.equal(ex.classes.length, IMPACTS.length, 'every table class is listed');

  // alignment = (137 * 2.5 + 5 * -1) / 142
  assert.ok(near(ex.alignment as number, 337.5 / 142, 1e-2));
  assert.equal(ex.skipped.length, 0);
  assert.equal(ex.rule, EXPOSURE_RULE);
});

test('exposureOverlay: the assumed flag rides on the holding row', () => {
  const ex = exposureOverlay(
    [
      { asset: 'PEPE', value_usd: 2 },
      { asset: 'WBTC', value_usd: 2 },
    ],
    IMPACTS
  );
  const pepe = ex.holdings.find((h) => h.asset === 'PEPE')!;
  const wbtc = ex.holdings.find((h) => h.asset === 'WBTC')!;
  assert.equal(pepe.assumed, true);
  assert.equal(pepe.klass, 'btc');
  assert.equal(pepe.klassLabel, 'Bitcoin', 'the class label is the table\u2019s own');
  assert.equal(wbtc.assumed, false);
});

test('exposureOverlay: an unvalued holding makes the total unknown, and every share null', () => {
  const ex = exposureOverlay(
    [
      { asset: 'USDT', value_usd: 100 },
      { asset: 'ETH', value_usd: null },
    ],
    IMPACTS
  );
  assert.equal(ex.total_usd, null, 'a partial total is never stated');
  assert.equal(ex.coverage, null);
  for (const c of ex.classes) assert.equal(c.share, null, `${c.asset} share must be null`);
  const usd = ex.classes.find((c) => c.asset === 'usd')!;
  assert.equal(usd.value_usd, 100, 'the class value is still shown');
  assert.equal(ex.skipped.length, 1);
  assert.equal(ex.skipped[0].asset, 'ETH');
  assert.match(ex.skipped[0].reason, /no value/);
  // The valued holding still scores; only the share is withheld.
  assert.ok(near(ex.alignment as number, 2.5));
});

test('exposureOverlay: zero, negative and NaN values are refused and named', () => {
  const ex = exposureOverlay(
    [
      { asset: 'USDT', value_usd: 100 },
      { asset: 'DUST', value_usd: 0 },
      { asset: 'OWED', value_usd: -5 },
      { asset: 'BROKEN', value_usd: Number.NaN },
    ],
    IMPACTS
  );
  assert.equal(ex.total_usd, null, 'NaN leaves the total unknown');
  const named = ex.skipped.map((s) => s.asset).sort();
  assert.deepEqual(named, ['BROKEN', 'DUST', 'OWED']);
  assert.match(ex.skipped.find((s) => s.asset === 'DUST')!.reason, /zero or negative/);
  assert.equal(ex.classes.find((c) => c.asset === 'usd')!.value_usd, 100);
});

test('exposureOverlay: a class the weight table does not score is named, not scored as zero', () => {
  const withoutGold = IMPACTS.filter((i) => i.asset !== 'gold');
  const ex = exposureOverlay([{ asset: 'PAXG', value_usd: 10 }], withoutGold);
  assert.equal(ex.mapped_usd, 0);
  assert.equal(ex.alignment, null, 'nothing mapped, so there is no alignment to state');
  assert.equal(ex.skipped.length, 1);
  assert.match(ex.skipped[0].reason, /not scored by the weight table/);
});

test('exposureOverlay: an empty book is not an error — it is a zero-coverage read', () => {
  const ex = exposureOverlay([], IMPACTS);
  assert.equal(ex.total_usd, 0);
  assert.equal(ex.mapped_usd, 0);
  assert.equal(ex.alignment, null);
  assert.equal(ex.coverage, null, 'no total to take a share of');
  assert.equal(ex.classes.length, IMPACTS.length);
  for (const c of ex.classes) {
    assert.equal(c.value_usd, 0);
    assert.equal(c.share, null, 'there is no share of an empty book');
  }
});
