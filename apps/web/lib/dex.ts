/**
 * DexScreener client surface, shared by the API route and the UI.
 *
 * Kept out of app/api/dex/route.ts on purpose: a Next.js route module may only
 * export the known segment config (dynamic, revalidate, runtime, GET, ...).
 * Exporting anything else fails the build with
 *   "Property 'TYPES' is incompatible with index signature" (TS2344).
 */

export const DEX = 'https://api.dexscreener.com';

export const DEX_TYPES = [
  'profiles',
  'boosts',
  'boosts-top',
  'search',
  'tokens',
  'token-pairs',
  'orders',
] as const;

export type DexType = (typeof DEX_TYPES)[number];

export const DEX_CHAINS = [
  'solana',
  'ethereum',
  'bsc',
  'base',
  'arbitrum',
  'polygon',
] as const;

export type DexChain = (typeof DEX_CHAINS)[number];

/** Measured: a base58 mint is 32-44 chars. Anything else is a typo, not a token. */
export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isMint(v: string) {
  return MINT_RE.test(v);
}

export type DexToken = { address: string; name: string; symbol: string };

export type DexPair = {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: DexToken;
  quoteToken: DexToken;
  priceNative?: string;
  priceUsd?: string;
  /** Present on most pairs but genuinely absent on some -- render as em-dash. */
  marketCap?: number;
  fdv?: number;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    header?: string;
    openGraph?: string;
    websites?: { url: string; label?: string }[];
    socials?: { url: string; type?: string }[];
  };
};

export type DexProfile = {
  address: string;
  chain: string;
  symbol: string | null;
  icon: string | null;
  header: string | null;
  description: string | null;
  links: { label?: string; url?: string; type?: string }[];
  amount: number | null;
  totalAmount: number | null;
  url: string | null;
};

/** Field presence is NOT uniform across DexScreener endpoints -- measure it. */
export function pairMetricPresence(pairs: DexPair[]) {
  const n = pairs.length || 1;
  const has = (k: keyof DexPair) => pairs.filter((p) => p[k] != null).length;
  return {
    rows: pairs.length,
    priceUsd: has('priceUsd'),
    volume: has('volume'),
    priceChange: has('priceChange'),
    liquidity: has('liquidity'),
    txns: has('txns'),
    info: has('info'),
    labels: has('labels'),
    pairCreatedAt: has('pairCreatedAt'),
    coverage: (k: keyof DexPair) => `${((has(k) / n) * 100).toFixed(1)}%`,
  };
}
