/**
 * Client-hint scoping regression: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (`next.config.js` § Critical-CH removal):
 *  - Payload's `withPayload` appends a `/:path*` group carrying `Accept-CH` and
 *    `Critical-CH: Sec-CH-Prefers-Color-Scheme`. Chrome RE-ISSUES a navigation
 *    when a `Critical-CH` hint it has not sent is advertised (`Vary` includes
 *    it), so the first document request is a 307 and only the retry renders.
 *    Lighthouse's `redirects` audit scores that 0 — measured est. savings
 *    610-660 ms on `/` and `/economy` before the fix.
 *  - The hint is genuinely needed by Payload's admin (`getRequestTheme` reads
 *    the header to pick the colour scheme before paint), so it must NOT be
 *    dropped outright: `/blog/**` keeps it.
 *  - The wrapper sets `poweredByHeader: false` (Payload's own guard replaces
 *    the grouped `X-Powered-By` with the bare Next.js default, which would drop
 *    the `Payload` token), so both scopes must re-emit Payload's exact value.
 *
 * What is asserted here is the CONFIG, because that is the only layer that can
 * express it: `resolve-routes.js` merges middleware headers with
 * `resHeaders[key] = value`, so a middleware can add or overwrite a header but
 * can never delete one — the same negative result that made the header-level
 * approach impossible to route through `src/middleware.ts`.
 *
 * Usage: cd apps/web && bun run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp';
import config from '@/../next.config.js';

interface HeaderGroup {
  source: string;
  headers: { key: string; value: string }[];
}

const groups: HeaderGroup[] = await config.headers();

/**
 * What a REQUEST PATH resolves to in the built config. Every matching route
 * applies, in config order, and a key set twice is the last value (the router
 * does exactly this with `resHeaders[key] = value`), so the resolved view is
 * the merge of all matching groups — not just the first. Matching uses Next's
 * own `pathToRegexp`, so the assertions hold for real paths (including
 * `/blogfoo` and `/blog/`, the two a hand-rolled prefix test gets wrong).
 */
function resolveGroup(pathname: string) {
  const matching = groups.filter((candidate) => pathToRegexp(candidate.source).test(pathname));
  return {
    matching: matching.map((group) => group.source),
    // The last matching group is the most specific scope, which is the one the
    // split exists to place the path in.
    scope: matching.at(-1)?.source,
    header: (key: string): string | undefined =>
      [...matching]
        .reverse()
        .flatMap((group) => group.headers)
        .find((h) => h.key.toLowerCase() === key.toLowerCase())?.value,
  };
}

test('client-hint: the frontend no longer advertises Critical-CH', () => {
  for (const pathname of ['/', '/economy', '/market/crypto', '/coins', '/login', '/team', '/api/ticker']) {
    const { scope, header } = resolveGroup(pathname);
    assert.equal(header('Critical-CH'), undefined, `${pathname} must not carry Critical-CH (scope ${scope ?? 'none'})`);
    assert.equal(header('Accept-CH'), undefined, `${pathname} must not carry Accept-CH`);
  }
});

test('client-hint: /blog keeps the hint Payload admin reads', () => {
  for (const pathname of ['/blog', '/blog/', '/blog/my-post', '/blog/cms/admin', '/blog/cms/api/posts']) {
    const { scope, header } = resolveGroup(pathname);
    assert.equal(header('Accept-CH'), 'Sec-CH-Prefers-Color-Scheme', pathname);
    assert.equal(header('Critical-CH'), 'Sec-CH-Prefers-Color-Scheme', pathname);
    // The group also declares the matching `Vary`, but Next's own RSC vary list
    // supersedes it on the wire — measured identical before and after this
    // change, so the runtime value is deliberately not asserted here.
    assert.equal(scope, '/blog/:path*', pathname);
  }
});

test('client-hint: the frontend scope does not bleed into /blog and the blog scope not out of it', () => {
  // The negative-lookahead group is what carves the admin out; a bare prefix
  // would also swallow `/blogfoo`, and a `/:path*` fallthrough would re-add the
  // hint to every page. Both failure modes are asserted against.
  assert.equal(resolveGroup('/blogfoo').scope, '/:path((?!blog(?:/|$)).*)');
  assert.equal(resolveGroup('/blog').scope, '/blog/:path*');
  assert.equal(resolveGroup('/blog/cms/admin').scope, '/blog/:path*');
  // `/` also matches the app's own `/:path*` security-header group, which is
  // emitted first; the scope that wins is the one the split placed it in.
  assert.equal(resolveGroup('/').scope, '/:path((?!blog(?:/|$)).*)');
  assert.ok(resolveGroup('/blog').matching.includes('/:path*'));
});

test('client-hint: X-Powered-By survives the split on both scopes', () => {
  // `poweredByHeader: false` is what stops Payload's guard from overwriting the
  // grouped value with the bare default; both scopes must then re-emit it.
  assert.equal(config.poweredByHeader, false);
  for (const pathname of ['/', '/economy', '/blog', '/blog/cms/admin']) {
    assert.equal(resolveGroup(pathname).header('X-Powered-By'), 'Next.js, Payload', pathname);
  }
});

test('client-hint: the app security headers are still emitted verbatim on every path', () => {
  const expected: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  };
  for (const pathname of ['/', '/economy', '/blog', '/api/ticker']) {
    const { header } = resolveGroup(pathname);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(header(key), value, `${pathname} ${key}`);
    }
    assert.ok(header('Permissions-Policy')?.startsWith('camera=()'), pathname);
    assert.ok(header('Content-Security-Policy-Report-Only')?.includes("frame-ancestors 'self'"), pathname);
  }
});
