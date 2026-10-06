/**
 * mapPool tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (app/(frontend)/api/economy/_lib/rows.ts):
 *  - results land in INPUT ORDER, not completion order. A pool that scatters
 *    its answers would render a country profile with indicator 7's value under
 *    indicator 2's label, and nothing downstream can detect that;
 *  - at most `limit` callbacks are in flight at once. The World Bank pool and
 *    the shared limiter already serialise upstream calls; this bounds how many
 *    promises are open, so a 30-indicator profile does not hold 30 pending
 *    fetches (each with a 25 s deadline) against a shared transport;
 *  - an empty pool is a no-op: the callback is never entered;
 *  - a rejection propagates rather than being swallowed, so a failed upstream
 *    surfaces as a failed request instead of a half-filled row.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from '@/app/(frontend)/api/economy/_lib/rows';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('pool: results keep input order even when callbacks resolve out of order', async () => {
  // Callback i resolves after callback i+1: index 0 sleeps longest, so a pool
  // that appended on completion would emit [4, 3, 2, 1, 0].
  const items = [0, 1, 2, 3, 4];
  const out = await mapPool(items, items.length, async (i) => {
    await wait((items.length - i) * 10);
    return i * 2;
  });
  assert.deepEqual(out, [0, 2, 4, 6, 8], 'a scattered pool would put one indicator\'s value under another\'s label');
});

test('pool: the concurrency bound holds, never more than limit in flight', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = [0, 1, 2, 3, 4];
  const out = await mapPool(items, 2, async (i) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await wait(10);
    inFlight -= 1;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.ok(maxInFlight <= 2, `expected at most 2 in flight, saw ${maxInFlight}`);
  assert.equal(maxInFlight, 2, 'the pool should actually use its allowance, not run serially');
});

test('pool: an empty input returns an empty array and never calls fn', async () => {
  let calls = 0;
  const out = await mapPool<number, number>([], 4, async (n) => {
    calls += 1;
    return n;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0, 'an empty pool must not enter the callback');
});

test('pool: a rejecting callback propagates the rejection', async () => {
  const boom = new Error('upstream died');
  await assert.rejects(
    mapPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw boom;
      return n;
    }),
    boom,
    'a swallowed rejection would render a half-filled row as a success'
  );
});
