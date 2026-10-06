/** Regime rules, matching, and MacroRegime assembly (impact scoring lives in model-regime-impacts). */
import { readDimension } from './model-regime-trend';
import type { DimensionId, DimensionReading, SeriesInput } from './model-regime-trend';
import { scoreImpacts } from './model-regime-impacts';
import type { ImpactRow } from './model-regime-impacts';

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


export * from './model-regime-impacts';

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
