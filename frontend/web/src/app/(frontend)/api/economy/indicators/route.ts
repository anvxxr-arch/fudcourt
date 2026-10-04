import { NextResponse } from 'next/server';
import { COUNTRY_BY_ISO3, INDICATORS } from '@/features/economy/registry';
import { CATEGORY_BY_ID, TAXONOMY } from '@/features/economy/taxonomy';
import { toMeta } from '@/app/(frontend)/api/economy/_lib/rows';
import type { EconomicIndicator } from '@/features/economy/model';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * The indicator EXPLORER (plan Phase 6).
 *
 * Filtering is LOCAL and that is stated in the payload (`total` vs `matched`): a
 * filter that re-fetched would cost an upstream call per keystroke, and the
 * registry is small enough to filter in memory. The facets are computed over the
 * FULL set, not the narrowed one, so the counts do not collapse to 1 as the user
 * drills in — a facet list that empties itself as you use it is unusable.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams;

  const category = q.get('category') ?? '';
  const country = q.get('country') ?? '';
  const frequency = q.get('frequency') ?? '';
  const source = q.get('source') ?? '';
  const importance = Number(q.get('importance') ?? '0');
  const text = (q.get('q') ?? '').trim().toLowerCase();

  // An unknown filter VALUE is a local 400, not a silently-ignored parameter —
  // "no results" and "you misspelled the category" must not look the same.
  if (category && !CATEGORY_BY_ID[category as keyof typeof CATEGORY_BY_ID]) {
    return NextResponse.json(
      { error: 'unknown category', detail: `${JSON.stringify(category)} is not a taxonomy category` },
      { status: 400 }
    );
  }
  if (country && !COUNTRY_BY_ISO3[country.toUpperCase()] && !COUNTRY_BY_ISO3[country.toLowerCase()]) {
    return NextResponse.json(
      { error: 'unknown country', detail: `${JSON.stringify(country)} is not an ISO3 code this module covers` },
      { status: 400 }
    );
  }

  const all = INDICATORS;
  const countryIso3 = country ? (COUNTRY_BY_ISO3[country.toUpperCase()]?.id ?? COUNTRY_BY_ISO3[country.toLowerCase()]?.id ?? '') : '';

  const matched = all.filter((ind: EconomicIndicator) => {
    if (category && ind.category !== category) return false;
    if (countryIso3 && ind.country !== countryIso3) return false;
    if (frequency && ind.frequency !== frequency) return false;
    if (source && ind.source !== source) return false;
    if (importance && ind.importance !== importance) return false;
    if (text && !ind.name.toLowerCase().includes(text) && !ind.slug.includes(text)) return false;
    return true;
  });

  const byCategory = new Map<string, number>();
  const byCountry = new Map<string, number>();
  const byFrequency = new Map<string, number>();
  const bySource = new Map<string, number>();
  for (const ind of all) {
    byCategory.set(ind.category, (byCategory.get(ind.category) ?? 0) + 1);
    if (ind.country) byCountry.set(ind.country, (byCountry.get(ind.country) ?? 0) + 1);
    byFrequency.set(ind.frequency, (byFrequency.get(ind.frequency) ?? 0) + 1);
    bySource.set(ind.source, (bySource.get(ind.source) ?? 0) + 1);
  }

  return NextResponse.json({
    indicators: matched.map(toMeta),
    total: matched.length,
    matched: matched.length,
    registryTotal: all.length,
    // The explorer is local-filtering, and says so rather than implying the
    // narrowing came from upstream.
    filtered: 'local',
    facets: {
      categories: TAXONOMY.map((c) => ({ id: c.id, label: c.label, count: byCategory.get(c.id) ?? 0 })).filter((c) => c.count > 0),
      countries: [...byCountry.entries()]
        .map(([id, count]) => ({ id, name: COUNTRY_BY_ISO3[id]?.name ?? id, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      frequencies: [...byFrequency.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
      sources: [...bySource.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
    },
    asOf: Math.floor(Date.now() / 1000),
  });
}
