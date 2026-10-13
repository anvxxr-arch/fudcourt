/**
 * Gateway forwarding tests for the `data` family (the `/api/data/*` surface).
 *
 * REGRESSION GUARD for the subpath-drop bug: until 2026-10-12 the gateway built
 * its upstream as `${DATA_URL}/api/${family}` and threw the path remainder
 * away, so `/api/data/metrics?series_id=x` reached `:3101/api/data` and
 * answered the 404 envelope instead of the metric rows. Every `/api/data/*`
 * sub-path except the dedicated `/api/data/news` route was unreachable through
 * the web tier.
 *
 * These tests read the WHOLE gateway (`@/app/(frontend)/api/[...path]/route`)
 * with `fetch` stubbed, so they assert the exact upstream URL the production
 * code builds — the thing the fix changed — and the allowlist that keeps the
 * operator-only (`runs`, `health`) and mutating (`ingest`) segments off the
 * public edge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET as gatewayGET } from '@/app/(frontend)/api/[...path]/route';

/** Stub fetch and capture every upstream URL the gateway requests. */
function captureFetch(): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

const req = (path: string) => new NextRequest(`https://app.test${path}`);

test('gateway: /api/data sub-paths are forwarded WITH their remainder', async () => {
  const cases = [
    ['/api/data/metrics?series_id=s1&limit=10', '/api/data/metrics?series_id=s1&limit=10'],
    ['/api/data/ohlcv?instrument=i&venue=v&timeframe=1d', '/api/data/ohlcv?instrument=i&venue=v&timeframe=1d'],
    ['/api/data/charts/index?domain=market', '/api/data/charts/index?domain=market'],
    ['/api/data/timeseries?series_id=s1', '/api/data/timeseries?series_id=s1'],
    ['/api/data/news?limit=2', '/api/data/news?limit=2'],
    ['/api/data/series', '/api/data/series'],
  ];
  for (const [path, wantUpstreamSuffix] of cases) {
    const { urls, restore } = captureFetch();
    try {
      const res = await gatewayGET(req(path));
      assert.equal(res.status, 200, `${path} status`);
      assert.equal(urls.length, 1, `${path} made ${urls.length} upstream calls`);
      // The upstream base is configurable; assert the PATH+QUERY the gateway
      // built, which is the part the fix owns.
      assert.ok(
        urls[0].endsWith(wantUpstreamSuffix),
        `${path} upstream = ${urls[0]}, want suffix ${wantUpstreamSuffix}`,
      );
    } finally {
      restore();
    }
  }
});

test('gateway: operator-only and mutating /api/data segments are refused, never forwarded', async () => {
  for (const path of ['/api/data/runs', '/api/data/ingest/run', '/api/data/health']) {
    const { urls, restore } = captureFetch();
    try {
      const res = await gatewayGET(req(path));
      assert.equal(res.status, 404, `${path} must be a gateway 404`);
      assert.equal(urls.length, 0, `${path} must NOT reach the sidecar (made ${urls.length} calls)`);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, 'not_found');
    } finally {
      restore();
    }
  }
});

test('gateway: the legacy bare-family forwards are unchanged', async () => {
  const cases = [
    ['/api/llama?mode=chains', '/api/llama?mode=chains'],
    ['/api/news?source=cointelegraph', '/api/news?source=cointelegraph'],
    ['/api/cryptorank?mode=home', '/api/cryptorank?mode=home'],
  ];
  for (const [path, want] of cases) {
    const { urls, restore } = captureFetch();
    try {
      const res = await gatewayGET(req(path));
      assert.equal(res.status, 200, `${path} status`);
      assert.ok(urls[0].endsWith(want), `${path} upstream = ${urls[0]}`);
    } finally {
      restore();
    }
  }
});

test('gateway: a data 502 names the real reason and omits a selector kind', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3101'); }) as unknown as typeof fetch;
  try {
    const res = await gatewayGET(req('/api/data/metrics?series_id=s1'));
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error?: string; kind?: unknown };
    assert.match(body.error ?? '', /unreachable/);
    // `data` has no selector, so `kind` must be OMITTED, not sent as null.
    assert.equal('kind' in body, false, 'data family must not carry a selector kind');
  } finally {
    globalThis.fetch = original;
  }
});
