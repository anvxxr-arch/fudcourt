import { themeColor } from '@/styles/tokens';
import type { Quote } from './detail-shared';

/**
 * Median of the non-null values, or null when there are none.
 *
 * The definition lives in `client.ts` — one `medianOf` serves the board, the
 * detail view and the API routes. Re-exported so the detail modules keep a
 * single import site for every formatter.
 */
export { medianOf } from './client';

export function chgColor(p: number | null): string | undefined {
  if (p === null) return themeColor.labelTertiary;
  return p >= 0 ? themeColor.blue : themeColor.red;
}

/**
 * A price is shown in the currency it is actually denominated in.
 *
 * A coin-margined option premium is denominated in the coin: OKX's
 * BTC-settled 260929-84000 call quotes 0.001, which is 0.001 *BTC* (~$83),
 * and rendering that as "$0.001" is wrong by five orders of magnitude. So
 * each quote carries its own settlement and labels itself with it.
 *
 * The headline figure only gets a unit when every priced venue agrees on
 * one. For spot, swaps and futures the same contract is listed by different
 * venues in different units (OKX coin-margined BTC, Bybit USDT, Coinbase
 * USDC) — those are the same money, so a single "83,485 BTC" label on the
 * median would be nonsense. Where they disagree, prices are shown as USD.
 */
export const fmtPrice = (p: number | null, unit: string | null) => {
  if (p === null) return '—';
  const body = p < 0.01 ? p.toExponential(4) : p < 1000 ? p.toFixed(3) : p.toLocaleString('en-US', { minimumFractionDigits: 2 });
  return unit === 'USD' ? `$${body}` : unit ? `${body} ${unit}` : `$${body}`;
};

// The headline median's unit, used only when all priced venues agree on it.
export function headlineSettle(priced: Quote[]): string {
  const units = [...new Set(priced.map(q => q.settle).filter((s): s is string => typeof s === 'string'))];
  return units.length === 1 ? units[0] : 'USD';
}

// Cross-venue divergence across the venues that priced it.
export function crossVenueSpread(priced: Quote[]): number | null {
  if (priced.length < 2) return null;
  const prices = priced.map(q => q.last as number);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mean <= 0) return null;
  return (Math.max(...prices.map(p => Math.abs(p - mean) / mean)) * 100);
}

export const fmtVol = (v: number | null) =>
  v === null ? '—' : v < 1e6 ? `$${(v / 1e3).toFixed(0)}K` : v < 1e9 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e9).toFixed(2)}B`;
export const fmtPct = (p: number | null) => (p === null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`);
export const fmtSpread = (s: number | null) => (s === null ? '—' : s === 0 ? '0%' : s < 0.0001 ? `${s.toExponential(1)}%` : `${s.toFixed(4)}%`);
// Funding is a fraction; shown in basis points, which is how it is quoted.
export const fmtFunding = (f: number | null) => (f === null ? '—' : `${(f * 10000).toFixed(3)} bps`);
export const fmtOi = (o: number | null) => (o === null ? '—' : o.toLocaleString('en-US', { maximumFractionDigits: 0 }));
