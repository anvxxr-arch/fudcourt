/**
 * Portfolio exposure over a macro regime — the overlay that crosses the
 * regime's asset-class weight table with what the treasury actually holds.
 *
 * WHAT THIS ANSWERS. The regime board states "the weight table scores BTC
 * bearish, USD bullish". That is a claim about ASSET CLASSES, not about this
 * book. The overlay turns it into a claim about the book: how much of the
 * treasury sits in each class, and what the value-weighted stance of those
 * holdings is. It is a READING of the regime against the holdings — never a
 * recommendation, never a forecast, and never a position size.
 *
 * THE CLASSIFICATION IS A STATED RULE, NOT AN INFERENCE. The weight table
 * scores five classes (btc, gold, usd, bonds, equity); a treasury holding is a
 * token. So every holding is mapped by the explicit table below, and a symbol
 * that falls through is scored as the crypto-risk class with `assumed: true` on
 * its row — the board shows the assumption instead of hiding it. A stablecoin is
 * USD-class because it is a claim on a dollar; a tokenised gold claim is gold;
 * bitcoin is the crypto-risk class; and any OTHER token is also the crypto-risk
 * class, because the table's `btc` column is the channel crypto beta transmits
 * through. Nothing here is mapped by guessing at a name.
 *
 * A PARTIAL BOOK HAS NO SHARE. If a holding's value is unknown (null), the
 * total is null and every share is null — a share computed over a partial total
 * is a lie about the book's composition. The run NAMES the holding it could not
 * value instead of quietly shrinking the denominator.
 *
 * PURE: no network, no clock, no I/O — so it unit-tests offline against fixed
 * holdings and a fixed weight table.
 */
import type { AssetId, Stance } from './model-regime-trend';
import type { ImpactRow } from './model-regime-impacts';

/** A treasury holding, as the `assets` read model aggregates it. */
export type HoldingInput = { asset: string; value_usd: number | null };

/**
 * The stablecoins the overlay treats as USD-class. Membership is a claim about
 * the token's redemption, so the set is EXPLICIT: a new stablecoin that is not
 * listed falls through to the crypto-risk class and reads `assumed: true`,
 * which is visible, rather than being silently blessed as cash.
 */
const STABLECOINS = new Set([
  'USDT', 'USDC', 'DAI', 'USDE', 'PYUSD', 'FDUSD', 'TUSD', 'BUSD', 'USDD',
  'GUSD', 'LUSD', 'FRAX', 'USDP', 'USDS', 'SUSD', 'MIM', 'ALUSD', 'CRVUSD',
  'GHO', 'USDX', 'USDL', 'USD0', 'RLUSD', 'USDT0', 'USDB', 'DOLA', 'USDF',
]);

/** Explicit non-stable bindings. Everything else falls through to the proxy. */
const EXPLICIT_CLASS: Readonly<Record<string, AssetId>> = {
  BTC: 'btc',
  WBTC: 'btc',
  XAUT: 'gold',
  PAXG: 'gold',
};

/** The class a symbol that matches no explicit binding is scored as. */
const FALLBACK_CLASS: AssetId = 'btc';

/** The classification rule, stated once and returned in the payload. */
export const EXPOSURE_RULE =
  'a stablecoin is USD-class, a tokenised gold claim is gold, bitcoin is the crypto-risk class, ' +
  'and every other token is scored as the crypto-risk class too — the weight table\u2019s crypto column ' +
  'is the channel that beta transmits through. Rows carrying an assumed class are marked.';

/** The class a holding is scored as, and whether the binding was explicit. */
export function classifyHolding(asset: string): { klass: AssetId; assumed: boolean } {
  const sym = asset.trim().toUpperCase();
  if (STABLECOINS.has(sym)) return { klass: 'usd', assumed: false };
  const explicit = EXPLICIT_CLASS[sym];
  if (explicit) return { klass: explicit, assumed: false };
  return { klass: FALLBACK_CLASS, assumed: true };
}

