/**
 * Route-registry consistency: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test: the crawl registry (`PUBLIC_ROUTES` — the single source
 * of truth `sitemap.ts` and `robots.ts` iterate) and the real page tree under
 * `src/app` describe the SAME site. Nothing enforced that, and they drifted:
 * `/market/{forex,commodity,stock}` shipped as live, link-reachable market-hub
 * sections but were never added to `PUBLIC_ROUTES`, so all three were absent
 * from `sitemap.xml` and from the crawl tier (measured 2026-10-02). The drift
 * in the other direction — a registry entry naming a page that no longer
 * exists — is what silently advertises a dead URL to crawlers.
 *
 * The rule, in one line: a STATIC page under the `(public)` route group is
 * either registered in `PUBLIC_ROUTES` or disallowed by `robots.ts`. Nothing
 * else is a valid state, and the disallow list is read from `robots.ts` itself
 * rather than restated here, so un-disallowing a path re-opens this check for
 * it. Dynamic routes (`/market/ticker/[ticker]`) are enumerated separately by
 * `sitemap.ts` from a symbol allowlist, so they are not static entries.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { PUBLIC_ROUTES } from '@/server/routes';
import robots from '@/app/robots';

const APP = path.join(process.cwd(), 'src', 'app');

interface Page {
  /** URL path, route groups `(name)` stripped (`/` for the index). */
  url: string;
  /** True when the page sits under the `(public)` route group. */
  isPublic: boolean;
}

/** Every `page.tsx` in `src/app`, as its URL path. */
function pages(): Page[] {
  const out: Page[] = [];
  const walk = (dir: string, url: string, isPublic: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // `api` holds route handlers, not pages. Route groups `(name)` are not
        // URL segments; `(public)` also flips the crawl-tier flag.
        if (entry.name === 'api') continue;
        const segment = /^\(.*\)$/.test(entry.name) ? '' : `/${entry.name}`;
        walk(path.join(dir, entry.name), url + segment, isPublic || entry.name === '(public)');
      } else if (entry.name === 'page.tsx' || entry.name === 'page.ts') {
        out.push({ url: url === '' ? '/' : url, isPublic });
      }
    }
  };
  walk(APP, '', false);
  return out;
}

/** The paths `robots.ts` tells crawlers to stay out of (exact or prefix). */
function disallowed(): string[] {
  const rules = robots().rules;
  const list = Array.isArray(rules) ? rules : [rules];
  return list.flatMap((rule) => {
    if (Array.isArray(rule.disallow)) return rule.disallow;
    return rule.disallow ? [rule.disallow] : [];
  });
}

test('routes: every static (public) page is in the crawl registry or robots-disallowed', () => {
  const deny = disallowed();
  const isDisallowed = (p: string): boolean =>
    deny.some((d) => p === d || p.startsWith(d.endsWith('/') ? d : `${d}/`));
  const registered = new Set(PUBLIC_ROUTES.map((r) => r.path));

  const unclassified = pages()
    .filter((p) => p.isPublic)
    .filter((p) => !p.url.includes('[')) // dynamic: sitemap.ts enumerates these
    .filter((p) => !registered.has(p.url) && !isDisallowed(p.url))
    .map((p) => p.url)
    .sort();

  assert.deepEqual(
    unclassified,
    [],
    `(public) pages neither in PUBLIC_ROUTES nor disallowed by robots.ts: ${unclassified.join(', ')} — register each (sitemap + crawl tier) or disallow it`,
  );
});

test('routes: every PUBLIC_ROUTES entry resolves to a real page', () => {
  const real = new Set(pages().map((p) => p.url));
  const phantom = PUBLIC_ROUTES.map((r) => r.path)
    .filter((p) => !real.has(p))
    .sort();

  assert.deepEqual(
    phantom,
    [],
    `PUBLIC_ROUTES names paths with no page: ${phantom.join(', ')} — sitemap.xml would advertise a dead URL`,
  );
});

test('routes: PUBLIC_ROUTES carries no duplicate paths', () => {
  const paths = PUBLIC_ROUTES.map((r) => r.path);
  const duplicates = [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))].sort();
  assert.deepEqual(duplicates, []);
});
