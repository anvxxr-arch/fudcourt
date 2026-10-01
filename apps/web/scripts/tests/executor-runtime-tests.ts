/**
 * The pure safety gates that sit between a validated request and a created
 * execution row.
 *
 * Both rules are REFUSE-ONLY. Neither resizes, neither warns and proceeds: a
 * guard that degrades to advice is not a guard. That makes both pure functions
 * of committed state — no database, no venue — which is what makes them
 * testable at all; the wrappers around them only gather numbers and the venue's
 * truth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePortfolioGates,
  evaluatePositionPolicy,
} from '../../src/platform/executor/runtime';
import { DEFAULT_RISK_PROFILE, type RiskProfile } from '../../src/platform/executor/types';

const PROFILE: RiskProfile = {
  ...DEFAULT_RISK_PROFILE,
  maxRiskPerTradePct: 2,
  maxOpenRiskPct: 5,
  maxDailyLossPct: 5,
};

// ---------------------------------------------------------------------------
// §93 — existing-position policy: no accidental netting.

test('§93 a flat account opens freely in either direction', () => {
  assert.equal(evaluatePositionPolicy({ intent: 'open', side: 'buy', symbol: 'BTC/USDT', existingQuantity: 0 }), null);
  assert.equal(evaluatePositionPolicy({ intent: 'open', side: 'sell', symbol: 'BTC/USDT', existingQuantity: 0 }), null);
});

test('§93 ADD is allowed: the same direction is an explicit increase', () => {
  assert.equal(evaluatePositionPolicy({ intent: 'open', side: 'buy', symbol: 'BTC/USDT', existingQuantity: 0.5 }), null);
  assert.equal(evaluatePositionPolicy({ intent: 'open', side: 'sell', symbol: 'BTC/USDT', existingQuantity: -0.5 }), null);
});

test('§93 REJECT: the opposing side would net through flat, not add', () => {
  // The distinction is DIRECTION, not existence — a long exists either way, but
  // only the opposite side silently passes through flat.
  const shortIntoLong = evaluatePositionPolicy({ intent: 'open', side: 'sell', symbol: 'BTC/USDT', existingQuantity: 0.5 });
  assert.ok(shortIntoLong, 'a short opening against a long must be refused');
  assert.equal(shortIntoLong.status, 409);
  const longIntoShort = evaluatePositionPolicy({ intent: 'open', side: 'buy', symbol: 'BTC/USDT', existingQuantity: -0.5 });
  assert.ok(longIntoShort, 'a long opening against a short must be refused');
  assert.equal(longIntoShort.status, 409);
});

test('§93 the refusal names the position, the direction and the way out', () => {
  const refusal = evaluatePositionPolicy({ intent: 'open', side: 'sell', symbol: 'BTC/USDT', existingQuantity: 0.5 });
  assert.ok(refusal);
  // A refusal the user cannot act on is a dead end: it must say what is there,
  // what was asked, and what to do instead.
  assert.match(refusal.detail, /BTC\/USDT/);
  assert.match(refusal.detail, /long side/);
  assert.match(refusal.detail, /reduce|close/);
});

test('§93 exits are never gated — refusing one would trap the user in the position', () => {
  for (const intent of ['close', 'reduce'] as const) {
    assert.equal(evaluatePositionPolicy({ intent, side: 'sell', symbol: 'BTC/USDT', existingQuantity: 0.5 }), null);
    assert.equal(evaluatePositionPolicy({ intent, side: 'buy', symbol: 'BTC/USDT', existingQuantity: -0.5 }), null);
  }
});

test('§93 a dust position still counts: netting through flat is netting', () => {
  // Rounding leaves venue positions that are not exactly zero. Treating a tiny
  // non-zero as flat is how a "0.00000001 short" becomes an accidental flip.
  assert.ok(evaluatePositionPolicy({ intent: 'open', side: 'buy', symbol: 'BTC/USDT', existingQuantity: -1e-8 }));
});

// ---------------------------------------------------------------------------
// §73 / §74 — portfolio gates, pinned here so both gate families share one
// home rather than one living in an E2E script.

test('§73 an opening inside the ceiling proceeds', () => {
  assert.equal(
    evaluatePortfolioGates({
      intent: 'open', equity: 100_000, openRisk: 100, realizedPnlToday: 0,
      ownRisk: 50, profile: PROFILE,
    }),
    null,
  );
});

test('§73 a breach refuses with the committed, requested and ceiling figures', () => {
  const refusal = evaluatePortfolioGates({
    intent: 'open', equity: 100_000, openRisk: 5_000, realizedPnlToday: 0,
    ownRisk: 500, profile: PROFILE,
  });
  assert.ok(refusal, 'the ceiling must actually bite');
  assert.equal(refusal.status, 409);
  assert.equal(refusal.fields.maxOpenRiskPct, PROFILE.maxOpenRiskPct);
  assert.ok(refusal.fields.maxOpenRiskUsd > 0);
});

test('§74 the daily loss guard blocks openings once the day is down to the limit', () => {
  // 5% of 100,000 = 5,000 lost ⇒ blocked.
  const refusal = evaluatePortfolioGates({
    intent: 'open', equity: 100_000, openRisk: 0, realizedPnlToday: -5_000,
    ownRisk: 10, profile: PROFILE,
  });
  assert.ok(refusal);
  assert.equal(refusal.error, 'daily loss guard reached');
});

test('§74 a profitable or flat day does not block', () => {
  assert.equal(
    evaluatePortfolioGates({
      intent: 'open', equity: 100_000, openRisk: 0, realizedPnlToday: 0,
      ownRisk: 10, profile: PROFILE,
    }),
    null,
  );
  assert.equal(
    evaluatePortfolioGates({
      intent: 'open', equity: 100_000, openRisk: 0, realizedPnlToday: 2_500,
      ownRisk: 10, profile: PROFILE,
    }),
    null,
  );
});

test('§73/§74 exits are never gated in either direction of the day', () => {
  for (const intent of ['close', 'reduce'] as const) {
    assert.equal(
      evaluatePortfolioGates({
        intent, equity: 100_000, openRisk: 5_000, realizedPnlToday: -9_999,
        ownRisk: 999, profile: PROFILE,
      }),
      null,
      `${intent} must never be refused`,
    );
  }
});

test('§73 an unresolvable equity basis blocks nothing rather than inventing a ceiling', () => {
  // No basis ⇒ no percentage to test against. Blocking here would refuse every
  // trade on an account we simply failed to read, which is not the same as risk.
  assert.equal(
    evaluatePortfolioGates({
      intent: 'open', equity: null, openRisk: 1_000_000, realizedPnlToday: -1_000_000,
      ownRisk: 999_999, profile: PROFILE,
    }),
    null,
  );
});
