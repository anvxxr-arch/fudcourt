import { NextResponse } from 'next/server';
import { DEX, DEX_TYPES, DEX_CHAINS, type DexType, type DexChain, type DexPair, type DexProfile, isMint } from '@/features/dex/client';
import { limitedFetch } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * DexScreener public API proxy.
 *
 * Measured surface (2026-09-26, live against api.dexscreener.com). The old
 * `/latest/dex/pairs/{chain}` path this file used to call no longer exists --
 * it answers 404 with an HTML error page, so `type=pairs` was a hard 500 and
 * the Trench page could never use it. Every type below is a path verified to
 * return 200 with real data.
 *
 * Two upstream behaviours drive the design:
 *
 *  1. `GET /tokens/v1/{chain}/{address}` answers **200 with `[]`** for a
 *     syntactically invalid address. A proxy that forwards that verbatim makes
 *     "typo in the CA" indistinguishable from "token has no markets", so an
 *     invalid address is rejected locally with a 400 before it costs a request.
 *
 *  2. Error bodies are not always JSON -- a bad chain returns an HTML error
 *     page. The message is taken from the body text, never invented, and an
 *     upstream failure is always surfaced as a failure: this route never
 *     answers 200 with an empty `data` array to paper over a dead upstream.
 */

const TIMEOUT_MS = 20_000;

function fail(message: string, status: number, detail?: string) {
  return NextResponse.json(
    { error: message, ...(detail ? { detail } : {}) },
    { status }
  );
}

