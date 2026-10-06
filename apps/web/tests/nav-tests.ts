/**
 * Site navigation model tests (navbar + breadcrumb): run OFFLINE, no network,
 * no clock, no DOM.
 *
 * Contract under test (`src/ui/site-nav.ts`):
 *  - the section list and the crawl registry describe the SAME site. A navbar is
 *    the one place a visitor is guaranteed to see, so a link that is not a
 *    registered public route is either a typo or a page nobody can crawl;
 *  - the active section is matched on a SEGMENT boundary, never a bare prefix:
 *    `/market` must not claim `/marketplace`. This is the bug the naive
 *    `startsWith` implementation ships with;
 *  - `/` matches by EQUALITY. Every path is under the root, so a prefix rule
 *    would light Home up on every page of the site;
 *  - a path under no section resolves to `null` rather than to a guess;
 *  - a humanised segment keeps codes readable (`id` → `ID`, `us-cpi` → `US CPI`)
 *    and does not re-case a word it does not know;
 *  - a trail is the root plus one crumb per segment, the LAST crumb is the
 *    current page, a query string or hash never becomes a crumb, and a label map
 *    overrides the fallback by the crumb's href.
 *
 * Usage: cd apps/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_SECTIONS, TERMINAL, activeSection, buildTrail, humanizeSegment } from '@/ui/site-nav';
import { PUBLIC_ROUTES } from '@/server/routes';

test('nav: every section is a registered public route (navbar and sitemap agree)', () => {
  const registered = new Set(PUBLIC_ROUTES.map((r) => r.path));
  for (const section of NAV_SECTIONS) {
    assert.ok(
      registered.has(section.href),
      `the navbar links ${section.href}, but it is not in PUBLIC_ROUTES — a link a visitor is guaranteed to see must be a crawlable route`,
    );
  }
});

test('nav: section keys and hrefs are unique', () => {
  const keys = NAV_SECTIONS.map((s) => s.key);
  const hrefs = NAV_SECTIONS.map((s) => s.href);
  assert.equal(new Set(keys).size, keys.length, 'two sections share a key, so the active state is ambiguous');
  assert.equal(new Set(hrefs).size, hrefs.length, 'two sections point at the same href');
});

test('nav: the terminal is an action, not a section', () => {
  // It is gated. If it ever became a section, the navbar would offer a login
  // wall as a top-level destination to anonymous visitors.
  assert.ok(
    !NAV_SECTIONS.some((s) => s.href === TERMINAL.href),
    'the gated terminal must not be listed as a public section',
  );
});

test('nav: the active section is matched on a segment boundary', () => {
  assert.equal(activeSection('/market'), 'market');
  assert.equal(activeSection('/market/crypto'), 'market');
  assert.equal(activeSection('/market/ticker/btc'), 'market');
  assert.equal(activeSection('/economy'), 'economy');
  assert.equal(activeSection('/economy/nation/id'), 'economy');
  assert.equal(activeSection('/economy/regime'), 'economy');
  assert.equal(activeSection('/blog/hello-world'), 'blog');
});

test('nav: a bare prefix match would light up a neighbouring route', () => {
  // `/marketplace` is NOT under `/market`. The same trap for `/economy2`.
  assert.equal(activeSection('/marketplace'), null);
  assert.equal(activeSection('/economy2'), null);
  assert.equal(activeSection('/market-ing'), null);
});

test('nav: the root matches by equality only', () => {
  assert.equal(activeSection('/'), 'home');
  // Every one of these is "under" `/`; a prefix rule would call them all home.
  assert.equal(activeSection('/login'), null);
  assert.equal(activeSection('/team/wallets'), null);
  assert.equal(activeSection('/admin'), null);
  assert.notEqual(activeSection('/signals'), 'home');
});

test('nav: the active section agrees with the section list itself', () => {
  for (const section of NAV_SECTIONS) {
    assert.equal(activeSection(section.href), section.key, `${section.href} must resolve to its own section`);
  }
});

test('nav: a segment is humanised, and codes stay readable', () => {
  assert.equal(humanizeSegment('central-bank'), 'Central Bank');
  assert.equal(humanizeSegment('hello_world'), 'Hello World');
  assert.equal(humanizeSegment('nation'), 'Nation');
  // ISO codes and the acronyms this app spells in URLs.
  assert.equal(humanizeSegment('id'), 'ID');
  assert.equal(humanizeSegment('us'), 'US');
  assert.equal(humanizeSegment('us-cpi'), 'US CPI');
  // A word longer than three characters keeps its own casing.
  assert.equal(humanizeSegment('regime'), 'Regime');
});

test('nav: a malformed percent-escape stays literal instead of throwing', () => {
  assert.equal(humanizeSegment('%E0%A4%A'), '%E0%A4%A');
  assert.equal(humanizeSegment('caf%C3%A9'), 'Café');
});

test('nav: the trail is the root plus one crumb per segment', () => {
  assert.deepEqual(buildTrail('/economy/regime'), [
    { href: '/', label: 'Home' },
    { href: '/economy', label: 'Economy' },
    { href: '/economy/regime', label: 'Regime' },
  ]);
  assert.deepEqual(buildTrail('/economy/nation/id'), [
    { href: '/', label: 'Home' },
    { href: '/economy', label: 'Economy' },
    { href: '/economy/nation', label: 'Nation' },
    { href: '/economy/nation/id', label: 'ID' },
  ]);
});

test('nav: the root is a single crumb, which is what lets a caller hide the trail', () => {
  assert.deepEqual(buildTrail('/'), [{ href: '/', label: 'Home' }]);
  // The component renders nothing at length < 2, so this is the contract it reads.
  assert.ok(buildTrail('/').length < 2, 'the home page must not render a one-item breadcrumb');
  assert.ok(buildTrail('/market').length >= 2);
});

test('nav: the last crumb is the current page, and it equals the pathname', () => {
  for (const path of ['/market', '/market/crypto', '/economy/nation/id', '/blog/hello-world']) {
    const trail = buildTrail(path);
    assert.equal(trail[trail.length - 1].href, path, `the trail for ${path} must end on ${path}`);
  }
});

test('nav: a query string or hash never becomes a crumb', () => {
  assert.deepEqual(buildTrail('/economy/regime?cb=1'), buildTrail('/economy/regime'));
  assert.deepEqual(buildTrail('/economy/regime#top'), buildTrail('/economy/regime'));
});

test('nav: a trailing slash does not add an empty crumb', () => {
  assert.deepEqual(buildTrail('/economy/'), buildTrail('/economy'));
});

test('nav: a label map overrides the humanised fallback, keyed by href', () => {
  const labels = { '/economy': 'Macro', '/economy/nation/id': 'Indonesia' };
  assert.deepEqual(buildTrail('/economy/nation/id', labels), [
    { href: '/', label: 'Home' },
    { href: '/economy', label: 'Macro' },
    { href: '/economy/nation', label: 'Nation' },
    { href: '/economy/nation/id', label: 'Indonesia' },
  ]);
});

test('nav: the root crumb is itself overridable', () => {
  assert.equal(buildTrail('/market', { '/': 'Beranda' })[0].label, 'Beranda');
});
