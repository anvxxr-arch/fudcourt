/** Regime trend engine and dimension readings: noise-aware trend classification over published observations. */

export type DimensionId = 'growth' | 'inflation' | 'labor' | 'liquidity' | 'policy';
export type TrendDirection = 'up' | 'down' | 'flat';
export type AssetId = 'btc' | 'gold' | 'usd' | 'bonds' | 'equity';
export type Stance = 'strongly bullish' | 'bullish' | 'neutral' | 'bearish' | 'strongly bearish';

/** The asset classes the impact table scores, in display order. */
export const ASSETS: readonly { id: AssetId; label: string }[] = [
  { id: 'btc', label: 'BTC' },
  { id: 'gold', label: 'Gold' },
  { id: 'usd', label: 'USD' },
  { id: 'bonds', label: 'Bonds' },
  { id: 'equity', label: 'Equity' },
];

/**
 * The word each dimension uses for a direction. Separate from the rule table's
 * tags because the two answer different questions: the word is what a reader
 * sees ("Disinflation"), the tag is what a rule matches on ("cool").
 */
export const VOCAB: Readonly<Record<DimensionId, { up: string; down: string; flat: string }>> = {
  growth: { up: 'Accelerating', down: 'Cooling', flat: 'Steady' },
  inflation: { up: 'Re-accelerating', down: 'Disinflation', flat: 'Sticky' },
  labor: { up: 'Loosening', down: 'Tightening', flat: 'Stable' },
  liquidity: { up: 'Expanding', down: 'Contracting', flat: 'Flat' },
  policy: { up: 'Tightening', down: 'Easing', flat: 'On hold' },
};

/**
 * The rule table's semantic tag per direction. `inflation.flat` is "sticky"
 * rather than "stable" on purpose: an inflation rate that is not moving is not
 * good news, it is the absence of disinflation, and the rule table needs to be
 * able to say so.
 */
const TAGS: Readonly<Record<DimensionId, Record<TrendDirection, string>>> = {
  growth: { up: 'hot', down: 'cool', flat: 'steady' },
  inflation: { up: 'hot', down: 'cool', flat: 'sticky' },
  labor: { up: 'loose', down: 'tight', flat: 'stable' },
  liquidity: { up: 'expand', down: 'contract', flat: 'flat' },
  policy: { up: 'tight', down: 'ease', flat: 'hold' },
};

export type TrendResult = {
  direction: TrendDirection;
  /** latest − value `lookback` periods back. */
  change: number;
  /** Periods actually spanned (clamped to the series length). */
  lookback: number;
  /** The threshold the change was judged against. */
  noise: number;
  /** |change| / noise. 1 means "exactly at the noise floor". */
  strength: number;
};

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Robust sigma: MAD of the values, scaled to be a consistent normal estimate. */
function robustSigma(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const med = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - med)));
}

/**
 * Classify a series' direction over `lookback` periods.
 *
 * Returns `null` when there are too few points to say anything — which is a
 * first-class answer here. A caller that receives `null` reports "insufficient
 * data" for that dimension; it does not fall back to "flat", because "flat" is
 * a claim and "unknown" is not.
 */
export function classifyTrend(values: readonly number[], lookback: number): TrendResult | null {
  const n = values.length;
  if (n < 4) return null;
  const span = Math.max(1, Math.min(lookback, n - 1));
  const latest = values[n - 1];
  const past = values[n - 1 - span];
  const change = latest - past;

  const diffs: number[] = [];
  for (let i = 1; i < n; i++) diffs.push(values[i] - values[i - 1]);
  const sigma = robustSigma(diffs);

  // A series that is constant, or perfectly monotone with equal steps, has a
  // zero MAD of differences — the noise model would then call ANY move
  // significant. Floor the threshold at a scale-relative epsilon so those
  // series still resolve to 'flat' instead of 'up'.
  const scale = Math.max(Math.abs(latest), Math.abs(past), 1e-12);
  const sigmaEff = Math.max(sigma, scale * 1e-9);
  const noise = sigmaEff * Math.sqrt(span);

  const direction: TrendDirection = change > noise ? 'up' : change < -noise ? 'down' : 'flat';
  // A step-function series (a policy rate that holds, then moves) has a zero MAD
  // of differences, so ANY move is significant — which is the right verdict. But
  // the raw ratio is then unbounded and would report strength=1e7, so it is
  // capped: past the cap the number stops carrying information.
  const raw = change === 0 ? 0 : Math.abs(change) / noise;
  const strength = Math.min(raw, 99);
  return { direction, change, lookback: span, noise, strength };
}

/** One dimension's resolved reading, ready for the rule table and the UI. */
export type DimensionReading = {
  id: DimensionId;
  label: string;
  /** The canonical slug the reading came from (e.g. `us-cpi`). */
  series: string;
  unit: string;
  decimals: number;
  latest: { date: string; value: number } | null;
  prior: { date: string; value: number } | null;
  trend: TrendResult | null;
  /** The vocabulary word, or null when the dimension could not be read. */
  word: string | null;
  /** The rule-table tag, or null when unreadable. */
  tag: string | null;
  /** Why the reading is absent, when it is. */
  reason: string | null;
};

/** A series handed to `buildRegime`, already read and filtered by the route. */
export type SeriesInput = {
  id: DimensionId;
  slug: string;
  label: string;
  unit: string;
  decimals: number;
  /** Oldest → newest, finite values only. */
  values: readonly number[];
  dates: readonly string[];
  lookback: number;
  /** Set when the route could not read the series at all. */
  failure?: string | null;
};

/** Periods back a trend is measured, per publication cadence. */
export const LOOKBACK_BY_FREQUENCY: Readonly<Record<string, number>> = {
  daily: 30,
  weekly: 12,
  monthly: 6,
  quarterly: 4,
  annual: 3,
};

/** Read one dimension from a series input. Pure. */
export function readDimension(input: SeriesInput): DimensionReading {
  const base = { id: input.id, label: input.label, series: input.slug, unit: input.unit, decimals: input.decimals };
  if (input.failure) {
    return { ...base, latest: null, prior: null, trend: null, word: null, tag: null, reason: input.failure };
  }
  const trend = classifyTrend(input.values, input.lookback);
  if (!trend) {
    return { ...base, latest: null, prior: null, trend: null, word: null, tag: null, reason: 'not enough published observations to establish a direction' };
  }
  const n = input.values.length;
  const span = trend.lookback;
  const latest = { date: input.dates[n - 1] ?? '', value: input.values[n - 1] };
  const prior = { date: input.dates[n - 1 - span] ?? '', value: input.values[n - 1 - span] };
  return {
    ...base,
    latest,
    prior,
    trend,
    word: VOCAB[input.id][trend.direction],
    tag: TAGS[input.id][trend.direction],
    reason: null,
  };
}
