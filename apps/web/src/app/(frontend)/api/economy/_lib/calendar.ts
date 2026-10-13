/**
 * The economic calendar's computation, extracted from the route so the boot
 * warm (src/instrumentation.ts) can prime the exact payload a default request
 * asks for -- and so every request shares one memoised run instead of fanning
 * out over the candidate series again.
 *
 * The fan-out is wide (every importance>=3 series, ~900 of them), so a cold run
 * is seconds when the upstreams are healthy and minutes when one degrades (each
 * stalled World Bank call used to hold its wave for the pool timeout). The
 * response is deterministic for a given window within CALENDAR_TTL_SECONDS, so
 * it is memoised -- single-flight, stale-while-revalidate -- on that key: the
 * first reader pays the fan-out, everyone else, including the post-deploy warm,
 * gets the cached body.
 */
import { INDICATORS } from '@/features/economy/model';
import { readObservations } from '@/app/(frontend)/api/economy/_lib/adapters';
import { mapPool, toReleaseRow } from '@/app/(frontend)/api/economy/_lib/rows';
import { memo } from '@/features/market/bis';

/**
 * How long the release log may be reused. The events are reference periods of
 * values that already exist, read through FRED/World Bank/BIS memos of 30
 * minutes or more, so a 300s window cannot expose a release the source has not
 * published.
 */
export const CALENDAR_TTL_SECONDS = 300;

/** Days of history a calendar request spans by default. */
export const DEFAULT_WINDOW_DAYS = 120;

type ReleaseRow = ReturnType<typeof toReleaseRow>;

export type CalendarPayload = {
  events: ReleaseRow[];
  total: number;
  failed: { symbol: string; reason: string }[];
  candidates: number;
};

/** The default `[from, to]` reference-period window ending today. */
export function calendarWindow(now: Date): { from: string; to: string } {
  const from = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return { from, to: now.toISOString().slice(0, 10) };
}

/** The memo key for one query; the route and the boot warm must agree on it. */
export function calendarKey(from: string, to: string, country: string, category: string, importance: number): string {
  return `calendar:${from}:${to}:${country}:${category}:${importance}`;
}

async function computeCalendar(
  from: string,
  to: string,
  country: string,
  category: string,
  importance: number
): Promise<CalendarPayload> {
  // Only market-moving series belong on a calendar; a country's whole registry
  // would drown the events that matter.
  const candidates = INDICATORS.filter((i) => {
    if (i.importance < 3) return false;
    if (country && i.country !== country) return false;
    if (category && i.category !== category) return false;
    if (importance && i.importance !== importance) return false;
    return true;
  });

  const failed: { symbol: string; reason: string }[] = [];
  const events = await mapPool(candidates, 8, async (ind) => {
    try {
      const obs = await readObservations(ind);
      const row = toReleaseRow(ind, obs);
      return row.actual !== null && row.releaseAt !== null && row.releaseAt >= from && row.releaseAt <= to ? row : null;
    } catch (e) {
      failed.push({ symbol: `${ind.source}:${ind.slug}`, reason: e instanceof Error ? e.message : String(e) });
      return null;
    }
  });

  const out = events.filter((e): e is NonNullable<typeof e> => e !== null);
  out.sort((a, b) => String(b.releaseAt).localeCompare(String(a.releaseAt)));
  return { events: out, total: out.length, failed, candidates: candidates.length };
}

/**
 * The memoised calendar for one query. The single entry point the route and the
 * boot warm both use, so a warm run and a live request share one fan-out.
 */
export function calendar(
  from: string,
  to: string,
  country: string,
  category: string,
  importance: number
): Promise<CalendarPayload> {
  return memo(calendarKey(from, to, country, category, importance), CALENDAR_TTL_SECONDS * 1000, () =>
    computeCalendar(from, to, country, category, importance)
  );
}

/**
 * Prime the default window's payload so the first post-deploy request is a memo
 * hit instead of the whole fan-out. Best-effort: a throw leaves the cold-miss
 * inline path as the fallback. Returns the event count for one log line.
 */
export async function warmCalendar(): Promise<number> {
  const { from, to } = calendarWindow(new Date());
  const payload = await calendar(from, to, '', '', 0);
  return payload.total;
}
