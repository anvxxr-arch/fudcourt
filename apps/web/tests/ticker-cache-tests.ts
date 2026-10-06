/**
 * Ticker route-cache tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test:
 *  - app/(frontend)/api/ticker/instrument/route.ts keeps a route-local
 *    validated-payload cache (TICKER_TTL_MS) with single-flight, keyed by the
 *    normalized query string (base x type x expiry x strike x kind). A repeated
 *    identical request within the window costs nothing upstream (X-Cache: HIT)
 *    and concurrent identical requests share one round-trip (X-Cache:
 *    COALESCED). BEFORE cache admission every 200 body passes
 *    isValidInstrumentBody: priced > 0 with at least one finite-last quote —
 *    an all-venue outage is a loud 502 that is NEVER cached, so the next
 *    identical request retries upstream instead of replaying the failure.
 *  - app/(frontend)/api/ticker/instruments/route.ts keeps the same shape of
 *    cache keyed by normalized symbol. BEFORE admission every 200 body passes
 *    isValidInstrumentsBody: at least one populated venue/type — an empty
 *    listing is a loud 502 that is NEVER cached.
 *  - features/market/ticker/venues runSweep() is the single-flight gate for
 *    the venue sweep: concurrent callers share one underlying execution, the
 *    gate clears on settle (a post-sweep caller starts fresh), and a failure
 *    clears the gate (the next caller retries upstream).
 *
 * The routes read CCXT, not fetch, so there is no fetch to stub: the tests
 * replace the venues module's tickerClients()/ensureMarkets() with fakes that
 * serve canned markets and tickers and count upstream calls. The fakes are
 * restored after every test. runSweep takes its work as a callback, so its
 * tests pass plain async functions — no venue stubbing needed there (the L2
 * it writes through is fail-open and a no-op with no Valkey URL).
 *
 * Each test uses its own base/symbol so the route-local caches shared across
 * tests in this file never turn one test's MISS into another's HIT.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test, mock } from 'bun:test';
import assert from 'node:assert/strict';
import { GET as instrumentGET } from '@/app/(frontend)/api/ticker/instrument/route';
import { GET as instrumentsGET } from '@/app/(frontend)/api/ticker/instruments/route';
import { runSweep } from '@/features/market/ticker/venues';
import * as venuesModule from '@/features/market/ticker/venues';
import {
  TICKER_EXCHANGES,
  venuesForType,
  type TickerExchange,
  type TickerRow,
} from '@/features/market/ticker/client';

// ---------------------------------------------------------------------------
// The CCXT stub. Every upstream call the two routes make goes through
// tickerClients() (client handles) and ensureMarkets() (market lists), so
// replacing both module members reaches every venue without touching the
// routes. Markets are minimal spot listings; fetchTicker prices whatever base
// the price function answers and throws for the rest (an unpriceable venue).
// ---------------------------------------------------------------------------
type FakeMarkets = Record<string, Record<string, unknown>>;

function spotMarkets(bases: readonly string[]): FakeMarkets {
  const out: FakeMarkets = {};
  for (const base of bases) {
    out[`${base}/USDT`] = {
      active: true,
      spot: true,
      base,
      quote: 'USDT',
      settle: 'USDT',
      expiry: undefined,
      strike: undefined,
      contractSize: 1,
    };
  }
  return out;
}

const upstream = { load: 0, tick: 0 };

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function stubVenues(opts: {
  bases: readonly string[];
  price: (base: string) => number | null;
  delayMs?: number;
}): () => void {
  const markets = spotMarkets(opts.bases);
  type FakeClient = { markets: FakeMarkets; fetchTicker: (symbol: string) => Promise<unknown> };
  const clients = {} as Record<TickerExchange, FakeClient>;
  for (const venue of TICKER_EXCHANGES) {
    clients[venue] = {
      markets,
      fetchTicker: async (symbol: string): Promise<unknown> => {
        upstream.tick += 1;
        if (opts.delayMs) await delay(opts.delayMs);
        const base = symbol.split('/')[0] ?? '';
        const last = opts.price(base);
        if (last === null) throw new Error('no price returned');
        return {
          last,
          bid: last,
          ask: last,
          high: last,
          low: last,
          baseVolume: 1,
          quoteVolume: last,
          percentage: 0,
          timestamp: 1,
        };
      },
    };
  }
  const fakes = new Map<TickerExchange, FakeClient>(
    (Object.keys(clients) as TickerExchange[]).map((v) => [v, clients[v]]),
  );
  upstream.load = 0;
  upstream.tick = 0;
  // The suites run from TypeScript source under `bun test`, whose ESM namespace
  // objects are frozen — the compiled-CJS monkeypatch this file used before
  // (assigning into the module object the routes close over) is not available.
  // Bun's module mock is the equivalent seam: it replaces the two functions for
  // every importer, including the route modules, and `mock.restore()` puts the
  // real ones back. The rest of the module is spread through untouched, so
  // runSweep and the sweep cache keep their real identities.
  mock.module('@/features/market/ticker/venues', () => ({
    ...venuesModule,
    tickerClients: () => fakes as unknown as Map<TickerExchange, never>,
    ensureMarkets: async (_venue: TickerExchange): Promise<unknown> => {
      upstream.load += 1;
      return fakes.get(_venue)?.markets ?? null;
    },
  }));
  return () => {
    mock.restore();
  };
}

/** Deterministic distinct price per base, so key-collision tests can tell bodies apart. */
const priceFor = (base: string): number | null => base.charCodeAt(0) * 1000;

