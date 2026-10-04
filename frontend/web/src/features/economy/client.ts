/**
 * The economy domain's CLIENT — the only thing a view is allowed to know about
 * where a number came from (plan Phase 11).
 *
 * WHY THIS FILE EXISTS. The whole point of the module's shape is that a view
 * never learns the name "FRED". A page imports these types and these two fetch
 * helpers; the upstream, its credential, its rate limit and its revision
 * behaviour live behind `/api/economy/*` and can be replaced without touching a
 * single component. If a component ever needs `fredUrl` or `WORLDBANK_API` to
 * render, the layering has already failed.
 *
 * The envelope types below are the contract with the route layer, and they carry
 * the project's honesty rules as TYPES: every measured value is `number | null`
 * so "the upstream published nothing" cannot be silently rendered as `0`, and
 * every row keeps the `date` its value belongs to, because a number without a
 * reference period is not a measurement.
 */

export type {
  Country,
  EconomicIndicator,
  EconomicObservation,
  EconomicRelease,
  Frequency,
  Importance,
  Region,
  SeasonalAdjustment,
  SourceId,
  ValueShape,
} from '@/features/economy/model';

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

export type CentralBankRow = {
  slug: string;
  short: string;
  name: string;
  area: string;
  country: string | null;
  region: string;
  note: string;
  rate: number | null;
  date: string | null;
  /** The previous DISTINCT rate — null when the window holds only one level. */
  previousRate: number | null;
};

export type CentralBanksEnvelope = {
  banks: CentralBankRow[];
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type CentralBankEnvelope = {
  bank: CentralBankRow;
  history: { date: string; value: number | null }[];
  /** Each level change with the date it took effect — the decision list. */
  changes: { date: string; from: number; to: number }[];
  related: IndicatorMeta[];
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type LiquidityComponent = {
  id: string;
  label: string;
  /** The level as the upstream publishes it. */
  value: number | null;
  unit: string;
  date: string | null;
  previous: number | null;
  /** The change over the window, in the series' own unit. */
  change: number | null;
  /** Whether a rising value is looser (`+1`) or tighter (`-1`) liquidity. */
  direction: 1 | -1;
  source: string;
  note: string;
};

export type LiquidityEnvelope = {
  components: LiquidityComponent[];
  index: { value: number; trend: 'Expanding' | 'Neutral' | 'Contracting'; components: number } | null;
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type CompareSeries = {
  slug: string;
  label: string;
  country: string | null;
  unit: string;
  decimals: number;
  frequency: string;
  points: { date: string; value: number | null }[];
};

export type CompareEnvelope = {
  period: string;
  series: CompareSeries[];
  /** Slugs the request named that resolved to nothing. */
  missing: string[];
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

export type CalendarEnvelope = {
  events: ReleaseRow[];
  window: { from: string; to: string };
  total: number;
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

/** The base path every helper here talks to. Views never call an upstream. */
export const ECONOMY_API = '/api/economy';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  const body = (await res.json()) as T & { error?: string; detail?: string };
  if (!res.ok) {
    // A failed read is LOUD: the caller renders the error, never an empty board
    // that reads as "the world has no data".
    throw new Error(body.detail ?? body.error ?? `${path} responded ${res.status}`);
  }
  return body;
}

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

export function fetchCentralBanks(signal?: AbortSignal): Promise<CentralBanksEnvelope> {
  return getJson(`${ECONOMY_API}/central-banks`, signal);
}

export function fetchCentralBank(slug: string, signal?: AbortSignal): Promise<CentralBankEnvelope> {
  return getJson(`${ECONOMY_API}/central-banks/${encodeURIComponent(slug)}`, signal);
}

export function fetchLiquidity(signal?: AbortSignal): Promise<LiquidityEnvelope> {
  return getJson(`${ECONOMY_API}/liquidity`, signal);
}

export function fetchCompare(
  slugs: readonly string[],
  period: string,
  signal?: AbortSignal
): Promise<CompareEnvelope> {
  const p = new URLSearchParams({ indicators: slugs.join(','), period });
  return getJson(`${ECONOMY_API}/compare?${p}`, signal);
}

export type CalendarQuery = { from?: string; to?: string; country?: string; category?: string; importance?: number };

export function fetchCalendar(query: CalendarQuery = {}, signal?: AbortSignal): Promise<CalendarEnvelope> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  }
  const qs = p.toString();
  return getJson(`${ECONOMY_API}/calendar${qs ? `?${qs}` : ''}`, signal);
}

// ---------------------------------------------------------------------------
// Formatting. One place decides how a missing value and a number look, so a
// board and a detail page can never disagree about what an em dash means.
// ---------------------------------------------------------------------------

/** The project's single spelling of "the upstream published nothing". */
export const NO_VALUE = '—';

export function formatValue(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** A compact magnitude for a level too large to print in full (reserves, GDP). */
export function formatCompact(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  const abs = Math.abs(value);
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (abs >= scale) return `${(value / scale).toFixed(decimals)}${suffix}`;
  }
  return value.toFixed(decimals);
}

/** Whether a change reads as up, down or flat — the sign a tint keys off. */
export function changeSign(change: number | null | undefined): -1 | 0 | 1 {
  if (change === null || change === undefined || !Number.isFinite(change) || change === 0) return 0;
  return change > 0 ? 1 : -1;
}

/** A signed delta with the series' own decimals, for a "vs prior" cell. */
export function formatDelta(change: number | null | undefined, decimals: number): string {
  if (change === null || change === undefined || !Number.isFinite(change)) return NO_VALUE;
  const s = change > 0 ? '+' : '';
  return `${s}${change.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return NO_VALUE;
  // Periods arrive as `2026-08` / `2025` / a full instant; only the date part is
  // ever shown, and a period is NOT reformatted into a local midnight (which
  // would shift a month back a day in a negative-offset zone).
  return iso.length <= 10 ? iso : iso.slice(0, 10);
}

/** A relative "how stale is this" label for a release or a rate. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return NO_VALUE;
  const t = Date.parse(iso.length === 7 ? `${iso}-01` : iso.length === 4 ? `${iso}-01-01` : iso);
  if (!Number.isFinite(t)) return NO_VALUE;
  const days = Math.round((t - now) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return `in ${days}d`;
  return `${-days}d ago`;
}
