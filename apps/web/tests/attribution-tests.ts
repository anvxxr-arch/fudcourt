/**
 * P&L attribution tests (`@/lib/attribution`): run OFFLINE — no network, no
 * clock, no database. The model is pure by construction.
 *
 * Contract under test:
 *  - the decomposition is EXACT: `priceEffect + flowEffect === delta` for every
 *    pair, in all four shapes (both ends priced, opened, closed, quantity-less),
 *    asserted on the raw sum rather than a tolerance;
 *  - the independent derivation `p1·(q1 − q0)` agrees with the residual form, so
 *    the identity is checked against its own algebra rather than restated;
 *  - `opened`/`closed` are SET, and a 0 price effect carries its reason — the
 *    distinction between "nothing to reprice" and "the price held still";
 *  - a key's row is the SUM of its assets' effects, and the totals are the sum of
 *    the rows, so `residualUsd` is 0 and a reader can check the split;
 *  - one observation in the window yields NULL totals and no rows — never a
 *    confident `$0.00` for a change the window cannot support;
 *  - a row with no quantity but a value is a real endpoint with nothing to
 *    reprice, while a row absent altogether is the `null` endpoint.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttribution,
  decomposePair,
  pairInputsFromRows,
  type AttrPairInput,
} from '@/lib/attribution';

/** A pair with both endpoints present. */
const pair = (key: string, asset: string, q0: number, v0: number, q1: number, v1: number): AttrPairInput => ({
  key,
  asset,
  start: { qty: q0, valueUsd: v0 },
  end: { qty: q1, valueUsd: v1 },
});

/** The identity, asserted exactly rather than within a tolerance. */
const assertExact = (p: ReturnType<typeof decomposePair>) => {
  assert.equal(
    p.priceEffectUsd + p.flowEffectUsd,
    p.deltaUsd,
    `identity broke: ${p.priceEffectUsd} + ${p.flowEffectUsd} !== ${p.deltaUsd}`,
  );
};

test('decomposePair: a pure price move lands entirely in the price effect', () => {
  // 1 ETH held throughout at $2,500 → $2,750. Nothing was bought or sold.
  const p = decomposePair(pair('ethereum', 'ETH', 1, 2500, 1, 2750));
  assertExact(p);
  assert.equal(p.startPrice, 2500);
  assert.equal(p.endPrice, 2750);
  assert.equal(p.deltaUsd, 250);
  assert.equal(p.priceEffectUsd, 250);
  assert.equal(p.flowEffectUsd, 0);
  assert.equal(p.opened, false);
  assert.equal(p.closed, false);
});

test('decomposePair: a pure quantity move lands entirely in the book effect', () => {
  // Price held at $2,500; the position doubled.
  const p = decomposePair(pair('ethereum', 'ETH', 1, 2500, 2, 5000));
  assertExact(p);
  assert.equal(p.priceEffectUsd, 0);
  assert.equal(p.flowEffectUsd, 2500);
});

test('decomposePair: a mixed move splits exactly, and the independent form agrees', () => {
  // $2,500 → $3,000 on 1 → 2 units. Δ = 3,500 = 500 (price) + 3,000 (book).
  const p = decomposePair(pair('ethereum', 'ETH', 1, 2500, 2, 6000));
  assertExact(p);
  assert.equal(p.deltaUsd, 3500);
  assert.equal(p.priceEffectUsd, 500);
  assert.equal(p.flowEffectUsd, 3000);
  // The derivation the header states, computed independently of the residual.
  assert.ok(Math.abs(p.flowEffectUsd - (p.endPrice as number) * (p.endQty - p.startQty)) < 1e-9);
});

test('decomposePair: the identity holds when the split is inexact in binary', () => {
  // Thirds: no float can hold them, so this is where a tolerance would hide a bug.
  const p = decomposePair(pair('ethereum', 'ETH', 3, 10, 3, 11));
  assertExact(p);
  assert.ok(Math.abs(p.flowEffectUsd - (p.endPrice as number) * (p.endQty - p.startQty)) < 1e-9);
});

