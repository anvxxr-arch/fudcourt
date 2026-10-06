/**
 * Economy domain model: taxonomy, entities, country + indicator registries,
 * regime engine, and the view-safe client — split by board domain across
 * `model-*.ts` and re-exported here, so the domain keeps one import address
 * (`@/features/economy/model`). The shared view-safe row types live below;
 * everything else lives in its domain module.
 */

/** One headline cell on a country or dashboard board. */
export type Metric = {
  slug: string;
  label: string;
  category: string;
  /** `null` when the upstream has no published observation — rendered `—`. */
  value: number | null;
  /** The period the value belongs to (e.g. `2026-08`, `2025`), never "now". */
  date: string | null;
  /** The observation one period earlier, when the window holds one. */
  previous: number | null;
  unit: string;
  decimals: number;
  frequency: string;
  source: string;
  /** `null` when the source does not state a seasonal adjustment. */
  seasonalAdjustment: string | null;
};

/** One row of an indicator table. */
export type IndicatorRow = Metric & { importance: number; note: string };

/** A category block on a country profile. */
export type CategoryBlock = { category: string; label: string; rows: IndicatorRow[] };

/** One scheduled or recently published event. */
export type ReleaseRow = {
  slug: string;
  label: string;
  country: string | null;
  category: string;
  importance: number;
  unit: string;
  /** ISO-8601 instant, or null when the source states no publication time. */
  releaseAt: string | null;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  revised: number | null;
};

/** A country summary on the explorer. */
export type CountrySummary = {
  id: string;
  iso2: string;
  iso3: string;
  name: string;
  region: string;
  currency: string;
  timezone: string | null;
  indicatorCount: number;
};

export * from './model-taxonomy';
export * from './model-nation';
export * from './model-indicator';
export * from './model-central-bank';
export * from './model-regime';
export * from './model-client';
export * from './model-format';
