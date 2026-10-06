import { color } from '@/styles/tokens';
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


// The legacy flat hex table `C` lived here until the design-system cutover (DR-037). It is DELETED,
// not re-exported: `src/styles/tokens.ts` is the one source of truth for design values. This module
// stays the home of the DOMAIN palettes (`CHAIN_COLOR`, `COLOR_PRESETS`, `EMOJI_PRESETS`,
// `EVENT_PRESETS`) and the shared view types/helpers — data a provider or the user owns, which is
// exactly why they are not design tokens.
export type Asset = {
  id: number; chain: string; asset: string; quantity: number;
  value_usd: number; share_pct?: number; wallet: string; updated_at?: string;
};

export type Wallet = {
  address: string; label: string; chain: string; monitored: number;
  alias: string; emoji: string; color: string; notes: string | null;
};

export const CHAIN_COLOR: Record<string, string> = {
  BSC: '#f0b90b', Ethereum: '#8a92b2', Polygon: '#8247e5',
  Solana: '#14f195', Hyperliquid: '#3ddc97', Base: '#0052ff',
  Arbitrum: '#28a0f0', Optimism: '#ff0420', Binance: '#f0b90b', Fiat: '#888',
  // The signals board labels this chain and this is the value it already rendered (formerly `C.accent`),
  // so the entry is the chain palette's second home for it — a domain entry, not a design token.
  Robinhood: '#3ddc97',
};
/** Chain brand colour, case-insensitive (`'solana'` and `'Solana'` agree). Falls back to `color.labelTertiary`. */
export function chainColor(chain: string | null | undefined): string {
  if (!chain) return color.labelTertiary;
  const needle = chain.toLowerCase();
  for (const [name, hex] of Object.entries(CHAIN_COLOR)) {
    if (name.toLowerCase() === needle) return hex;
  }
  return color.labelTertiary;
}

export const EMOJI_PRESETS = ['💰','🎒','🦊','🐋','🤖','🏦','💳','🔒','🌐','💎','👛','🎮','📈','🛡️','✈️','🍕','🎯','🧊'];
export const COLOR_PRESETS = ['#3ddc97','#f0b90b','#8a92b2','#8247e5','#14f195','#0052ff','#28a0f0','#ff0420','#ff6b6b','#ffd166','#06d6a0','#118ab2'];
export const EVENT_PRESETS = ['Deposit','Withdrawal','Trade','Transfer','Fee','Interest','Airdrop','Payment','Refund','Swap','Other'];

export function buildWalletMap(wallets: Wallet[]) {
  const map: Record<string, Wallet> = {};
  for (const w of wallets) map[w.label] = w;
  return map;
}

export function getAlias(label: string, walletByLabel: Record<string, Wallet>) {
  const w = walletByLabel[label];
  if (!w) return label;
  return `${w.emoji} ${w.alias || w.label}`;
}

export function getColor(label: string, walletByLabel: Record<string, Wallet>) {
  return walletByLabel[label]?.color || color.blue;
}

export function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
}

export function groupSum<T>(items: T[], key: (item: T) => string, val: (item: T) => number) {
  const sums: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    sums[k] = (sums[k] || 0) + val(item);
  }
  return sums;
}

/** Canonical number formatter (plan Step 3 contract). Alias of fmtPrice: 2dp at/above 1, more precision below, thousands-separated, null -> dash. */
export const formatNumber = fmtPrice;