test('decomposePair: a pair that OPENED has nothing to reprice, and says so', () => {
  const p = decomposePair({ key: 'solana', asset: 'SOL', start: null, end: { qty: 2, valueUsd: 6000 } });
  assertExact(p);
  assert.equal(p.opened, true);
  assert.equal(p.closed, false);
  assert.equal(p.startPrice, null);
  assert.equal(p.priceEffectUsd, 0);
  assert.equal(p.flowEffectUsd, 6000);
  assert.equal(p.priceSharePct, 0);
});

test('decomposePair: a pair that CLOSED carries its whole value as a book effect', () => {
  const p = decomposePair({ key: 'solana', asset: 'SOL', start: { qty: 1, valueUsd: 2500 }, end: null });
  assertExact(p);
  assert.equal(p.opened, false);
  assert.equal(p.closed, true);
  assert.equal(p.endPrice, null);
  assert.equal(p.priceEffectUsd, 0);
  assert.equal(p.flowEffectUsd, -2500);
});

test('decomposePair: a value with no quantity is not a zero-priced holding', () => {
  // The sync wrote a value but no quantity: there is no unit price to reprice.
  const p = decomposePair({ key: 'ethereum', asset: 'DUST', start: { qty: 0, valueUsd: 50 }, end: { qty: 0, valueUsd: 50 } });
  assertExact(p);
  assert.equal(p.startPrice, null);
  assert.equal(p.endPrice, null);
  assert.equal(p.opened, true);
  assert.equal(p.closed, true);
  assert.equal(p.deltaUsd, 0);
  assert.equal(p.priceEffectUsd, 0);
  assert.equal(p.flowEffectUsd, 0);
  // Nothing moved, so there is no share to report.
  assert.equal(p.priceSharePct, null);
});

test('buildAttribution: a key aggregates its assets, and the totals close', () => {
  const result = buildAttribution({
    dimension: 'chain',
    range: '7d',
    observations: 4,
    fromTs: '2026-10-01T00:00:00.000Z',
    toTs: '2026-10-08T00:00:00.000Z',
    pairs: [
      pair('ethereum', 'ETH', 1, 2500, 1, 2750), // +250 market
      pair('ethereum', 'USDC', 1000, 1000, 1500, 1500), // +500 book
      pair('solana', 'SOL', 10, 500, 10, 400), // −100 market
    ],
  });

  assert.equal(result.singleObservation, false);
  assert.equal(result.rows.length, 2);

  const eth = result.rows.find((r) => r.key === 'ethereum');
  assert.ok(eth);
  assert.equal(eth.assets, 2);
  assert.equal(eth.startValueUsd, 3500);
  assert.equal(eth.endValueUsd, 4250);
  assert.equal(eth.deltaUsd, 750);
  assert.equal(eth.priceEffectUsd, 250);
  assert.equal(eth.flowEffectUsd, 500);

  const sol = result.rows.find((r) => r.key === 'solana');
  assert.ok(sol);
  assert.equal(sol.deltaUsd, -100);
  assert.equal(sol.priceEffectUsd, -100);
  assert.equal(sol.flowEffectUsd, 0);

  // The totals are the sum of the rows, and the split is checkable.
  assert.equal(result.totalDeltaUsd, 650);
  assert.equal(result.totalPriceEffectUsd, 150);
  assert.equal(result.totalFlowEffectUsd, 500);
  assert.equal(result.residualUsd, 0);
  // The market's 150 of the 650 move — the rest is the book, and they sum to 100%.
  assert.ok(result.marketSharePct !== null && Math.abs(result.marketSharePct - (150 / 650) * 100) < 1e-9);
  // Rows lead with the biggest absolute move: ethereum (+750) before solana (−100).
  assert.equal(result.rows[0].key, 'ethereum');
});

