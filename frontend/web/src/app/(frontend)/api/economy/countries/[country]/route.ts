import { NextResponse } from 'next/server';
import { countryByAnyCode, indicatorsForCountry } from '@/features/economy/registry';
import { CATEGORY_BY_ID, TAXONOMY } from '@/features/economy/taxonomy';
import { readObservations } from '@/app/(frontend)/api/economy/_lib/adapters';
import { mapPool, toIndicatorRow, toMetric, toReleaseRow } from '@/app/(frontend)/api/economy/_lib/rows';
import type { EconomicIndicator, EconomicObservation } from '@/features/economy/model';
import type { CategoryBlock, Metric, ReleaseRow } from '@/features/economy/client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/** Headline slugs a profile leads with, in display order. Absent ones are skipped. */
const HEADLINE = ['gdp', 'cpi', 'unemployment', 'policy-rate', 'm2', 'deficit', 'gov-revenue', 'current-account'];

type Failed = { symbol: string; reason: string };

/**
 * One country's whole economic profile (plan Phase 5).
 *
 * The country is an AGGREGATOR: every indicator the registry binds for it is
 * read and grouped by taxonomy category, so the page cannot show a series the
 * explorer does not know about, or miss one it does.
 *
 * Failure is per-indicator, never per-page. A country where the World Bank has
 * nothing for one series still renders the other twenty; the gap is named in
 * `failed[]` and rendered as an em dash, which is the difference between "this
 * upstream is quiet" and "this country has no data".
 */
export async function GET(_req: Request, { params }: { params: Promise<{ country: string }> }) {
  const { country: raw } = await params;
  const country = countryByAnyCode(raw ?? '');
  if (!country) {
    return NextResponse.json(
      { error: 'unknown country', detail: `${JSON.stringify(raw ?? '')} is not a country this module covers` },
      { status: 404 }
    );
  }

  const indicators = indicatorsForCountry(country.id);
  const failed: Failed[] = [];
  const obsBySlug = new Map<string, EconomicObservation[]>();

  await mapPool(indicators, 8, async (ind: EconomicIndicator) => {
    try {
      obsBySlug.set(ind.slug, await readObservations(ind));
    } catch (e) {
      obsBySlug.set(ind.slug, []);
      failed.push({ symbol: `${ind.source}:${ind.slug}`, reason: e instanceof Error ? e.message : String(e) });
    }
  });

  const rows = indicators.map((ind) => toIndicatorRow(ind, obsBySlug.get(ind.slug) ?? []));

  // Group by category in TAXONOMY order so the profile reads the same way the
  // explorer's facets are ordered. An empty category is dropped, not rendered as
  // a heading over nothing.
  const groups: CategoryBlock[] = [];
  for (const cat of TAXONOMY) {
    const catRows = rows.filter((r) => r.category === (CATEGORY_BY_ID[cat.id]?.label ?? cat.id));
    if (catRows.length === 0) continue;
    groups.push({ category: cat.id, label: cat.label, rows: catRows });
  }

  const headlineMetrics: Metric[] = [];
  for (const key of HEADLINE) {
    const slug = `${country.iso2.toLowerCase()}-${key}`;
    const ind = indicators.find((i) => i.slug === slug);
    if (ind) headlineMetrics.push(toMetric(ind, obsBySlug.get(slug) ?? []));
  }
  // A country with no policy rate bound to a headline slug (most of the 125) still
  // leads with its central bank's rate when the registry carries one.
  if (!headlineMetrics.some((m) => m.slug.endsWith('-policy-rate'))) {
    const pr = indicators.find((i) => i.subcategory === 'policy-rate');
    if (pr) headlineMetrics.push(toMetric(pr, obsBySlug.get(pr.slug) ?? []));
  }

  const releases: ReleaseRow[] = indicators
    .filter((i) => i.importance >= 3)
    .map((i) => toReleaseRow(i, obsBySlug.get(i.slug) ?? []))
    .filter((r) => r.actual !== null)
    .sort((a, b) => String(b.releaseAt).localeCompare(String(a.releaseAt)))
    .slice(0, 12);

  const published = rows.filter((r) => r.value !== null).length;
  if (published === 0) {
    // Every upstream answered nothing — that is an outage, not an empty country.
    return NextResponse.json(
      { error: 'no data returned', detail: `no upstream published a value for ${country.iso3}`, failed },
      { status: 502 }
    );
  }

  return NextResponse.json({
    country: { ...country, indicatorCount: indicators.length },
    keyMetrics: headlineMetrics,
    groups,
    releases,
    failed,
    upstream: ['api.worldbank.org v2 (annual)', 'fred.stlouisfed.org graph CSV (keyless)', 'stats.bis.org WS_CBPOL (daily)'],
    derived: `${rows.length} indicator(s) read for ${country.iso3}, ${published} with a published value, ${failed.length} upstream item(s) failed; a value the upstream did not publish is null (rendered '—'), never 0; the budget balance is emitted only for a year BOTH its legs observe`,
    asOf: Math.floor(Date.now() / 1000),
  });
}
