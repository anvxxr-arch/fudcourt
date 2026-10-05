/**
 * IMF Fiscal Monitor (SDMX 2.1) — keyless, public.
 *
 * `https://api.imf.org/external/sdmx/2.1/data/IMF.FAD,<vintage>,<ver>/<ISO3>..A`
 * answers general-government fiscal aggregates. The World Bank publishes NONE of
 * these for Indonesia (every government-finance indicator answers `obs=0` on the
 * raw API, measured), so this is the source that fills that gap — and it is the
 * only one found that is simultaneously keyless, machine-readable and stable.
 *
 * Four measured properties shape this module:
 *
 *  - **The `FM` "latest" dataflow is EMPTY.** `IMF.FAD,FM,5.0.0/IDN.G1_…` answers
 *    200 with a DataSet carrying no Series, for every country tried. Only a
 *    DATED VINTAGE flow serves data, and the vintage id is discovered from the
 *    dataflow catalogue (`…/dataflow/IMF.FAD/all/latest`, 12 KB) rather than
 *    hardcoded — a hardcoded `FM_2025_OCT_VINTAGE` would silently freeze the
 *    board on one edition forever.
 *  - **The key order is `COUNTRY.INDICATOR.FREQUENCY`**, not the
 *    `FREQUENCY.COUNTRY.INDICATOR` order the older IMF host used. A wrong order
 *    is not a 400: it answers 200 with an empty DataSet, which reads exactly like
 *    "this country has no data".
 *  - **An empty INDICATOR segment (`IDN..A`) returns EVERY indicator in one
 *    call** — 8 series, 21 observations each, ~21 KB. One call per country, not
 *    one per indicator.
 *  - **The payload is SDMX-ML only.** `format=jsondata` and an SDMX-JSON Accept
 *    header are both ignored (the latter 500s), so the parse below is regex over
 *    a flat, self-closing structure rather than a JSON read.
 *
 * ## The actual/projection boundary
 *
 * A vintage runs to 2030 and **carries no flag that separates an outturn from a
 * forecast**: the DSD has no OBS_STATUS attribute (the `CL_OBS_STATUS` codelist
 * exists but is never referenced), and `DERIVATION_TYPE` is the constant `"M"`
 * ("Mixed-type data") on every observation of every country probed — measured
 * over IDN, USA, DEU, BRA and JPN, 2018-2030, all `M`. A board that printed
 * "newest non-null" would therefore show a 2030 projection as the current value.
 *
 * So the boundary is derived from the one field that IS populated and
 * unambiguous — the vintage's own `PUBLICATION_DATE` — and it is a necessity,
 * not a guess: **a vintage cannot contain an actual for a fiscal year that had
 * not yet ended when the vintage was published.** The October 2025 vintage
 * (published 2025-10-15) is therefore actual through 2024, and every later
 * observation is dropped here rather than exposed. Callers get `actualThrough`
 * and `droppedProjections` so they can say so out loud.
 */
import { memo } from './bis';
import { getJSON, getText } from '@/lib/fetch';
import { SOURCE_UA } from './bis';

/** IMF SDMX 2.1 data endpoint (the host that actually serves the vintages). */
export const IMF_SDMX = 'https://api.imf.org/external/sdmx/2.1/data';

/** Dataflow catalogue for the IMF's Fiscal Affairs Department. 12 KB, no refs. */
export const IMF_DATAFLOW_CATALOGUE = 'https://api.imf.org/external/sdmx/2.1/dataflow/IMF.FAD/all/latest';

/** Agency that owns the Fiscal Monitor dataflows. */
export const IMF_FM_AGENCY = 'IMF.FAD';

/**
 * The vintage to fall back on when the catalogue cannot be read. Kept only as a
 * degraded mode — the normal path discovers the newest published edition.
 */
export const IMF_FM_FALLBACK = { id: 'FM_2025_OCT_VINTAGE', version: '1.0.0' } as const;

/** A fiscal vintage changes twice a year; six hours is far more than enough. */
export const IMF_TTL_MS = 6 * 60 * 60_000;

const TIMEOUT_MS = 30_000;

/** One observation: a value and the fiscal year it was published for. */
export type ImfPoint = { year: string; value: number };

/** One indicator's ACTUAL observations, ascending by year. */
export type ImfSeries = { indicator: string; points: readonly ImfPoint[] };

/** What a vintage read yields: the actuals, plus the boundary that produced them. */
export type ImfFiscal = {
  /** The dated dataflow the values came from, e.g. `FM_2025_OCT_VINTAGE`. */
  vintage: string;
  /** The vintage's own `PUBLICATION_DATE`, ISO-8601, verbatim from upstream. */
  published: string;
  /** Last fiscal year this vintage could report as an outturn (publicationYear - 1). */
  actualThrough: number;
  /** Observations dropped as projections/estimates — reported, never silently lost. */
  droppedProjections: number;
  /** One entry per requested indicator that the vintage carries. */
  series: readonly ImfSeries[];
};

/** A vintage id as the catalogue spells it, e.g. `FM_2025_OCT_VINTAGE`. */
const VINTAGE_ID = /^FM_(\d{4})_([A-Z]{3})_VINTAGE$/;

/**
 * The newest Fiscal Monitor vintage in a catalogue body, or null.
 *
 * Months sort chronologically under plain string compare (JAN < FEB < … < DEC),
 * so the id itself orders the editions; no date parsing is needed. Only dated
 * vintages qualify — the undated `FM` flow answers no data at all (measured).
 */
