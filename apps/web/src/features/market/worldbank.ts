/**
 * World Bank indicators (API v2) — keyless, public.
 *
 * `https://api.worldbank.org/v2/country/<ISO3+ISO3+…>/indicator/<ID>?format=json`
 * answers annual country indicators. Three measured properties shape this module:
 *
 *  - ONE indicator per call. The documented `;`-separated indicator list is
 *    rejected with `{"message":[{"key":"Invalid value"}]}` (measured), so a board
 *    of N indicators is N calls, not one. Multiple COUNTRIES do batch, though
 *    (`IDN;WLD` works), which is why the worldwide board costs one call per
 *    indicator rather than one per country.
 *  - A country whose latest year is not yet published comes back as `null` for
 *    that year. The newest NON-NULL observation is used, and its year is reported
 *    alongside — a 2023 figure must never be printed as if it were 2025's.
 *  - The API is FAST and tolerates concurrency (32 simultaneous calls answered
 *    200 in 0.7s, measured), while the shared limiter serialises everything into
 *    a ~2s-per-call chain. These calls therefore go through their own pool
 *    (`lib/pool.ts`), not the limiter; the memo below still gives them
 *    the long TTL and single-flight they need.
 *
 * The response is JSON, so it is cacheable — but the limiter's cache is bypassed
 * with the limiter, which is why the memo here is the only cache these reads have.
 */
import { memo } from './bis';
import { createFetchPool } from '@/lib/http';
import { SOURCE_UA } from './bis';

/** World Bank API v2 root. */
export const WORLDBANK_API = 'https://api.worldbank.org/v2';

/** Annual series: a day's staleness is irrelevant, an hour is plenty. */
export const WORLDBANK_TTL_MS = 60 * 60_000;

/** Concurrent World Bank calls. Measured safe well past this; 6 keeps the board
 *  to a couple of seconds without leaning on the upstream's patience. */
export const WORLDBANK_POOL = 6;

const TIMEOUT_MS = 30_000;

/** The one lane every World Bank call in this process shares. */
const wbFetch = createFetchPool(WORLDBANK_POOL, TIMEOUT_MS);

/**
 * How far back the board looks for a comparison point, and the minimum span it
 * will accept. A cell's "change" is the newest observation within a year of
 * `latest - DELTA_TARGET_YEARS`; anything closer than `MIN_DELTA_SPAN_YEARS` is
 * refused, because a change over two years is not a trend and printing it beside
 * a genuine decade change would make the two look alike.
 */
export const DELTA_TARGET_YEARS = 10;
export const MIN_DELTA_SPAN_YEARS = 8;

/** ISO3 codes batched into one request (`;`-joined, as the API expects). */
export function worldBankUrl(indicator: string, countries: readonly string[], fromYear: number): string {
  const to = new Date().getUTCFullYear();
  const p = new URLSearchParams({
    format: 'json',
    per_page: String(Math.max(50, countries.length * (to - fromYear + 1) * 2)),
    date: `${fromYear}:${to}`,
  });
  return `${WORLDBANK_API}/country/${countries.join(';')}/indicator/${indicator}?${p}`;
}

/** One observation: a value and the year it was published for. */
export type WorldBankPoint = { year: string; value: number };

/** One country's latest published observation of an indicator. */
export type WorldBankObs = { country: string; countryName: string; year: string; value: number };

/** One country's latest observation plus an earlier one to compare it against. */
export type WorldBankSeries = {
  country: string;
  countryName: string;
  /** Newest non-null observation in the window. */
  latest: WorldBankPoint;
  /**
   * The observation `DELTA_TARGET_YEARS` earlier (±1 year), for a decade change.
   * Null when the window holds no observation at least `MIN_DELTA_SPAN_YEARS`
   * before `latest` — a series that only just started has no trend to show, and
   * inventing one from two adjacent years would be worse than showing nothing.
   */
  prior: WorldBankPoint | null;
  /**
   * Every observation in the window, ascending by year — the list `latest` and
   * `prior` were picked FROM. Carried so a caller can align two series on a
   * COMMON year: a fiscal balance computed from a 2024 revenue and a 2023
   * expense is not any year's balance. The upstream's own cash-balance series
   * would save the work but only exists in an archived source this API no longer
   * serves (`GC.BAL.CASH.GD.ZS` -> `Invalid format` on the data endpoint,
   * measured), so the alignment is done here instead.
   */
  points: readonly WorldBankPoint[];
};

type RawRow = {
  // NOTE: `country.id` is the ISO2 code ("BR"), NOT the ISO3 the request was
  // scoped to ("BRA") — keying on it silently matches nothing. The ISO3 lives in
  // `countryiso3code`, which is what this module keys and looks up on.
  country?: { id?: string; value?: string };
  countryiso3code?: string;
  date?: string;
  value?: number | null;
};

