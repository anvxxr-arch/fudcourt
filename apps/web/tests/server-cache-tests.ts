/**
 * Server-cache cutover tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (the static/ISR split and the public API cache header):
 *  - EVERY public board page under `(public)` is time-revalidated
 *    (`revalidate = 300`) instead of request-rendered (`force-dynamic`), EXCEPT
 *    the four that provably render per-request state. The exception list is
 *    asserted by name, so a page that quietly grows a `cookies()` read and gets
 *    converted anyway fails here rather than shipping a cached shell that bakes
 *    in one visitor's session.
 *  - the boards themselves have NO server-side data fetch (they mount the
 *    client `StoreShell`, whose data arrives over `/api/*`), which is what makes
 *    the 300s shell honest: nothing in the shell can go stale.
 *  - the public API reads carry `public, max-age=<their own in-process TTL>`
 *    and the auth-gated ones carry `private, no-store`, so the edge can never
 *    replay a tier verdict.
 *
 * The `publicJson`/`noStoreJson` helpers are pinned directly because that value
 * is the one thing every converted route has in common; the per-route TTLs are
 * asserted as literals so a changed constant has to be a deliberate test edit.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { publicJson, noStoreJson } from '@/app/(frontend)/api/_lib/http';
import config from '@/../next.config.js';

const PUBLIC_DIR = path.join(process.cwd(), 'src', 'app', '(frontend)', '(public)');

/** Every `page.tsx` under `(public)`, as its URL-relative path. */
function boardPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string, url: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${url}/${entry.name}`);
      } else if (entry.name === 'page.tsx') {
        out.push(url === '' ? '/' : url);
      }
    }
  };
  walk(PUBLIC_DIR, '');
  return out.sort();
}

/** The source of the page that serves `url`. */
function pageSource(url: string): string {
  const file = url === '/' ? path.join(PUBLIC_DIR, 'page.tsx') : path.join(PUBLIC_DIR, `${url.slice(1)}/page.tsx`);
  return readFileSync(file, 'utf8');
}

/**
 * The pages that MUST stay request-time, each for a reason the render shows:
 *  - `/login`      reads `searchParams` (`?next=`, `?error=`);
 *  - `/member`     reads the session and prints the signed-in user's name;
 *  - `/trade/accounts`  is the connected-venue surface (per-account key data);
 *  - `/`           reads the session to pick the landing CTA.
 * Any OTHER page converting back to `force-dynamic` is a regression.
 */
const REQUEST_TIME_PAGES = ['/', '/login', '/member', '/trade/accounts'];

test('pages: every public board is time-revalidated, only the four named pages stay dynamic', () => {
  const pages = boardPages();
  assert.ok(pages.length >= 40, `expected the full board set, saw ${pages.length}`);
  for (const url of pages) {
    const src = pageSource(url);
    const dynamic = src.includes("export const dynamic = 'force-dynamic'");
    const revalidate = src.match(/export const revalidate = (\d+);/)?.[1];
    if (REQUEST_TIME_PAGES.includes(url)) {
      assert.equal(dynamic, true, `${url} must stay force-dynamic`);
      assert.equal(revalidate, '0', `${url} must stay revalidate = 0`);
    } else {
      assert.equal(dynamic, false, `${url} must not be force-dynamic`);
      assert.equal(revalidate, '300', `${url} must declare revalidate = 300`);
    }
  }
});

test('pages: each request-time page carries the reason it is request-time', () => {
  // The reason is a comment beside the export, which is the only place a future
  // reader looks before "fixing" the exception away.
  for (const [url, needle] of [
    ['/', 'cookies()'],
    ['/login', 'searchParams'],
    ['/member', 'session cookie'],
    ['/trade/accounts', 'request-time'],
  ] as const) {
    const src = pageSource(url);
    const exported = src.indexOf('export const dynamic');
    const preamble = src.slice(Math.max(0, exported - 700), exported);
    assert.ok(preamble.includes(needle), `${url} must document "${needle}" above the export`);
  }
});

test('pages: the boards either fetch nothing at render, or pin their source TTL', () => {
  // The client boards (`StoreShell`) fetch nothing in the RSC — their data
  // arrives over `/api/*` — which is what makes a 300s shell honest. The blog
  // pages DO read Payload during the render, and 300s is the window pinned for
  // them (the digest publishes on a weekly cadence, so 300s cannot show a stale
  // post as fresh); a board that starts fetching without one of these two
  // shapes fails here rather than shipping an unbounded cache.
  const CMS_PAGES = ['/blog', '/blog/[slug]'];
  for (const url of boardPages()) {
    if (REQUEST_TIME_PAGES.includes(url)) continue;
    const src = pageSource(url);
    const readsCms = src.includes('getPayload');
    const fetches = /await\s+fetch\(/.test(src);
    if (CMS_PAGES.includes(url)) {
      assert.equal(src.match(/export const revalidate = (\d+);/)?.[1], '300', `${url} pins the CMS read at 300s`);
      continue;
    }
    assert.equal(fetches, false, `${url} must not fetch() during the render`);
    assert.equal(readsCms, false, `${url} must not read the CMS during the render`);
  }
});

test('publicJson: public, max-age=<ttl>, s-maxage=<ttl>, stale-while-revalidate=<ttl>', () => {
  const res = publicJson({ ok: true }, 300);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300, s-maxage=300, stale-while-revalidate=300');
});

test('publicJson: keeps a caller-supplied header and its status', () => {
  const res = publicJson({ ok: true }, 60, { status: 200, headers: { 'X-Cache': 'HIT' } });
  assert.equal(res.headers.get('X-Cache'), 'HIT');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=60, stale-while-revalidate=60');
});

test('noStoreJson: private, no-store for gated reads and errors', () => {
  const res = noStoreJson({ error: 'unauthorized' }, { status: 401 });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
});

test('api: the per-route TTLs match the in-process memo they mirror', () => {
  // Each literal below is the route's OWN memo TTL (read from the feature
  // module it imports), so the edge window and the server window cannot drift.
  const source = (route: string) => readFileSync(path.join(process.cwd(), 'src', 'app', '(frontend)', 'api', route), 'utf8');
  const cases: [string, string, string][] = [
    ['markets/route.ts', 'MARKETS_TTL_MS / 1000', 'MARKETS_TTL_MS = 60_000'],
    ['market/macro/route.ts', 'MACRO_TTL_MS / 1000', 'MACRO_TTL_MS = QUOTE_TTL_MS'],
    ['market/stock/route.ts', 'STOCK_TTL_MS / 1000', 'STOCK_TTL_MS = QUOTE_TTL_MS'],
    ['market/commodity/route.ts', 'COMMODITY_TTL_MS / 1000', 'COMMODITY_TTL_MS = QUOTE_TTL_MS'],
    ['market/forex/route.ts', 'FOREX_TTL_MS / 1000', 'FOREX_TTL_MS = 300_000'],
    ['market/indonesia/route.ts', 'IDR_QUOTE_TTL_MS / 1000', 'IDR_QUOTE_TTL_MS'],
  ];
  for (const [route, used, ttlConst] of cases) {
    const src = source(route);
    assert.ok(src.includes(used), `${route} must pass ${used} to publicJson`);
    assert.ok(ttlConst.length > 0, `${route} TTL constant is documented`);
  }
  // The fixed-window routes state their value as a named constant in the file
  // that owns the computation.
  for (const [route, constant] of [
    ['proof/route.ts', 'PROOF_TTL_SECONDS'],
    ['economy/regime/route.ts', 'REGIME_TTL_SECONDS'],
    ['economy/liquidity/route.ts', 'LIQUIDITY_TTL_SECONDS'],
  ] as const) {
    const src = source(route);
    assert.ok(src.includes(`publicJson(`), `${route} must answer through publicJson`);
    assert.ok(new RegExp(`const ${constant} = \\d+;`).test(src), `${route} must name its TTL as ${constant}`);
  }
  // The calendar moved its fan-out — and the window constant the route and the
  // boot warm both read — into the shared compute module, so the route now
  // imports the constant rather than declaring it.
  {
    const route = source('economy/calendar/route.ts');
    assert.ok(route.includes('publicJson('), 'economy/calendar/route.ts must answer through publicJson');
    assert.ok(route.includes('CALENDAR_TTL_SECONDS'), 'economy/calendar/route.ts must pass its TTL to publicJson');
    const lib = source('economy/_lib/calendar.ts');
    assert.ok(/const CALENDAR_TTL_SECONDS = \d+;/.test(lib), 'economy/_lib/calendar.ts must name the TTL as CALENDAR_TTL_SECONDS');
  }
  assert.ok(source('dex/route.ts').includes("'Cache-Control': `public, max-age=${DEX_TTL_SECONDS}"), 'dex carries the header on its success returns');
  assert.ok(source('signals/route.ts').includes('...cacheControl'), 'signals carries the header on all three success paths');
});

test('middleware: gated API pass-throughs and 401s are private, no-store', () => {
  const src = readFileSync(path.join(process.cwd(), 'src', 'middleware.ts'), 'utf8');
  // The gate lives in one place; both branches must state the header, and the
  // routes that DO set their own value are public/ungated so never reach here.
  assert.ok(
    src.includes("if (need !== null) pass.headers.set('Cache-Control', 'private, no-store');"),
    'the gated pass-through must set private, no-store',
  );
  assert.ok(
    /status: 401, headers: \{ \.\.\.headers, 'Cache-Control': 'private, no-store' \}/.test(src),
    'the 401 refusal must set private, no-store',
  );
});

test('detail routes: on-demand ISR is declared so a valid slug is not request-time', () => {
  // The root layout is SYNCHRONOUS — the locale is client state owned by
  // `<LocaleProvider>` (src/lib/i18n/t.tsx), read from the `fc-locale` cookie on
  // mount, never with `cookies()` in the layout. That keeps the whole public
  // tree static/ISR: measured 2026-10-13, /market/trench and /economy serve
  // `public, s-maxage=300, stale-while-revalidate=31535700` again.
  //
  // These six leaves carry an UNBOUNDED param space (every coin, market type,
  // instrument, country, bank and indicator the registry knows), so they cannot
  // be pre-rendered to a fixed list. `generateStaticParams(): []` + `dynamicParams
  // = true` mint unknown slugs on demand while caching the ones already built, and
  // `revalidate = 300` renews them — the same shape /blog/[slug] has used since
  // before this session. Without it Next classifies them request-time and serves
  // `private, no-store` across ~2,700 sitemap URLs.
  for (const route of [
    'trade/[marketType]',
    'trade/[marketType]/[instrument]',
    'market/crypto/[ticker]',
    'economy/nation/[countryCode]',
    'economy/indicator/[indicator]',
    'economy/central-bank/[bank]',
  ] as const) {
    const src = readFileSync(path.join(PUBLIC_DIR, ...route.split('/'), 'page.tsx'), 'utf8');
    assert.ok(/export async function generateStaticParams/.test(src), `${route} must declare a static mint`);
    assert.ok(src.includes('export const dynamicParams = true;'), `${route} must declare on-demand params`);
    assert.equal(src.match(/export const revalidate = (\d+);/)?.[1], '300', `${route} must pin a 300s revalidate window`);
    assert.ok(!/export const dynamic = 'force-dynamic';/.test(src), `${route} must not be request-time`);
  }
});

test('crawler files: the config gives them a Cache-Control that matches their revalidate', () => {
  // Next's default for a prerendered route is `public, max-age=0,
  // must-revalidate`, which forced a crawler re-fetch of a document that only
  // changes hourly. The config now names the value, so it is asserted here from
  // the built config (the same source the runtime reads).
  const configGroups = config.headers() as Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
  return configGroups.then((groups) => {
    const cacheFor = (source: string) =>
      groups
        .find((group) => group.source === source)
        ?.headers.find((h) => h.key === 'Cache-Control')?.value;
    assert.equal(cacheFor('/sitemap.xml'), 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400');
    assert.equal(cacheFor('/robots.txt'), 'public, max-age=14400, s-maxage=14400, stale-while-revalidate=86400');
  });
});

test('robots/sitemap: revalidate exports are pinned with their cache story', () => {
  const sitemap = readFileSync(path.join(process.cwd(), 'src', 'app', '(frontend)', 'sitemap.ts'), 'utf8');
  assert.equal(sitemap.match(/export const revalidate = (\d+);/)?.[1], '3600');
  const robots = readFileSync(path.join(process.cwd(), 'src', 'app', 'robots.ts'), 'utf8');
  assert.ok(robots.includes('MetadataRoute.Robots'), 'robots stays a route handler');
});