const ireq = (base: string, type = 'spot', extra = '') =>
  new Request(`https://app.test/api/ticker/instrument?base=${base}&type=${type}${extra}`);
const sreq = (symbol: string) =>
  new Request(`https://app.test/api/ticker/instruments?symbol=${encodeURIComponent(symbol)}`);

type InstrumentBody = { priced: number; price: number | null; quotes: unknown[]; base: string };

// ---------------------------------------------------------------------------
// instrument route: valid MISS -> HIT
// ---------------------------------------------------------------------------
test('instrument: valid MISS then HIT; the second identical request costs nothing upstream', async () => {
  const restore = stubVenues({ bases: ['BTC'], price: priceFor });
  try {
    const r1 = await instrumentGET(ireq('BTC'));
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('X-Cache'), 'MISS');
    const b1 = (await r1.json()) as InstrumentBody;
    assert.ok(b1.priced > 0);
    assert.equal(b1.price, priceFor('BTC'));
    const afterFirst = { ...upstream };

    const r2 = await instrumentGET(ireq('BTC'));
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('X-Cache'), 'HIT');
    const b2 = (await r2.json()) as InstrumentBody;
    assert.deepEqual(b2, b1);
    assert.deepEqual({ ...upstream }, afterFirst);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// instrument route: concurrent single-flight
// ---------------------------------------------------------------------------
test('instrument: N concurrent identical requests share one upstream execution', async () => {
  const restore = stubVenues({ bases: ['ETH'], price: priceFor, delayMs: 40 });
  try {
    const results = await Promise.all([
      instrumentGET(ireq('ETH')),
      instrumentGET(ireq('ETH')),
      instrumentGET(ireq('ETH')),
      instrumentGET(ireq('ETH')),
      instrumentGET(ireq('ETH')),
    ]);
    for (const r of results) assert.equal(r.status, 200);
    const headers = results.map((r) => r.headers.get('X-Cache')).sort();
    assert.deepEqual(headers, ['COALESCED', 'COALESCED', 'COALESCED', 'COALESCED', 'MISS']);
    const bodies = await Promise.all(results.map((r) => r.json()));
    for (const b of bodies.slice(1)) assert.deepEqual(b, bodies[0]);
    // One fetchTicker per spot venue for the single shared execution — and the
    // settled run is now cached, so a follow-up is a free HIT.
    assert.equal(upstream.tick, venuesForType('spot').length);
    const r = await instrumentGET(ireq('ETH'));
    assert.equal(r.headers.get('X-Cache'), 'HIT');
    assert.equal(upstream.tick, venuesForType('spot').length);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// instrument route: all-venue outage is a loud uncached 502
// ---------------------------------------------------------------------------
test('instrument: all-venue outage is a 502 that is never cached', async () => {
  const restore = stubVenues({ bases: ['SOL'], price: () => null });
  try {
    const r1 = await instrumentGET(ireq('SOL'));
    assert.equal(r1.status, 502);
    assert.equal(r1.headers.get('X-Cache'), 'MISS');
    const b1 = (await r1.json()) as { error: string };
    assert.match(b1.error, /malformed/);
    // The failure must not be cached: an identical retry hits upstream again.
    const before = { ...upstream };
    const r2 = await instrumentGET(ireq('SOL'));
    assert.equal(r2.status, 502);
    assert.ok(upstream.tick > before.tick);
    assert.ok(upstream.load > before.load);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// instrument route: distinct normalized keys do not collide
// ---------------------------------------------------------------------------
test('instrument: distinct normalized keys do not collide; case folds to one key', async () => {
  const restore = stubVenues({ bases: ['AVAX', 'LINK'], price: priceFor });
  try {
    const ra = await instrumentGET(ireq('AVAX'));
    assert.equal(ra.status, 200);
    const ba = (await ra.json()) as InstrumentBody;
    const rl = await instrumentGET(ireq('LINK'));
    assert.equal(rl.status, 200);
    const bl = (await rl.json()) as InstrumentBody;
    // Two keys, two upstream executions, two different bodies.
    assert.equal(ba.base, 'AVAX');
    assert.equal(bl.base, 'LINK');
    assert.notDeepEqual(bl, ba);
    assert.equal(bl.price, priceFor('LINK'));
    // Normalization: lowercase is the same key, served from cache for free.
    const before = { ...upstream };
    const rc = await instrumentGET(ireq('avax'));
    assert.equal(rc.status, 200);
    assert.equal(rc.headers.get('X-Cache'), 'HIT');
    assert.deepEqual((await rc.json()) as InstrumentBody, ba);
    assert.deepEqual({ ...upstream }, before);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// instruments route: valid MISS -> HIT
// ---------------------------------------------------------------------------
test('instruments: valid listing MISS then HIT; the repeat costs nothing upstream', async () => {
  const restore = stubVenues({ bases: ['BTC'], price: priceFor });
  try {
    const r1 = await instrumentsGET(sreq('BTC/USDT'));
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('X-Cache'), 'MISS');
    const afterFirst = { ...upstream };
    const r2 = await instrumentsGET(sreq('BTC/USDT'));
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('X-Cache'), 'HIT');
    assert.deepEqual((await r2.json()) as unknown, (await r1.json()) as unknown);
    assert.deepEqual({ ...upstream }, afterFirst);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// instruments route: concurrent single-flight
// ---------------------------------------------------------------------------
test('instruments: N concurrent identical requests coalesce to one upstream run', async () => {
  const restore = stubVenues({ bases: ['ETH'], price: priceFor, delayMs: 40 });
  try {
    const results = await Promise.all([
      instrumentsGET(sreq('ETH/USDT')),
      instrumentsGET(sreq('ETH/USDT')),
      instrumentsGET(sreq('ETH/USDT')),
      instrumentsGET(sreq('ETH/USDT')),
      instrumentsGET(sreq('ETH/USDT')),
    ]);
    for (const r of results) assert.equal(r.status, 200);
    const headers = results.map((r) => r.headers.get('X-Cache')).sort();
    assert.deepEqual(headers, ['COALESCED', 'COALESCED', 'COALESCED', 'COALESCED', 'MISS']);
    const bodies = await Promise.all(results.map((r) => r.json()));
    for (const b of bodies.slice(1)) assert.deepEqual(b, bodies[0]);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// instruments route: empty listing is a loud uncached 502
// ---------------------------------------------------------------------------
test('instruments: empty listing is a 502 that is never cached; recovery serves 200', async () => {
  // SOL is absent from the stubbed markets, so its listing is empty.
  const restore = stubVenues({ bases: ['BTC'], price: priceFor });
  try {
    const r1 = await instrumentsGET(sreq('SOL/USDT'));
    assert.equal(r1.status, 502);
    assert.equal(r1.headers.get('X-Cache'), 'MISS');
    const before = { ...upstream };
    const r2 = await instrumentsGET(sreq('SOL/USDT'));
    assert.equal(r2.status, 502);
    assert.ok(upstream.load > before.load);
  } finally {
    restore();
  }
  // The 502 left nothing behind: once the venue lists SOL, the same key 200s.
  const restore2 = stubVenues({ bases: ['SOL'], price: priceFor });
  try {
    const r3 = await instrumentsGET(sreq('SOL/USDT'));
    assert.equal(r3.status, 200);
    assert.equal(r3.headers.get('X-Cache'), 'MISS');
  } finally {
    restore2();
  }
});

// ---------------------------------------------------------------------------
// instruments route: distinct symbols do not collide
// ---------------------------------------------------------------------------
test('instruments: distinct symbols do not collide', async () => {
  const restore = stubVenues({ bases: ['AVAX', 'LINK'], price: priceFor });
  try {
    const ra = await instrumentsGET(sreq('AVAX/USDT'));
    assert.equal(ra.status, 200);
    const rl = await instrumentsGET(sreq('LINK/USDT'));
    assert.equal(rl.status, 200);
    const ba = (await ra.json()) as { symbol: string };
    const bl = (await rl.json()) as { symbol: string };
    assert.equal(ba.symbol, 'AVAX/USDT');
    assert.equal(bl.symbol, 'LINK/USDT');
    assert.notDeepEqual(bl, ba);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// runSweep single-flight
// ---------------------------------------------------------------------------
function sweepRows(tag: string): TickerRow[] {
  return [{ symbol: 'BTC/USDT', base: 'BTC', tag } as unknown as TickerRow];
}

test('runSweep: N concurrent callers share one underlying execution', async () => {
  let runs = 0;
  const run = async (): Promise<TickerRow[]> => {
    runs += 1;
    await delay(40);
    return sweepRows('shared');
  };
  const results = await Promise.all([runSweep(run), runSweep(run), runSweep(run), runSweep(run)]);
  assert.equal(runs, 1);
  for (const rows of results.slice(1)) assert.deepEqual(rows, results[0]);
  assert.deepEqual(results[0], sweepRows('shared'));
});

test('runSweep: gate clears on settle; a post-sweep caller starts fresh', async () => {
  let runs = 0;
  const run = async (): Promise<TickerRow[]> => {
    runs += 1;
    return sweepRows(`run-${runs}`);
  };
  const first = await runSweep(run);
  assert.equal(runs, 1);
  const second = await runSweep(run);
  assert.equal(runs, 2);
  assert.deepEqual(first, sweepRows('run-1'));
  assert.deepEqual(second, sweepRows('run-2'));
});

test('runSweep: failure clears the gate; the next caller retries upstream', async () => {
  let runs = 0;
  const failing = async (): Promise<TickerRow[]> => {
    runs += 1;
    await delay(20);
    throw new Error('venue down');
  };
  await assert.rejects(Promise.all([runSweep(failing), runSweep(failing), runSweep(failing)]));
  assert.equal(runs, 1);
  // The failed sweep pinned nothing: the retry runs upstream again and succeeds.
  const ok = async (): Promise<TickerRow[]> => {
    runs += 1;
    return sweepRows('recovered');
  };
  const rows = await runSweep(ok);
  assert.equal(runs, 2);
  assert.deepEqual(rows, sweepRows('recovered'));
});