/**
 * The comparison pair for an ASCENDING observation list: the newest point and
 * the one closest to `DELTA_TARGET_YEARS` earlier, refusing any span under
 * `MIN_DELTA_SPAN_YEARS`. Shared by the parsed upstream series and by series
 * DERIVED from them, so both apply the same span rule — a derived column whose
 * change was computed by different rules would not be comparable with its
 * neighbours.
 *
 * Caller must pass a non-empty list.
 */
export function pickLatestAndPrior(points: readonly WorldBankPoint[]): {
  latest: WorldBankPoint;
  prior: WorldBankPoint | null;
} {
  const latest = points[points.length - 1];
  const latestYear = Number(latest.year);
  let prior: WorldBankPoint | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const span = latestYear - Number(p.year);
    if (span < MIN_DELTA_SPAN_YEARS) continue;
    const gap = Math.abs(span - DELTA_TARGET_YEARS);
    // `<` (not `<=`) keeps the FIRST year at a given distance, i.e. the
    // earliest when two are equidistant — the longer, more conservative span.
    if (gap < bestGap) {
      bestGap = gap;
      prior = p;
    }
  }
  return { latest, prior };
}

/**
 * The full per-country series in the window, each reduced to its newest
 * observation and a decade-earlier comparison point.
 *
 * Returned in the order of `countries` so the board's row order is curated, not
 * the upstream's. A country with no published value in the window is dropped.
 *
 * `nameMap` (exact upstream `country.value` -> the code the request was scoped
 * to) exists for the INCOME-GROUP aggregates only: High income / Low income /
 * Lower- and Upper-middle income come back with `countryiso3code` as an EMPTY
 * STRING (not absent), so `??` keeps `''` and the row is dropped, while
 * `country.id` is an internal code (`XD`, `XM`, `XN`, `XT`) that is NOT the
 * requested one — the name is the only field that maps back. Countries and the
 * other aggregates carry a real iso3 and never consult the map.
 */
export function parseWorldBankSeries(
  json: unknown,
  countries: readonly string[],
  nameMap?: Readonly<Record<string, string>>
): WorldBankSeries[] {
  if (!Array.isArray(json)) return [];
  // An API-level rejection arrives as a ONE-element array ([{message:[…]}]), not
  // as a non-200 — so a short array is an error to surface, not an empty result.
  if (json.length < 2 || !Array.isArray(json[1])) {
    throw new Error(`World Bank error payload: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const rows = json[1] as RawRow[];
  const points = new Map<string, WorldBankPoint[]>();
  const names = new Map<string, string>();
  for (const r of rows) {
    const name = r.country?.value;
    // `||` throughout, never `??`: the income-group aggregates ship an empty
    // string, which `??` would pass through as a (falsy but defined) id.
    const id = r.countryiso3code || (name && nameMap?.[name]) || r.country?.id;
    if (!id || typeof r.value !== 'number' || !Number.isFinite(r.value)) continue;
    const year = r.date ?? '';
    // Only a four-digit year can be compared or printed as one; anything else is
    // a malformed row and would sort wrongly against real years.
    if (!/^\d{4}$/.test(year)) continue;
    const list = points.get(id);
    if (list) list.push({ year, value: r.value });
    else points.set(id, [{ year, value: r.value }]);
    if (name && !names.has(id)) names.set(id, name);
  }

  return countries.flatMap((code) => {
    const list = points.get(code);
    if (!list || list.length === 0) return [];
    // Ascending by year, so the last entry is the newest. String compare is safe
    // because every year here matched /^\d{4}$/.
    list.sort((a, b) => (a.year < b.year ? -1 : a.year > b.year ? 1 : 0));
    return [
      { country: code, countryName: names.get(code) ?? code, ...pickLatestAndPrior(list), points: list },
    ];
  });
}

/** Fetch + memoise one indicator's full series for a fixed country list. */
export async function fetchWorldBankSeries(
  indicator: string,
  countries: readonly string[],
  fromYear: number,
  nameMap?: Readonly<Record<string, string>>
): Promise<WorldBankSeries[]> {
  const url = worldBankUrl(indicator, countries, fromYear);
  return memo(`wb:${indicator}:${url}`, WORLDBANK_TTL_MS, async () => {
    const res = await wbFetch(url, { headers: { 'User-Agent': SOURCE_UA } });
    if (!res.ok) throw new Error(`World Bank upstream ${res.status}`);
    return parseWorldBankSeries(await res.json(), countries, nameMap);
  });
}

/** Fetch + memoise one indicator's newest observation per country. */
export async function fetchWorldBank(
  indicator: string,
  countries: readonly string[],
  fromYear: number,
  nameMap?: Readonly<Record<string, string>>
): Promise<WorldBankObs[]> {
  const series = await fetchWorldBankSeries(indicator, countries, fromYear, nameMap);
  return series.map((s) => ({
    country: s.country,
    countryName: s.countryName,
    year: s.latest.year,
    value: s.latest.value,
  }));
}
