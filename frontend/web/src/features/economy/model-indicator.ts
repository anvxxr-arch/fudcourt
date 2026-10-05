/** Economy indicator domain: series entities, series table, and registry. */
import type { CategoryId, SubcategoryId } from './model-taxonomy';
import { CATEGORY_OF_SUBCATEGORY } from './model-taxonomy';
import { COUNTRIES, type CountryRow, type Frequency, type Importance, type SeasonalAdjustment, type SourceId, type ValueShape } from './model-nation';
import { CENTRAL_BANKS, POLICY_RATE_INDICATORS } from './model-central-bank';
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
// The series table. One row = one canonical series key, with the bindings that
// can fill it. `fred` wins over `wb` for a country that carries both.
// ---------------------------------------------------------------------------

/** How one upstream's series is read and rendered. */
type Binding = {
  /** The upstream's own series key — the FRED id, the World Bank code. */
  id: string;
  frequency: Frequency;
  seasonalAdjustment: SeasonalAdjustment;
  shape: ValueShape;
  /** Periods to look back for a `yoy`; 0 when the shape does not need one. */
  lag: number;
  unit: string;
  decimals: number;
};

type SeriesDef = {
  /** Slug suffix. `<iso2-lower>-<key>`, e.g. `us-cpi`. */
  key: string;
  /** Display label; the indicator's name is `<country> <label>`. */
  label: string;
  category: CategoryId;
  subcategory: SubcategoryId;
  importance: Importance;
  note: string;
  /** US-preferred binding (FRED). Only ever bound for the United States. */
  fred?: Binding;
  /** Fallback / rest-of-world binding (World Bank). */
  wb?: Binding;
  /**
   * A series with no upstream of its own: the value is `legs[0] − legs[1]`,
   * published ONLY for a period both legs observe. The difference between a
   * 2024 revenue and a 2023 expense is not any year's balance, so a country
   * whose legs never share a year gets no row at all.
   */
  derive?: { legs: readonly [string, string]; frequency: Frequency; seasonalAdjustment: SeasonalAdjustment; unit: string; decimals: number };
};

