/**
 * Market route failure contract: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (app/(frontend)/api/market/{stock,commodity,macro}/route.ts):
 *  - `region` is OUR parameter, and only the stock route reads one: a value
 *    outside STOCK_REGIONS is a strict 400 that names the allowed set, never a
 *    clamp to the default region. An EMPTY value is still a value -- `?region=`
 *    is a param the route must reject rather than treat as absent;
 *  - a symbol whose upstream call fails is REPORTED, not dropped: the board is
 *    still a 200, the symbol rides in `failed[]` with its reason, and it is
 *    absent from `quotes` -- so a partial board can never pass for a full one;
 *  - only a board where EVERY symbol failed is a loud 502, and it carries the
 *    whole `failed[]` array rather than a bare error string -- never a fake
 *    empty 200.
 *
 * Every upstream call these routes make goes through `limitedFetch`, which
 * serialises them through one chain with a 200 ms floor, so a full-board test
 * costs roughly 200 ms per symbol (~3 s for the 16-symbol US board). That is
 * the price of driving the real seam instead of a private one, and it keeps the
 * suite honest about the concurrency the route actually runs at.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET as stockGET } from '@/app/(frontend)/api/market/stock/route';
import { GET as commodityGET } from '@/app/(frontend)/api/market/commodity/route';
import { GET as macroGET } from '@/app/(frontend)/api/market/macro/route';
import { STOCK_REGIONS, STOCK_SYMBOLS } from '@/features/market/stock-regions';
import { COMMODITY_SYMBOLS } from '@/features/market/commodity-symbols';
import { MACRO_SYMBOLS, YAHOO_CHART } from '@/features/market/clients';
import { __resetLimiter } from '@/lib/rate-limit';
// ---------------------------------------------------------------------------
// A fetch stub. Every upstream call these routes make goes through
// `limitedFetch`, which composes its own deadline around whatever
// `globalThis.fetch` answers -- so replacing the global reaches all four
// families (Yahoo, BIS, FRED, World Bank) without touching the limiter or the
// routes. The stub answers a real `Response` because `limitedFetch` reads the
// body ONCE and rebuilds an equivalent Response per caller from the text.
// ---------------------------------------------------------------------------
type Stub = { status?: number; body?: unknown };
/** Sentinel: the upstream REFUSES the connection rather than answering. That is
 *  a different failure from a non-200, and the routes report them differently
 *  (`fetch failed: …` versus `upstream <status>`), so both paths stay drivable. */
const REFUSED: unique symbol = Symbol('refused');
type Answer = Stub | typeof REFUSED;
const calls: string[] = [];
function stubFetch(handler: (url: string) => Answer): () => void {
  const original = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const answer = handler(url);
    if (answer === REFUSED) throw new Error('stubbed upstream: connection refused');
    const { status = 200, body } = answer;
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    __resetLimiter();
  };
}
/** A minimal chart envelope `parseChart` accepts: a finite price is the one
 *  field it refuses to invent, so a stub that omits it would be testing the
 *  failure path rather than the success path. */
function chartBody(symbol: string, price: number): unknown {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: price,
            chartPreviousClose: price - 1,
            symbol,
            longName: `${symbol} stub`,
            exchangeName: 'STUB',
            currency: 'USD',
          },
          indicators: { quote: [{ close: [price - 1, price] }] },
        },
      ],
    },
  };
}
/** `createFetchPool` logs every non-ok upstream, which is right in production
 *  and noise in a test whose whole point is that every call fails. */
function silenceConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}
const symbolsOf = (failed: { symbol: string }[]) => failed.map((f) => f.symbol);
// ---------------------------------------------------------------------------
// The region guard (stock only — the other two routes read no params)
// ---------------------------------------------------------------------------
test('market stock: a region outside STOCK_REGIONS is a 400 naming the allowed set, never a clamp', async () => {
  __resetLimiter();
  const res = await stockGET(new Request('http://localhost/api/market/stock?region=bogus'));
  assert.equal(res.status, 400, 'a bogus region is a client error, not a defaulted board');
  const body = await res.json();
  assert.equal(body.error, 'invalid region');
  assert.ok(
    STOCK_REGIONS.every((r) => String(body.detail).includes(r)),
    'the detail must name every region the route will actually serve'
  );
  assert.equal(calls.length, 0, 'a rejected param must not reach the upstream at all');
});
test('market stock: an empty region param is a param, not an absent one', async () => {
  __resetLimiter();
  const res = await stockGET(new Request('http://localhost/api/market/stock?region='));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid region');
  assert.equal(calls.length, 0);
});
// ---------------------------------------------------------------------------
// The all-fail 502 — the loud refusal, never a fake empty 200
// ---------------------------------------------------------------------------
test('market stock: every symbol failing is a 502 carrying the whole failed array', async () => {
  const restore = stubFetch(() => REFUSED);
  try {
    const res = await stockGET(new Request('http://localhost/api/market/stock?region=us'));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'no quotes returned');
    assert.equal(body.failed.length, STOCK_SYMBOLS.us.length, 'every symbol must be named, none dropped');
    assert.deepEqual(symbolsOf(body.failed), [...STOCK_SYMBOLS.us], 'input order, one entry per symbol');
    for (const f of body.failed) assert.match(f.reason, /^fetch failed: /, 'a refused connection is reported as a fetch failure');
    assert.equal(calls.length, STOCK_SYMBOLS.us.length, 'one upstream call per symbol, no batch endpoint');
  } finally {
    restore();
  }
});
test('market commodity: every symbol failing is a 502 carrying the whole failed array', async () => {
  const restore = stubFetch(() => REFUSED);
  try {
    const res = await commodityGET();
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'no quotes returned');
    assert.equal(body.failed.length, COMMODITY_SYMBOLS.length, 'every symbol must be named, none dropped');
    assert.deepEqual(symbolsOf(body.failed), [...COMMODITY_SYMBOLS], 'input order, one entry per symbol');
    for (const f of body.failed) assert.match(f.reason, /^fetch failed: /);
    assert.equal(calls.length, COMMODITY_SYMBOLS.length, 'one upstream call per symbol, no batch endpoint');
  } finally {
    restore();
  }
});
test('market macro: every quote failing is a 502, and the other families report their own failures', async () => {
  const restore = stubFetch(() => REFUSED);
  const quiet = silenceConsoleError();
  try {
    const res = await macroGET();
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'no quotes returned');
    assert.ok(
      String(body.detail).includes(`all ${MACRO_SYMBOLS.length} quote symbols failed`),
      'the detail counts the quote block, which is the board\'s spine'
    );
    const named = new Set(symbolsOf(body.failed));
    for (const s of MACRO_SYMBOLS) assert.ok(named.has(s), `${s} must be named in failed[]`);
    // The macro board is four upstreams, and a total quote failure does not
    // excuse the other three from reporting: the client is told which families
    // are dark, not just that the board is.
    assert.ok(named.has('BIS:WS_CBPOL'), 'the policy-rate family reports its own failure');
    assert.ok([...named].some((s) => s.startsWith('FRED:')), 'the FRED family reports its own failure');
    assert.ok([...named].some((s) => s.startsWith('WB:')), 'the World Bank family reports its own failure');
    assert.ok(body.failed.length > MACRO_SYMBOLS.length, 'a total quote failure still reports the other families');
  } finally {
    quiet();
    restore();
  }
});
// ---------------------------------------------------------------------------
// The partial board — a 200 that admits what it is missing
// ---------------------------------------------------------------------------
test('market stock: one symbol failing is a 200 with that symbol named in failed[]', async () => {
  const symbols = STOCK_SYMBOLS.us;
  const broken = symbols[0];
  const restore = stubFetch((url) => {
    const symbol = decodeURIComponent(url.slice(YAHOO_CHART.length + 1).split('?')[0]);
    if (symbol === broken) return REFUSED;
    return { body: chartBody(symbol, 100 + symbol.length) };
  });
  try {
    const res = await stockGET(new Request('http://localhost/api/market/stock'));
    assert.equal(res.status, 200, 'a partial board is a success that admits its gap, not an error');
    const body = await res.json();
    assert.equal(body.region, 'us', 'a bare request serves the default region');
    assert.equal(body.count, symbols.length - 1);
    assert.equal(body.quotes.length, symbols.length - 1);
    assert.equal(body.failed.length, 1, 'exactly the one symbol that failed');
    assert.equal(body.failed[0].symbol, broken);
    assert.match(body.failed[0].reason, /^fetch failed: /);
    assert.ok(
      !body.quotes.some((q: { symbol: string }) => q.symbol === broken),
      'a failed symbol must not also appear as a quote'
    );
    assert.equal(calls.length, symbols.length, 'one upstream call per symbol, no batch endpoint');
  } finally {
    restore();
  }
});