/** Fetch upstream, converting a non-2xx into a loud proxy error. */
type CacheState = 'HIT' | 'MISS' | 'COALESCED';
type UpstreamOk = { json: unknown; cache: CacheState };
type UpstreamErr = { error: NextResponse };
async function upstream(path: string, label: string): Promise<UpstreamOk | UpstreamErr> {
  let res: Response;
  let cacheState: CacheState = 'MISS';
  try {
    // Routed through the shared limiter/cache: DexScreener answers bursts with
    // 429 (Cloudflare 1015), and the UI fires on every keystroke and toggle.
    res = await limitedFetch(DEX + path, {
      cache: 'no-store',
      headers: { 'User-Agent': 'fudcourt-web/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const mark = res.headers.get('X-Cache');
    cacheState = mark === 'HIT' || mark === 'COALESCED' ? mark : 'MISS';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: fail(`upstream ${label} unreachable: ${msg}`, 502) };
  }

  if (!res.ok) {
    // Upstream errors here are frequently HTML, not JSON. Take the text as the
    // detail and report the real status -- never substitute our own wording for
    // what upstream actually said.
    const body = await res.text().catch(() => '');
    if (res.status === 429) {
      // Cloudflare 1015. Say so plainly and name the cause, because the fix is
      // "slow down" and a bare 429 reads as a broken server.
      return {
        error: fail(
          `upstream ${label} rate limited (HTTP 429, Cloudflare 1015) — too many requests in a short window`,
          429,
          body.slice(0, 200) || 'no retry-after header'
        ),
      };
    }
    return {
      error: fail(`upstream ${label} HTTP ${res.status}`, res.status, body.slice(0, 200)),
    };
  }

  try {
    return { json: (await res.json()) as unknown, cache: cacheState };
  } catch {
    return { error: fail(`upstream ${label} returned a non-JSON body`, 502) };
  }
}

function clampLimit(raw: string | null) {
  const n = parseInt(raw || '30', 10);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(n, 100);
}

/** Flatten a `{schemaVersion, pairs}` envelope or a bare pair array. */
function asPairs(json: unknown): DexPair[] | null {
  if (Array.isArray(json)) return json as DexPair[];
  if (json && typeof json === 'object' && Array.isArray((json as { pairs?: unknown }).pairs)) {
    return (json as { pairs: DexPair[] }).pairs;
  }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = (url.searchParams.get('type') || 'profiles') as DexType;

  if (!DEX_TYPES.includes(type)) {
    return fail(`unknown type '${type}'`, 400, `expected one of ${DEX_TYPES.join(', ')}`);
  }

  const limit = clampLimit(url.searchParams.get('limit'));
  const p = (k: string) => url.searchParams.get(k) ?? '';

  // An unknown chain must fail as an unknown CHAIN. Left unchecked it produced
  // "unknown type 'search?q=weth'" -- because the raw param had been read into
  // `type` -- which points the caller at the wrong field entirely.
  const wantedChain = p('chain').trim();
  if (wantedChain && !DEX_CHAINS.includes(wantedChain as DexChain)) {
    return fail(`unknown chain '${wantedChain}'`, 400, `expected one of ${DEX_CHAINS.join(', ')}`);
  }

  let upstreamPath = '';
  let kind = '';
  // Set only for search: DexScreener ignores a server-side chain filter, so the
  // narrowing happens here and the full spread is reported alongside it.
  let filterChain = '';

  switch (type) {
    case 'profiles':
      upstreamPath = '/token-profiles/latest/v1';
      kind = 'profiles';
      break;
    case 'boosts':
      upstreamPath = '/token-boosts/latest/v1';
      kind = 'profiles';
      break;
    case 'boosts-top':
      upstreamPath = '/token-boosts/top/v1';
      kind = 'profiles';
      break;
    case 'search': {
      const q = p('q').trim();
      if (!q) return fail('search needs a non-empty `q`', 400);
      // DexScreener search has NO chain filter -- `q=weth` returns pairs across
      // 16 chains (measured). `chain` is therefore applied locally, as a filter
      // over the returned set, and echoed back as `chainsSeen` so the UI can
      // show what a query actually spans instead of implying it was scoped.
      const wantChain = wantedChain;
      upstreamPath = `/latest/dex/search?q=${encodeURIComponent(q)}`;
      kind = 'pairs';
      filterChain = wantChain || '';
      break;
    }
    case 'tokens-v1': {
      // /tokens/v1/{chain}/{addr} is a DISTINCT endpoint from token-pairs/v1:
      // it is single-token and returns the deepest single pair. Kept separate
      // because its 200-with-empty-list behaviour on a bad mint is identical,
      // and it is the cheapest way to resolve ONE market.
      const addr = p('address').trim();
      if (!isMint(addr)) {
        return fail('`address` is not a valid token address', 400, 'expected a base58 mint, a 0x EVM address, or a dotted name');
      }
      const chain = wantedChain || 'solana';
      upstreamPath = `/tokens/v1/${chain}/${addr}`;
      kind = 'pairs';
      break;
    }
    case 'tokens': {
      // Upstream accepts up to 30 comma-separated addresses.
      const addrs = p('addresses')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      if (addrs.length === 0) return fail('tokens needs `addresses`', 400);
      if (addrs.length > 30) return fail('tokens accepts at most 30 addresses', 400);
      const bad = addrs.filter((a) => !isMint(a));
      if (bad.length) {
        // Without this, upstream answers 200 [] and a typo'd CA is
        // indistinguishable from a token with no markets.
        return fail(`${bad.length} address(es) are not valid mints`, 400, bad.join(','));
      }
      upstreamPath = `/latest/dex/tokens/${addrs.join(',')}`;
      kind = 'pairs';
      break;
    }
    case 'token-pairs': {
      const addr = p('address').trim();
      if (!isMint(addr)) {
        return fail('`address` is not a valid token address', 400, 'expected a base58 mint, a 0x EVM address, or a dotted name');
      }
      const chain = wantedChain || 'solana';
      upstreamPath = `/token-pairs/v1/${chain}/${addr}`;
      kind = 'pairs';
      break;
    }
    case 'orders': {
      const addr = p('address').trim();
      if (!isMint(addr)) {
        return fail('`address` is not a valid token address', 400, 'expected a base58 mint, a 0x EVM address, or a dotted name');
      }
      const chain = wantedChain || 'solana';
      upstreamPath = `/orders/v1/${chain}/${addr}`;
      kind = 'orders';
      break;
    }
  }

  const up = await upstream(upstreamPath, type);
  if ('error' in up) return up.error;
  const json = up.json;
  // Surfaced so the limiter is observable from outside: a HIT and a MISS return
  // byte-identical bodies, and without this header a 0.005s cached response is
  // indistinguishable from a real upstream round-trip. Measured 0.53s -> 0.005s.
  // COALESCED means "shared a call that was already in flight" -- distinct from
  // both, and reported as such rather than rounded down to MISS.
  const cacheState = up.cache;
  const cacheHeaders = { 'X-Cache': cacheState };

  // --- profiles / boosts: list of profile records, passed through trimmed ---
  if (kind === 'profiles') {
    if (!Array.isArray(json)) {
      return fail(`upstream ${type} did not return a list`, 502);
    }
    const all = json as Record<string, unknown>[];
    const rows: DexProfile[] = all.slice(0, limit).map((t) => ({
      address: t.tokenAddress as string,
      chain: t.chainId as string,
      symbol: (t.tokenSymbol as string) ?? null,
      icon: (t.icon as string) ?? null,
      header: (t.header as string) ?? null,
      description: (t.description as string) ?? null,
      links: Array.isArray(t.links) ? (t.links as DexProfile['links']) : [],
      amount: typeof t.amount === 'number' ? t.amount : null,
      totalAmount: typeof t.totalAmount === 'number' ? t.totalAmount : null,
      url: (t.url as string) ?? null,
    }));
    return NextResponse.json({
      kind,
      type,
      data: rows,
      returned: rows.length,
      total: all.length,
      upstream: DEX + upstreamPath,
      fetchedAt: Math.floor(Date.now() / 1000),
    }, { headers: cacheHeaders });
  }

  // --- orders: its own payload family (orders + boosts, no pairs) ---
  if (kind === 'orders') {
    const o = (json ?? {}) as { orders?: unknown; boosts?: unknown };
    return NextResponse.json({
      kind: 'orders',
      orders: Array.isArray(o.orders) ? o.orders : [],
      boosts: Array.isArray(o.boosts) ? o.boosts : [],
      upstream: DEX + upstreamPath,
      fetchedAt: Math.floor(Date.now() / 1000),
    }, { headers: cacheHeaders });
  }

  // --- pairs: {schemaVersion, pairs} envelope or a bare array ---
  const pairs = asPairs(json);
  if (pairs === null) {
    return fail(`upstream ${type} returned an unrecognised shape`, 502);
  }

  // Report what the query actually spanned BEFORE any local narrowing, so the
  // UI can say "23 pairs across 7 chains" instead of implying the query was
  // chain-scoped upstream when it never was.
  const seen: Record<string, number> = {};
  for (const pr of pairs) {
    if (pr?.chainId) seen[pr.chainId] = (seen[pr.chainId] || 0) + 1;
  }
  const matched = filterChain
    ? pairs.filter((pr) => pr?.chainId === filterChain)
    : pairs;

  if (filterChain && matched.length === 0) {
    // A filter that excludes everything is a real answer, but it must not be
    // reported as though the chain had no pairs at all upstream.
    return NextResponse.json({
      kind: 'pairs',
      type,
      data: [],
      returned: 0,
      total: pairs.length,
      filteredBy: filterChain,
      chainsSeen: seen,
      note: `upstream returned ${pairs.length} pairs across ${Object.keys(seen).length} chains; none on '${filterChain}'`,
      upstream: DEX + upstreamPath,
      fetchedAt: Math.floor(Date.now() / 1000),
    }, { headers: cacheHeaders });
  }

  const rows = matched.slice(0, limit);
  return NextResponse.json({
    kind: 'pairs',
    type,
    data: rows,
    returned: rows.length,
    total: matched.length,
    // unfiltered total, so a caller can tell "30 rows" from "30 of 240"
    upstreamTotal: pairs.length,
    // Always report the spread. An unfiltered search that silently omitted this
    // made a 16-chain result look like a single-chain one.
    chainsSeen: seen,
    ...(filterChain ? { filteredBy: filterChain } : {}),
    upstream: DEX + upstreamPath,
    fetchedAt: Math.floor(Date.now() / 1000),
  }, { headers: cacheHeaders });
}
