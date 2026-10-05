/**
 * Macro regime engine tests (plan Phase 13, stages 16–17): run OFFLINE, no
 * network, no clock.
 *
 * Contract under test (features/economy/regime.ts):
 *  - a direction is declared ONLY when the move over the lookback beats the
 *    series' own period-to-period variation. This is the whole reason the module
 *    exists: a rule that called every nonzero change a trend would flip a
 *    country between regimes on rounding noise. The flat cases below are the
 *    ones that matter — they are what a naive `sign(change)` implementation
 *    gets wrong;
 *  - a series with too few observations resolves to NOTHING, never to "flat".
 *    "Flat" is a claim about the economy; "unknown" is not, and a regime built
 *    on a fabricated flat reading is confidently wrong;
 *  - a step-function series (a policy rate that holds, then moves) IS
 *    directional — its normal variation is zero, so any move is real — but its
 *    signal-to-noise ratio must stay finite, or the JSON payload carries 1e7 and
 *    one series can single-handedly claim high confidence;
 *  - the rule table is ORDERED: a specific combination must not be shadowed by a
 *    looser rule that matches the same readings;
 *  - a rule whose required dimension could not be read does NOT fire. It is
 *    never satisfied by a missing value;
 *  - the liquidity breadth vote reads `direction`, so a rising component whose
 *    rise TIGHTENS votes to contract.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIMENSION_LABEL,
  buildRegime,
  classifyTrend,
  liquidityBreadth,
  matchRegime,
  readDimension,
  scoreImpacts,
  stanceFor,
  type DimensionId,
  type DimensionReading,
  type SeriesInput,
  type TrendDirection,
} from '@/features/economy/model';

/** A rising series with real period-to-period noise, so MAD is not zero. */
const UP = [1, 1.1, 1.05, 1.2, 1.15, 1.3, 1.25, 1.4, 1.5, 1.6, 1.7, 1.8];
/** Its mirror — same magnitude of change, opposite sign. */
const DOWN = [...UP].reverse();
/** Oscillating around a level: the change over the lookback is zero. */
const FLAT = [1.0, 1.05, 0.95, 1.02, 0.98, 1.01, 0.99, 1.0, 1.03, 0.97, 1.0, 1.01];

function dates(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `202${String(Math.floor(i / 12)).slice(-1)}-${String((i % 12) + 1).padStart(2, '0')}-01`);
}

function series(id: DimensionId, direction: TrendDirection | null, opts: { lookback?: number; values?: number[] } = {}): SeriesInput {
  const values = direction === null ? [1, 2] : (opts.values ?? (direction === 'up' ? UP : direction === 'down' ? DOWN : FLAT));
  return {
    id,
    slug: `${id}-test`,
    label: DIMENSION_LABEL[id],
    unit: '%',
    decimals: 2,
    values,
    dates: dates(values.length),
    lookback: opts.lookback ?? 6,
  };
}

/** A resolved reading with a chosen direction, for rule-table tests. */
function reading(id: DimensionId, direction: TrendDirection): DimensionReading {
  return readDimension(series(id, direction));
}

// ---------------------------------------------------------------------------
// Trend classification
// ---------------------------------------------------------------------------

test('regime: a sustained move past the noise floor is a direction', () => {
  const up = classifyTrend(UP, 6);
  assert.ok(up, 'the series is long enough to read');
  assert.equal(up.direction, 'up');
  assert.ok(up.change > 0);
  assert.ok(up.strength >= 1, `strength ${up.strength} must clear the floor`);

  const down = classifyTrend(DOWN, 6);
  assert.ok(down);
  assert.equal(down.direction, 'down');
});

test('regime: noise around a level is FLAT, not a direction', () => {
  const r = classifyTrend(FLAT, 6);
  assert.ok(r);
  assert.equal(r.direction, 'flat', 'an oscillating series has no trend, whatever the last two points did');
  assert.ok(r.strength < 1, `strength ${r.strength} must stay under the floor`);
});

test('regime: a constant series is flat, never a divide-by-zero direction', () => {
  const r = classifyTrend([2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5], 6);
  assert.ok(r);
  assert.equal(r.direction, 'flat');
  assert.equal(r.change, 0);
  assert.ok(Number.isFinite(r.noise) && r.noise > 0, 'the noise floor is floored, never zero');
  assert.ok(Number.isFinite(r.strength), 'strength stays finite');
});

test('regime: too few observations resolve to null, never to "flat"', () => {
  for (const short of [[], [1], [1, 2], [1, 2, 3]]) {
    assert.equal(classifyTrend(short, 6), null, `${JSON.stringify(short)} must not yield a reading`);
  }
  assert.ok(classifyTrend([1, 2, 3, 4], 6), 'four points is the first length that reads');
});

