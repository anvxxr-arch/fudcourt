import { DEX_CHAINS } from './client';

export const SEARCH_CHAINS = DEX_CHAINS as readonly string[];

export type Mode = 'pairs' | 'profiles' | 'boosts' | 'boosts-top' | 'search' | 'mint' | 'orders';

export const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: 'profiles', label: 'new profiles', hint: 'tokens that just published a profile on DexScreener. Carries marketing metadata only -- no price, no volume, no liquidity. Joining one to its markets is what enriches it.' },
  { key: 'boosts', label: 'paid boosts', hint: 'tokens with active paid promotion. `amount`/`totalAmount` are the paid spend in USD; a large totalAmount with a tiny amount is an old campaign topping up, not a fresh pump.' },
  { key: 'boosts-top', label: 'top boosts', hint: 'the most-boosted tokens right now (token-boosts/top/v1). Same profile family as paid boosts -- marketing metadata only, no price/volume. `totalAmount` is lifetime paid spend; compare it against `amount` to spot a campaign topping up vs a fresh push.' },
  { key: 'pairs', label: 'top pairs', hint: 'the busiest Solana markets by volume, via the profiles->pairs join. Measured on this feed: liquidity is present on only 1 in 4 of a fresh cohort and labels on 0 in 4, so those cells render as an em-dash, never 0.' },
  { key: 'search', label: 'search', hint: 'DexScreener search by symbol or address. Case-insensitive substring match on the returned set; the API caps at 30 pairs per query.' },
  { key: 'orders', label: 'token orders', hint: 'DexScreener orders for one token: profile/boost payments with their status (orders/v1). Empty lists are shown as empty -- upstream really returned none. Useful for checking whether a token actually PAID for its profile or boost.' },
  { key: 'mint', label: 'mint lookup', hint: 'exact on-chain address lookup. A malformed address is rejected locally with a 400 -- upstream answers 200 with an empty list, which would make a typo look exactly like a token with no markets. Base58 mints, 0x EVM addresses and NEAR names are all accepted; the live profile feed is not base58-only.' },
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
