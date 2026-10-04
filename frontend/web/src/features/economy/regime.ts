/**
 * The economy domain's INTELLIGENCE LAYER (plan Phase 13, stages 16–17).
 *
 * WHAT THIS FILE IS, AND WHAT IT REFUSES TO BE. The backend computes; it does
 * not narrate. Everything here is arithmetic over published observations —
 * trend detection with an explicit noise model, a rule table over the resulting
 * readings, and a weight table that turns those readings into a directional
 * score per asset class. No language model is involved, nothing is inferred
 * from a headline, and no number is ever invented to fill a gap.
 *
 * The module is PURE: no network, no clock, no I/O. `buildRegime` takes the
 * observations the route already read and returns a complete, auditable result.
 * That is what makes the engine unit-testable offline — the test suite feeds it
 * a series and asserts the regime, instead of asserting whatever today's
 * upstream happened to say.
 *
 * WHY THE TREND TEST IS NOISE-AWARE. "CPI rose from 2.6 to 2.7" is not a
 * trend; it is a print. A rule that called any nonzero change a direction would
 * flip a country between regimes on rounding noise and would be confidently
 * wrong most of the time. So a direction is only declared when the move over
 * the lookback exceeds what the series' own period-to-period variation predicts
 * — a random-walk null, with sigma estimated robustly (MAD of first
 * differences, scaled) so a single outlier cannot inflate the threshold.
 */

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

// ---------------------------------------------------------------------------
// Regime rules
// ---------------------------------------------------------------------------

export type RegimeRule = {
  code: string;
  label: string;
  /** One line stating what the combination means. */
  summary: string;
  /** Every listed dimension must be readable AND carry one of the listed tags. */
  when: Partial<Record<DimensionId, readonly string[]>>;
};

/**
 * Ordered, first match wins. Specificity is the order: a rule naming three
 * dimensions is tested before one naming two, so "growth cooling while
 * inflation re-accelerates" cannot be shadowed by the looser "growth cooling".
 */
