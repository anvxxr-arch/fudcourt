/**
 * IMF Fiscal Monitor source tests: run OFFLINE, no network.
 *
 * Contract under test (features/market/imf.ts):
 *  - a vintage runs years PAST its publication date, and the payload carries no
 *    flag separating an outturn from a forecast (measured: no OBS_STATUS
 *    attribute in the DSD, `DERIVATION_TYPE` a constant "M" on every obs of
 *    every country probed). The parser therefore DROPS every year after
 *    `publicationYear - 1`, so a projection can never reach a board that prints
 *    "newest" as the current value — and the count of what it dropped is
 *    reported rather than silently lost;
 *  - a body with no readable PUBLICATION_DATE is an ERROR, not an empty result:
 *    without the boundary the caller would print 2030 projections;
 *  - `only` fixes both membership and ORDER (the board's rows are curated);
 *  - the vintage is DISCOVERED from the catalogue, and the undated `FM` flow —
 *    which answers no data at all (measured) — is never selected.
 *
 * Usage: cd apps/web && npm run test:shapers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImfFiscal, pickLatestVintage } from '@/features/market/imf';

/** A vintage body shaped like the real one: 2 series, years spanning the boundary. */
const VINTAGE = `<?xml version='1.0' encoding='UTF-8'?>
<message:StructureSpecificData xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message">
<message:Header><message:Structure structureID="IMF.FAD_FM_2025_OCT_VINTAGE_1_0_0" namespace="urn:x" dimensionAtObservation="TIME_PERIOD"><common:StructureUsage><Ref agencyID="IMF.FAD" id="FM_2025_OCT_VINTAGE" version="1.0.0"/></common:StructureUsage></message:Structure></message:Header>
<message:DataSet ss:dataScope="DataStructure" action="Replace" LANGUAGE="EN" PUBLICATION_DATE="2025-10-15T12:45:00Z" UPDATE_DATE="2025-10-16T19:38:34Z">
<Series COUNTRY="IDN" INDICATOR="G2M_S13_POGDP_PT" FREQUENCY="A" OVERLAP="OL" SCALE="0" METHODOLOGY="GFS"><Obs TIME_PERIOD="2010" OBS_VALUE="16.8865469188977" DERIVATION_TYPE="M"/><Obs TIME_PERIOD="2024" OBS_VALUE="16.8447" DERIVATION_TYPE="M"/><Obs TIME_PERIOD="2025" OBS_VALUE="15.6111" DERIVATION_TYPE="M"/><Obs TIME_PERIOD="2030" OBS_VALUE="16.9857" DERIVATION_TYPE="M"/></Series>
<Series COUNTRY="IDN" INDICATOR="G1_S13_POGDP_PT" FREQUENCY="A" OVERLAP="OL" SCALE="0" METHODOLOGY="GFS"><Obs TIME_PERIOD="2010" OBS_VALUE="15.6441066008953" DERIVATION_TYPE="M"/><Obs TIME_PERIOD="2024" OBS_VALUE="14.5461" DERIVATION_TYPE="M"/><Obs TIME_PERIOD="2025" OBS_VALUE="13.7282" DERIVATION_TYPE="M"/><Obs TIME_PERIOD="2026" OBS_VALUE="13.8551" DERIVATION_TYPE="M"/><Obs TIME_PERIOD="2030" OBS_VALUE="14.2935" DERIVATION_TYPE="M"/></Series>
<Series COUNTRY="IDN" INDICATOR="ZZ_BOGUS_PT" FREQUENCY="A"><Obs TIME_PERIOD="2024" OBS_VALUE="1.0" DERIVATION_TYPE="M"/></Series>
</message:DataSet></message:StructureSpecificData>`;

test('the actual/projection boundary comes from the vintage publication date', () => {
  const out = parseImfFiscal(VINTAGE);
  assert.equal(out.published, '2025-10-15T12:45:00Z');
  // October 2025 vintage: FY2025 had not ended when it was published, so 2024 is
  // the last year it can call an outturn.
  assert.equal(out.actualThrough, 2024);
  assert.equal(out.vintage, 'FM_2025_OCT_VINTAGE');
});

