/** Economy client — markets: central banks, liquidity, compare, calendar, regime. */
import type { Country } from './model-nation';
import type { ReleaseRow } from './model';
import { ECONOMY_API, getJson, type IndicatorMeta } from './model-client-catalog';

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

/** One dimension's reading in a macro regime. */
export type RegimeDimension = {
  id: string;
  label: string;
  /** The canonical slug the reading came from, or '' when none is bound. */
  series: string;
  unit: string;
  decimals: number;
  latest: { date: string; value: number } | null;
  prior: { date: string; value: number } | null;
  /** `null` when the series could not be read — a first-class answer, not "flat". */
  trend: { direction: 'up' | 'down' | 'flat'; change: number; lookback: number; noise: number; strength: number } | null;
  word: string | null;
  tag: string | null;
  reason: string | null;
};

export type RegimeImpact = {
  asset: string;
  label: string;
  stance: string;
  score: number;
  /** Every weight that produced the score, so the sum can be audited. */
  contributions: { dimension: string; word: string; weight: number }[];
};

export type RegimeEnvelope = {
  /** The scope as an OBJECT. Distinct from `subject`, which is its display name. */
  scope: { kind: 'global'; anchor: { iso3: string; name: string } } | { kind: 'country'; country: Country };
  /** The scope's display name ("Global", or a country's name). */
  subject: string;
  dimensions: RegimeDimension[];
  regime: { code: string; label: string; summary: string } | null;
  /** Why no rule fired, when none did. */
  regimeReason: string | null;
  confidence: 'high' | 'medium' | 'low';
  impacts: RegimeImpact[];
  /** Dimensions that could not be read, by id. */
  missing: string[];
  /** A deterministic reading of the computed facts. No model involved. */
  narrative: string;
  failed: { symbol: string; reason: string }[];
  upstream: string[];
  derived: string;
  asOf: number;
};

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

/** The macro regime for a country, or global when `country` is omitted. */
export function fetchRegime(country?: string, signal?: AbortSignal): Promise<RegimeEnvelope> {
  const qs = country ? `?country=${encodeURIComponent(country)}` : '';
  return getJson(`${ECONOMY_API}/regime${qs}`, signal);
}

/** One holding, classified into the regime's own asset classes and scored. */
export type ExposureHolding = {
  asset: string;
  value_usd: number;
  /** The class the holding was mapped to. */
  klass: string;
  /** That class's display label, from the weight table. */
  klassLabel: string;
  /** The class came from the fallback rule, not an explicit binding. */
  assumed: boolean;
  stance: string;
  score: number;
};

/** One asset class as this book holds it. */
export type ExposureClass = {
  asset: string;
  label: string;
  stance: string;
  score: number;
  value_usd: number;
  /** Share of the total book, or null when the total is not known. */
  share: number | null;
  /** The symbols in this class, largest first. */
  holdings: string[];
};

export type ExposureOverlay = {
  /** Every class the weight table scores, in its order — including empty ones. */
  classes: ExposureClass[];
  holdings: ExposureHolding[];
  /** Sum of every valued holding, or null when any holding could not be valued. */
  total_usd: number | null;
  mapped_usd: number;
  /** Value-weighted mean of the class scores, or null when nothing mapped. */
  alignment: number | null;
  /** Value share that mapped to a scored class, or null when the total is unknown. */
  coverage: number | null;
  /** Holdings left out of the maths, each naming its reason. */
  skipped: { asset: string; reason: string }[];
  /** The classification rule, stated. */
  rule: string;
};

/**
 * The regime joined with the treasury's own exposure. `exposure` is null when
 * the holdings read itself failed — the regime half is still served, and the
 * failure is named in `failed[]` rather than rendered as a zero.
 */
export type ExposureEnvelope = RegimeEnvelope & { exposure: ExposureOverlay | null };

/**
 * The result of an exposure read, with the HTTP status resolved to a REASON.
 *
 * The overlay reads private holdings, so the route is team-gated: an anonymous
 * or below-tier caller gets a 401, which is not an error to show — it is a
 * prompt to sign in. Resolving the status here keeps the view from string-
 * matching on an error message to tell "not signed in" apart from "the read
 * broke", which are different screens.
 */
export type ExposureRead = {
  data: ExposureEnvelope | null;
  /** True when the API answered 401 — anonymous, or below the tier the holdings need. */
  unauthorized: boolean;
  /** The failure text when the read failed for any other reason. */
  error: string | null;
};

export async function fetchExposure(country?: string, signal?: AbortSignal): Promise<ExposureRead> {
  const qs = country ? `?country=${encodeURIComponent(country)}` : '';
  const path = `${ECONOMY_API}/exposure${qs}`;
  try {
    const res = await fetch(path, { signal });
    if (res.status === 401) return { data: null, unauthorized: true, error: null };
    if (!res.ok) return { data: null, unauthorized: false, error: `${path} HTTP ${res.status}` };
    return { data: (await res.json()) as ExposureEnvelope, unauthorized: false, error: null };
  } catch (e) {
    return { data: null, unauthorized: false, error: e instanceof Error ? e.message : String(e) };
  }
}