export const REGIME_RULES: readonly RegimeRule[] = [
  {
    code: 'stagflation',
    label: 'Stagflation risk',
    summary: 'growth is cooling while inflation re-accelerates — the policy trade-off is at its worst, because easing would feed the price pressure it is meant to answer.',
    when: { growth: ['cool'], inflation: ['hot'] },
  },
  {
    code: 'overheating',
    label: 'Overheating',
    summary: 'growth and inflation are both running hot and policy is still tightening — demand is outrunning capacity.',
    when: { growth: ['hot'], inflation: ['hot'], policy: ['tight'] },
  },
  {
    code: 'goldilocks-easing',
    label: 'Goldilocks easing',
    summary: 'growth is holding up while inflation cools and policy eases — the most supportive combination for risk assets.',
    when: { growth: ['hot'], inflation: ['cool'], policy: ['ease'] },
  },
  {
    code: 'late-cycle-easing',
    label: 'Late-cycle easing',
    summary: 'growth is cooling, inflation is falling, and policy has turned — a late-cycle easing regime, historically supportive for duration and risk assets once the slowdown stops deepening.',
    when: { growth: ['cool'], inflation: ['cool'], policy: ['ease'] },
  },
  {
    code: 'reflation',
    label: 'Reflation',
    summary: 'growth and inflation are rising together — nominal activity is re-accelerating.',
    when: { growth: ['hot'], inflation: ['hot'] },
  },
  {
    code: 'goldilocks',
    label: 'Goldilocks',
    summary: 'growth is firm while inflation cools — a benign expansion.',
    when: { growth: ['hot'], inflation: ['cool'] },
  },
  {
    code: 'disinflationary-slowdown',
    label: 'Disinflationary slowdown',
    summary: 'growth and inflation are both falling — activity is cooling and price pressure is easing with it.',
    when: { growth: ['cool'], inflation: ['cool'] },
  },
  {
    code: 'policy-drag',
    label: 'Policy drag',
    summary: 'growth is cooling while policy is still tightening — the brake is applied into a slowdown.',
    when: { growth: ['cool'], policy: ['tight'] },
  },
  {
    code: 'liquidity-drain',
    label: 'Liquidity drain',
    summary: 'liquidity is contracting while policy tightens — the two most direct drains on risk assets are aligned.',
    when: { liquidity: ['contract'], policy: ['tight'] },
  },
  {
    code: 'liquidity-driven-easing',
    label: 'Liquidity-driven easing',
    summary: 'liquidity is expanding while policy eases — the two most direct supports for risk assets are aligned.',
    when: { liquidity: ['expand'], policy: ['ease'] },
  },
  {
    code: 'mid-cycle-expansion',
    label: 'Mid-cycle expansion',
    summary: 'growth is accelerating without a decisive inflation signal — a mid-cycle expansion.',
    when: { growth: ['hot'] },
  },
  {
    code: 'slowdown-policy-hold',
    label: 'Slowdown, policy on hold',
    summary: 'growth is cooling but policy has not moved — the market is waiting on the central bank.',
    when: { growth: ['cool'], policy: ['hold'] },
  },
  {
    code: 'cooling-sticky-prices',
    label: 'Cooling, sticky prices',
    summary: 'growth is cooling while inflation refuses to follow — the easing the slowdown would normally invite is not yet available.',
    when: { growth: ['cool'], inflation: ['sticky'] },
  },
  {
    code: 'inflationary-drift',
    label: 'Inflationary drift',
    summary: 'growth is steady while inflation re-accelerates — the price signal is moving on its own, without a demand impulse behind it.',
    when: { growth: ['steady'], inflation: ['hot'] },
  },
  {
    code: 'disinflationary-drift',
    label: 'Disinflationary drift',
    summary: 'growth is steady while inflation cools — price pressure is easing without the cost of a slowdown.',
    when: { growth: ['steady'], inflation: ['cool'] },
  },
  {
    code: 'wait-and-see',
    label: 'Wait-and-see',
    summary: 'growth is steady, inflation is sticky, and policy has not moved — no dimension has broken decisively in either direction.',
    // Requires policy to be genuinely idle. Without the third clause a country
    // holding rates steady while tightening would be labelled "wait-and-see",
    // which hides the one dimension that is actually moving.
    when: { growth: ['steady'], inflation: ['sticky'], policy: ['hold'] },
  },
  {
    code: 'easing',
    label: 'Easing cycle',
    summary: 'policy is easing — the direction of travel is accommodative.',
    when: { policy: ['ease'] },
  },
  {
    code: 'tightening',
    label: 'Tightening cycle',
    summary: 'policy is tightening — the direction of travel is restrictive.',
    when: { policy: ['tight'] },
  },
];

