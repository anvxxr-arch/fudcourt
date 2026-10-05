import { NextResponse } from 'next/server';
import { INDICATOR_BY_SLUG } from '@/features/economy/model';
import { readObservations } from '@/app/(frontend)/api/economy/_lib/adapters';
import { mapPool } from '@/app/(frontend)/api/economy/_lib/rows';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/** The periods a comparison may ask for, in days. `max` is unbounded. */
const PERIODS: Readonly<Record<string, number | null>> = {
  '1y': 365,
  '2y': 730,
  '5y': 365 * 5,
  '10y': 365 * 10,
  max: null,
};

/** A period string → a cutoff date, or `null` for "no cutoff". */
function cutoffFor(period: string): string | null {
  const days = PERIODS[period];
  if (days === null || days === undefined) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Compare any set of canonical series on one axis (plan Phase 10).
 *
 * The query is `?indicators=a,b,c&period=5y` and NO static URL is minted per
 * combination — the plan's explicit requirement, and the reason this is one
 * dynamic route rather than a matrix of pages.
 *
 * Series are aligned by their own dates, not resampled onto a common grid. A
 * monthly CPI and an annual GDP print cannot be honestly interpolated onto one
 * axis, so each series carries its own `points` and the view draws them as they
 * are; the `frequency` field tells the view which is which. `missing` names every
 * slug that resolved to nothing, so a typo reads as a typo rather than as an
 * empty line.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get('indicators') ?? '').trim();
  const period = (url.searchParams.get('period') ?? '5y').trim().toLowerCase();

  // The plan's own query shape (Phase 10): `?countries=us,id,jp&series=cpi,gdp`
  // expands to the canonical slugs `<iso2>-<series>` here, so a caller never has
  // to know a slug to compare two countries on one measure.
  const countriesParam = (url.searchParams.get('countries') ?? '').trim();
  const seriesParam = (url.searchParams.get('series') ?? '').trim();
  const expanded =
    !raw && countriesParam && seriesParam
      ? countriesParam
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean)
          .flatMap((iso2) => seriesParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((s) => `${iso2}-${s}`))
          .join(',')
      : raw;

  if (!(period in PERIODS)) {
    return NextResponse.json(
      { error: 'unknown period', detail: `${JSON.stringify(period)} is not one of ${Object.keys(PERIODS).join(', ')}` },
      { status: 400 }
    );
  }

  const cutoff = cutoffFor(period);

  const slugs = [...new Set(expanded.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  if (slugs.length === 0) {
    return NextResponse.json({ error: 'no indicators requested', detail: 'pass ?indicators=<slug>,<slug> or ?countries=us,id&series=cpi,gdp' }, { status: 400 });
  }

  const failed: { symbol: string; reason: string }[] = [];
  const missing: string[] = [];
  const resolved = slugs.map((slug) => {
    const ind = INDICATOR_BY_SLUG[slug];
    if (!ind) missing.push(slug);
    return ind;
  });

  const series = await mapPool(resolved, 6, async (ind) => {
    if (!ind) return null;
    try {
      const obs = await readObservations(ind);
      const points = obs
        .filter((o) => cutoff === null || o.date >= cutoff)
        .map((o) => ({ date: o.date, value: o.value }));
      return {
        slug: ind.slug,
        label: ind.name,
        country: ind.country,
        unit: ind.unit,
        decimals: ind.decimals,
        frequency: ind.frequency,
        points,
      };
    } catch (e) {
      failed.push({ symbol: `${ind.source}:${ind.slug}`, reason: e instanceof Error ? e.message : String(e) });
      return null;
    }
  });

  const out = series.filter((s): s is NonNullable<typeof s> => s !== null);
  if (out.length === 0) {
    return NextResponse.json(
      { error: 'no series resolved', detail: 'none of the requested slugs could be read', missing, failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    period,
    cutoff,
    series: out,
    missing,
    failed,
    upstream: [...new Set(out.map((s) => s.slug.split('-')[0]))].map((iso2) => `${iso2} via its bound source`),
    derived: `each series read on its own cadence and filtered to observations on/after ${cutoff ?? 'the start of its history'}; series are NOT resampled onto a common grid (a monthly and an annual print cannot be honestly interpolated onto one axis), so each carries its own frequency; ${missing.length} slug(s) unresolved, ${failed.length} read(s) failed`,
    asOf: Math.floor(Date.now() / 1000),
  });
}
