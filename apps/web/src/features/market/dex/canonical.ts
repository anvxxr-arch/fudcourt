import { getJSON } from '@/lib/fetch';

/**
 * The CANONICAL DEX reads (plan §30). This is the provider-agnostic path: the
 * web tier asks Fudcourt's own canonical API and never names DexScreener, so a
 * provider swap upstream cannot change what this screen shows. The legacy
 * `/api/dex` proxy stays only for the feeds canonical genuinely does not model
 * (token profiles, paid boosts, orders) — those are marketing records, not
 * market data.
 *
 * Three reads, matching the canonical model's own split:
 *   /api/v1/dex/pools    identity, sides, liquidity, volume, age — the pool
 *   /api/v1/dex/markets  the LATEST market state per pool (24h change, txn
 *                        counts, market cap) — a separate fact with its own
 *                        cadence, which is why the pool row does not carry it
 *   /api/v1/dex/venues   dex_venue_id -> exchange name, because a pool carries
 *                        only the minted id and an id alone is not renderable
 *
 * Absent is absent: every optional canonical field is nullable and maps to
 * `null` here, which the formatters render as an em-dash. Nothing is defaulted
 * to 0 — a 0% change and an unreported change must not look alike.
 */

export type CanonPool = {
  pool_id: string;
  chain_id: string;
  dex_venue_id: string | null;
  address: string;
  base_asset_id: string | null;
  quote_asset_id: string | null;
  base_symbol: string | null;
  quote_symbol: string | null;
  fee_tier_bps: number | null;
  price: number | null;
  liquidity_usd: number | null;
  volume_24h_usd: number | null;
  fdv_usd: number | null;
  pool_created_at: string | null;
  at: string;
  source: string;
};

export type CanonMarket = {
  snapshot_id: string;
  pool_id: string;
  chain_id: string;
  at: string;
  price_usd: string | null;
  volume_24h_usd: string | null;
  txns_24h: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
  price_change_pct_24h: string | null;
  fdv_usd: string | null;
  market_cap_usd: string | null;
};

export type CanonChain = {
  chain_id: string;
  name: string;
  display_name: string | null;
  kind: string;
};

export type CanonVenue = {
  venue_id: string;
  name: string | null;
  kind: string;
  known: boolean;
  market_types: string[] | null;
};

export type BoardRow = {
  poolId: string;
  address: string;
  /** "SOL/USDC" — an em-dash side when the provider did not name it. */
  pair: string;
  dex: string;
  /** The chain's NAME; the opaque chain_id only if the registry has no row. */
  chain: string;
  /** The CANONICAL chain id — what a chain filter must send back to the API. */
  chainId: string;
  priceUsd: number | null;
  change24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  buys: number | null;
  sells: number | null;
  marketCapUsd: number | null;
  /** RFC3339 pool creation time, as the canonical API spells it. */
  createdAt: string | null;
  /** Which provider this pool row came from (canonical provenance). */
  source: string;
  /** True when a market snapshot backed the change/txns/mcap columns. */
  hasMarketState: boolean;
};

export type BoardResult = {
  rows: BoardRow[];
  /** Pools returned by the canonical read. */
  pools: number;
  /** How many of those had market state (the rest render em-dashes). */
  withMarketState: number;
  /** Venues in the registry, i.e. how many pool rows can be NAMED. */
  venues: number;
  /** Chains in the registry, i.e. how many pool rows can be NAMED by chain. */
  chains: number;
  /**
   * The FULL chain registry, display-name first: the chain filter's option
   * list. Built from the same read the join uses, so the filter can never
   * offer a chain the board cannot actually resolve — and it is stable
   * across refetches (a select that narrows its own options after each pick
   * is a trap, which a page-derived list would be).
   */
  chainOptions: { id: string; name: string }[];
};

