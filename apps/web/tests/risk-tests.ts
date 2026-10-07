/**
 * Risk feed tests (F10): run OFFLINE, no network, no clock (`nowSec` is passed).
 *
 * Contract under test (features/risk/model.ts):
 *  - the implied probability is the MID of a two-sided book. A crossed book, a
 *    one-sided book, a non-positive quote and a quote above 1 are each NOT a
 *    price, and each is REFUSED with a named reason. This is the whole point:
 *    a fabricated 50% would read as "the market is undecided" when the truth is
 *    "there is no market here", and that is the same lie as a fake number;
 *  - a book wider than 10% of its mid is real data and is KEPT, but marked
 *    `wide` — a 1c spread on a 1.5c market is arithmetic, not consensus, and
 *    the board must be able to say so;
 *  - a market whose event already resolved is excluded and NAMED, so the board
 *    never prices an outcome that is already known;
 *  - the join between a headline and a market is LEXICAL: a shared token of 5+
 *    characters that is not a stopword. `will`/`the` must not link anything, and
 *    the field is named `lexicalMatches` because no causal claim is made;
 *  - the slice is STATED: `shown`, `priced` and `upstreamTotal` ride the payload,
 *    so a 20-row page of 50,307 can never read as the whole market.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookQualityOf,
  buildRiskFeed,
  impliedProbability,
  mostDecidedMarket,
  parsePubDate,
  readMarket,
  significantTokens,
  type Headline,
  type PredictionRow,
} from '@/features/risk/model';

const NOW = 1_800_000_000; // a fixed instant; no clock in the test either.

function row(over: Partial<PredictionRow> = {}): PredictionRow {
  return {
    id: 'r1',
    title: 'Will Bitcoin close above 200000 by December?',
    platform: 'kalshi',
    category: 'crypto',
    endDate: '2030-01-01',
    volume24hUsd: 1000,
    bid: 0.4,
    ask: 0.44,
    spread: 4,
    externalUrl: 'https://kalshi.com/markets/r1',
    ...over,
  };
}

function headline(over: Partial<Headline> = {}): Headline {
  return {
    title: 'Bitcoin rallies as ETF inflows accelerate',
    link: 'https://example.com/a',
    pubDate: 'Wed, 07 Oct 2026 18:55:36 +0000',
    source: 'Cointelegraph',
    ...over,
  };
}

test('impliedProbability: the mid of a two-sided book', () => {
  const q = impliedProbability(0.4, 0.44);
  assert.ok('probability' in q);
  if (!('probability' in q)) return;
  assert.ok(Math.abs(q.probability - 0.42) < 1e-12);
  assert.ok(Math.abs(q.spread - 0.04) < 1e-12);
  assert.ok(Math.abs(q.relativeSpread - 0.04 / 0.42) < 1e-12);
});

test('impliedProbability: every unquotable book is REFUSED with a reason', () => {
  const cases: [number, number, RegExp][] = [
    [0.5, 0.5, /crossed or one-sided/],
    [0.6, 0.5, /crossed or one-sided/],
    [0, 0.4, /non-positive/],
    [-0.1, 0.4, /non-positive/],
    [0.4, 0, /non-positive/],
    [1.2, 1.4, /above 1/],
  ];
  for (const [bid, ask, re] of cases) {
    const q = impliedProbability(bid, ask);
    assert.ok('reason' in q, `${bid}/${ask} must be refused`);
    if (!('reason' in q)) continue;
    assert.match(q.reason, re);
  }
  const nan = impliedProbability(Number.NaN, 0.4);
  assert.ok('reason' in nan);
});

test('bookQualityOf: a 10%-wide book is the boundary between tight and wide', () => {
  assert.equal(bookQualityOf(null), 'unknown');
  assert.equal(bookQualityOf(0.05), 'tight');
  assert.equal(bookQualityOf(0.1), 'tight', 'the boundary itself is still tight');
  assert.equal(bookQualityOf(0.11), 'wide');
  // The motivating case: 1c wide on a 1.5c market is 67% relative — wide.
  assert.equal(bookQualityOf(0.01 / 0.015), 'wide');
});

test('readMarket: a thin book is kept, marked wide, and its conviction is stated', () => {
  const m = readMarket(row({ bid: 0.01, ask: 0.02 }), [], []);
  assert.ok(!('skipped' in m));
  if ('skipped' in m) return;
  assert.ok(Math.abs((m.probability as number) - 0.015) < 1e-12);
  assert.equal(m.bookQuality, 'wide');
  assert.ok(Math.abs((m.conviction as number) - 0.485) < 1e-12);
});

test('readMarket: an unpriceable book is skipped, never printed as 50%', () => {
  const m = readMarket(row({ bid: 0.5, ask: 0.5 }), [], []);
  assert.ok('skipped' in m);
  if (!('skipped' in m)) return;
  assert.equal(m.skipped.id, 'r1');
  assert.match(m.skipped.reason, /crossed or one-sided/);
});

test('significantTokens: short words, stopwords and bare numbers cannot link', () => {
  const t = significantTokens('Will the Bitcoin market reach 200000 by December?');
  assert.ok(t.has('bitcoin'));
  assert.ok(t.has('december'));
  assert.ok(!t.has('will'), 'a stopword never links');
  assert.ok(!t.has('the'));
  assert.ok(!t.has('market'), 'a listed common noun never links');
  assert.ok(!t.has('200000'), 'a bare number never links — a magnitude is not a subject');
  // The motivating false match: two different assets, one shared figure.
  const btc = significantTokens('Will Bitcoin reach 200000?');
  const eth = significantTokens('Will Ethereum reach 200000?');
  const shared = [...btc].filter((x) => eth.has(x));
  assert.deepEqual(shared, [], 'a shared magnitude must not link two different subjects');
});

test('readMarket: the join is lexical and named as such', () => {
  const heads = [
    headline({ title: 'Bitcoin rallies as ETF inflows accelerate', link: 'https://example.com/btc' }),
    headline({ title: 'Solana outage halts validators', link: 'https://example.com/sol' }),
  ];
  const m = readMarket(row(), heads, heads.map((h) => significantTokens(h.title)));
  assert.ok(!('skipped' in m));
  if ('skipped' in m) return;
  assert.deepEqual(m.lexicalMatches, ['https://example.com/btc'], 'only the shared-token headline links');
});

test('buildRiskFeed: volume ranks the board, largest first', () => {
  const feed = buildRiskFeed(
    [row({ id: 'a', volume24hUsd: 10 }), row({ id: 'b', volume24hUsd: 5000 }), row({ id: 'c', volume24hUsd: 900 })],
    [],
    { nowSec: NOW }
  );
  assert.deepEqual(feed.markets.map((m) => m.id), ['b', 'c', 'a']);
});

test('buildRiskFeed: a resolved event is excluded and NAMED', () => {
  const feed = buildRiskFeed(
    [row({ id: 'live', endDate: '2030-01-01' }), row({ id: 'done', endDate: '2020-01-01', title: 'Did X win?' })],
    [],
    { nowSec: NOW }
  );
  assert.deepEqual(feed.markets.map((m) => m.id), ['live']);
  assert.equal(feed.skipped.length, 1);
  assert.equal(feed.skipped[0].id, 'done');
  assert.match(feed.skipped[0].reason, /already resolved|resolved on 2020-01-01/);
});

test('buildRiskFeed: the slice is stated, never implied', () => {
  const feed = buildRiskFeed([row()], [], { upstreamTotal: 50307, nowSec: NOW });
  assert.equal(feed.slice.shown, 1);
  assert.equal(feed.slice.priced, 1);
  assert.equal(feed.slice.upstreamTotal, 50307);
  assert.match(feed.slice.note, /1 rows of 50307|page 1/);
});

test('buildRiskFeed: headlines are freshest first, and an unparseable date sorts last', () => {
  const feed = buildRiskFeed(
    [],
    [
      headline({ link: 'old', pubDate: 'Wed, 01 Oct 2025 00:00:00 +0000' }),
      headline({ link: 'new', pubDate: 'Tue, 06 Oct 2026 00:00:00 +0000' }),
      headline({ link: 'undated', pubDate: 'not a date' }),
    ],
    { nowSec: NOW }
  );
  assert.equal(feed.headlines[0].link, 'new');
  assert.equal(feed.headlines[1].link, 'old');
  assert.equal(feed.headlines[2].link, 'undated');
  assert.equal(feed.headlines[2].ageHours, null, 'an unparseable date states no age');
});

test('parsePubDate: RFC-822 and ISO both resolve; garbage does not', () => {
  assert.equal(parsePubDate('not a date'), null);
  assert.equal(typeof parsePubDate('Wed, 07 Oct 2026 18:55:36 +0000'), 'number');
  assert.equal(typeof parsePubDate('2026-10-07'), 'number');
});

test('buildRiskFeed: an empty upstream is not an error — it is an empty read', () => {
  const feed = buildRiskFeed([], [], { nowSec: NOW });
  assert.deepEqual(feed.markets, []);
  assert.deepEqual(feed.skipped, []);
  assert.equal(feed.aggregate, null);
  assert.equal(feed.slice.priced, 0);
  assert.match(feed.derived, /MID of the two-sided book/);
});

test('mostDecidedMarket: the furthest from a coin flip, NOT the biggest market', () => {
  // The live case that exposed this: a $3.38M market the book prices at 1.5%
  // ranked first by volume, beside a $300K market priced at 91.1%. Selecting by
  // volume and rendering `0.5 + conviction` printed 98.5% for the 1.5% market —
  // the exact inversion this board exists to prevent.
  const feed = buildRiskFeed(
    [
      row({ id: 'big', bid: 0.01, ask: 0.02, volume24hUsd: 3_380_443 }), // p 1.5%, conviction 48.5
      row({ id: 'small', bid: 0.91, ask: 0.912, volume24hUsd: 300_300 }), // p 91.1%, conviction 41.1
    ],
    [],
    { nowSec: NOW }
  );
  assert.equal(feed.markets[0].id, 'big', 'volume still ranks the table');
  const decided = mostDecidedMarket(feed.markets);
  assert.equal(decided?.id, 'big');
  assert.ok(Math.abs((decided?.probability ?? 0) - 0.015) < 1e-9, 'the PRICED probability, not 0.5 + conviction');
  assert.ok(Math.abs((decided?.conviction ?? 0) - 0.485) < 1e-9);
});

test('mostDecidedMarket: null when nothing is priced', () => {
  assert.equal(mostDecidedMarket([]), null);
});

test('mostDecidedMarket: conviction is distance from 0.5, so a longshot can beat a favourite', () => {
  const feed = buildRiskFeed(
    [row({ id: 'low', bid: 0.03, ask: 0.032 }), row({ id: 'high', bid: 0.91, ask: 0.912 })],
    [],
    { nowSec: NOW }
  );
  // 3% sits 47 points from a coin flip; 91.1% sits 41.1 — the longshot is the
  // more decided market, and the board must say so rather than assume that a
  // high price means high conviction.
  assert.equal(mostDecidedMarket(feed.markets)?.id, 'low');

  const nearer = buildRiskFeed(
    [row({ id: 'near', bid: 0.55, ask: 0.552 }), row({ id: 'far', bid: 0.97, ask: 0.972 })],
    [],
    { nowSec: NOW }
  );
  assert.equal(mostDecidedMarket(nearer.markets)?.id, 'far');
});