test('regime: a step-function series is directional with a FINITE strength', () => {
  // A policy rate that holds for twenty periods, then moves once. Its normal
  // variation is zero, so the move is real — but the ratio must not explode.
  const values = [...Array(20).fill(4.0), 4.25];
  const r = classifyTrend(values, 30);
  assert.ok(r);
  assert.equal(r.direction, 'up');
  assert.ok(Number.isFinite(r.strength), 'strength must serialise to JSON, so it cannot be Infinity');
  assert.ok(r.strength <= 99, `strength ${r.strength} must be capped`);
});

test('regime: the lookback is clamped to the series length', () => {
  const r = classifyTrend(UP, 999);
  assert.ok(r);
  assert.equal(r.lookback, UP.length - 1, 'a lookback past the start of the series clamps');
});

// ---------------------------------------------------------------------------
// Reading a dimension
// ---------------------------------------------------------------------------

test('regime: an unreadable dimension says WHY and carries no word', () => {
  const r = readDimension({ ...series('growth', null), failure: 'upstream 503' });
  assert.equal(r.trend, null);
  assert.equal(r.word, null);
  assert.equal(r.tag, null);
  assert.equal(r.reason, 'upstream 503');
});

test('regime: a short series is unreadable, not flat', () => {
  const r = readDimension(series('growth', 'up', { values: [1, 1.5] }));
  assert.equal(r.word, null);
  assert.equal(r.tag, null);
  assert.match(r.reason ?? '', /not enough published observations/);
});

// ---------------------------------------------------------------------------
// The rule table
// ---------------------------------------------------------------------------

test('regime: the specific combination wins over the looser rule', () => {
  // growth cooling + inflation hot matches `stagflation` (2 dims) and also, via
  // policy, `tightening`. Order must put stagflation first.
  const matched = matchRegime([reading('growth', 'down'), reading('inflation', 'up'), reading('policy', 'up')]);
  assert.equal(matched?.code, 'stagflation');
});

test('regime: a rule needing an unreadable dimension does not fire', () => {
  // Overheating needs policy. With policy unreadable it must fall through to
  // `reflation`, which needs only growth and inflation.
  const matched = matchRegime([reading('growth', 'up'), reading('inflation', 'up')]);
  assert.equal(matched?.code, 'reflation');
});

test('regime: wait-and-see requires policy to be genuinely idle', () => {
  const withHold = matchRegime([reading('growth', 'flat'), reading('inflation', 'flat'), reading('policy', 'flat')]);
  assert.equal(withHold?.code, 'wait-and-see');

  // Same growth and inflation, but policy is tightening: the label must name the
  // one dimension that is actually moving.
  const withTight = matchRegime([reading('growth', 'flat'), reading('inflation', 'flat'), reading('policy', 'up')]);
  assert.equal(withTight?.code, 'tightening');
});

test('regime: steady growth with cooling inflation still names a regime', () => {
  const matched = matchRegime([reading('growth', 'flat'), reading('inflation', 'down')]);
  assert.equal(matched?.code, 'disinflationary-drift');
});

test('regime: no readable dimension matches nothing at all', () => {
  assert.equal(matchRegime([]), null);
  assert.equal(matchRegime([reading('growth', 'flat')]), null, 'steady growth alone is not a regime');
});

// ---------------------------------------------------------------------------
// Asset scoring
// ---------------------------------------------------------------------------

test('regime: the stance thresholds are the table\'s own units', () => {
  assert.equal(stanceFor(2.0), 'strongly bullish');
  assert.equal(stanceFor(1.99), 'bullish');
  assert.equal(stanceFor(0.75), 'bullish');
  assert.equal(stanceFor(0.74), 'neutral');
  assert.equal(stanceFor(0), 'neutral');
  assert.equal(stanceFor(-0.74), 'neutral');
  assert.equal(stanceFor(-0.75), 'bearish');
  assert.equal(stanceFor(-2.0), 'strongly bearish');
});

test('regime: every score is the sum of its listed contributions', () => {
  const impacts = scoreImpacts([reading('liquidity', 'up'), reading('policy', 'down'), reading('inflation', 'up')]);
  for (const row of impacts) {
    const sum = Math.round(row.contributions.reduce((a, c) => a + c.weight, 0) * 100) / 100;
    assert.equal(row.score, sum, `${row.label}: score must equal the sum of the contributions shown`);
    assert.equal(row.stance, stanceFor(row.score), `${row.label}: stance must follow from the score`);
  }
  // Liquidity expanding is the single strongest support for BTC in the table.
  const btc = impacts.find((i) => i.asset === 'btc');
  assert.ok(btc);
  assert.ok(btc.score > 0, 'expanding liquidity and easing policy must not leave BTC bearish');
});

test('regime: an unreadable dimension contributes nothing, silently', () => {
  const impacts = scoreImpacts([]);
  for (const row of impacts) {
    assert.equal(row.score, 0);
    assert.equal(row.stance, 'neutral');
    assert.deepEqual(row.contributions, []);
  }
});

