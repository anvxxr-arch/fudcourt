/**
 * Display formatters shared by the market hub's asset-class sections. One
 * module so the stock, commodity and forex tables format a number the same
 * way -- a price rendered `331.74` in one table and `331.740000` in another is
 * drift. Pure functions, no JSX, so both the route (server) and the boards
 * (client) can import them.
 *
 * Every formatter is null-tolerant: a metric the upstream did not report is
 * `—`, never a fabricated 0.
 */

/** Shown for a value the upstream did not report. */
export const dash = '—';

/** A price: 2dp at/above 1, more precision below it, thousands-separated. */
export function fmtPrice(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return dash;
  const abs = Math.abs(p);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;
  return p.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** A forex rate: precision adapts to magnitude (IDR ~17,970 vs EUR ~1.13). */
export function fmtRate(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return dash;
  const abs = Math.abs(r);
  const digits = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : 6;
  return r.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Signed percentage, e.g. `+1.24%`; null -> '—'. */
export function fmtPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return dash;
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}

/** Signed absolute change, same precision rule as fmtPrice. */
export function fmtChange(c: number | null): string {
  if (c === null || !Number.isFinite(c)) return dash;
  return `${c >= 0 ? '+' : ''}${fmtPrice(c)}`;
}

/**
 * Compact volume: 12.34M / 4.50B; null -> '—'.
 *
 * A literal 0 is also '—'. This feed sends 0 for volume it does not publish
 * (measured on Yahoo Finance: ^JKSE, ^N225, ^HSI and ^AXJO all report 0 while
 * ^GSPC and ^KS11 report real figures), so a 0 here is an absent metric, not a
 * measurement of zero -- printing it would assert a number the upstream never
 * made. The route keeps the raw value; only the board declines to show it.
 */
export function fmtVolume(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return dash;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/** Unix seconds -> local `HH:MM:SS`; null -> '—'. */
export function fmtTime(unix: number | null): string {
  if (unix === null || !Number.isFinite(unix)) return dash;
  return new Date(unix * 1000).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * A unix second as a UTC date AND time: `2026-10-04 00:02 UTC`.
 *
 * `fmtTime` gives a clock time with no date, which is right for a live intraday
 * quote and wrong for a daily fix: the FX feed stamps one rate per UTC day, so a
 * bare `00:02:32` says which minute but not WHICH DAY, and a reader cannot tell
 * today's rate from one three days stale.
 */
export function fmtDateTime(unix: number | null): string {
  if (unix === null || !Number.isFinite(unix)) return dash;
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** A currency code as shown: Yahoo quotes cents-denominated futures as `USX`. */
export function fmtCurrency(code: string | null): string {
  if (!code) return '';
  return code === 'USX' ? 'US¢' : code;
}

/** Tone for a signed value: up / down / flat (null and 0 are flat). */
export function tone(v: number | null): 'up' | 'down' | 'flat' {
  if (v === null || !Number.isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/** 1.23T / 45.6B / 789.0M / 12.3K, else the plain number at `decimals`. */
function compactCount(v: number, prefix: string, decimals: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${prefix}${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${prefix}${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${prefix}${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${prefix}${(v / 1e3).toFixed(1)}K`;
  return `${prefix}${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/**
 * An annual indicator rendered for its KIND rather than as a bare number: a
 * percent, a compact dollar amount, a head count, a number of years, a per-1,000
 * rate or a tonnage. `decimals` rides on the series spec, so a 1dp indicator and
 * a 2dp one do not silently render at the same precision.
 *
 * Null -> '—', and a non-finite value is treated as absent rather than printed.
 */
export function fmtIndicator(v: number | null, kind: string, decimals: number): string {
  if (v === null || !Number.isFinite(v)) return dash;
  switch (kind) {
    case 'pct':
      return `${v.toFixed(decimals)}%`;
    case 'usd':
      return compactCount(v, '$', decimals);
    case 'count':
    case 'pop':
      return compactCount(v, '', decimals);
    case 'years':
      return `${v.toFixed(decimals)} yr`;
    case 'per1k':
      return `${v.toFixed(decimals)} /1k`;
    case 'tonnes':
      return `${v.toFixed(decimals)} t`;
    default:
      return v.toFixed(decimals);
  }
}

/**
 * The same rendering with an explicit sign, for a change between two
 * observations of the same series. Null -> '—', exactly like the level: a change
 * over a missing leg is withheld, never computed from a zero.
 */
export function fmtIndicatorDelta(v: number | null, kind: string, decimals: number): string {
  if (v === null || !Number.isFinite(v)) return dash;
  return `${v >= 0 ? '+' : ''}${fmtIndicator(v, kind, decimals)}`;
}
