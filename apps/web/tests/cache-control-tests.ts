/**
 * Cache-Control header-policy tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (deployed batch):
 *  - app/(frontend)/api/economy/countries/route.ts: the 200 carries
 *    `Cache-Control: public, max-age=3600` (compiled registry, hourly mirror).
 *  - app/(frontend)/api/economy/indicators/route.ts: the 200 carries
 *    `Cache-Control: public, max-age=3600`; the strict 400s (unknown category,
 *    unknown country) carry none.
 *  - the collapsed gateway app/(frontend)/api/[...path]/route.ts serves the
 *    llama and news families (ADR-006). A 200 with no sidecar Cache-Control
 *    gains the mirror default `public, max-age=15` (the sidecar's own 15s
 *    TTL); a 200 WITH a sidecar value keeps it verbatim; non-200s (sidecar
 *    400, sidecar unreachable 502) carry none.
 *
 * The proxy seam is `globalThis.fetch`, which both routes call directly, so a
 * stubbed global drives every path without touching the routes. The stub
 * answers a real `Response` because the routes read status, headers and text.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GET as countriesGET } from '@/app/(frontend)/api/economy/countries/route';
import { GET as indicatorsGET } from '@/app/(frontend)/api/economy/indicators/route';
import { GET as gatewayGET } from '@/app/(frontend)/api/[...path]/route';

// ---------------------------------------------------------------------------
// Sidecar fetch stub for the llama/news proxies.
// ---------------------------------------------------------------------------
type SidecarAnswer = { status?: number; body?: unknown; cacheControl?: string };
function stubSidecar(answer: SidecarAnswer | 'refused'): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (answer === 'refused') throw new Error('stubbed sidecar: connection refused');
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (answer.cacheControl !== undefined) headers.set('Cache-Control', answer.cacheControl);
    return new Response(JSON.stringify(answer.body ?? { ok: true }), {
      status: answer.status ?? 200,
      headers,
    });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const llamaReq = (qs = '?mode=chains') => new NextRequest(`https://app.test/api/llama${qs}`);
const newsReq = (qs = '?source=cointelegraph') => new NextRequest(`https://app.test/api/news${qs}`);

// ---------------------------------------------------------------------------
// The converted public reads answer through `publicJson`, so the value is
// `public, max-age=<that route's own in-process TTL>` plus the shared window.
// The regex asserts WHICH constant each route passes: the number a changed TTL
// must move. Routes that are gated are asserted to never use it at all.
// ---------------------------------------------------------------------------
const PUBLIC_TTL_ROUTES: [string, RegExp][] = [
  ['markets/route.ts', /MARKETS_TTL_MS \/ 1000/],
  ['economy/regime/route.ts', /REGIME_TTL_SECONDS/],
  ['economy/liquidity/route.ts', /LIQUIDITY_TTL_SECONDS/],
  ['economy/calendar/route.ts', /CALENDAR_TTL_SECONDS/],
  ['market/macro/route.ts', /MACRO_TTL_MS \/ 1000/],
  ['market/stock/route.ts', /STOCK_TTL_MS \/ 1000/],
  ['market/commodity/route.ts', /COMMODITY_TTL_MS \/ 1000/],
  ['market/forex/route.ts', /FOREX_TTL_MS \/ 1000/],
  ['market/indonesia/route.ts', /IDR_QUOTE_TTL_MS \/ 1000/],
];
test('api: every converted read pins its own TTL and stays public', () => {
  for (const [route, ttlPattern] of PUBLIC_TTL_ROUTES) {
    const src = readFileSync(path.join(process.cwd(), 'src', 'app', '(frontend)', 'api', route), 'utf8');
    assert.ok(src.includes('publicJson'), `${route} must answer through publicJson`);
    assert.ok(ttlPattern.test(src), `${route} must pass its own TTL`);
    assert.equal(/private, no-store/.test(src), false, `${route} is public and must not be no-store`);
  }
});
test('api: dex and signals carry the header inline on every success return', () => {
  // These two build the header on a shared object rather than through the
  // helper: dex writes five success bodies each with a per-request `X-Cache`,
  // and signals has three (HIT / COALESCED / MISS). What matters is the same
  // value, so it is asserted from the source that produces it.
  const dex = readFileSync(path.join(process.cwd(), 'src', 'app', '(frontend)', 'api', 'dex', 'route.ts'), 'utf8');
  assert.ok(dex.includes("public, max-age=${DEX_TTL_SECONDS}"), 'dex cacheHeaders carries public max-age');
  assert.ok(dex.includes('const DEX_TTL_SECONDS = 15;'), 'dex TTL mirrors the 15s limiter memo');
  const signals = readFileSync(path.join(process.cwd(), 'src', 'app', '(frontend)', 'api', 'signals', 'route.ts'), 'utf8');
  assert.ok(signals.includes('public, max-age=${VALID_TTL_MS / 1000}'), 'signals cacheControl carries public max-age');
  assert.equal(signals.match(/\.\.\.cacheControl/g)?.length, 3, 'all three signals success paths carry it');
});
test('api: the proof read is public over the 300s sync window', () => {
  const src = readFileSync(path.join(process.cwd(), 'src', 'app', '(frontend)', 'api', 'proof', 'route.ts'), 'utf8');
  assert.ok(src.includes('publicJson(await treasuryProof(), PROOF_TTL_SECONDS)'));
  assert.ok(src.includes('const PROOF_TTL_SECONDS = 300;'));
});
test('api: the gated reads are never public-cached', () => {
  // `/api/all` and friends short-circuit in `@/server/auth` before the handler,
  // so their `private, no-store` is set once in `src/middleware.ts` (asserted in
  // server-cache-tests.ts) rather than copied into each route file.
  for (const route of ['all', 'wallets', 'coins', 'pnl', 'plans', 'journal', 'treasury']) {
    const src = readFileSync(path.join(process.cwd(), 'src', 'app', '(frontend)', 'api', route, 'route.ts'), 'utf8');
    assert.equal(src.includes('publicJson'), false, `${route} is gated and must never be public-cached`);
  }
});

// ---------------------------------------------------------------------------
// countries: 200 carries the hourly mirror header.
// ---------------------------------------------------------------------------
test('countries: 200 carries public, max-age=3600', async () => {
  const res = await countriesGET();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=3600');
  const body = await res.json();
  assert.ok(Array.isArray(body.countries) && body.countries.length > 0);
});

// ---------------------------------------------------------------------------
// indicators: 200 carries the header; strict 400s are headerless.
// ---------------------------------------------------------------------------
test('indicators: 200 carries public, max-age=3600', async () => {
  const res = await indicatorsGET(new Request('https://app.test/api/economy/indicators'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=3600');
});

test('indicators: unknown category is a headerless 400', async () => {
  const res = await indicatorsGET(new Request('https://app.test/api/economy/indicators?category=nope'));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Cache-Control'), null);
});

test('indicators: unknown country is a headerless 400', async () => {
  const res = await indicatorsGET(new Request('https://app.test/api/economy/indicators?country=XXX'));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Cache-Control'), null);
});

// ---------------------------------------------------------------------------
// llama: 200 default / verbatim preserve / non-200 headerless.
// ---------------------------------------------------------------------------
test('llama: 200 without sidecar Cache-Control gains public, max-age=15', async () => {
  const restore = stubSidecar({ status: 200, body: { items: [] } });
  try {
    const res = await gatewayGET(llamaReq());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=15');
  } finally {
    restore();
  }
});

test('llama: 200 preserves a sidecar Cache-Control verbatim', async () => {
  const restore = stubSidecar({ status: 200, body: { items: [] }, cacheControl: 'public, max-age=60' });
  try {
    const res = await gatewayGET(llamaReq());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  } finally {
    restore();
  }
});

test('llama: sidecar 400 is forwarded headerless', async () => {
  const restore = stubSidecar({ status: 400, body: { error: 'bad mode' } });
  try {
    const res = await gatewayGET(llamaReq('?mode=bogus'));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), null);
  } finally {
    restore();
  }
});

test('llama: unreachable sidecar is a headerless 502', async () => {
  const restore = stubSidecar('refused');
  try {
    const res = await gatewayGET(llamaReq());
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Cache-Control'), null);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// news: 200 default / verbatim preserve / non-200 headerless.
// ---------------------------------------------------------------------------
test('news: 200 without sidecar Cache-Control gains public, max-age=15', async () => {
  const restore = stubSidecar({ status: 200, body: { items: [], total: 0 } });
  try {
    const res = await gatewayGET(newsReq());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=15');
  } finally {
    restore();
  }
});

test('news: 200 preserves a sidecar Cache-Control verbatim', async () => {
  const restore = stubSidecar({ status: 200, body: { items: [], total: 0 }, cacheControl: 'no-store' });
  try {
    const res = await gatewayGET(newsReq());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  } finally {
    restore();
  }
});

test('news: sidecar 400 is forwarded headerless', async () => {
  const restore = stubSidecar({ status: 400, body: { error: 'bad source' } });
  try {
    const res = await gatewayGET(newsReq('?source=bogus'));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), null);
  } finally {
    restore();
  }
});

test('news: unreachable sidecar is a headerless 502', async () => {
  const restore = stubSidecar('refused');
  try {
    const res = await gatewayGET(newsReq());
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Cache-Control'), null);
  } finally {
    restore();
  }
});
