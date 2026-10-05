/**
 * shapers.ts — pure display helpers for the CEX Executor surface.
 *
 * No fetch, no React, no clock reads except the `now` parameter: every function
 * is deterministic given its arguments so the parent can unit-test this file
 * directly. The UI renders every number through these helpers so the two house
 * rules hold everywhere at once:
 *
 *   1. ABSENT IS `—`. A null/undefined/non-finite figure renders the em dash,
 *      never `0` and never an invented value. The risk engine is explicit about
 *      this (`expectedLossAtStop: null` when no stop is configured,
 *      `risk.estimatedTotalRisk/priceRisk/safetyReserve: null` without a stop,
 *      `risk.budget: null` for capital/outcome sizing) — a `0` here would be a
 *      fabricated number, not a measurement.
 *   2. TRIM FLOAT NOISE, DO NOT LIE ABOUT PRECISION. Quantities render at the
 *      instrument's step decimals when the caller knows them (0.1 + 0.2 shows
 *      as `0.3`, not `0.30000000000000004`) and at most 8 significant decimals
 *      otherwise. Money/prices never round a non-zero value down to `0.00`.
 */

/** The house em dash: "this value is absent", never zero. */
export const DASH = '—';

/** Absent = null/undefined/non-finite. NaN and ±Infinity are absent, not zero. */
export function isAbsent(value: number | null | undefined): boolean {
  return value === null || value === undefined || !Number.isFinite(value);
}

/** Group the integer part with thousands separators; fraction untouched. */
function group(value: string): string {
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [intPart, fracPart] = body.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fracPart ? `.${fracPart}` : ''}`;
}

/** Fixed decimals with trailing zeros trimmed: `0.30000000` → `0.3`, `3.00` → `3`. */
function trimmed(value: number, maxDecimals: number): string {
  const fixed = Math.abs(value) < 1e15 ? value.toFixed(maxDecimals) : String(value);
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Decimals carried by an instrument step/tick (`0.001` → 3, `1e-7` → 7). */
export function decimalsForStep(step: number | null | undefined): number | null {
  if (isAbsent(step) || (step as number) <= 0) return null;
  const text = String(step);
  const exp = /e-(\d+)$/i.exec(text);
  if (exp) return Number(exp[1]);
  const frac = text.split('.')[1];
  return frac ? frac.length : 0;
}

/**
 * Quantity. `stepDecimals` (from the instrument step size) caps the fraction
 * digits; without it up to 8 decimals are kept and float noise is trimmed.
 */
export function formatQty(value: number | null | undefined, stepDecimals?: number | null): string {
  if (isAbsent(value)) return DASH;
  const v = value as number;
  const decimals = stepDecimals === null || stepDecimals === undefined ? 8 : Math.max(0, Math.min(8, stepDecimals));
  return group(trimmed(v, decimals));
}

/**
 * Money in quote currency: `$1,234.56`. A non-zero value below one cent keeps
 * its significant decimals rather than being shown as `$0.00`.
 */
export function formatMoney(
  value: number | null | undefined,
  opts: { signed?: boolean; decimals?: number } = {},
): string {
  if (isAbsent(value)) return DASH;
  const v = value as number;
  const decimals = opts.decimals ?? 2;
  const body =
    v !== 0 && Math.abs(v) < 0.01
      ? trimmed(v, 8)
      : trimmed(v, decimals);
  const prefix = opts.signed ? (v < 0 ? '-' : '+') : v < 0 ? '-' : '';
  return `${prefix}$${group(v < 0 || opts.signed ? body.replace(/^-/, '') : body)}`;
}

/**
 * Price, honoring the instrument tick. Same honesty rule as money: a non-zero
 * price below the display precision keeps its significant decimals.
 */
export function formatPrice(value: number | null | undefined, tickSize?: number | null): string {
  if (isAbsent(value)) return DASH;
  const v = value as number;
  const decimals = decimalsForStep(tickSize) ?? 2;
  if (v !== 0 && Math.abs(v) < Math.pow(10, -decimals) / 2) return formatMoney(v);
  return `$${group(trimmed(v, decimals))}`;
}

/** Percent POINTS with a `%` suffix: `1` → `1.00%`, `0.05` → `0.05%`. */
export function formatPct(
  value: number | null | undefined,
  opts: { decimals?: number; signed?: boolean } = {},
): string {
  if (isAbsent(value)) return DASH;
  const v = value as number;
  const decimals = opts.decimals ?? 2;
  const shown = v !== 0 && Math.abs(v) < Math.pow(10, -decimals) / 2 ? trimmed(v, 8) : trimmed(v, decimals);
  const prefix = opts.signed ? (v < 0 ? '-' : '+') : v < 0 ? '-' : '';
  return `${prefix}${shown.replace(/^-/, '')}%`;
}

/** Basis points: `5` → `5 bps`, `0.25` → `0.25 bps`. */
export function formatBps(value: number | null | undefined): string {
  if (isAbsent(value)) return DASH;
  return `${trimmed(value as number, 4)} bps`;
}

/**
 * Duration, PRD §86's shape: `45s`, `20m 14s`, `30m`, `1h 15m`, `2d 3h`.
 * Negative or non-finite input is absent (`—`), not `0s`.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (isAbsent(ms)) return DASH;
  const v = ms as number;
  if (v < 0) return DASH;
  const totalSeconds = Math.floor(v / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Risk/reward as `2.94`; `—` whenever the ratio is not computable. */
export function formatRiskReward(value: number | null | undefined): string {
  if (isAbsent(value)) return DASH;
  return (value as number).toFixed(2);
}

/** Completion from a 0..1 fraction: `0.67` → `67%`. Never clamped, never faked. */
export function formatCompletionPct(pct: number | null | undefined): string {
  if (isAbsent(pct)) return DASH;
  return `${Math.round((pct as number) * 100)}%`;
}

/** `YYYY-MM-DD HH:MM:SS` (UTC) — stable across time zones for tables/tests. */
export function formatTimestamp(ms: number | null | undefined): string {
  if (isAbsent(ms)) return DASH;
  return new Date(ms as number).toISOString().slice(0, 19).replace('T', ' ');
}

/** Relative time: `5s ago`, `3m ago`, `2h ago`, `4d ago`. Future = `—`. */
export function formatAgo(ts: number | null | undefined, now: number = Date.now()): string {
  if (isAbsent(ts)) return DASH;
  const diff = now - (ts as number);
  if (diff < 0) return DASH;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
