/** Market-impact scoring and liquidity breadth for the regime engine. */
import { ASSETS } from './model-regime-trend';
import type { AssetId, DimensionId, DimensionReading, Stance } from './model-regime-trend';
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
