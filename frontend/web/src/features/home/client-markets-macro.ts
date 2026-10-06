/**
 * Home markets macro domain: US Treasury curve / dollar / volatility board,
 * BIS policy rates, FRED indicators, World Bank worldwide board, plus the
 * Indonesia board.
 */
import { DASH, isNum } from './client-shared';
import { fmtNum, fmtUsdCompact } from './client-crypto';
import type { Quote } from './client-markets-quotes';

/**
 * The macro family: the US Treasury curve (13-week / 5y / 10y / 30y), the dollar
 * index and the volatility indices, plus curve spreads DERIVED locally. Same
 * Yahoo chart endpoint as the commodity/stock families, but a yield row's delta
 * is rendered in basis points — see `fmtBp`.
 */
export const MACRO_URL = '/api/market/macro';

/**
 * A Treasury yield level in percent (`5.277%`). A yield is quoted in percent, so
 * this is a percentage-point level — NOT `fmtPct`, which would print a bare
 * number with a sign and read as a change. Absent -> `—`.
 */
export function fmtYield(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return `${v.toFixed(3)}%`;
}

/**
 * A move in basis points from a percent-quoted level: `Δpercent × 100`
 * (`0.077` -> `+7.7 bp`). This is the convention for a yield delta — a
 * percent-of-percent change on a yield would be meaningless. Absent -> `—`.
 */
export function fmtBp(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH;
  const bp = v * 100;
  return `${bp >= 0 ? '+' : ''}${bp.toFixed(digits)} bp`;
}

/** A spread already expressed in basis points (`+128.4 bp`). Absent -> `—`. */
export function fmtBpRaw(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH;
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)} bp`;
}

/**
 * A FRED indicator value with its own unit appended, e.g. `3.71% YoY`, `4.2%`,
 * `+29K`, `197,000`, `0.45 pp`, `51.7 index`. The `unit` string comes from the
 * route's spec, so the same formatter covers every indicator without a per-series
 * branch here. Absent -> `—`.
 */
export function fmtIndicator(v: number | null | undefined, unit: string, decimals: number): string {
  if (!isNum(v)) return DASH;
  if (unit.startsWith('%')) return `${v.toFixed(decimals)}${unit}`;
  if (unit === 'claims') return fmtNum(v, 0);
  if (unit === 'K MoM') return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}K`;
  return `${v.toFixed(decimals)} ${unit}`;
}

/**
 * A headcount, compacted to three significant figures (`8.22B`). The worldwide
 * board compares 125 rows; the raw form (`8,215,424,893`) made the population
 * column wider than any other two columns combined, for digits no reader takes in
 * past the third. `count` stays exact for the tables that show one row at a time.
 */
