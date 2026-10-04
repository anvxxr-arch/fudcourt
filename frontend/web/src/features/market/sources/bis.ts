/**
 * BIS central-bank policy rates (WS_CBPOL, daily) — keyless, public.
 *
 * `https://stats.bis.org/api/v1/data/WS_CBPOL/D.<AREA+AREA+…>?format=csv` answers
 * the daily policy rate for each requested area. Two measured quirks drive this
 * module:
 *
 *  - the endpoint answers `406 Not Acceptable` without an explicit SDMX Accept
 *    header (a bare `Accept: *​/*` is rejected), so `BIS_ACCEPT` is mandatory;
 *  - a non-reporting area comes back as `NaN` or an empty `OBS_VALUE` rather than
 *    being omitted, so both are skipped — an area with no usable observation is
 *    absent from the result, never present as `NaN`.
 *
 * The response is CSV, which the shared limiter does not cache (it caches JSON),
 * so the parsed result is memoised here for `BIS_TTL_MS`.
 */
import { limitedFetch } from '@/platform/http/rate-limit';
import { memo } from './ttl';

/** BIS SDMX v1 data endpoint for the central-bank policy-rate dataflow. */
export const BIS_CBPOL = 'https://stats.bis.org/api/v1/data/WS_CBPOL';

/** BIS rejects the request without this exact Accept header (measured: 406). */
export const BIS_ACCEPT = 'application/vnd.sdmx.data+csv;version=1.0.0';

/** A policy rate changes at most every few weeks; half an hour is ample. */
export const BIS_TTL_MS = 30 * 60_000;

/** What every outbound source here identifies as. */
export const SOURCE_UA = 'Mozilla/5.0 (compatible; FUDCOURT/1.0; +https://fc.dwirijal.my.id)';

const TIMEOUT_MS = 25_000;

/** One central bank's policy rate. `rate` is percent per annum. */
export type PolicyRate = { area: string; rate: number; date: string };

/** An ISO date `days` before `now` — keeps the CSV body to the recent tail. */
export function daysAgo(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The data URL for a fixed area list, from `startPeriod` forward. */
export function bisUrl(areas: readonly string[], startPeriod: string): string {
  const p = new URLSearchParams({ format: 'csv', startPeriod });
  return `${BIS_CBPOL}/D.${areas.join('+')}?${p}`;
}

/**
 * Keep the latest usable observation per requested area.
 *
 * Returned in the order of `areas` so the board's row order is the curated one,
 * not the upstream's. An area the window carries no value for is dropped.
 */
export function parseBisCsv(text: string, areas: readonly string[]): PolicyRate[] {
  const want = new Set(areas);
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const iArea = header.indexOf('REF_AREA');
  const iTime = header.indexOf('TIME_PERIOD');
  const iVal = header.indexOf('OBS_VALUE');
  if (iArea < 0 || iTime < 0 || iVal < 0) return [];

  const best = new Map<string, PolicyRate>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length <= iVal) continue;
    const area = cols[iArea];
    if (!want.has(area)) continue;
    const raw = cols[iVal];
    if (!raw || raw === 'NaN') continue;
    const rate = Number(raw);
    if (!Number.isFinite(rate)) continue;
    const date = cols[iTime];
    const prev = best.get(area);
    if (!prev || date > prev.date) best.set(area, { area, rate, date });
  }
  return areas.map((a) => best.get(a)).filter((r): r is PolicyRate => r !== undefined);
}

/**
 * Fetch + memoise the policy rates for a fixed area list.
 *
 * A 60-day window is used rather than a few days: several central banks (Korea,
 * for one) report monthly, so a short window would silently drop them.
 */
export async function fetchPolicyRates(areas: readonly string[]): Promise<PolicyRate[]> {
  const url = bisUrl(areas, daysAgo(60));
  return memo(`bis:${url}`, BIS_TTL_MS, async () => {
    const res = await limitedFetch(url, {
      headers: { Accept: BIS_ACCEPT, 'User-Agent': SOURCE_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`BIS upstream ${res.status}`);
    return parseBisCsv(await res.text(), areas);
  });
}
