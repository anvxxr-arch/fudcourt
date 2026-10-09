import { themeColor } from '@/styles/tokens';

/**
 * format.ts — the treasury family's number formatting, in one place so the
 * time machine and the leaderboard render a value identically.
 *
 * The rule that matters: a `null` is the em dash, never a `0`. A missing metric
 * (a window with one observation has no change; an asset that never had a start
 * value has no percentage) is a real gap, and a confident `$0.00` would be a lie
 * the reader cannot see through. Every helper here takes `number | null` and
 * says `—` for the gap.
 */

export const DASH = '—';

export function usd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}

export function qty(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/**
 * A UNIT price, or the em dash — deliberately finer than `usd()`, following the
 * house `fmtPrice` convention the plans ledger uses (2dp at ≥1, 4dp at ≥0.01,
 * 8dp at ≥1e-6, adaptive below that). A 2dp USD render HIDES the very move the
 * attribution panel exists to explain: the USDT peg drifting `0.99967 → 0.99957`
 * prints `$1.00 → $1.00` beside a non-zero `Market` cell, which reads as the
 * panel contradicting itself. A price is not an amount, so it does not get the
 * amount's rounding.
 */
export function price(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  const digits = abs === 0 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs >= 1e-6 ? 8 : Math.min(16, -Math.floor(Math.log10(abs)) + 3);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A short, timezone-stable label for a snapshot instant (server sends UTC ISO). */
export function shortTs(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

/** Green for a gain, red for a loss, neutral for zero or a gap. */
export function toneOf(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return themeColor.labelSecondary;
  return v > 0 ? themeColor.green : themeColor.red;
}

/** The medal for a zero-based rank, or the plain number past the podium. */
export function medal(rank: number): string {
  return ['🥇', '🥈', '🥉'][rank] ?? String(rank + 1);
}