const SERIES: readonly SeriesDef[] = [
  // -- Growth ---------------------------------------------------------------
  {
    key: 'gdp', label: 'GDP growth', category: 'growth', subcategory: 'gdp', importance: 3,
    note: 'Real gross domestic product, year over year',
    fred: { id: 'GDPC1', frequency: 'quarterly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 4, unit: '% YoY', decimals: 2 },
    wb: { id: 'NY.GDP.MKTP.KD.ZG', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'gdp-nominal', label: 'GDP (nominal)', category: 'growth', subcategory: 'gdp', importance: 2,
    note: 'Gross domestic product, current US$',
    wb: { id: 'NY.GDP.MKTP.CD', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: 'US$', decimals: 0 },
  },
  {
    key: 'gdp-per-capita', label: 'GDP per capita', category: 'growth', subcategory: 'gdp-per-capita', importance: 2,
    note: 'GDP per capita, current US$',
    wb: { id: 'NY.GDP.PCAP.CD', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: 'US$', decimals: 0 },
  },
  {
    key: 'investment', label: 'Gross capital formation', category: 'growth', subcategory: 'investment', importance: 2,
    note: 'Gross capital formation, % of GDP — the investment share of output',
    wb: { id: 'NE.GDI.TOTL.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'manufacturing', label: 'Manufacturing', category: 'growth', subcategory: 'manufacturing', importance: 2,
    note: 'Manufacturing value added, % of GDP',
    wb: { id: 'NV.IND.MANF.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },

  // -- Labor ----------------------------------------------------------------
  {
    key: 'unemployment', label: 'Unemployment', category: 'labor', subcategory: 'unemployment', importance: 3,
    note: 'Unemployment rate, % of the labour force',
    fred: { id: 'UNRATE', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'level', lag: 0, unit: '%', decimals: 1 },
    wb: { id: 'SL.UEM.TOTL.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '%', decimals: 2 },
  },
  {
    key: 'nonfarm-payrolls', label: 'Nonfarm payrolls', category: 'labor', subcategory: 'payrolls', importance: 3,
    note: 'Month-over-month change in total nonfarm payrolls, thousands',
    fred: { id: 'PAYEMS', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'change', lag: 1, unit: 'K MoM', decimals: 0 },
  },
  {
    key: 'jobless-claims', label: 'Initial jobless claims', category: 'labor', subcategory: 'jobless-claims', importance: 3,
    note: 'Initial unemployment insurance claims, weekly, in persons',
    fred: { id: 'ICSA', frequency: 'weekly', seasonalAdjustment: 'SA', shape: 'level', lag: 0, unit: 'claims', decimals: 0 },
  },
  {
    key: 'participation', label: 'Labour force participation', category: 'labor', subcategory: 'participation', importance: 2,
    note: 'Labour force participation rate, ages 15+, total',
    wb: { id: 'SL.TLF.CACT.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '%', decimals: 1 },
  },

  // -- Inflation ------------------------------------------------------------
  {
    key: 'cpi', label: 'CPI', category: 'inflation', subcategory: 'cpi', importance: 3,
    note: 'Consumer price index, all items, year over year',
    fred: { id: 'CPIAUCSL', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
    wb: { id: 'FP.CPI.TOTL.ZG', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'core-cpi', label: 'Core CPI', category: 'inflation', subcategory: 'core-cpi', importance: 3,
    note: 'CPI excluding food and energy, year over year',
    fred: { id: 'CPILFESL', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'pce', label: 'PCE price index', category: 'inflation', subcategory: 'pce', importance: 3,
    note: 'Personal consumption expenditures price index, year over year',
    fred: { id: 'PCEPI', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'core-pce', label: 'Core PCE', category: 'inflation', subcategory: 'core-pce', importance: 3,
    note: 'PCE excluding food and energy — the Federal Reserve’s preferred inflation gauge',
    fred: { id: 'PCEPILFE', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
  },

  // -- Monetary & money -----------------------------------------------------
  {
    key: 'm2', label: 'M2', category: 'monetary', subcategory: 'money-supply', importance: 3,
    note: 'M2 money stock, year over year',
    fred: { id: 'M2SL', frequency: 'monthly', seasonalAdjustment: 'SA', shape: 'yoy', lag: 12, unit: '% YoY', decimals: 2 },
  },
  {
    // The money-supply input for the 124 countries whose M2 is not on FRED. It is
    // a GROWTH rate, not a level, because the regime engine reads the direction of
    // money growth: a rising nominal money stock is not "expanding liquidity" if
    // it is rising slower than before.
    key: 'money-growth', label: 'Broad money growth', category: 'monetary', subcategory: 'money-supply', importance: 2,
    note: 'Broad money growth, year over year',
    wb: { id: 'FM.LBL.BMNY.ZG', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% YoY', decimals: 2 },
  },
  {
    key: 'broad-money', label: 'Broad money', category: 'money', subcategory: 'broad-money', importance: 2,
    note: 'Broad money, % of GDP',
    wb: { id: 'FM.LBL.BMNY.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },

  // -- Fiscal ---------------------------------------------------------------
  {
    key: 'gov-revenue', label: 'Government revenue', category: 'fiscal', subcategory: 'revenue', importance: 3,
    note: 'Government revenue excluding grants, % of GDP (IMF GFS via World Bank)',
    wb: { id: 'GC.REV.XGRT.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'gov-expense', label: 'Government expense', category: 'fiscal', subcategory: 'spending', importance: 3,
    note: 'Government expense, % of GDP (IMF GFS via World Bank)',
    wb: { id: 'GC.XPN.TOTL.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'deficit', label: 'Budget balance', category: 'fiscal', subcategory: 'deficit', importance: 3,
    note: 'Revenue minus expense, both legs read from the SAME year. Negative is a deficit.',
    derive: { legs: ['GC.REV.XGRT.GD.ZS', 'GC.XPN.TOTL.GD.ZS'], frequency: 'annual', seasonalAdjustment: 'NA', unit: '% GDP', decimals: 2 },
  },
  {
    key: 'tax-revenue', label: 'Tax revenue', category: 'fiscal', subcategory: 'revenue', importance: 2,
    note: 'Tax revenue, % of GDP',
    wb: { id: 'GC.TAX.TOTL.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'interest-payments', label: 'Interest payments', category: 'fiscal', subcategory: 'interest-payments', importance: 2,
    note: 'Interest payments, % of government revenue — the share of intake already committed to debt service',
    wb: { id: 'GC.XPN.INTP.RV.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% rev.', decimals: 1 },
  },

  // -- Trade ----------------------------------------------------------------
  {
    key: 'trade-openness', label: 'Trade openness', category: 'trade', subcategory: 'trade-openness', importance: 2,
    note: 'Exports plus imports of goods and services, % of GDP',
    wb: { id: 'NE.TRD.GNFS.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 1 },
  },
  {
    key: 'current-account', label: 'Current account', category: 'trade', subcategory: 'current-account', importance: 3,
    note: 'Current account balance, % of GDP (countries only upstream)',
    wb: { id: 'BN.CAB.XOKA.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 2 },
  },
  {
    key: 'fdi', label: 'FDI inflows', category: 'trade', subcategory: 'fdi', importance: 2,
    note: 'Foreign direct investment, net inflows, % of GDP',
    wb: { id: 'BX.KLT.DINV.WD.GD.ZS', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: '% GDP', decimals: 2 },
  },
  {
    key: 'reserves', label: 'Reserves', category: 'trade', subcategory: 'reserves', importance: 2,
    note: 'Total reserves including gold, current US$ (countries only upstream)',
    wb: { id: 'FI.RES.TOTL.CD', frequency: 'annual', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: 'US$', decimals: 0 },
  },

  // -- Sentiment & credit ---------------------------------------------------
  {
    key: 'consumer-sentiment', label: 'Consumer sentiment', category: 'sentiment', subcategory: 'consumer-sentiment', importance: 2,
    note: 'University of Michigan consumer sentiment index',
    fred: { id: 'UMCSENT', frequency: 'monthly', seasonalAdjustment: 'NSA', shape: 'level', lag: 0, unit: 'index', decimals: 1 },
  },
  {
    key: 'term-spread', label: '10y − 2y spread', category: 'credit', subcategory: 'credit-spread', importance: 2,
    note: '10-year minus 2-year Treasury constant-maturity spread; negative = inverted',
    fred: { id: 'T10Y2Y', frequency: 'daily', seasonalAdjustment: 'NA', shape: 'level', lag: 0, unit: 'pp', decimals: 2 },
  },
];

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

/**
 * The legs behind a derived series, keyed by the slug suffix. Exported because
 * the ADAPTER — which lives in the route layer — must fetch both legs; the
 * provider codes stay out of `model.ts` so a view can never reach one.
 */
export const DERIVED_LEGS: Readonly<Record<string, readonly [string, string]>> = Object.fromEntries(
  SERIES.filter((s) => s.derive).map((s) => [s.key, s.derive!.legs]),
);

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