test('decomposePair: the shares sum to 100%, so the panel\'s "of the move" is literally true', () => {
  const up = decomposePair(pair('ethereum', 'ETH', 1, 2500, 2, 6000));
  assert.ok(up.priceSharePct !== null);
  const upBook = (up.flowEffectUsd / up.deltaUsd) * 100;
  assert.ok(Math.abs(up.priceSharePct + upBook - 100) < 1e-9, `${up.priceSharePct} + ${upBook} !== 100`);

  // The regression this guard exists for. A market that falls WITH a falling
  // holding accounts for PART of the fall, so its share must be POSITIVE; against
  // `|delta|` it came out negative and the panel said "-100% of the move".
  const down = decomposePair(pair('ethereum', 'ETH', 1, 2500, 1, 2000));
  assert.equal(down.deltaUsd, -500);
  assert.equal(down.priceEffectUsd, -500);
  assert.equal(down.priceSharePct, 100);
});

test('buildAttribution: one observation yields null totals, never a zero', () => {
  const result = buildAttribution({
    dimension: 'asset',
    range: '24h',
    observations: 1,
    fromTs: '2026-10-08T00:00:00.000Z',
    toTs: '2026-10-08T00:00:00.000Z',
    pairs: [pair('ethereum', 'ETH', 1, 2500, 1, 2500)],
  });
  assert.equal(result.singleObservation, true);
  assert.equal(result.totalDeltaUsd, null);
  assert.equal(result.totalPriceEffectUsd, null);
  assert.equal(result.totalFlowEffectUsd, null);
  assert.equal(result.residualUsd, null);
  assert.equal(result.marketSharePct, null);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.pairs, []);
});

test('buildAttribution: an empty windows list is not an error', () => {
  const result = buildAttribution({
    dimension: 'chain',
    range: '7d',
    observations: 3,
    fromTs: null,
    toTs: null,
    pairs: [],
  });
  assert.equal(result.singleObservation, false);
  assert.equal(result.totalDeltaUsd, 0);
  assert.equal(result.residualUsd, 0);
  assert.deepEqual(result.rows, []);
});

test('pairInputsFromRows: a missing side is the null endpoint, a quantity-less row is not', () => {
  const inputs = pairInputsFromRows([
    { key: 'ethereum', asset: 'ETH', q0: 1, v0: 2500, q1: 1, v1: 2750 },
    { key: 'ethereum', asset: 'NEW', q0: null, v0: null, q1: 5, v1: 500 },
    { key: 'ethereum', asset: 'DUST', q0: null, v0: 50, q1: null, v1: null },
    { key: 'ethereum', asset: 'GONE', q0: null, v0: null, q1: null, v1: null },
  ]);

  // The last row carries no endpoint at all and is dropped.
  assert.equal(inputs.length, 3);

  const held = inputs.find((i) => i.asset === 'ETH');
  assert.deepEqual(held?.start, { qty: 1, valueUsd: 2500 });
  assert.deepEqual(held?.end, { qty: 1, valueUsd: 2750 });

  const opened = inputs.find((i) => i.asset === 'NEW');
  assert.equal(opened?.start, null);
  assert.deepEqual(opened?.end, { qty: 5, valueUsd: 500 });

  // A value with no quantity is a real endpoint, not a missing one.
  const dusty = inputs.find((i) => i.asset === 'DUST');
  assert.deepEqual(dusty?.start, { qty: 0, valueUsd: 50 });
  assert.equal(dusty?.end, null);
});

test('pairInputsFromRows: both-null quantity and value on a side stay null', () => {
  const inputs = pairInputsFromRows([{ key: 'k', asset: 'A', q0: 0, v0: 0, q1: null, v1: null }]);
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].start, { qty: 0, valueUsd: 0 });
  assert.equal(inputs[0].end, null);
});