export function fmtCountCompact(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

/**
 * A World Bank value rendered by its `kind`: `usd`/`pop` are compacted, the rest
 * are plain with their unit. Absent -> `—`.
 */
export function fmtEconomy(v: number | null | undefined, kind: string, decimals: number): string {
  if (!isNum(v)) return DASH;
  switch (kind) {
    case 'usd':
      return fmtUsdCompact(v);
    case 'pop':
      return fmtCountCompact(v);
    case 'count':
      return fmtNum(v, 0);
    case 'years':
      return `${v.toFixed(decimals)} yr`;
    case 'pct':
      return `${v.toFixed(decimals)}%`;
    case 'per1k':
      return `${v.toFixed(decimals)}/1k`;
    case 'tonnes':
      return `${v.toFixed(decimals)} t`;
    default:
      return v.toFixed(decimals);
  }
}

/**
 * A worldwide cell's change against its decade-earlier observation, read by the
 * same `kind` rules as the value itself: a percentage series moves in POINTS
 * (`+1.2 pp`), a money or headcount series in PERCENT of its old level (`+38%`),
 * and a level series (years, per-1,000 births, tonnes) in absolute units.
 *
 * Absent comparison -> `—`, never `+0`: "no trend shown" and "no change" are
 * different claims and must not render the same. The direction is NOT a judgement
 * — a rising government debt and a rising life expectancy both print `+`.
 */
export function fmtDelta(
  value: number | null | undefined,
  prior: { value: number; year: string } | null | undefined,
  kind: string,
  decimals: number
): string {
  if (!isNum(value) || !prior || !isNum(prior.value)) return DASH;
  const d = value - prior.value;
  const sign = d >= 0 ? '+' : '';
  switch (kind) {
    case 'pct':
      return `${sign}${d.toFixed(1)} pp`;
    case 'usd':
    case 'pop':
    case 'count': {
      // A relative change off a zero base is undefined; withhold it rather than
      // print an infinity.
      if (prior.value === 0) return DASH;
      return `${sign}${((d / Math.abs(prior.value)) * 100).toFixed(0)}%`;
    }
    default:
      return `${sign}${d.toFixed(decimals)}`;
  }
}

/** Direction of a cell's change: -1 down, 1 up, 0 flat or not comparable. */
export function deltaDir(
  value: number | null | undefined,
  prior: { value: number } | null | undefined
): -1 | 0 | 1 {
  if (!isNum(value) || !prior || !isNum(prior.value)) return 0;
  const d = value - prior.value;
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

/** A policy rate level (`3.875%`). Absent -> `—`. */
export function fmtPolicyRate(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return `${v.toFixed(3).replace(/\.?0+$/, '')}%`;
}

/** An observation year, or `—`. Kept separate so a year is never confused for a value. */
export function fmtYear(v: string | null | undefined): string {
  return v && v.length > 0 ? v : DASH;
}

/** One locally-derived curve spread (bp), null unless both legs returned a quote. */
export type MacroSpread = {
  label: string;
  long: string;
  short: string;
  bp: number | null;
  note: string;
};

/**
 * One macro row as `/api/market/macro` emits it: the Yahoo chart row plus the
 * presentation metadata the board needs. `unit` is `'yield'` (level in percent,
 * delta in basis points) or `'index'` (level in points, delta in percent).
 */
export type MacroQuote = Quote & {
  group: string;
  unit: 'yield' | 'index';
  note: string;
};

/** One central bank's policy rate row (the macro family's BIS block). */
export type PolicyRateRow = {
  area: string;
  bank: string;
  region: string;
  rate: number | null;
  date: string | null;
  note: string;
};

/**
 * One US macro indicator row (FRED). `value` is already TRANSFORMED server-side —
 * a level, a year-over-year percent, or a period change — so the panel prints it
 * with `unit` rather than recomputing anything. `date` is the observation the
 * value came from, which is why it is always shown next to it.
 */
export type IndicatorRow = {
  id: string;
  name: string;
  group: string;
  unit: string;
  decimals: number;
  value: number | null;
  date: string | null;
  note: string;
};

/**
 * One cell of the worldwide board: the newest annual value, the year it refers
 * to, and — where the window holds an observation at least ~8 years back — an
 * earlier value to compare it against. `prior` null means "no trend to show",
 * never "no change".
 */
export type WorldCell = {
  value: number | null;
  year: string | null;
  prior: { value: number; year: string } | null;
};

/**
 * One row of the worldwide board (World Bank, annual) — a country or an
 * aggregate. `cells` is keyed by indicator id and each cell carries its OWN
 * reference year: the series publish on different lags, so one shared year
 * column would be wrong for most of them.
 */
export type WorldRow = {
  code: string;
  name: string;
  region: string;
  cells: Record<string, WorldCell>;
};

/**
 * One COLUMN of the worldwide board. Rides in the payload so the landing page
 * renders the headers (and formats the cells) from the API instead of importing
 * the macro family across a feature boundary.
 */
export type WorldIndicatorRow = {
  id: string;
  name: string;
  short: string;
  kind: string;
  decimals: number;
  note: string;
  /** The column block this indicator's header groups under, in `WORLD_THEMES` order. */
  theme: string;
};

/**
 * A failed upstream item. The macro/indonesia families report `{symbol, reason}`
 * objects rather than the bare symbol names the Yahoo-only families report, so a
 * panel can say WHY a row is missing instead of just that it is.
 */
export type UpstreamFailure = { symbol: string; reason: string };

/**
 * `/api/market/macro` — the GLOBAL macro board.
 *
 * Independent blocks: live Yahoo quotes, locally-derived curve spreads, BIS
 * policy rates, FRED indicators, and the World Bank worldwide board (countries
 * plus the world/income/region aggregates). Any block can be empty (with its
 * cause named in `failed[]`) without the others being withheld — which is why
 * this is declared explicitly rather than as a spread-carrying `QuotesEnvelope`,
 * whose `failed` is a `string[]`.
 */
export type MacroEnvelope = {
  quotes: MacroQuote[];
  spreads: MacroSpread[];
  policyRates: PolicyRateRow[];
  indicators: IndicatorRow[];
  /** Column specs for the worldwide table, in render order. */
  worldIndicators: WorldIndicatorRow[];
  /** The 125 countries on the worldwide board, grouped by `region`. */
  economies: WorldRow[];
  /** World, the four income groups and the regional/unions blocks. */
  aggregates: WorldRow[];
  count: number;
  failed: UpstreamFailure[];
  upstream: string[];
  userAgent: string;
  asOf: number;
  derived: string;
};

// ---------------------------------------------------------------------------
// The Indonesia family — `/api/market/indonesia`.
// ---------------------------------------------------------------------------

/**
 * The Indonesia board: LIVE rupiah crosses + IDX indices (Yahoo), the BI-Rate
 * (BIS), and annual structural indicators (World Bank).
 */
export const INDONESIA_URL = '/api/market/indonesia';

/** A rupiah/index row: a Yahoo quote plus the group it belongs to and a note. */
export type IndonesiaQuote = Quote & { group: string; note: string };

/** The BI-Rate row. `rate` is percent per annum; `date` is the BIS observation. */
export type IndonesiaPolicy = {
  area: string;
  label: string;
  rate: number | null;
  date: string | null;
  note: string;
};

/**
 * One annual Indonesian indicator. `kind` drives formatting (`usd`/`count` are
 * compacted), and `year` is MANDATORY next to the value — an annual figure shown
 * without its year reads as current when it is not.
 */
export type IndonesiaEconomyRow = {
  id: string;
  name: string;
  group: string;
  kind: string;
  decimals: number;
  value: number | null;
  year: string | null;
  note: string;
};

export type IndonesiaEnvelope = {
  quotes: IndonesiaQuote[];
  policy: IndonesiaPolicy;
  economy: IndonesiaEconomyRow[];
  /**
   * Provenance of the IMF Fiscal Monitor block: which vintage, when it was
   * published, the last fiscal year it can call an outturn, and how many
   * projection years were withheld. Null when the IMF block is unavailable.
   */
  apbn: {
    vintage: string;
    published: string;
    actualThrough: number;
    droppedProjections: number;
  } | null;
  count: number;
  failed: UpstreamFailure[];
  upstream: string[];
  userAgent: string;
  asOf: number;
  derived: string;
};
