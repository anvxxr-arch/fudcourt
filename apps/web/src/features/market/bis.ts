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
import { limitedFetch } from '@/lib/rate-limit';

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

/**
 * A tiny in-process TTL cache with single-flight and stale-while-revalidate, for
 * the CSV/text macro feeds.
 *
 * The shared limiter (`lib/rate-limit.ts`) micro-caches only bodies it
 * can `JSON.parse`. BIS and FRED answer CSV, so those responses are never cached
 * there and every board reload would re-hit upstream. These series move daily at
 * most, so a long TTL is correct — and the in-flight map means N simultaneous
 * reloads cost one upstream call, not N.
 *
 * Revalidate is STALE-WHILE-REVALIDATE, not blocking, because the limiter
 * serialises every upstream call through one chain with a minimum gap: a cold
 * board of ~19 memoised series pays each one's latency in turn (measured ~20s
 * for the macro route). Serving the previous value while the refresh runs means
 * only the first-ever request pays that, and every later one is instant.
 *
 * Scope matches the limiter's: per Node process, which is what one `next start`
 * gives us. Rejections are never cached, so a transient upstream failure is
 * retried on the next request rather than pinned for the whole window.
 */
type Entry = { at: number; value: unknown };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * How far past its TTL a value may still be SERVED while a refresh runs in the
 * background. Without a bound, an upstream that has been down for days would be
 * papered over with a very old body indefinitely; past this the caller waits for
 * a live read instead. Expressed as a multiple of the entry's own TTL, so one
 * rule fits a short quote cache and a 1-hour annual series.
 */
const STALE_MULTIPLIER = 6;

/** Start (and register) one run, storing its value on success. */
function refresh<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = fn()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}

/** Resolve `fn()` once per `key` per `ttlMs`; concurrent callers share one run. */
export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit) {
    const age = Date.now() - hit.at;
    // Fresh — serve without touching upstream.
    if (age < ttlMs) return Promise.resolve(hit.value as T);
    // Stale but recent enough to serve: hand back the old value NOW and refresh
    // in the background. Deliberately not awaited, and a failed refresh is
    // swallowed (the run is never stored, so the next call retries) — a
    // stale-but-real body beats turning a working board into an error page. A
    // later caller while that refresh is in flight still gets the stale value
    // rather than blocking on it, which is the whole point.
    if (age < ttlMs * STALE_MULTIPLIER) {
      if (!inflight.has(key)) refresh(key, fn).catch(() => {});
      return Promise.resolve(hit.value as T);
    }
  }
  // No usable entry (or one too old to serve): single-flight a blocking read.
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  return refresh(key, fn);
}

/** Test seam: drop memoised macro-feed values and in-flight memo runs. */
export function __resetMemo() {
  store.clear();
  inflight.clear();
}
