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
  'tokens-v1',
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
  // measured 2026-09-26: search returns these too, so they must be selectable
  'robinhood', 'cronos', 'ton', 'aptos', 'celo', 'ink', 'linea', 'scroll',
  'mantle', 'metis', 'manta', 'soneium', 'arc', 'flowevm', 'pulsechain', 'xrpl',
  // measured 2026-09-27: the live profile feed serves NEAR tokens, and
  // /token-pairs/v1/near/<name> answers 200. Without this the chain select
  // could not reach a real market that upstream is happy to serve.
  'near',
] as const;

export type DexChain = (typeof DEX_CHAINS)[number];

/**
 * A token address, per chain family. Measured against the live
 * `token-profiles/latest/v1` feed, which is NOT base58-only: as of 2026-09-27
 * 6 of its 30 records are `0x…` (robinhood, bsc) or a NEAR name
 * (`rust-334.meme-cooking.near`). A validator that only accepts base58 rejects
 * real tokens, and -- worse -- caused the profiles->pairs join to abort the
 * entire request.
 *
 *   base58  solana-style mints, 32-44 chars
 *   hex     0x-prefixed EVM addresses, exactly 40 hex digits
 *   name    NEAR-style dotted names (`segment.segment`)
 */
export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const HEX_RE = /^0x[0-9a-fA-F]{40}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$/i;

export function isMint(v: string) {
  const s = v.trim();
  return MINT_RE.test(s) || HEX_RE.test(s) || NAME_RE.test(s);
}

/** Which address family this is, or null. Used to report honestly. */
export function addressKind(v: string): 'base58' | 'hex' | 'name' | null {
  const s = v.trim();
  if (HEX_RE.test(s)) return 'hex';
  if (MINT_RE.test(s)) return 'base58';
  if (NAME_RE.test(s)) return 'name';
  return null;
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
