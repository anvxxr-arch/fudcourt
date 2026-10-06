/**
 * Cache-Control header-policy tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (deployed batch):
 *  - app/(frontend)/api/economy/countries/route.ts: the 200 carries
 *    `Cache-Control: public, max-age=3600` (compiled registry, hourly mirror).
 *  - app/(frontend)/api/economy/indicators/route.ts: the 200 carries
 *    `Cache-Control: public, max-age=3600`; the strict 400s (unknown category,
 *    unknown country) carry none.
 *  - app/(frontend)/api/llama/route.ts and app/(frontend)/api/news/route.ts:
 *    thin sidecar proxies. A 200 with no sidecar Cache-Control gains the
 *    mirror default `public, max-age=15` (the sidecar's own 15s TTL); a 200
 *    WITH a sidecar value keeps it verbatim; non-200s (sidecar 400, sidecar
 *    unreachable 502) carry none.
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
import { GET as countriesGET } from '@/app/(frontend)/api/economy/countries/route';
import { GET as indicatorsGET } from '@/app/(frontend)/api/economy/indicators/route';
import { GET as llamaGET } from '@/app/(frontend)/api/llama/route';
import { GET as newsGET } from '@/app/(frontend)/api/news/route';

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
    const res = await llamaGET(llamaReq());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=15');
  } finally {
    restore();
  }
});

test('llama: 200 preserves a sidecar Cache-Control verbatim', async () => {
  const restore = stubSidecar({ status: 200, body: { items: [] }, cacheControl: 'public, max-age=60' });
  try {
    const res = await llamaGET(llamaReq());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  } finally {
    restore();
  }
});

test('llama: sidecar 400 is forwarded headerless', async () => {
  const restore = stubSidecar({ status: 400, body: { error: 'bad mode' } });
  try {
    const res = await llamaGET(llamaReq('?mode=bogus'));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), null);
  } finally {
    restore();
  }
});

test('llama: unreachable sidecar is a headerless 502', async () => {
  const restore = stubSidecar('refused');
  try {
    const res = await llamaGET(llamaReq());
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
    const res = await newsGET(newsReq());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=15');
  } finally {
    restore();
  }
});

test('news: 200 preserves a sidecar Cache-Control verbatim', async () => {
  const restore = stubSidecar({ status: 200, body: { items: [], total: 0 }, cacheControl: 'no-store' });
  try {
    const res = await newsGET(newsReq());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  } finally {
    restore();
  }
});

test('news: sidecar 400 is forwarded headerless', async () => {
  const restore = stubSidecar({ status: 400, body: { error: 'bad source' } });
  try {
    const res = await newsGET(newsReq('?source=bogus'));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), null);
  } finally {
    restore();
  }
});

test('news: unreachable sidecar is a headerless 502', async () => {
  const restore = stubSidecar('refused');
  try {
    const res = await newsGET(newsReq());
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Cache-Control'), null);
  } finally {
    restore();
  }
});
