/**
 * FRED (St. Louis Fed) macro series — keyless, public.
 *
 * `https://fred.stlouisfed.org/graph/fredgraph.csv?id=<SERIES>&cosd=<date>`
 * answers a two-column CSV (`observation_date,<SERIES>`) without an API key.
 * `cosd` (start date) is passed so a request carries the tail the transform
 * needs, not the series' whole history.
 *
 * Honest-by-construction: FRED writes `.` for a missing observation and leaves
 * the field blank for a not-yet-published one; both are skipped rather than read
 * as 0. A transform that needs a point the window does not carry returns null
 * (the UI renders '—') instead of computing a different number over a shorter
 * span.
 *
 * The response is CSV, which the shared limiter does not cache, so the shaped
 * result is memoised here for `FRED_TTL_MS`.
 */
import { limitedFetch } from '@/lib/rate-limit';
import { memo } from './bis';
import { SOURCE_UA } from './bis';

/** FRED's public CSV graph endpoint — no API key required (measured). */
export const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

/** These series publish monthly/quarterly; half an hour is ample. */
export const FRED_TTL_MS = 30 * 60_000;

const TIMEOUT_MS = 25_000;

/** The CSV URL for one series from `cosd` (an ISO date) forward. */
export function fredUrl(seriesId: string, cosd: string): string {
  const p = new URLSearchParams({ id: seriesId, cosd });
  return `${FRED_CSV}?${p}`;
}

export type FredObs = { date: string; value: number };

/** Parse `observation_date,SERIES` CSV; `.` and blanks are missing, not zero. */
export function parseFredCsv(text: string): FredObs[] {
  const out: FredObs[] = [];
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const comma = lines[i].indexOf(',');
    if (comma < 0) continue;
    const date = lines[i].slice(0, comma).trim();
    const raw = lines[i].slice(comma + 1).trim();
    if (!date || raw === '' || raw === '.') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) out.push({ date, value });
  }
  return out;
}

/** How a series' observations reduce to the one headline number the board shows. */
export type FredShape = 'level' | 'yoy' | 'change';

/**
 * Reduce a series to its headline number.
 *
 * - `level`  -> the latest value as published.
 * - `yoy`    -> percent change against the observation `lag` rows back (12 for a
 *               monthly series' year-ago point, 4 for a quarterly one).
 * - `change` -> the difference against the previous observation (e.g. payrolls).
 *
 * `lag` must be given by the caller: guessing a frequency from date spacing is
 * how a quarterly series silently gets a 12-month "YoY" that is really 3 years.
 */
export function shapeFred(obs: FredObs[], shape: FredShape, lag: number): { value: number; date: string } | null {
  if (obs.length === 0) return null;
  const last = obs[obs.length - 1];
  if (shape === 'level') return { value: last.value, date: last.date };
  if (lag < 1 || obs.length <= lag) return null;
  const base = obs[obs.length - 1 - lag];
  if (shape === 'change') return { value: last.value - base.value, date: last.date };
  if (base.value === 0) return null;
  return { value: (last.value / base.value - 1) * 100, date: last.date };
}

/** Fetch + memoise a shaped FRED series; `cosd` should cover `lag` rows back. */
export async function fetchFred(
  seriesId: string,
  cosd: string,
  shape: FredShape,
  lag: number
): Promise<{ value: number; date: string } | null> {
  const url = fredUrl(seriesId, cosd);
  return memo(`fred:${seriesId}:${shape}:${lag}:${cosd}`, FRED_TTL_MS, async () => {
    const res = await limitedFetch(url, {
      headers: { 'User-Agent': SOURCE_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`FRED upstream ${res.status}`);
    return shapeFred(parseFredCsv(await res.text()), shape, lag);
  });
}