/** A canonical Dec arrives as an exact string; NaN-safe and null-preserving. */
function decToNum(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * One page of the canonical board. Throws on any non-200: a 502/404 must reach the view.
 *
 * `chainId` is the CANONICAL chain id (`chain:…`), not a provider name — the
 * pools AND markets reads both filter server-side on it, so a filtered board
 * is a filtered JOIN, not a join that is filtered after the fact (which would
 * pair pools with market snapshots from other chains' pools at the same ids).
 * `undefined` = every chain.
 */
export async function fetchCanonicalBoard(limit = 60, chainId?: string): Promise<BoardResult> {
  const chainQ = chainId ? `&chain=${encodeURIComponent(chainId)}` : '';
  const [poolRes, marketRes, venueRes, chainRes] = await Promise.all([
    getJSON<{ data: CanonPool[] }>(`/api/v1/dex/pools?limit=${limit}${chainQ}`, { cache: 'no-store' }),
    getJSON<{ data: CanonMarket[] }>(`/api/v1/dex/markets?sort=volume&limit=${limit}${chainQ}`, { cache: 'no-store' }),
    getJSON<{ data: CanonVenue[] }>(`/api/v1/dex/venues?limit=${limit}`, { cache: 'no-store' }),
    // The chain registry is read at the API's OWN cap (1000), not the board's
    // page size: a page of pools references whichever chains it references, and
    // a 468-row registry would otherwise miss them and print raw ids. Bounded
    // by maxLimit, so this stays one request.
    getJSON<{ data: CanonChain[] }>(`/api/v1/dex/chains?limit=1000`, { cache: 'no-store' }),
  ]);
  const pools = poolRes.data ?? [];
  const markets = marketRes.data ?? [];
  const venues = venueRes.data ?? [];
  const chains = chainRes.data ?? [];

  // Both lookups are keyed by ids that arrive FROM the API, so they are built
  // on a null prototype: a plain object literal also inherits `constructor` and
  // `toString`, and an id that ever collided with one would silently resolve to
  // a function instead of a miss.
  const venueName: Record<string, string> = Object.create(null);
  for (const v of venues) if (v.name) venueName[v.venue_id] = v.name;
  // The board read returns the newest snapshot per pool, so a plain lookup is
  // the join — no "pick the latest" pass is possible to get wrong here.
  const market: Record<string, CanonMarket> = Object.create(null);
  for (const m of markets) market[m.pool_id] = m;
  const chainName: Record<string, string> = Object.create(null);
  for (const c of chains) chainName[c.chain_id] = c.display_name || c.name;

  const rows: BoardRow[] = pools.map((p) => {
    const m = market[p.pool_id];
    const base = p.base_symbol ?? '—';
    const quote = p.quote_symbol ?? '—';
    const venue = p.dex_venue_id ? venueName[p.dex_venue_id] : undefined;
    return {
      poolId: p.pool_id,
      address: p.address,
      pair: `${base}/${quote}`,
      dex: venue || '—',
      chain: chainName[p.chain_id] || p.chain_id,
      chainId: p.chain_id,
      // The pool's own price wins; the market snapshot is the fallback, since
      // either can be absent for a given pool.
      priceUsd: p.price ?? decToNum(m?.price_usd),
      change24h: decToNum(m?.price_change_pct_24h),
      volume24h: p.volume_24h_usd ?? decToNum(m?.volume_24h_usd),
      liquidityUsd: p.liquidity_usd,
      buys: m?.buys_24h ?? null,
      sells: m?.sells_24h ?? null,
      marketCapUsd: decToNum(m?.market_cap_usd),
      createdAt: p.pool_created_at ?? null,
      source: p.source,
      hasMarketState: m != null,
    };
  });

  return {
    rows,
    pools: pools.length,
    withMarketState: rows.filter((r) => r.hasMarketState).length,
    venues: venues.length,
    chains: chains.length,
    chainOptions: chains
      .map((c) => ({ id: c.chain_id, name: c.display_name || c.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
