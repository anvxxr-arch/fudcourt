/**
 * medianOf tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (features/market/ticker/client.ts):
 *  - nulls and non-finite values are dropped, never coerced to 0. A venue that
 *    did not report a price is an "unknown", and folding it into the median as
 *    a zero would print a real-looking number that is simply wrong;
 *  - `positiveOnly` defaults to FALSE. A price must be > 0, but a 24h change is
 *    signed and legitimately negative, so the default is the signed case — the
 *    one that silently corrupts when the flag is forgotten;
 *  - even-length input averages the two middle values, odd-length takes the
 *    middle one;
 *  - nothing usable left (empty, or all null / non-finite / non-positive when
 *    filtered) returns null.
 *
 * Usage: cd apps/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianOf } from '@/features/market/ticker/client';

test('median: nulls and non-finite values are dropped, not folded in as zero', () => {
  assert.equal(medianOf([3, null, 1, Number.NaN, 2, Number.POSITIVE_INFINITY]), 2);
  assert.equal(medianOf([null, 5, null]), 5);
});

test('median: positiveOnly defaults to false, so a negative value is kept', () => {
  // A 24h change is signed; discarding the losers would blank every losing pair.
  assert.equal(medianOf([-5, -1, -3]), -3);
  assert.equal(medianOf([-10, 10]), 0);
  assert.equal(medianOf([-5, -1, -3], false), -3);
});

test('median: positiveOnly excludes zero and negatives when asked', () => {
  assert.equal(medianOf([-5, -1, 3, 7], true), 5);
  assert.equal(medianOf([0, 0, 4, 8], true), 6);
  assert.equal(medianOf([-1, -2, -3], true), null, 'nothing positive left means no figure at all');
});

test('median: even-length averages the two middle values', () => {
  assert.equal(medianOf([4, 1, 3, 2]), 2.5);
  assert.equal(medianOf([10, 2, 8, 4, 6, 0]), 5);
});

test('median: odd-length takes the middle value', () => {
  assert.equal(medianOf([9, 1, 5]), 5);
  assert.equal(medianOf([100, 1, 50, 2, 75]), 50);
});

test('median: an empty or all-null input returns null', () => {
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([null, null]), null);
  assert.equal(medianOf([Number.NaN, Number.POSITIVE_INFINITY, null]), null);
});
