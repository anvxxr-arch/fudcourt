/** Economy indicator domain: series entities, series table, and registry. */
import type { CategoryId, SubcategoryId } from './model-taxonomy';
import { CATEGORY_OF_SUBCATEGORY } from './model-taxonomy';
import { COUNTRIES, type CountryRow, type Frequency, type Importance, type SeasonalAdjustment, type SourceId, type ValueShape } from './model-nation';
import { CENTRAL_BANKS, POLICY_RATE_INDICATORS } from './model-central-bank';
import { SERIES, type Binding, type SeriesDef } from './model-indicator-series';
export * from './model-indicator-series';
/**
 * The economy domain's canonical data model (plan Phase 3).
 *
 * THE POINT OF THIS FILE: the database and the API must NOT take the shape of
 * whichever provider happens to be cheapest this year. FRED, the World Bank,
 * BIS, the IMF and every future source are normalised into these four entities,
 * so a provider can be swapped without touching a single view. The mapping
 * provider → entity lives in `registry.ts` (`source` + `sourceSeriesId`), never
 * in a page.
 *
 * The four entities and what they are for:
 *
 *   Country              — identity. A stable ISO-keyed row, no measurements.
 *   EconomicIndicator    — a SERIES: the taxonomy slot plus the provenance of
 *                          the upstream that fills it. One row per (country,
 *                          series) — this is what a URL slug resolves to.
 *   EconomicObservation  — one dated value of an indicator. The history.
 *   EconomicRelease      — one dated EVENT: the moment a value is published,
 *                          with whatever actual/forecast/previous the source
 *                          gives. Referenced by indicator id, never a separate
 *                          unlinked dataset (plan Phase 8).
 *
 * Honesty rules that live in the TYPES, not in a comment somewhere:
 *   - every measured field is `number | null`, never `0` for "unknown";
 *   - `seasonalAdjustment` and `frequency` are required, because a value
 *     without them cannot be compared to another value;
 *   - `revised` is separate from `previous`, because a revision and a change
 *     are different facts and collapsing them invents history.
 */

/**
 * A canonical series: the taxonomy slot plus the provenance of the upstream that
 * fills it. `slug` is the canonical URL key (`us-cpi`, `id-cpi`) and is what
 * `/economy/indicator/<slug>` resolves.
 */
export type EconomicIndicator = {
  /** Canonical, stable, URL-safe: `<iso2-lower>-<key>`, e.g. `us-core-cpi`. */
  slug: string;
  name: string;
  /** Country id (ISO3). `null` for a supranational series (e.g. euro-area M3). */
  country: string | null;
  category: CategoryId;
  subcategory: SubcategoryId;
  unit: string;
  frequency: Frequency;
  seasonalAdjustment: SeasonalAdjustment;
  source: SourceId;
  /** The upstream's own series key — the FRED id, the World Bank code, the BIS area. */
  sourceSeriesId: string;
  importance: Importance;
  decimals: number;
  shape: ValueShape;
  /** Periods to look back for a `yoy`; 0 when the shape does not need one. */
  lag: number;
  /** One line on what the series measures, shown as the row's title attribute. */
  note: string;
};

/** One dated value of an indicator. */
export type EconomicObservation = {
  indicatorId: string;
  /** Period the observation is FOR, as the upstream labels it (e.g. `2024`, `2026-08`). */
  date: string;
  value: number | null;
  /** The observation one period earlier, when the window holds one. */
  previous: number | null;
  /** The value as first published, when the source exposes a revision. */
  revised: number | null;
};

/**
 * One scheduled publication. `indicatorId` ties it to the series it belongs to
 * (plan Phase 8: "all events must reference an EconomicIndicator").
 *
 * `actual`, `forecast`, `previous` and `revised` are each `number | null` and
 * MEAN DIFFERENT THINGS when null: a null `forecast` is "no consensus published
 * here", not "consensus is zero", and it must never be rendered as one.
 */
export type EconomicRelease = {
  indicatorId: string;
  /** ISO-8601 instant the value is published, when the source states one. */
  releaseAt: string | null;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  revised: number | null;
  importance: Importance;
  unit: string;
};