// ---------------------------------------------------------------------------
// Liquidity breadth
// ---------------------------------------------------------------------------

test('regime: the breadth vote reads DIRECTION, so a tightening rise votes to contract', () => {
  // A rising reverse-repo balance or a rising dollar DRAINS liquidity. A board
  // that treated every rise as expansion would be wrong in exactly the regime
  // this module exists to detect.
  const r = liquidityBreadth([
    { change: 10, direction: -1 },
    { change: 5, direction: 1 },
  ]);
  assert.ok(r);
  assert.equal(r.components, 2);
  assert.equal(r.value, 50, 'one loosening and one tightening is balanced');
  assert.equal(r.trend, 'Neutral');

  const drain = liquidityBreadth([{ change: 10, direction: -1 }, { change: 3, direction: -1 }]);
  assert.equal(drain?.value, 0);
  assert.equal(drain?.trend, 'Contracting');

  const flood = liquidityBreadth([{ change: 1, direction: 1 }, { change: 1, direction: 1 }]);
  assert.equal(flood?.value, 100);
  assert.equal(flood?.trend, 'Expanding');
});

test('regime: a component with no change abstains, and an empty basket is null', () => {
  const r = liquidityBreadth([{ change: 4, direction: 1 }, { change: null, direction: 1 }]);
  assert.ok(r);
  assert.equal(r.components, 1, 'a component with no usable change does not vote');
  assert.equal(r.value, 100);

  assert.equal(liquidityBreadth([]), null);
  assert.equal(liquidityBreadth([{ change: null, direction: 1 }]), null);
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

test('regime: a full set of moving dimensions reads as high confidence', () => {
  const r = buildRegime('Test', [
    series('growth', 'down'),
    series('inflation', 'down'),
    series('labor', 'down'),
    series('liquidity', 'up'),
    series('policy', 'down'),
  ]);
  assert.equal(r.regime?.code, 'late-cycle-easing');
  assert.equal(r.confidence, 'high');
  assert.deepEqual(r.missing, []);
  assert.match(r.narrative, /late-cycle easing/i);
});

test('regime: steady dimensions are readable but do NOT count as directional evidence', () => {
  const r = buildRegime('Test', [
    series('growth', 'flat'),
    series('inflation', 'flat'),
    series('labor', 'flat'),
    series('liquidity', 'flat'),
    series('policy', 'flat'),
  ]);
  assert.equal(r.regime?.code, 'wait-and-see');
  assert.equal(r.confidence, 'low', 'five readable but unmoving dimensions is not strong evidence');
});

test('regime: a missing dimension is named, and no rule that needs it fires', () => {
  const r = buildRegime('Test', [series('growth', 'up'), series('inflation', 'up'), series('labor', 'flat')]);
  assert.deepEqual(r.missing, ['liquidity', 'policy']);
  assert.equal(r.regime?.code, 'reflation');
  const policy = r.dimensions.find((d) => d.id === 'policy');
  assert.equal(policy?.word, null);
  assert.equal(policy?.tag, null);
});

test('regime: with nothing readable, no regime is stated and it says so', () => {
  const r = buildRegime('Test', []);
  assert.equal(r.regime, null);
  assert.equal(r.confidence, 'low');
  assert.match(r.regimeReason ?? '', /no dimension could be read/);
  assert.match(r.narrative, /no dimension could be read/);
});

test('regime: the narrative restates only the computed words', () => {
  const r = buildRegime('Test', [series('growth', 'down'), series('inflation', 'down'), series('policy', 'down')]);
  for (const d of r.dimensions) {
    if (d.word) assert.ok(r.narrative.toLowerCase().includes(d.word.toLowerCase()), `${d.word} must appear in the narrative`);
  }
  assert.match(r.narrative, /not a forecast/);
});

test('regime: the result carries `subject`, and NEVER a `scope` key', () => {
  // The API route spreads this result into a payload that ALREADY carries a
  // `scope` OBJECT. While this key was named `scope`, the spread silently
  // overwrote that object with this string, and every consumer reading
  // `scope.kind` crashed at runtime — a failure no type-check caught, because
  // the string lived in `MacroRegime` and the object in `RegimeEnvelope`.
  const r = buildRegime('Indonesia', [series('growth', 'up'), series('inflation', 'up')]);
  assert.equal(r.subject, 'Indonesia', 'the scope display name must survive as `subject`');
  assert.ok(
    !('scope' in r),
    'a `scope` key on this result would shadow the route\'s scope object and break the payload',
  );
});

test('regime: the narrative names the scope from `subject`', () => {
  const r = buildRegime('Japan', [series('growth', 'down'), series('inflation', 'down')]);
  assert.match(r.narrative, /^Japan:/, 'the narrative opens with the scope name');
});
