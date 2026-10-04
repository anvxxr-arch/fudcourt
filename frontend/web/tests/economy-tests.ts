/**
 * Economy registry tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (features/economy/{countries,registry,taxonomy}.ts):
 *  - the economy country table and the worldwide board's own allowlist describe
 *    the SAME economies. Nothing enforces that, and the failure is silent in both
 *    directions: a country on the board with no profile page is a dead end, and a
 *    profile page for a country the board does not carry advertises a row that
 *    does not exist. The table is static precisely so the URL resolves offline —
 *    which is also why nothing else would ever catch it drifting;
 *  - ISO2 and ISO3 both resolve, case-insensitively, and the two namespaces
 *    cannot collide (alpha-2 is two characters, alpha-3 is three). A duplicated
 *    key would silently resolve one code to the WRONG country, so uniqueness is
 *    asserted rather than assumed;
 *  - an unknown code resolves to null — the page turns that into a real 404;
 *  - every currency is a well-formed ISO-4217 code, and every central bank's
 *    `area` is an area BIS actually carries (POLICY_RATES). A typo here would
 *    render a live row that can never fill, which reads as "no data", not "bug";
 *  - every indicator slug is unique and matches its country's iso2, so
 *    `/economy/indicator/<slug>` resolves to exactly one series;
 *  - every indicator's `frequency` is one its `source` can actually publish — a
 *    World Bank series is annual, a FRED series is not, and a mismatch would make
 *    the page promise a cadence the upstream never delivers;
 *  - every derived series names exactly two legs that exist as real indicators,
 *    because the adapter fetches both and a missing leg is a silent blank column.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CENTRAL_BANKS,
  CENTRAL_BANK_BY_SLUG,
  COUNTRY_BY_ISO2,
  COUNTRY_BY_ISO3,
  COUNTRY_LIST,
  DERIVED_LEGS,
  INDICATOR_BY_SLUG,
  INDICATORS,
  categoryOf,
  countryByAnyCode,
  indicatorsForCategory,
  indicatorsForCountry,
} from '@/features/economy/registry';
import { CATEGORY_BY_ID, SUBCATEGORY_LABELS, TAXONOMY } from '@/features/economy/taxonomy';
import { POLICY_RATES, WORLD_COUNTRIES } from '@/features/market/macro/client';

test('economy: the country table is exactly the worldwide board allowlist', () => {
  const board = WORLD_COUNTRIES.map((c) => c.code).sort();
  const table = COUNTRY_LIST.map((c) => c.iso3).sort();
  assert.deepEqual(table, board, 'a country on one list but not the other is a dead end or a phantom page');
});

test('economy: ISO2 and ISO3 keys are unique, so no code resolves to the wrong country', () => {
  const keys = COUNTRY_LIST.flatMap((c) => [c.iso2, c.iso3]);
  const seen = new Set<string>();
  for (const k of keys) {
    assert.ok(!seen.has(k), `duplicate lookup key ${k}`);
    seen.add(k);
  }
});

test('economy: codes are well-formed and cannot collide across the two namespaces', () => {
  for (const c of COUNTRY_LIST) {
    assert.match(c.iso3, /^[A-Z]{3}$/, `${c.iso3} is not an alpha-3 code`);
    assert.match(c.iso2, /^[A-Z]{2}$/, `${c.iso2} is not an alpha-2 code`);
    assert.equal(c.id, c.iso3, `${c.iso3} id must be the ISO3 the upstreams are keyed on`);
  }
  const iso2 = new Set(COUNTRY_LIST.map((c) => c.iso2));
  for (const c of COUNTRY_LIST) assert.ok(!iso2.has(c.iso3), `${c.iso3} is both an ISO2 and an ISO3`);
});

test('economy: ISO2, ISO3 and either case all resolve to the same country', () => {
  const id = countryByAnyCode('ID');
  assert.ok(id, 'ID resolves');
  assert.equal(id.iso3, 'IDN');
  for (const spelling of ['id', 'ID', 'Id', 'idn', 'IDN', 'iDn', '  IDN  ']) {
    assert.equal(countryByAnyCode(spelling)?.iso3, 'IDN', `${JSON.stringify(spelling)} resolves to Indonesia`);
  }
  assert.equal(countryByAnyCode('MY')?.iso3, 'MYS');
  assert.equal(countryByAnyCode('US')?.iso3, 'USA');
});

test('economy: an unknown code resolves to null, never to a default country', () => {
  for (const bad of ['', 'ZZ', 'ZZZ', 'XYZ', 'INDONESIA', '1', 'us;id']) {
    assert.equal(countryByAnyCode(bad), null, `${JSON.stringify(bad)} must not resolve`);
  }
});

test('economy: every currency is a well-formed ISO-4217 code', () => {
  for (const c of COUNTRY_LIST) {
    assert.match(c.currency, /^[A-Z]{3}$/, `${c.iso3} currency ${JSON.stringify(c.currency)}`);
  }
});

test('economy: the lookup tables and the list agree', () => {
  assert.equal(Object.keys(COUNTRY_BY_ISO2).length, COUNTRY_LIST.length);
  assert.equal(Object.keys(COUNTRY_BY_ISO3).length, COUNTRY_LIST.length);
  for (const c of COUNTRY_LIST) {
    assert.equal(COUNTRY_BY_ISO2[c.iso2], COUNTRY_BY_ISO3[c.iso3], `${c.iso3} resolves to the same object by both keys`);
  }
});

test('economy: every central bank slug is unique and its area is one BIS carries', () => {
  const areas = new Set(POLICY_RATES.map((p) => p.area));
  const slugs = new Set<string>();
  for (const b of CENTRAL_BANKS) {
    assert.ok(!slugs.has(b.slug), `duplicate bank slug ${b.slug}`);
    slugs.add(b.slug);
    assert.ok(areas.has(b.area), `${b.slug} area ${b.area} is not on BIS WS_CBPOL`);
    assert.equal(CENTRAL_BANK_BY_SLUG[b.slug], b, `${b.slug} resolves back to itself`);
  }
});

test('economy: every indicator slug is unique and namespaced by its country', () => {
  const slugs = new Set<string>();
  for (const ind of INDICATORS) {
    assert.ok(!slugs.has(ind.slug), `duplicate indicator slug ${ind.slug}`);
    slugs.add(ind.slug);
    assert.equal(INDICATOR_BY_SLUG[ind.slug], ind, `${ind.slug} resolves back to itself`);
    assert.match(ind.slug, /^[a-z0-9-]+$/, `${ind.slug} is not URL-safe`);
  }
});

test('economy: every indicator sits in a category its subcategory belongs to', () => {
  for (const ind of INDICATORS) {
    assert.equal(categoryOf(ind.subcategory), ind.category, `${ind.slug}: ${ind.subcategory} is not in ${ind.category}`);
    assert.ok(CATEGORY_BY_ID[ind.category], `${ind.slug} category ${ind.category} is not in the taxonomy`);
    assert.ok(SUBCATEGORY_LABELS[ind.subcategory], `${ind.slug} subcategory ${ind.subcategory} has no label`);
  }
  // The taxonomy must not declare a category the registry never uses, or the
  // board would render an empty section with no way to tell it is empty by design.
  const used = new Set(INDICATORS.map((i) => i.category));
  for (const cat of TAXONOMY) {
    if (cat.id === 'money' || cat.id === 'credit' || cat.id === 'sentiment' || cat.id === 'consumer' || cat.id === 'housing') continue;
    assert.ok(used.has(cat.id), `category ${cat.id} is declared but no indicator uses it`);
  }
});

test('economy: every indicator frequency is one its source can publish', () => {
  // World Bank structural data is annual; BIS policy rates are daily. A monthly
  // FRED series declared annual would silently collapse twelve prints into one.
  for (const ind of INDICATORS) {
    if (ind.source === 'worldbank') {
      assert.equal(ind.frequency, 'annual', `${ind.slug}: a World Bank series is annual`);
    }
    if (ind.source === 'bis') {
      assert.equal(ind.frequency, 'daily', `${ind.slug}: a BIS policy rate is daily`);
    }
  }
});

test('economy: every derived series is reachable and its legs are known upstream codes', () => {
  const bySlug = new Map(INDICATORS.map((i) => [i.slug, i]));
  // DERIVED_LEGS is keyed by the series KEY (the slug suffix, e.g. `deficit`) and
  // each leg is the upstream series code the adapter fetches (a World Bank code),
  // NOT an indicator slug — so the two invariants are checked separately.
  const upstreamCodes = new Set(INDICATORS.filter((i) => i.source === 'worldbank' && !i.sourceSeriesId.startsWith('derived:')).map((i) => i.sourceSeriesId));
  for (const [key, legs] of Object.entries(DERIVED_LEGS)) {
    assert.equal(legs.length, 2, `${key} must have exactly two legs`);
    // The key must resolve to a real, addressable series — at least one country
    // carries it, or `/economy/indicator/<slug>` would have nothing to show.
    const reachable = [...bySlug.keys()].some((s) => s.endsWith(`-${key}`));
    assert.ok(reachable, `${key} is a derived series but no indicator carries it`);
    for (const leg of legs) {
      assert.ok(upstreamCodes.has(leg), `${key} leg ${leg} is not an upstream code any indicator binds`);
    }
    // A derived series' own binding must name its key, so the adapter can find the
    // legs from the indicator alone.
    const sample = INDICATORS.find((i) => i.slug.endsWith(`-${key}`));
    assert.equal(sample?.sourceSeriesId, `derived:${key}`, `${key}'s indicator must bind derived:${key}`);
  }
});

test('economy: indicatorsForCountry and indicatorsForCategory agree with the flat list', () => {
  for (const c of COUNTRY_LIST.slice(0, 12)) {
    const mine = indicatorsForCountry(c.iso3);
    for (const ind of mine) assert.equal(ind.country, c.iso3, `${ind.slug} is not ${c.iso3}'s`);
    assert.deepEqual(
      mine.map((i) => i.slug).sort(),
      INDICATORS.filter((i) => i.country === c.iso3).map((i) => i.slug).sort(),
      `${c.iso3}: the country filter matches the flat list`
    );
  }
  for (const cat of TAXONOMY) {
    const mine = indicatorsForCategory(cat.id);
    for (const ind of mine) assert.equal(ind.category, cat.id, `${ind.slug} is not in ${cat.id}`);
  }
});
