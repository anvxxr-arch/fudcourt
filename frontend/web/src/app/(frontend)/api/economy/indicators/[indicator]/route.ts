import { NextResponse } from 'next/server';
import { INDICATOR_BY_SLUG, INDICATORS } from '@/features/economy/model';
import { readObservations } from '@/app/(frontend)/api/economy/_lib/adapters';
import { toMeta, toReleaseRow } from '@/app/(frontend)/api/economy/_lib/rows';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * One canonical series (plan Phase 6).
 *
 * The slug is the URL key — `us-cpi`, `id-cpi` — and the registry resolves it to
 * exactly one upstream binding, so the same page serves a monthly FRED series and
 * an annual World Bank one without the view knowing the difference.
 *
 * `related` is computed from the taxonomy (same category, same country first),
 * NOT from a hand-written list: a related-indicators list that is maintained by
 * hand is a list that goes stale the moment a series is added.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ indicator: string }> }) {
  const { indicator: slug } = await params;
  const ind = INDICATOR_BY_SLUG[(slug ?? '').toLowerCase()];
  if (!ind) {
    return NextResponse.json(
      { error: 'unknown indicator', detail: `${JSON.stringify(slug ?? '')} is not a canonical series slug` },
      { status: 404 }
    );
  }

  const failed: { symbol: string; reason: string }[] = [];
  let observations: { date: string; value: number | null; previous: number | null }[] = [];
  try {
    observations = (await readObservations(ind)).map((o) => ({ date: o.date, value: o.value, previous: o.previous }));
  } catch (e) {
    failed.push({ symbol: `${ind.source}:${ind.sourceSeriesId}`, reason: e instanceof Error ? e.message : String(e) });
  }

  if (observations.length === 0 && failed.length > 0) {
    // The upstream itself failed — a loud 502, never an empty chart that reads as
    // "this series has no history".
    return NextResponse.json(
      { error: 'upstream failed', detail: `could not read ${ind.source} series ${ind.sourceSeriesId}`, failed },
      { status: 502 }
    );
  }

  const withValues = observations.filter((o) => o.value !== null);
  const latest = withValues.length > 0 ? withValues[withValues.length - 1] : null;

  // Same category first (a peer series), then the same series in other countries,
  // capped so the rail stays a rail.
  const sameCategory = INDICATORS.filter((i) => i.slug !== ind.slug && i.category === ind.category && i.country === ind.country);
  const otherCountries = INDICATORS.filter((i) => i.slug !== ind.slug && i.subcategory === ind.subcategory && i.country !== ind.country);
  const related = [...sameCategory, ...otherCountries].slice(0, 12).map(toMeta);

  return NextResponse.json({
    indicator: toMeta(ind),
    observations,
    latest: latest ? { date: latest.date, value: latest.value as number } : null,
    release: toReleaseRow(ind, observations.map((o) => ({ ...o, indicatorId: ind.slug, revised: null }))),
    related,
    failed,
    upstream: [ind.source === 'fred' ? 'fred.stlouisfed.org graph CSV (keyless)' : ind.source === 'bis' ? 'stats.bis.org WS_CBPOL (daily)' : 'api.worldbank.org v2 (annual)'],
    derived: `${observations.length} observation(s); shape '${ind.shape}'${ind.lag ? ` with lag ${ind.lag}` : ''} applied here, so the number is the canonical measure and not the raw upstream level; a transform whose base the window does not carry is null, never a shorter-span substitute; no forecast is published by this source, so forecast is null`,
    asOf: Math.floor(Date.now() / 1000),
  });
}
