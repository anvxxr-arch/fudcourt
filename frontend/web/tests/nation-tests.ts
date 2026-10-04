/**
 * Nation family tests: run OFFLINE, no network, no clock waiting.
 *
 * Contract under test (features/market/nation/client.ts):
 *  - the country table and the worldwide board's own allowlist describe the SAME
 *    125 economies. Nothing enforced that, and the failure is silent in both
 *    directions: a country on the board with no profile page is a dead end for a
 *    reader who clicks through, and a profile page for a country the board does
 *    not carry advertises a page whose own board row does not exist. `NATIONS` is
 *    a static table precisely so the URL resolves offline — which is also why
 *    nothing else would ever catch it drifting;
 *  - ISO2 and ISO3 both resolve, case-insensitively, and the two namespaces
 *    cannot collide (alpha-2 is two characters, alpha-3 is three). A duplicated
 *    key would silently resolve one code to the WRONG country, so uniqueness is
 *    asserted rather than assumed;
 *  - an unknown code resolves to null — the page turns that into a real 404;
 *  - every currency is a well-formed ISO-4217 code, and every `policyArea` is an
 *    area BIS actually carries (POLICY_RATES) or null. A typo here would render a
 *    live row that can never fill, which reads as "no data" rather than "bug";
 *  - the indicator SPECS are the board's own objects, not copies. The page and
 *    the board must never be able to disagree about the same number, and a
 *    restated list is exactly how they would.
 *
 * Usage: cd frontend/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIONS,
  NATION_BALANCE_ID,
  NATION_BALANCE_LEGS,
  NATION_FISCAL,
  NATION_FISCAL_IDS,
  NATION_INDICATORS,
  NATION_SLUGS,
  NATION_THEMES,
  nationByCode,
  nationFlag,
  nationPath,
} from '@/features/market/nation/client';
import { BALANCE_ID, BALANCE_LEGS, ECONOMY_INDICATORS, POLICY_RATES, WORLD_COUNTRIES, WORLD_THEMES } from '@/features/market/macro/client';
import { ID_APBN } from '@/features/market/indonesia/client';

test('nation: the country table is exactly the worldwide board allowlist', () => {
  const board = WORLD_COUNTRIES.map((c) => c.code).sort();
  const table = NATIONS.map((n) => n.code).sort();
  assert.deepEqual(table, board, 'a country on one list but not the other is a dead end or a phantom page');
});

test('nation: the board order is preserved (the index reads like the board)', () => {
  assert.deepEqual(
    NATIONS.map((n) => n.code),
    WORLD_COUNTRIES.map((c) => c.code)
  );
  // The display name and region must match the board too: the profile's heading
  // and the board's row label are the same country and must not disagree.
  for (const [i, n] of NATIONS.entries()) {
    assert.equal(n.name, WORLD_COUNTRIES[i].name, `${n.code} name`);
    assert.equal(n.region, WORLD_COUNTRIES[i].region, `${n.code} region`);
  }
});

test('nation: ISO2 and ISO3 keys are unique, so no code resolves to the wrong country', () => {
  const keys = NATIONS.flatMap((n) => [n.code, n.iso2]);
  const seen = new Set<string>();
  for (const k of keys) {
    assert.ok(!seen.has(k), `duplicate lookup key ${k}`);
    seen.add(k);
  }
});

test('nation: codes are well-formed and cannot collide across the two namespaces', () => {
  for (const n of NATIONS) {
    assert.match(n.code, /^[A-Z]{3}$/, `${n.code} is not an alpha-3 code`);
    assert.match(n.iso2, /^[A-Z]{2}$/, `${n.iso2} is not an alpha-2 code`);
  }
  // alpha-2 is two characters and alpha-3 is three, so the flat map needs no
  // length check — asserted here so a future edit cannot quietly break that.
  const iso2 = new Set(NATIONS.map((n) => n.iso2));
  for (const n of NATIONS) assert.ok(!iso2.has(n.code), `${n.code} is both an ISO2 and an ISO3`);
});

test('nation: ISO2, ISO3 and either case all resolve to the same country', () => {
  const id = nationByCode('ID');
  assert.ok(id, 'ID resolves');
  assert.equal(id.code, 'IDN');
  for (const spelling of ['id', 'ID', 'Id', 'idn', 'IDN', 'iDn', '  IDN  ']) {
    assert.equal(nationByCode(spelling)?.code, 'IDN', `${JSON.stringify(spelling)} resolves to Indonesia`);
  }
  assert.equal(nationByCode('MY')?.code, 'MYS');
  assert.equal(nationByCode('US')?.code, 'USA');
});

test('nation: an unknown code resolves to null, never to a default country', () => {
  for (const bad of ['', 'ZZ', 'ZZZ', 'XYZ', 'INDONESIA', '1', 'us;id']) {
    assert.equal(nationByCode(bad), null, `${JSON.stringify(bad)} must not resolve`);
  }
});

test('nation: the canonical path is the lowercase alpha-2', () => {
  const jpn = nationByCode('JP');
  assert.ok(jpn);
  assert.equal(nationPath(jpn), '/economy/nation/jp');
  // The slug list drives sitemap.xml, so it must be the same set as the table.
  assert.equal(NATION_SLUGS.length, NATIONS.length);
  assert.equal(new Set(NATION_SLUGS).size, NATIONS.length);
  for (const s of NATION_SLUGS) assert.match(s, /^[a-z]{2}$/);
});

test('nation: every currency is a well-formed ISO-4217 code', () => {
  for (const n of NATIONS) {
    assert.match(n.currency, /^[A-Z]{3}$/, `${n.code} currency ${JSON.stringify(n.currency)}`);
  }
});

test('nation: every policyArea is an area BIS carries, or null', () => {
  const areas = new Set(POLICY_RATES.map((p) => p.area));
  for (const n of NATIONS) {
    if (n.policyArea === null) continue;
    assert.ok(areas.has(n.policyArea), `${n.code} policyArea ${n.policyArea} is not on BIS WS_CBPOL`);
  }
  // Euro-area members must resolve to the ECB's area, not to a national bank that
  // does not set their rate — and a euro member that resolved to its own ISO2
  // would silently show the wrong institution's rate.
  for (const n of NATIONS) {
    if (n.currency === 'EUR') assert.equal(n.policyArea, 'XM', `${n.code} uses the euro, so the ECB sets its rate`);
  }
});

test('nation: the flag is built from the alpha-2, and junk yields nothing', () => {
  assert.equal(nationFlag('ID'), '🇮🇩');
  assert.equal(nationFlag('US'), '🇺🇸');
  assert.equal(nationFlag('MY'), '🇲🇾');
  for (const bad of ['', 'I', 'IDN', '1D', 'I D']) assert.equal(nationFlag(bad), '', `${JSON.stringify(bad)} has no flag`);
});

test('nation: the indicator specs are the board\'s own objects, not copies', () => {
  // Identity, not deep-equality: a copy could pass a value comparison today and
  // drift tomorrow, and a page that disagreed with the board's row for the same
  // country would be worse than no page.
  assert.equal(NATION_INDICATORS, ECONOMY_INDICATORS);
  assert.equal(NATION_THEMES, WORLD_THEMES);
  assert.equal(NATION_BALANCE_ID, BALANCE_ID);
  assert.equal(NATION_BALANCE_LEGS, BALANCE_LEGS);
  assert.equal(NATION_FISCAL, ID_APBN);
  assert.deepEqual(NATION_FISCAL_IDS, ID_APBN.map((s) => s.id));
});

test('nation: every indicator belongs to a theme the render order carries', () => {
  const themes = new Set<string>(NATION_THEMES);
  for (const spec of NATION_INDICATORS) {
    assert.ok(themes.has(spec.theme), `${spec.id} theme ${spec.theme} is not in the render order`);
  }
  // The derived balance is not an upstream series, so it must NOT be requested.
  assert.ok(NATION_FISCAL_IDS.length > 0);
  assert.ok(!NATION_FISCAL_IDS.includes(NATION_BALANCE_ID));
});

test('nation: the balance legs are the two the derived column needs', () => {
  assert.equal(NATION_BALANCE_LEGS.length, 2);
  for (const leg of NATION_BALANCE_LEGS) {
    assert.ok(
      NATION_INDICATORS.some((s) => s.id === leg),
      `${leg} is a balance leg but is not fetched as a column`
    );
  }
  assert.equal(NATION_BALANCE_ID, 'derived:balance');
});