test('every year after the boundary is DROPPED, and the drop is counted', () => {
  const out = parseImfFiscal(VINTAGE);
  const revenue = out.series.find((s) => s.indicator === 'G1_S13_POGDP_PT');
  assert.ok(revenue, 'revenue series present');
  assert.deepEqual(
    revenue.points.map((p) => p.year),
    ['2010', '2024']
  );
  // G1 dropped 2025/2026/2030 (3), G2M dropped 2025/2030 (2) => 5 in total.
  assert.equal(out.droppedProjections, 5);
  for (const s of out.series) {
    for (const p of s.points) assert.ok(Number(p.year) <= out.actualThrough, `${s.indicator} ${p.year} is a projection`);
  }
});

test('a projection is never reachable even when it is the newest observation', () => {
  const out = parseImfFiscal(VINTAGE);
  const newest = out.series.flatMap((s) => s.points.map((p) => Number(p.year)));
  assert.equal(Math.max(...newest), 2024);
});

test('`only` fixes both membership and row order', () => {
  const out = parseImfFiscal(VINTAGE, ['G1_S13_POGDP_PT', 'G2M_S13_POGDP_PT']);
  assert.deepEqual(
    out.series.map((s) => s.indicator),
    ['G1_S13_POGDP_PT', 'G2M_S13_POGDP_PT']
  );
  // An indicator the vintage does not carry is simply absent, never a zero row.
  assert.equal(out.series.length, 2);
});

test('a vintage without a readable publication date is an error, not an empty result', () => {
  const noDate = VINTAGE.replace(/ PUBLICATION_DATE="[^"]*"/, '');
  assert.throws(() => parseImfFiscal(noDate), /PUBLICATION_DATE/);
  assert.throws(() => parseImfFiscal(VINTAGE.replace('2025-10-15T12:45:00Z', 'not-a-date')), /PUBLICATION_DATE/);
});

test('a non-numeric observation is skipped, not shipped as NaN', () => {
  const withNaN = VINTAGE.replace('OBS_VALUE="14.5461"', 'OBS_VALUE="NaN"');
  const out = parseImfFiscal(withNaN, ['G1_S13_POGDP_PT']);
  assert.deepEqual(
    out.series[0].points.map((p) => p.year),
    ['2010']
  );
});

test('an empty vintage body yields no series rather than throwing', () => {
  const empty = `<message:StructureSpecificData><message:Header><message:Structure structureID="IMF.FAD_FM_2025_OCT_VINTAGE_1_0_0"/></message:Header><message:DataSet PUBLICATION_DATE="2025-10-15T12:45:00Z"/></message:StructureSpecificData>`;
  const out = parseImfFiscal(empty);
  assert.deepEqual(out.series, []);
  assert.equal(out.droppedProjections, 0);
});

test('the newest dated vintage wins; the undated FM flow is never selected', () => {
  const catalogue = {
    data: {
      dataflows: [
        { id: 'FM', version: '5.0.0', name: 'Fiscal Monitor (FM)' },
        { id: 'FM_2025_APR_VINTAGE', version: '1.0.0' },
        { id: 'FM_2025_OCT_VINTAGE', version: '1.0.0' },
        { id: 'HPD', version: '1.0.0' },
        { id: 'FM_2024_OCT_VINTAGE', version: '1.0.0' },
      ],
    },
  };
  assert.deepEqual(pickLatestVintage(catalogue), { id: 'FM_2025_OCT_VINTAGE', version: '1.0.0' });
});

test('a catalogue with no dated vintage is null, not a guess', () => {
  assert.equal(pickLatestVintage({ data: { dataflows: [{ id: 'FM', version: '5.0.0' }] } }), null);
  assert.equal(pickLatestVintage({ data: {} }), null);
  assert.equal(pickLatestVintage(null), null);
  assert.equal(pickLatestVintage({ data: { dataflows: [{ id: 'FM_2025_OCT_VINTAGE' }] } }), null);
});