export function pickLatestVintage(
  catalogue: unknown
): { id: string; version: string } | null {
  const flows = (catalogue as { data?: { dataflows?: unknown } })?.data?.dataflows;
  if (!Array.isArray(flows)) return null;
  let best: { id: string; version: string } | null = null;
  for (const f of flows) {
    const id = (f as { id?: unknown })?.id;
    if (typeof id !== 'string' || !VINTAGE_ID.test(id)) continue;
    const version = (f as { version?: unknown })?.version;
    if (typeof version !== 'string' || version === '') continue;
    if (!best || id > best.id) best = { id, version };
  }
  return best;
}

/** The data URL for one country, every indicator, from `fromYear` forward. */
export function imfFiscalUrl(flow: { id: string; version: string }, country: string, fromYear: number): string {
  const p = new URLSearchParams({ startPeriod: String(fromYear) });
  return `${IMF_SDMX}/${IMF_FM_AGENCY},${flow.id},${flow.version}/${country}..A?${p}`;
}

/** The year part of an ISO-8601 timestamp, or null when it is not one. */
function isoYear(stamp: string): number | null {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(stamp);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

/**
 * Parse one vintage response into per-indicator ACTUALS.
 *
 * `only` (optional) restricts the result to a curated indicator list and fixes
 * its order — the board's row order is curated, not the upstream's. An indicator
 * the vintage does not carry is simply absent.
 *
 * Throws when the body carries no readable `PUBLICATION_DATE`: without it the
 * actual/projection boundary cannot be established, and returning the raw series
 * would hand the caller 2030 projections to print as current values.
 */
export function parseImfFiscal(xml: string, only?: readonly string[]): ImfFiscal {
  const vintageMatch = /structureID="([^"]*)"/.exec(xml);
  const vintage = vintageMatch ? vintageMatch[1].replace(/^IMF\.FAD_/, '').replace(/_\d+_\d+_\d+$/, '') : '';
  const publishedMatch = /PUBLICATION_DATE="([^"]*)"/.exec(xml);
  if (!publishedMatch) {
    throw new Error('IMF vintage carried no PUBLICATION_DATE — actuals cannot be separated from projections');
  }
  const published = publishedMatch[1];
  const pubYear = isoYear(published);
  if (pubYear === null) {
    throw new Error(`IMF vintage carried an unreadable PUBLICATION_DATE: ${published}`);
  }
  // The last fiscal year that had ENDED when the vintage was published.
  const actualThrough = pubYear - 1;

  const want = only ? new Set(only) : null;
  const series: ImfSeries[] = [];
  let droppedProjections = 0;

  for (const [, attrs, body] of xml.matchAll(/<Series ([^>]*)>([\s\S]*?)<\/Series>/g)) {
    const id = /INDICATOR="([^"]*)"/.exec(attrs)?.[1];
    if (!id || (want && !want.has(id))) continue;
    const points: ImfPoint[] = [];
    for (const obs of body.matchAll(/<Obs ([^>]*?)\/?>/g)) {
      const year = /TIME_PERIOD="([^"]*)"/.exec(obs[1])?.[1];
      const raw = /OBS_VALUE="([^"]*)"/.exec(obs[1])?.[1];
      if (!year || raw === undefined) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      // `<=` on the numeric year, so a projected year is DROPPED here and never
      // reaches a caller that would print it beside a real outturn.
      if (Number(year) > actualThrough) {
        droppedProjections += 1;
        continue;
      }
      points.push({ year, value });
    }
    points.sort((a, b) => (a.year < b.year ? -1 : a.year > b.year ? 1 : 0));
    if (points.length > 0) series.push({ indicator: id, points });
  }

  if (only) {
    const order = new Map(only.map((id, i) => [id, i]));
    series.sort((a, b) => (order.get(a.indicator) ?? 0) - (order.get(b.indicator) ?? 0));
  }

  return { vintage, published, actualThrough, droppedProjections, series };
}

/** Fetch the newest vintage id + version, memoised. Falls back to a pinned one. */
async function latestVintage(): Promise<{ id: string; version: string }> {
  return memo('imf:vintages', IMF_TTL_MS, async () => {
    const picked = pickLatestVintage(await getJSON<unknown>(IMF_DATAFLOW_CATALOGUE, {
      headers: { Accept: 'application/vnd.sdmx.structure+json;version=1.0.0', 'User-Agent': SOURCE_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
    if (!picked) throw new Error('IMF catalogue carried no dated Fiscal Monitor vintage');
    return picked;
  });
}

/**
 * Fetch + memoise one country's fiscal actuals from the newest vintage.
 *
 * The catalogue read is the only fallible discovery step: if it fails, the pinned
 * `IMF_FM_FALLBACK` is used rather than failing the whole board — a board on a
 * known-good edition beats no board. A failure of the DATA read is not swallowed:
 * it throws, and the caller reports the block as withheld.
 */
export async function fetchImfFiscal(
  country: string,
  fromYear: number,
  only?: readonly string[]
): Promise<ImfFiscal> {
  let flow: { id: string; version: string };
  try {
    flow = await latestVintage();
  } catch {
    flow = { ...IMF_FM_FALLBACK };
  }
  const url = imfFiscalUrl(flow, country, fromYear);
  return memo(`imf:${url}`, IMF_TTL_MS, async () => {
    const xml = await getText(url, {
      headers: { 'User-Agent': SOURCE_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return parseImfFiscal(xml, only);
  });
}
