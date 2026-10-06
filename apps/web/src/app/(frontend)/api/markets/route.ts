import { NextResponse } from 'next/server';
import {
  MARKETS_POOL,
  MARKETS_SEARCH_MAX,
  MARKETS_SORTS,
  MARKETS_ORDERS,
  MARKETS_PAGE_SIZE_MAX,
  MARKETS_TTL_MS,
  marketsUpstreamUrl,
  type MarketsCoin,
  type MarketsOrder,
  type MarketsSort,
} from '@/features/market/coingecko-markets';
import { limitedFetch } from '@/lib/rate-limit';
import { fail } from '../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

/** CoinGecko /coins/markets row -> the shape the tracker renders. */
type CgRow = {
  id?: string;
  symbol?: string;
  name?: string;
  image?: string;
  current_price?: number | null;
  price_change_percentage_24h?: number | null;
  high_24h?: number | null;
  low_24h?: number | null;
  total_volume?: number | null;
  market_cap?: number | null;
  market_cap_rank?: number | null;
};

/**
 * Read-only proxy to api.coingecko.com (public, keyless). Serves the tracker
 * view's market rows.
 *
 * Honest-by-construction choices (same rules as /api/llama):
 *  - search / sort / order / page / limit are OUR parameters -> strict 400s,
 *    never clamped, never silently ignored.
 *  - search + sort + pagination run LOCALLY over the top-250 pool and are
 *    reported in `derived` + `pool` + `upstreamTotal`; the body never pretends
 *    CoinGecko filtered or sorted for us.
 *  - null upstream metrics stay null (the UI renders `--`); never 0-filled.
 *  - non-2xx upstream keeps its real status (429 passes through loud), an
 *    empty pool is a loud 502 -- never a fake 200 with zero rows.
 *  - shared limiter (min-gap + TTL + single-flight): one upstream fetch
 *    serves every search keystroke for 60s.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);

  // --- OUR params: validate strictly (400 naming the field, never clamp) ---
  const sortRaw = url.searchParams.get('sort') ?? 'volume';
  if (!(MARKETS_SORTS as readonly string[]).includes(sortRaw)) {
    return fail(`unknown sort '${sortRaw}'`, 400, `expected one of ${MARKETS_SORTS.join(', ')}`);
  }
  const sort = sortRaw as MarketsSort;

  const orderRaw = url.searchParams.get('order') ?? 'desc';
  if (!(MARKETS_ORDERS as readonly string[]).includes(orderRaw)) {
    return fail(`unknown order '${orderRaw}'`, 400, `expected one of ${MARKETS_ORDERS.join(', ')}`);
  }
  const order = orderRaw as MarketsOrder;

  const intParam = (name: string, raw: string | null, dflt: number, min: number, max: number): number | string => {
    if (raw === null) return dflt;
    if (!/^\d+$/.test(raw)) return `${name} must be an integer, got '${raw}'`;
    const v = Number(raw);
    if (v < min || v > max) return `${name} must be between ${min} and ${max}, got ${v}`;
    return v;
  };

  const pageVal = intParam('page', url.searchParams.get('page'), 1, 1, 1_000_000);
  if (typeof pageVal === 'string') return fail(pageVal, 400, 'page');
  const page = pageVal;

  const limitVal = intParam('limit', url.searchParams.get('limit'), 50, 1, MARKETS_PAGE_SIZE_MAX);
  if (typeof limitVal === 'string') return fail(limitVal, 400, 'limit');
  const limit = limitVal;

  const search = (url.searchParams.get('search') ?? '').trim();
  if (search.length > MARKETS_SEARCH_MAX) {
    return fail(`search must be at most ${MARKETS_SEARCH_MAX} chars, got ${search.length}`, 400, 'search');
  }

  // --- upstream: one fixed pool fetch, cached + single-flighted ---
  let res: Response;
  try {
    res = await limitedFetch(marketsUpstreamUrl(), { signal: AbortSignal.timeout(TIMEOUT_MS) }, { ttlMs: MARKETS_TTL_MS });
  } catch (e) {
    return fail('upstream request failed', 502, e instanceof Error ? e.message : String(e));
  }

  if (!res.ok) {
    // Preserve the real upstream status (a CoinGecko 429 must not become a 200).
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.status?.error_message || body?.error || '';
    } catch {
      /* non-JSON error body: status alone is the honest report */
    }
    return NextResponse.json(
      { error: `upstream ${res.status} from CoinGecko`, ...(detail ? { detail: String(detail) } : {}) },
      { status: res.status }
    );
  }

  let rows: CgRow[];
  try {
    const body = await res.json();
    if (!Array.isArray(body)) {
      return fail('upstream returned a non-list payload', 502, JSON.stringify(body).slice(0, 120));
    }
    rows = body as CgRow[];
  } catch (e) {
    return fail('upstream returned non-JSON', 502, e instanceof Error ? e.message : String(e));
  }

  if (rows.length === 0) {
    // An empty market list is breakage, not a valid "no markets exist" answer.
    return fail('upstream returned an empty market list', 502, 'expected the top-250 pool');
  }

  const pool = rows.length;
  const coins: MarketsCoin[] = rows.map((r) => ({
    symbol: (r.symbol ?? '').toUpperCase(),
    baseAsset: (r.symbol ?? '').toUpperCase(),
    quoteAsset: 'USD',
    name: r.name,
    image: r.image,
    lastPrice: typeof r.current_price === 'number' ? r.current_price : 0,
    priceChangePercent: typeof r.price_change_percentage_24h === 'number' ? r.price_change_percentage_24h : null,
    highPrice: typeof r.high_24h === 'number' ? r.high_24h : null,
    lowPrice: typeof r.low_24h === 'number' ? r.low_24h : null,
    volume: typeof r.total_volume === 'number' ? r.total_volume : null,
    quoteVolume: typeof r.total_volume === 'number' ? r.total_volume : null,
    marketCap: typeof r.market_cap === 'number' ? r.market_cap : 0,
    rank: typeof r.market_cap_rank === 'number' ? r.market_cap_rank : 0,
    count: pool,
  }));

  // --- OUR filter/sort/pagination (local, labelled as derived) ---
  const q = search.toLowerCase();
  let matched = coins;
  if (q) {
    matched = coins.filter(
      (c) =>
        (c.name ?? '').toLowerCase().includes(q) ||
        c.baseAsset.toLowerCase().includes(q)
    );
  }

  const dir = order === 'asc' ? 1 : -1;
  const keyOf = (c: MarketsCoin): number | string => {
    switch (sort) {
      case 'mcap': return c.marketCap;
      case 'price': return c.lastPrice;
      case 'change': return c.priceChangePercent ?? -Infinity; // nulls sort last in desc
      case 'name': return (c.name ?? c.baseAsset).toLowerCase();
      case 'volume': return c.quoteVolume ?? 0;
    }
  };
  matched = [...matched].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (typeof ka === 'string' || typeof kb === 'string') {
      return String(ka).localeCompare(String(kb)) * dir;
    }
    return (ka - kb) * dir;
  });

  const total = matched.length;
  const offset = (page - 1) * limit;
  const slice = matched.slice(offset, offset + limit);

  return NextResponse.json(
    {
      coins: slice,
      total,
      limit,
      offset,
      hasMore: offset + slice.length < total,
      timestamp: Math.floor(Date.now() / 1000),
      pool,
      upstreamTotal: pool,
      upstream: marketsUpstreamUrl(),
      derived: `local search/sort/pagination over CoinGecko top ${pool} by market cap`,
    },
    {
      status: 200,
      headers: { 'X-Cache': res.headers.get('X-Cache') ?? 'MISS' },
    }
  );
}
