/**
 * World Bank indicators (API v2) — keyless, public.
 *
 * `https://api.worldbank.org/v2/country/<ISO3+ISO3+…>/indicator/<ID>?format=json`
 * answers annual country indicators. Two measured properties shape this module:
 *
 *  - ONE indicator per call. The documented `;`-separated indicator list is
 *    rejected with `{"message":[{"key":"Invalid value"}]}` (measured), so a board
 *    of N indicators is N calls, not one. Multiple COUNTRIES do batch, though
 *    (`IDN;WLD` works), which is why the global comparison costs one call per
 *    indicator rather than one per country.
 *  - A country whose latest year is not yet published comes back as `null` for
 *    that year. The newest NON-NULL observation is used, and its year is reported
 *    alongside — a 2023 figure must never be printed as if it were 2025's.
 *
 * The response is JSON, so the shared limiter caches it too; the memo here gives
 * the longer TTL these annual series deserve.
 */
import { limitedFetch } from '@/platform/http/rate-limit';
import { memo } from './ttl';
import { SOURCE_UA } from './bis';

/** World Bank API v2 root. */
export const WORLDBANK_API = 'https://api.worldbank.org/v2';

/** Annual series: a day's staleness is irrelevant, an hour is plenty. */
export const WORLDBANK_TTL_MS = 60 * 60_000;

const TIMEOUT_MS = 30_000;

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

/** One country's latest published observation of an indicator. */
export type WorldBankObs = { country: string; countryName: string; year: string; value: number };

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
 * Newest non-null observation per country.
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
export function parseWorldBank(
  json: unknown,
  countries: readonly string[],
  nameMap?: Readonly<Record<string, string>>
): WorldBankObs[] {
  if (!Array.isArray(json)) return [];
  // An API-level rejection arrives as a ONE-element array ([{message:[…]}]), not
  // as a non-200 — so a short array is an error to surface, not an empty result.
  if (json.length < 2 || !Array.isArray(json[1])) {
    throw new Error(`World Bank error payload: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const rows = json[1] as RawRow[];
  const best = new Map<string, WorldBankObs>();
  for (const r of rows) {
    const name = r.country?.value;
    // `||` throughout, never `??`: the income-group aggregates ship an empty
    // string, which `??` would pass through as a (falsy but defined) id.
    const id = r.countryiso3code || (name && nameMap?.[name]) || r.country?.id;
    if (!id || typeof r.value !== 'number' || !Number.isFinite(r.value)) continue;
    const year = r.date ?? '';
    const prev = best.get(id);
    if (!prev || year > prev.year) {
      best.set(id, { country: id, countryName: r.country?.value ?? id, year, value: r.value });
    }
  }
  return countries.map((c) => best.get(c)).filter((r): r is WorldBankObs => r !== undefined);
}

/** Fetch + memoise one indicator for a fixed country list. */
export async function fetchWorldBank(
  indicator: string,
  countries: readonly string[],
  fromYear: number,
  nameMap?: Readonly<Record<string, string>>
): Promise<WorldBankObs[]> {
  const url = worldBankUrl(indicator, countries, fromYear);
  return memo(`wb:${indicator}:${url}`, WORLDBANK_TTL_MS, async () => {
    const res = await limitedFetch(url, {
      headers: { 'User-Agent': SOURCE_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`World Bank upstream ${res.status}`);
    return parseWorldBank(await res.json(), countries, nameMap);
  });
}