/** One holding, classified and scored. */
export type ClassifiedHolding = {
  asset: string;
  value_usd: number;
  klass: AssetId;
  klassLabel: string;
  /** The class came from the fallback rule, not an explicit binding. */
  assumed: boolean;
  stance: Stance;
  score: number;
};

/** One asset class, as this book holds it. */
export type ClassExposure = {
  asset: AssetId;
  label: string;
  stance: Stance;
  score: number;
  value_usd: number;
  /** Share of the TOTAL book, or null when the total is not known. */
  share: number | null;
  /** The symbols that land in this class, largest first. */
  holdings: string[];
};

export type RegimeExposure = {
  /** Every class the weight table scores, in the table's order — including empty ones. */
  classes: ClassExposure[];
  /** Every holding that was valued and scored, largest first. */
  holdings: ClassifiedHolding[];
  /** Sum of every valued holding, or null when any holding could not be valued. */
  total_usd: number | null;
  /** Sum of the holdings that mapped to a scored class. */
  mapped_usd: number;
  /** The value-weighted mean of the class scores, in the table's own units, or null. */
  alignment: number | null;
  /** The value share that maps to a scored class, or null when the total is not known. */
  coverage: number | null;
  /** Holdings left out of the maths, each naming its reason. */
  skipped: { asset: string; reason: string }[];
  /** The classification rule, stated. */
  rule: string;
};

/**
 * Cross a set of holdings with a regime's impact rows. Pure.
 *
 * Every refusal is NAMED: an unvalued holding, a zero/negative value, and a
 * holding whose class the weight table does not score each land in `skipped`
 * with the reason, rather than being dropped or counted as zero.
 */
export function exposureOverlay(
  holdings: readonly HoldingInput[],
  impacts: readonly ImpactRow[]
): RegimeExposure {
  const byClass = new Map(impacts.map((i) => [i.asset, i]));
  const skipped: { asset: string; reason: string }[] = [];
  const classified: ClassifiedHolding[] = [];

  let total = 0;
  let totalKnown = true;
  let mapped = 0;

  for (const h of holdings) {
    const v = h.value_usd;
    if (v === null || typeof v !== 'number' || !Number.isFinite(v)) {
      // The total is now unknown: a share over a partial total would be a lie.
      totalKnown = false;
      skipped.push({ asset: h.asset, reason: 'no value is recorded for this holding, so the book total is unknown' });
      continue;
    }
    if (v <= 0) {
      skipped.push({ asset: h.asset, reason: 'the recorded value is zero or negative' });
      continue;
    }
    total += v;
    const { klass, assumed } = classifyHolding(h.asset);
    const impact = byClass.get(klass);
    if (!impact) {
      skipped.push({ asset: h.asset, reason: `class ${klass} is not scored by the weight table` });
      continue;
    }
    mapped += v;
    classified.push({
      asset: h.asset,
      value_usd: v,
      klass,
      klassLabel: impact.label,
      assumed,
      stance: impact.stance,
      score: impact.score,
    });
  }

  const total_usd = totalKnown ? total : null;
  const largestFirst = (a: { value_usd: number }, b: { value_usd: number }) => b.value_usd - a.value_usd;
  classified.sort(largestFirst);

  const classes: ClassExposure[] = impacts.map((imp) => {
    const rows = classified.filter((c) => c.klass === imp.asset).sort(largestFirst);
    const value = rows.reduce((s, c) => s + c.value_usd, 0);
    return {
      asset: imp.asset,
      label: imp.label,
      stance: imp.stance,
      score: imp.score,
      value_usd: value,
      share: total_usd !== null && total_usd > 0 ? value / total_usd : null,
      holdings: rows.map((r) => r.asset),
    };
  });

  const alignment =
    mapped > 0 ? classified.reduce((s, c) => s + c.value_usd * c.score, 0) / mapped : null;

  return {
    classes,
    holdings: classified,
    total_usd,
    mapped_usd: mapped,
    alignment: alignment === null ? null : Math.round(alignment * 100) / 100,
    coverage: total_usd !== null && total_usd > 0 ? mapped / total_usd : null,
    skipped,
    rule: EXPOSURE_RULE,
  };
}
