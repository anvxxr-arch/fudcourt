'use client';
import { color } from '@/styles/tokens';
import { chainColor } from '@/lib/format';

export type Sighting = { n: number; spanH: number; sources: number; surfaced: number };
export type Social = { type: string; url: string };

export type SignalRow = {
  id: number;
  ts: number;
  kind: string;
  chain: string;
  mint: string;
  symbol: string;
  name: string;
  url: string;
  mcap: number;
  liq?: number;
  price?: number;
  ageMin?: number;
  score?: number;
  decision?: string;
  source?: string;
  image?: string;
  holdersCount?: number;
  vetoes?: string[];
  volTrend?: number;
  topHolderPct?: number;
  nameReuse?: number;
  persistCount?: number;
  registryReuse?: number;
  sightings?: Sighting;
  socials?: Social[];
};

export type Counts = { rows?: number; rh?: number; sol?: number; surfaced?: number; runs?: number; revivals?: number };
export type Payload = {
  rows: SignalRow[];
  counts: Counts;
  generatedAt: number;
  pages?: number;
  page?: number;
  windowH?: number;
  solDelayMin?: number;
  upstream?: string;
  error?: string;
};

export const CHAINS = [
  { key: 'solana', label: '◎ Solana', color: chainColor('solana') },
  { key: 'robinhood', label: '🪶 Robinhood Chain', color: chainColor('robinhood') },
  { key: 'all', label: '⧉ Both', color: color.orange },
] as const;
export type ChainKey = (typeof CHAINS)[number]['key'];

// chain=all is a merged view, so its per-row breakdown comes from the row's
// own `chain` field -- the header counts (rh/sol) are the reliable totals.
export const MERGED: ChainKey[] = ['all'];

export const MODES = [
  { key: 'index', label: '168h index', hint: 'full 168h screening window. Carries only mcap/liq/score/decision — holders, top-holder % and sightings are absent on every row. chain=all is not offered upstream for this mode.', chains: ['solana', 'robinhood'] as ChainKey[] },
  { key: 'feed', label: '24h feed', hint: 'last 24h, 500 newest rows. Richer per row, but still sparse: measured 213/500 carry holders + top-holder %, 483/500 carry sightings/price/ageMin.', chains: ['solana', 'robinhood', 'all'] as ChainKey[] },
  { key: 'page', label: 'paged', hint: 'same data as the feed, paged 500 rows at a time. Upstream serves pages 2..10 only — page 1 is the feed.', chains: ['solana', 'robinhood', 'all'] as ChainKey[] },
] as const;
export type Mode = (typeof MODES)[number]['key'];

export const DECISION_COLOR: Record<string, string> = {
  surfaced: color.blue,
  watching: color.orange,
  'low score': color.labelTertiary,
  vetoed: color.red,
  blocked: color.red,
  bundle: color.orange,
};

// A missing metric is NOT zero. Upstream omits fields per row (e.g. liq on
// 23 of 7730 solana rows), so every formatter renders an em-dash for
// undefined rather than coercing to 0.
export const n2 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });

export function usd(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

export function ago(ts: number) {
  const m = Math.max(0, Math.floor((Date.now() / 1000 - ts) / 60));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

export function shortAddr(a: string) {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
