import { NextResponse } from 'next/server';
import { COUNTRY_BY_ISO3, countryByAnyCode, indicatorsForCountry, policyRateSlug } from '@/features/economy/registry';
import { readObservations } from '@/app/(frontend)/api/economy/_lib/adapters';
import { mapPool } from '@/app/(frontend)/api/economy/_lib/rows';
import { DIMENSION_LABEL, LOOKBACK_BY_FREQUENCY, buildRegime, type DimensionId, type SeriesInput } from '@/features/economy/regime';
import type { EconomicIndicator, EconomicObservation } from '@/features/economy/model';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * The macro regime (plan Phase 13, stages 16–17).
 *
 * The route's only job is to READ: it resolves a scope, fetches the series each
 * dimension needs, and hands them to `buildRegime`, which is pure. Every
 * judgement — trend, regime label, asset weights — lives in the feature, where
 * it is unit-tested offline against fixed series instead of against whatever the
 * upstream published this morning.
 *
 * Failure is per-dimension. A country whose central bank we do not track still
 * gets a regime if growth, inflation and liquidity resolved; the missing
 * dimension is named in `missing[]` and the rule table simply cannot fire a rule
 * that needed it. A dimension is NEVER filled in with a guess to complete the
 * picture.
 *
 * `?country=` accepts ISO2 or ISO3. With no parameter the scope is GLOBAL and the
 * anchor is the United States — the dollar money stock and the Fed's policy rate
 * are the dominant global liquidity and policy inputs, and the payload says so.
 */

/** The series key(s) that feed each dimension, in preference order. */
const DIMENSION_SERIES: Readonly<Record<DimensionId, readonly string[]>> = {
  growth: ['gdp'],
  inflation: ['cpi'],
  labor: ['unemployment'],
  policy: ['policy-rate'],
  liquidity: ['m2', 'money-growth'],
};

type Failed = { symbol: string; reason: string };

/** Resolve the indicator a dimension reads for one country, or null. */
function indicatorFor(id: DimensionId, iso2: string, iso3: string, all: readonly EconomicIndicator[]): EconomicIndicator | null {
  if (id === 'policy') {
    // A policy rate is namespaced by the central bank's BIS area, not by the
    // country, so it must be looked up through the registry's own mapping.
    const slug = policyRateSlug(iso3);
    if (slug) {
      const bySlug = all.find((i) => i.slug === slug);
      if (bySlug) return bySlug;
    }
    return all.find((i) => i.subcategory === 'policy-rate') ?? null;
  }
  for (const key of DIMENSION_SERIES[id]) {
    const hit = all.find((i) => i.slug === `${iso2.toLowerCase()}-${key}`);
    if (hit) return hit;
  }
  return null;
}

/** Read one dimension's series as an ordered, finite-value input. */
async function seriesFor(id: DimensionId, ind: EconomicIndicator | null, failed: Failed[]): Promise<SeriesInput> {
  const label = DIMENSION_LABEL[id];
  if (!ind) {
    return { id, slug: '', label, unit: '', decimals: 2, values: [], dates: [], lookback: 4, failure: 'no series is bound to this dimension for this scope' };
  }
  const lookback = LOOKBACK_BY_FREQUENCY[ind.frequency] ?? 4;
  try {
    const obs: EconomicObservation[] = await readObservations(ind);
    // Ascending by date, so the trend runs oldest → newest regardless of how the
    // upstream ordered its payload. A null value is dropped, not carried as 0.
    const sorted = obs
      .filter((o) => typeof o.value === 'number' && Number.isFinite(o.value))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      id,
      slug: ind.slug,
      label,
      unit: ind.unit,
      decimals: ind.decimals,
      values: sorted.map((o) => o.value as number),
      dates: sorted.map((o) => o.date),
      lookback,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    failed.push({ symbol: `${ind.source}:${ind.slug}`, reason });
    return { id, slug: ind.slug, label, unit: ind.unit, decimals: ind.decimals, values: [], dates: [], lookback, failure: reason };
  }
}

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('country');
  const country = raw ? countryByAnyCode(raw) : null;
  if (raw && !country) {
    return NextResponse.json(
      { error: 'unknown country', detail: `${JSON.stringify(raw)} is not a country this module covers` },
      { status: 404 }
    );
  }

  // The global scope is anchored on the United States — stated, not implied.
  const anchor = country ?? COUNTRY_BY_ISO3['USA'];
  if (!anchor) {
    return NextResponse.json({ error: 'no anchor', detail: 'the country table has no US row to anchor the global scope on' }, { status: 500 });
  }

  const bound = indicatorsForCountry(anchor.iso3);
  const failed: Failed[] = [];

  const inputs = await mapPool(
    (['growth', 'inflation', 'labor', 'liquidity', 'policy'] as DimensionId[]),
    5,
    (id: DimensionId) => seriesFor(id, indicatorFor(id, anchor.iso2, anchor.iso3, bound), failed)
  );

  const readable = inputs.filter((i) => i.values.length >= 4);
  if (readable.length === 0) {
    return NextResponse.json(
      { error: 'no data returned', detail: `no dimension resolved enough published observations for ${anchor.iso3}`, failed },
      { status: 502 }
    );
  }

  const regime = buildRegime(country ? country.name : 'Global', inputs);

  return NextResponse.json({
    scope: country ? { kind: 'country', country } : { kind: 'global', anchor: { iso3: anchor.iso3, name: anchor.name } },
    ...regime,
    failed,
    upstream: ['fred.stlouisfed.org graph CSV (keyless)', 'api.worldbank.org v2 (annual)', 'stats.bis.org WS_CBPOL (daily)'],
    derived:
      'a dimension is read only when its series published at least four observations; direction is declared only when the move over the lookback exceeds the series\u2019 own robust period-to-period variation (MAD of first differences, scaled by sqrt(lookback)), so rounding noise cannot flip a regime; the lookback is 6 monthly / 4 quarterly / 3 annual / 12 weekly / 30 daily periods; liquidity reads M2 year-over-year where FRED carries it and World Bank broad-money growth otherwise; the asset weights are stated heuristics over the transmission channel, every contribution is returned for audit, and the result is a reading of published data, not a forecast',
    asOf: Math.floor(Date.now() / 1000),
  });
}
