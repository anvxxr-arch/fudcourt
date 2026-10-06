/** Economy client — catalog: countries and indicators (envelopes + fetch helpers). */
import { getJSON } from '@/lib/fetch';
import type { CategoryBlock, CountrySummary, Metric, ReleaseRow } from './model';

/** The base path every helper here talks to. Views never call an upstream. */
export const ECONOMY_API = '/api/economy';

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return getJSON<T>(path, { signal });
}

export type CountriesEnvelope = {
  countries: CountrySummary[];
  regions: string[];
  total: number;
  asOf: number;
};

export type CountryEnvelope = {
  country: CountrySummary;
  keyMetrics: Metric[];
  groups: CategoryBlock[];
  releases: ReleaseRow[];
  /** Upstream items that failed, named so a gap is never silent. */
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type IndicatorMeta = {
  slug: string;
  name: string;
  country: string | null;
  countryName: string | null;
  category: string;
  subcategory: string;
  unit: string;
  frequency: string;
  seasonalAdjustment: string;
  source: string;
  importance: number;
  decimals: number;
  note: string;
};

export type IndicatorsEnvelope = {
  indicators: IndicatorMeta[];
  total: number;
  /** The size of the whole registry, so a filtered count can say "of N". */
  registryTotal: number;
  facets: {
    categories: { id: string; label: string; count: number }[];
    countries: { id: string; name: string; count: number }[];
    frequencies: { id: string; count: number }[];
    sources: { id: string; count: number }[];
  };
  asOf: number;
};

export type IndicatorEnvelope = {
  indicator: IndicatorMeta;
  observations: { date: string; value: number | null; previous: number | null }[];
  latest: { date: string; value: number } | null;
  release: ReleaseRow | null;
  related: IndicatorMeta[];
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export function fetchCountries(signal?: AbortSignal): Promise<CountriesEnvelope> {
  return getJson(`${ECONOMY_API}/countries`, signal);
}

export function fetchCountry(code: string, signal?: AbortSignal): Promise<CountryEnvelope> {
  return getJson(`${ECONOMY_API}/countries/${encodeURIComponent(code)}`, signal);
}

export type IndicatorQuery = {
  category?: string;
  country?: string;
  frequency?: string;
  source?: string;
  importance?: number;
  q?: string;
};

export function fetchIndicators(query: IndicatorQuery = {}, signal?: AbortSignal): Promise<IndicatorsEnvelope> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  }
  const qs = p.toString();
  return getJson(`${ECONOMY_API}/indicators${qs ? `?${qs}` : ''}`, signal);
}

export function fetchIndicator(slug: string, signal?: AbortSignal): Promise<IndicatorEnvelope> {
  return getJson(`${ECONOMY_API}/indicators/${encodeURIComponent(slug)}`, signal);
}
