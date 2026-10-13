import { DEX_CHAINS } from './client';

export const SEARCH_CHAINS = DEX_CHAINS as readonly string[];

export type Mode = 'board' | 'pairs' | 'profiles' | 'boosts' | 'boosts-top' | 'search' | 'mint' | 'orders';

export const MODES: { key: Mode }[] = [
  { key: 'board' },
  { key: 'profiles' },
  { key: 'boosts' },
  { key: 'boosts-top' },
  { key: 'pairs' },
  { key: 'search' },
  { key: 'mint' },
  { key: 'orders' },
];

/** Present-but-null is NOT zero. Every formatter here returns an em-dash. */
export function num(v: number | string | null | undefined, opts?: { prefix?: string; suffix?: string; dp?: number }) {
  if (v == null) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  const dp = opts?.dp ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 2 : 6);
  return `${opts?.prefix ?? ''}${n.toLocaleString('en-US', { maximumFractionDigits: dp })}${opts?.suffix ?? ''}`;
}

/** Compact money: $70.3M / $706.5K / $0.00. Absent stays absent. */
export function money(v: number | null | undefined) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a > 0) return `$${v.toPrecision(3)}`;
  return '$0';
}

export function pct(v: number | null | undefined) {
  if (v == null) return '—';
  const s = v > 0 ? '+' : '';
  return `${s}${v.toFixed(2)}%`;
}

export function age(ms: number | null | undefined) {
  if (!ms) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

export function win<T>(o: Record<string, T> | undefined, k: string): T | undefined {
  return o?.[k];
}
