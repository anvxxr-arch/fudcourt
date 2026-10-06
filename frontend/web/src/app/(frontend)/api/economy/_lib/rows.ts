/**
 * Envelope builders shared by the economy routes.
 *
 * Kept apart from `adapters.ts` on purpose: adapters face the PROVIDER (they know
 * a FRED id when they see one), builders face the CLIENT (they know only the
 * canonical model). A route composes the two, which is why a provider can be
 * replaced by editing one file and a rendered cell by editing the other.
 */
import { CATEGORY_BY_ID, SUBCATEGORY_LABELS } from '@/features/economy/model';
import { COUNTRY_BY_ISO3 } from '@/features/economy/model';
import type { EconomicIndicator, EconomicObservation } from '@/features/economy/model';
import type { IndicatorMeta, IndicatorRow, Metric, ReleaseRow } from '@/features/economy/model';
import { latestOf } from './adapters';

/** The headline cell for one indicator. */
export function toMetric(ind: EconomicIndicator, obs: readonly EconomicObservation[]): Metric {
  const latest = latestOf(obs);
  return {
    slug: ind.slug,
    label: ind.name,
    category: CATEGORY_BY_ID[ind.category]?.label ?? ind.category,
    value: latest?.value ?? null,
    date: latest?.date ?? null,
    previous: latest?.previous ?? null,
    unit: ind.unit,
    decimals: ind.decimals,
    frequency: ind.frequency,
    source: ind.source,
    seasonalAdjustment: ind.seasonalAdjustment === 'NA' ? null : ind.seasonalAdjustment,
  };
}

/** The table row: a metric plus the metadata a dense table shows. */
export function toIndicatorRow(ind: EconomicIndicator, obs: readonly EconomicObservation[]): IndicatorRow {
  return {
    ...toMetric(ind, obs),
    importance: ind.importance,
    note: ind.note,
  };
}

/**
 * A release event, built from the series' OWN newest observation rather than from
 * a separate calendar dataset — which is the plan's Phase 8 rule (every event
 * references an `EconomicIndicator`). `actual` is the published value, `previous`
 * the one before it. `forecast` is `null`: none of these upstreams publishes a
 * consensus, and inventing one would be the single most misleading thing this
 * module could do. `releaseAt` is the period the value is FOR, so a "recent
 * releases" list is ordered by fact, not by a scraped publication time.
 */
export function toReleaseRow(ind: EconomicIndicator, obs: readonly EconomicObservation[]): ReleaseRow {
  const latest = latestOf(obs);
  return {
    slug: ind.slug,
    label: ind.name,
    country: ind.country,
    category: CATEGORY_BY_ID[ind.category]?.label ?? ind.category,
    importance: ind.importance,
    unit: ind.unit,
    releaseAt: latest?.date ?? null,
    actual: latest?.value ?? null,
    forecast: null,
    previous: latest?.previous ?? null,
    revised: latest?.revised ?? null,
  };
}

/** The indicator's registry metadata, with the country name resolved for display. */
export function toMeta(ind: EconomicIndicator): IndicatorMeta {
  return {
    slug: ind.slug,
    name: ind.name,
    country: ind.country,
    countryName: ind.country ? (COUNTRY_BY_ISO3[ind.country]?.name ?? ind.country) : null,
    category: CATEGORY_BY_ID[ind.category]?.label ?? ind.category,
    subcategory: SUBCATEGORY_LABELS[ind.subcategory] ?? ind.subcategory,
    unit: ind.unit,
    frequency: ind.frequency,
    seasonalAdjustment: ind.seasonalAdjustment,
    source: ind.source,
    importance: ind.importance,
    decimals: ind.decimals,
    note: ind.note,
  };
}

/**
 * Run `fn` over `items` with bounded concurrency. The World Bank pool and the
 * shared limiter already serialise upstream calls; this bounds how many
 * PROMISES are open at once so a 30-indicator country profile does not hold 30
 * pending fetches (each with a 25 s deadline) against a shared transport.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
