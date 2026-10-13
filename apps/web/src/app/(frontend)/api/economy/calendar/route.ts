import { NextResponse } from 'next/server';
import { publicJson } from '../../_lib/http';
import { CATEGORY_BY_ID } from '@/features/economy/model';
import { CALENDAR_TTL_SECONDS, calendar, calendarWindow } from '@/app/(frontend)/api/economy/_lib/calendar';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/** Parse `YYYY-MM-DD`; anything else is null. */
function parseDay(s: string | null): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/**
 * The economic calendar (plan Phase 8).
 *
 * IMPORTANT HONESTY NOTE. None of this module's keyless upstreams publishes a
 * FORWARD publication schedule or a consensus forecast — only the periods values
 * were published FOR. So this calendar is a RELEASE LOG, not a forward schedule:
 * every row's `releaseAt` is the reference period of a value that exists, and
 * `forecast` is always null because no source here states one. It is labelled
 * exactly that way in `derived`, and the view titles it "recent releases".
 *
 * Every row references an `EconomicIndicator` through its `slug` — there is no
 * separate calendar dataset to drift, which is the plan's explicit rule.
 *
 * The window filters on the REFERENCE PERIOD, so a monthly series' August print
 * falls in an August window regardless of when the agency actually published it.
 *
 * The fan-out over the candidate series lives in `_lib/calendar.ts` and is
 * memoised there, so a warm run (the boot warm, or any earlier request) is
 * served from cache and this handler only parses, validates and shapes.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const def = calendarWindow(new Date());

  const from = parseDay(url.searchParams.get('from')) ?? def.from;
  const to = parseDay(url.searchParams.get('to')) ?? def.to;
  if (from > to) {
    return NextResponse.json({ error: 'invalid window', detail: `from (${from}) is after to (${to})` }, { status: 400 });
  }

  const country = (url.searchParams.get('country') ?? '').trim().toUpperCase();
  const category = (url.searchParams.get('category') ?? '').trim();
  const importance = Number(url.searchParams.get('importance') ?? '0');

  if (category && !CATEGORY_BY_ID[category as keyof typeof CATEGORY_BY_ID]) {
    return NextResponse.json(
      { error: 'unknown category', detail: `${JSON.stringify(category)} is not a taxonomy category` },
      { status: 400 }
    );
  }

  const payload = await calendar(from, to, country, category, importance);

  if (payload.events.length === 0 && payload.failed.length === payload.candidates && payload.candidates > 0) {
    return NextResponse.json(
      { error: 'no data returned', detail: 'every candidate series failed to read', failed: payload.failed },
      { status: 502 }
    );
  }

  return publicJson({
    events: payload.events.slice(0, 200),
    window: { from, to },
    total: payload.total,
    failed: payload.failed,
    upstream: ['fred.stlouisfed.org graph CSV', 'api.worldbank.org v2', 'stats.bis.org WS_CBPOL'],
    derived: `a RELEASE LOG, not a forward schedule: no source here publishes a publication calendar or a consensus, so every releaseAt is the REFERENCE PERIOD of a value that exists and every forecast is null; window filters on the reference period; ${payload.total} event(s) across ${payload.candidates} candidate series, ${payload.failed.length} read(s) failed`,
    asOf: Math.floor(Date.now() / 1000),
  }, CALENDAR_TTL_SECONDS);
}
