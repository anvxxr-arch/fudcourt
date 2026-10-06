/** Economy formatting: the single spelling of numbers and missing values. */
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