/** The rule a set of readings matches, or null when none does. Pure. */
export function matchRegime(readings: readonly DimensionReading[]): RegimeRule | null {
  const byId = new Map(readings.map((r) => [r.id, r]));
  for (const rule of REGIME_RULES) {
    let ok = true;
    for (const [id, tags] of Object.entries(rule.when) as [DimensionId, readonly string[]][]) {
      const r = byId.get(id);
      if (!r || r.tag === null || !tags.includes(r.tag)) {
        ok = false;
        break;
      }
    }
    if (ok) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Market impact
// ---------------------------------------------------------------------------

/**
 * Directional weights, per dimension reading. POSITIVE = supportive for that
 * asset, NEGATIVE = a headwind. These are stated heuristics, not estimates:
 * they encode the conventional transmission channel of each dimension (liquidity
 * and policy dominate risk assets; inflation dominates duration; a stronger
 * dollar tightens global conditions) and every contribution is returned to the
 * caller so a reader can audit the sum instead of trusting it.
 */
const IMPACT_WEIGHTS: Readonly<Record<string, Partial<Record<AssetId, number>>>> = {
  'growth:hot': { equity: 1.5, btc: 1.0, gold: -0.5, bonds: -0.5, usd: 0.5 },
  'growth:cool': { equity: -1.0, btc: -1.0, gold: 0.5, bonds: 1.0, usd: 0.5 },
  'growth:steady': {},
  'inflation:hot': { gold: 1.5, btc: 0.5, bonds: -1.5, equity: -1.0, usd: -0.5 },
  'inflation:cool': { bonds: 1.0, equity: 1.0, btc: 0.5, usd: -0.5 },
  'inflation:sticky': {},
  'labor:loose': { bonds: 0.5, equity: -0.5, btc: -0.5 },
  'labor:tight': { equity: 0.5, btc: 0.5, bonds: -0.5 },
  'labor:stable': {},
  'liquidity:expand': { btc: 2.0, equity: 1.0, gold: 0.5, bonds: 0.5, usd: -1.0 },
  'liquidity:contract': { btc: -2.0, equity: -1.0, gold: -0.5, bonds: -0.5, usd: 1.0 },
  'liquidity:flat': {},
  'policy:ease': { bonds: 1.5, equity: 1.0, btc: 1.0, gold: 1.0, usd: -1.0 },
  'policy:tight': { bonds: -1.5, equity: -1.0, btc: -1.0, gold: -1.0, usd: 1.0 },
  'policy:hold': {},
};

export type ImpactContribution = { dimension: DimensionId; word: string; weight: number };
export type ImpactRow = { asset: AssetId; label: string; stance: Stance; score: number; contributions: ImpactContribution[] };

/** Map a score to a stance. Pure; thresholds are the table's own units. */
export function stanceFor(score: number): Stance {
  if (score >= 2) return 'strongly bullish';
  if (score >= 0.75) return 'bullish';
  if (score <= -2) return 'strongly bearish';
  if (score <= -0.75) return 'bearish';
  return 'neutral';
}

/** Score every asset class from the readings. Pure. */
export function scoreImpacts(readings: readonly DimensionReading[]): ImpactRow[] {
  const rows: ImpactRow[] = ASSETS.map((a) => ({ asset: a.id, label: a.label, stance: 'neutral' as Stance, score: 0, contributions: [] }));
  const byAsset = new Map(rows.map((r) => [r.asset, r]));
  for (const r of readings) {
    if (!r.tag || !r.word) continue;
    const w = IMPACT_WEIGHTS[`${r.id}:${r.tag}`];
    if (!w) continue;
    for (const [asset, weight] of Object.entries(w) as [AssetId, number][]) {
      const row = byAsset.get(asset);
      if (!row || weight === 0) continue;
      row.score = Math.round((row.score + weight) * 100) / 100;
      row.contributions.push({ dimension: r.id, word: r.word, weight });
    }
  }
  for (const row of rows) row.stance = stanceFor(row.score);
  return rows;
}

// ---------------------------------------------------------------------------
// Liquidity breadth (shared with the liquidity board)
// ---------------------------------------------------------------------------

/**
 * The breadth score over a set of liquidity components: the share of live
 * components moving in their LOOSENING direction, 0–100, each casting one vote.
 * Extracted so the liquidity board and the regime engine cannot disagree about
 * what "liquidity is expanding" means.
 *
 * `change * direction > 0` is the loosening test, which is why `direction`
 * exists on the spec at all: a rising reverse-repo balance DRAINS reserves, so
 * a board that treated every rise as expansion would be confidently wrong in
 * exactly the regime it exists to detect.
 */
export function liquidityBreadth(
  components: readonly { change: number | null; direction: 1 | -1 }[]
): { value: number; trend: 'Expanding' | 'Neutral' | 'Contracting'; components: number } | null {
  const live = components.filter((c) => c.change !== null);
  if (live.length === 0) return null;
  let expand = 0;
  let contract = 0;
  for (const c of live) {
    const vote = Math.sign((c.change as number) * c.direction);
    if (vote > 0) expand++;
    else if (vote < 0) contract++;
  }
  const total = live.length;
  const value = Math.round(((expand + (total - expand - contract) * 0.5) / total) * 100);
  const trend = value >= 58 ? 'Expanding' : value <= 42 ? 'Contracting' : 'Neutral';
  return { value, trend, components: total };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type MacroRegime = {
  /**
   * The scope's DISPLAY NAME ("Global", or a country's name).
   *
   * Deliberately named `subject`, NOT `scope`. The API route spreads this
   * result into a payload that already carries a `scope` OBJECT
   * (`{kind:"global"|"country"}`); while this key was called `scope` it
   * silently overwrote that object with this string, and every consumer
   * reading `scope.kind` crashed. tests/regime-tests.ts pins the name.
   */
  subject: string;
  dimensions: DimensionReading[];
  regime: { code: string; label: string; summary: string } | null;
  /** Why no rule fired, when none did. */
  regimeReason: string | null;
  confidence: 'high' | 'medium' | 'low';
  impacts: ImpactRow[];
  /** Dimensions that could not be read, by id. */
  missing: DimensionId[];
  /** A deterministic reading of the computed facts. No model involved. */
  narrative: string;
};

/** Dimensions a regime needs before it is worth stating, in display order. */
export const DIMENSION_ORDER: readonly DimensionId[] = ['growth', 'inflation', 'labor', 'liquidity', 'policy'];

/** The display name of each dimension. */
export const DIMENSION_LABEL: Readonly<Record<DimensionId, string>> = {
  growth: 'Growth',
  inflation: 'Inflation',
  labor: 'Labor',
  liquidity: 'Liquidity',
  policy: 'Policy',
};

export function buildRegime(subject: string, series: readonly SeriesInput[]): MacroRegime {
  const byId = new Map(series.map((s) => [s.id, s]));
  const dimensions = DIMENSION_ORDER.map((id) => {
    const input = byId.get(id);
    if (!input) {
      return {
        id,
        label: DIMENSION_LABEL[id],
        series: '',
        unit: '',
        decimals: 2,
        latest: null,
        prior: null,
        trend: null,
        word: null,
        tag: null,
        reason: 'no series is bound to this dimension',
      } satisfies DimensionReading;
    }
    return readDimension(input);
  });

  const missing = dimensions.filter((d) => d.tag === null).map((d) => d.id);
  const matched = matchRegime(dimensions);
  const readable = dimensions.filter((d) => d.trend !== null);
  // A dimension that cleared its noise floor is a MOVING dimension; one that did
  // not is a genuine "steady" reading, not evidence for the regime either way.
  const directional = readable.filter((d) => (d.trend?.strength ?? 0) >= 1).length;

  // Confidence is about EVIDENCE, not about the regime being right: how many of
  // the five dimensions resolved, and how many of those actually moved.
  const confidence: MacroRegime['confidence'] =
    readable.length >= 5 && directional >= 3 ? 'high' : readable.length >= 3 && directional >= 2 ? 'medium' : 'low';

  const impacts = scoreImpacts(dimensions);

  const regimeReason = matched
    ? null
    : readable.length === 0
      ? 'no dimension could be read from published observations'
      : `no rule matched the readings (${dimensions.filter((d) => d.word).map((d) => `${d.label} ${d.word}`).join(', ')})`;

  return {
    subject,
    dimensions,
    regime: matched ? { code: matched.code, label: matched.label, summary: matched.summary } : null,
    regimeReason,
    confidence,
    impacts,
    missing,
    narrative: narrate(subject, dimensions, matched, impacts, confidence),
  };
}

/**
 * A deterministic sentence-per-fact reading. It restates ONLY what was computed
 * — the words, the regime, the stance table — so it cannot drift from the
 * numbers above it. This is the seam where an LLM may later rewrite the prose;
 * it must never be the place a number is produced.
 */
function narrate(
  subject: string,
  dimensions: readonly DimensionReading[],
  matched: RegimeRule | null,
  impacts: readonly ImpactRow[],
  confidence: MacroRegime['confidence']
): string {
  const parts: string[] = [];
  const read = dimensions.filter((d) => d.word !== null);
  if (read.length === 0) {
    return `${subject}: no dimension could be read from published observations, so no regime is stated.`;
  }
  parts.push(
    `${subject}: ${read.map((d) => `${d.label.toLowerCase()} ${d.word?.toLowerCase()}`).join(', ')}` +
      (read.length < dimensions.length ? ` (${dimensions.length - read.length} of ${dimensions.length} dimension(s) unreadable)` : '') +
      '.'
  );
  parts.push(
    matched
      ? `That combination reads as ${matched.label.toLowerCase()}.`
      : 'No rule in the table matches that combination, so no regime label is applied.'
  );
  const directional = impacts.filter((i) => i.stance !== 'neutral');
  parts.push(
    directional.length > 0
      ? `The weight table scores ${directional.map((i) => `${i.label} ${i.stance}`).join(', ')}.`
      : 'The weight table leaves every asset class neutral.'
  );
  parts.push(`Evidence confidence: ${confidence}. This is a rule table over published observations, not a forecast.`);
  return parts.join(' ');
}
