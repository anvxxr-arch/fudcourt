import { NextResponse } from 'next/server';
import { INDICATORS } from '@/features/economy/registry';
import { readObservations } from '@/app/(frontend)/api/economy/_lib/adapters';
import { mapPool, toReleaseRow } from '@/app/(frontend)/api/economy/_lib/rows';
import { CATEGORY_BY_ID } from '@/features/economy/taxonomy';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/** Days of history a calendar request spans by default. */
const DEFAULT_WINDOW_DAYS = 120;

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
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const now = new Date();
  const defFrom = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const defTo = now.toISOString().slice(0, 10);

  const from = parseDay(url.searchParams.get('from')) ?? defFrom;
  const to = parseDay(url.searchParams.get('to')) ?? defTo;
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

  if (out.length === 0 && failed.length === candidates.length && candidates.length > 0) {
    return NextResponse.json(
      { error: 'no data returned', detail: 'every candidate series failed to read', failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    events: out.slice(0, 200),
    window: { from, to },
    total: out.length,
    failed,
    upstream: ['fred.stlouisfed.org graph CSV', 'api.worldbank.org v2', 'stats.bis.org WS_CBPOL'],
    derived: `a RELEASE LOG, not a forward schedule: no source here publishes a publication calendar or a consensus, so every releaseAt is the REFERENCE PERIOD of a value that exists and every forecast is null; window filters on the reference period; ${out.length} event(s) across ${candidates.length} candidate series, ${failed.length} read(s) failed`,
    asOf: Math.floor(Date.now() / 1000),
  });
}
