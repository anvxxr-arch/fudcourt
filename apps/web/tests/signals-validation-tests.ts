/**
 * Signals validation-gate tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (app/(frontend)/api/signals/route.ts):
 *  - the route keeps a route-local validated-payload cache (30s TTL) with
 *    single-flight, so a repeated identical request within the window costs
 *    nothing upstream (X-Cache: HIT) and concurrent identical requests share
 *    one round-trip (X-Cache: COALESCED);
 *  - BEFORE cache admission every 200 body passes a mode-specific shape gate:
 *    scoreboard needs a non-empty `chains` object; index/feed/page need a
 *    `rows` array plus a `counts` object with at least one of them non-empty;
 *  - a malformed-200 (wrong family, non-JSON) or an empty envelope
 *    ({rows: [], counts: {}}) is a loud 502 that is NEVER cached -- the next
 *    identical request retries upstream instead of replaying the failure, and
 *    the normalizer's `rows: [] / counts: {}` defaults can never turn a broken
 *    upstream into a plausible-looking "no signals" board.
 *
 * Usage: cd apps/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '@/app/(frontend)/api/signals/route';

const VALID_ROWS = {
  v: 1,
  kind: 'index',
  chain: 'solana',
  generatedAt: 1791278262,
  counts: { rows: 2 },
  rows: [
    { id: 1, ts: 1, kind: 'vetted', chain: 'solana', mint: 'm1', symbol: 'A', name: 'a', url: 'u', mcap: 10 },
    { id: 2, ts: 2, kind: 'vetted', chain: 'solana', mint: 'm2', symbol: 'B', name: 'b', url: 'u', mcap: 20 },
  ],
};
const VALID_SB = {
  v: 1,
  kind: 'scoreboard',
  generatedAt: 1791267623,
  cohortDays: 3,
  chains: {
    solana: {
      latest: { day: '2026-10-06', n: 1, run: 1, flat: 0, dump: 0, unknown: 0 },
      cohortDays: 3,
      series: [],
      catches: [],
    },
  },
};

type Answer = { status?: number; body?: unknown } | 'refused';
function stubFetch(handler: (url: string) => Answer, counter: { n: number }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    counter.n += 1;
    const ans = handler(u);
    if (ans === 'refused') throw new Error('fetch failed');
    return new Response(JSON.stringify(ans.body), {
      status: ans.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
const req = (type: string, extra = '') =>
  new Request(`https://app.test/api/signals?type=${type}&chain=solana${extra}`);

test('signals: malformed-200 (wrong-family body) is a loud 502, never cached', async () => {
  const counter = { n: 0 };
  const restore = stubFetch(() => ({ status: 200, body: { hello: 'not signals' } }), counter);
  try {
    const r1 = await GET(req('index'));
    assert.equal(r1.status, 502);
    assert.equal(r1.headers.get('X-Cache'), 'MISS');
    const b1 = (await r1.json()) as { error: string };
    assert.match(b1.error, /malformed/);
    // The failure must not be cached: an identical retry hits upstream again.
    const r2 = await GET(req('index'));
    assert.equal(r2.status, 502);
    assert.equal(counter.n, 2);
  } finally {
    restore();
  }
});

test('signals: empty envelope {rows: [], counts: {}} is a loud 502, never cached', async () => {
  const counter = { n: 0 };
  const restore = stubFetch(() => ({ status: 200, body: { rows: [], counts: {} } }), counter);
  try {
    const r1 = await GET(req('index'));
    assert.equal(r1.status, 502);
    const r2 = await GET(req('index'));
    assert.equal(r2.status, 502);
    assert.equal(counter.n, 2);
  } finally {
    restore();
  }
});

test('signals: valid row payload caches; non-JSON 200 is a loud 502', async () => {
  const counter = { n: 0 };
  const original = globalThis.fetch;
  let textMode = false;
  globalThis.fetch = (async () => {
    counter.n += 1;
    if (textMode) return new Response('<html>oops</html>', { status: 200 });
    return new Response(JSON.stringify(VALID_ROWS), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  try {
    const r1 = await GET(req('page', '&n=2'));
    assert.equal(r1.status, 200);
    const b = (await r1.json()) as { rows: unknown[] };
    assert.equal(b.rows.length, 2);
    const r2 = await GET(req('page', '&n=2'));
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('X-Cache'), 'HIT');
    assert.equal(counter.n, 1);
    textMode = true;
    const r3 = await GET(req('feed'));
    assert.equal(r3.status, 502);
  } finally {
    globalThis.fetch = original;
  }
});
test('signals: concurrent identical requests coalesce to one upstream call', async () => {
  const counter = { n: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    counter.n += 1;
    await new Promise((r) => setTimeout(r, 50));
    return new Response(JSON.stringify(VALID_ROWS), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  try {
    const results = await Promise.all([
      GET(req('index')),
      GET(req('index')),
      GET(req('index')),
      GET(req('index')),
      GET(req('index')),
    ]);
    assert.equal(counter.n, 1);
    const headers = results.map((r) => r.headers.get('X-Cache')).sort();
    assert.deepEqual(headers, ['COALESCED', 'COALESCED', 'COALESCED', 'COALESCED', 'MISS']);
    const bodies = await Promise.all(results.map((r) => r.json()));
    for (const b of bodies.slice(1)) assert.deepEqual(b, bodies[0]);
    for (const r of results) assert.equal(r.status, 200);
  } finally {
    globalThis.fetch = original;
  }
});


test('signals: scoreboard without chains is a loud 502; valid scoreboard caches', async () => {
  const counter = { n: 0 };
  let serve: unknown = { v: 1, kind: 'scoreboard', generatedAt: 1, cohortDays: 3 };
  const restore = stubFetch(() => ({ status: 200, body: serve }), counter);
  try {
    const bad = await GET(req('scoreboard'));
    assert.equal(bad.status, 502);
    serve = VALID_SB;
    const r1 = await GET(req('scoreboard'));
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('X-Cache'), 'MISS');
    const r2 = await GET(req('scoreboard'));
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('X-Cache'), 'HIT');
    assert.equal(counter.n, 2);
  } finally {
    restore();
  }
});