/**
 * The economy domain's INDICATOR REGISTRY and CENTRAL-BANK registry
 * (plan Phases 3, 6, 7).
 *
 * WHAT THIS FILE IS. The single place that answers "which upstream series backs
 * the slug `us-core-cpi`?". It is generated from two compact inputs — the
 * country list (`countries.ts`) and the series table below — so a new country
 * adds its whole indicator set by existing, and a new series adds one row here
 * and lands for every country that carries it. Nothing downstream hardcodes a
 * FRED id or a World Bank code: the API resolves a slug through this registry
 * and reads `source` + `sourceSeriesId` off the result.
 *
 * WHY METADATA IS PER-BINDING, NOT PER-SERIES. The same taxonomy slot is filled
 * by different measurements on different clocks. `us-cpi` is FRED's
 * seasonally-adjusted monthly index that needs a 12-period year-ago transform;
 * `id-cpi` is the World Bank's annual print that IS the inflation rate already
 * and needs no transform at all. Frequency, seasonal adjustment, shape, lag,
 * decimals and unit therefore hang off each BINDING, never off the series — a
 * shared frequency is exactly how a monthly series gets compared to an annual
 * one as if they were the same number.
 *
 * THE SELECTION RULE (one slug per country per series key). A country resolves a
 * key to the MOST CURRENT source that carries it: the United States reads FRED
 * where FRED has the series, every other country falls back to the World Bank.
 * A key with no binding for a country produces NO row rather than a row that can
 * never fill — an indicator that exists only to render an em dash reads as "this
 * country has no inflation" when the truth is "we do not read that series for
 * it".
 */

// ---------------------------------------------------------------------------
// Generate the canonical indicators. One row per (country, series) the country
// can actually fill, plus one per central bank for its policy rate.
// ---------------------------------------------------------------------------

function buildIndicator(country: CountryRow, def: SeriesDef): EconomicIndicator | null {
  // The most current source that carries the series wins. FRED is US-only.
  let source: SourceId;
  let binding: Binding | null = null;

  if (def.derive) {
    source = 'worldbank';
    binding = { id: `derived:${def.key}`, frequency: def.derive.frequency, seasonalAdjustment: def.derive.seasonalAdjustment, shape: 'level', lag: 0, unit: def.derive.unit, decimals: def.derive.decimals };
  } else if (def.fred && country.iso3 === 'USA') {
    source = 'fred';
    binding = def.fred;
  } else if (def.wb) {
    source = 'worldbank';
    binding = def.wb;
  } else {
    return null;
  }

  return {
    slug: `${country.iso2.toLowerCase()}-${def.key}`,
    name: `${country.name} ${def.label}`,
    country: country.iso3,
    category: def.category,
    subcategory: def.subcategory,
    unit: binding.unit,
    frequency: binding.frequency,
    seasonalAdjustment: binding.seasonalAdjustment,
    source,
    sourceSeriesId: binding.id,
    importance: def.importance,
    decimals: binding.decimals,
    shape: binding.shape,
    lag: binding.lag,
    note: def.note,
  };
}

export const SERIES_INDICATORS: readonly EconomicIndicator[] = COUNTRIES.flatMap((c) =>
  SERIES.map((d) => buildIndicator(c, d)).filter((x): x is EconomicIndicator => x !== null),
);

export const INDICATORS: readonly EconomicIndicator[] = [...SERIES_INDICATORS, ...POLICY_RATE_INDICATORS];

export const INDICATOR_BY_SLUG: Readonly<Record<string, EconomicIndicator>> = Object.fromEntries(
  INDICATORS.map((i) => [i.slug, i]),
);

/** Every indicator for one country, in series-table order, policy rate last. */
export function indicatorsForCountry(iso3: string): EconomicIndicator[] {
  return INDICATORS.filter((i) => i.country === iso3);
}

/** Every indicator in one category, optionally narrowed to one country. */
export function indicatorsForCategory(category: CategoryId, iso3?: string): EconomicIndicator[] {
  return INDICATORS.filter((i) => i.category === category && (iso3 === undefined || i.country === iso3));
}

/** The category a subcategory resolves to — used by the explorer's filters. */
export function categoryOf(subcategory: SubcategoryId): CategoryId {
  return CATEGORY_OF_SUBCATEGORY[subcategory];
}

/** The `policy-rate` slug for a country, when it has a central bank we track. */
export function policyRateSlug(iso3: string): string | null {
  const bank = CENTRAL_BANKS.find((b) => b.country === iso3);
  return bank ? `${bank.area.toLowerCase()}-policy-rate` : null;
}
