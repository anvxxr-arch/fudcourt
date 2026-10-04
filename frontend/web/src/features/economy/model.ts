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
import type { CategoryId, SubcategoryId } from '@/features/economy/taxonomy';

/** The region grouping every country and every board uses. */
export type Region = 'Americas' | 'Europe' | 'Asia-Pacific' | 'Africa & Middle East';

/** How often a series prints. Required on every indicator — see the header. */
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';

/**
 * Whether the published value is seasonally adjusted. `NA` means the upstream
 * does not state it — an explicit "unknown", not an assertion of "not adjusted".
 */
export type SeasonalAdjustment = 'SA' | 'NSA' | 'NA';

/** 3 = market-moving headline, 2 = watched, 1 = context. */
export type Importance = 1 | 2 | 3;

/** The upstream a series is read from. The adapter for each lives in `features/market/sources`. */
export type SourceId = 'worldbank' | 'fred' | 'bis' | 'imf' | 'erapi';

/**
 * How a raw upstream level becomes the number we publish. `yoy` needs `lag`
 * because the transform depends on the series' own frequency: 12 for a monthly
 * year-ago point, 4 for a quarterly one. Reading the lag off date spacing is
 * exactly how a quarterly series silently gets a "YoY" over three years.
 */
export type ValueShape = 'level' | 'yoy' | 'change';

/** Identity of an economy. No measurements — those live on the indicator. */
export type Country = {
  /** ISO 3166-1 alpha-3 — the key every upstream is keyed on. */
  id: string;
  iso2: string;
  iso3: string;
  name: string;
  region: Region;
  /** ISO-4217 code. */
  currency: string;
  /** IANA zone of the capital, or null when not asserted (see `countries.ts`). */
  timezone: string | null;
};

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
