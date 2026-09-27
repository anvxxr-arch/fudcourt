import { NextResponse } from 'next/server';
import { DEX, DEX_TYPES, type DexType, type DexPair, type DexProfile, isMint } from '../../../lib/dex';

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
async function upstream(path: string, label: string) {
  let res: Response;
  try {
    res = await fetch(DEX + path, {
      cache: 'no-store',
      headers: { 'User-Agent': 'fudcourt-web/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: fail(`upstream ${label} unreachable: ${msg}`, 502) } as const;
  }

  if (!res.ok) {
    // Upstream errors here are frequently HTML, not JSON. Take the text as the
    // detail and report the real status -- never substitute our own wording for
    // what upstream actually said.
    const body = await res.text().catch(() => '');
    return {
      error: fail(`upstream ${label} HTTP ${res.status}`, res.status, body.slice(0, 200)),
    } as const;
  }

  try {
    return { json: (await res.json()) as unknown } as const;
  } catch {
    return { error: fail(`upstream ${label} returned a non-JSON body`, 502) } as const;
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

  let upstreamPath = '';
  let kind = '';

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
      upstreamPath = `/latest/dex/search?q=${encodeURIComponent(q)}`;
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
        return fail('`address` is not a valid mint', 400, 'expected 32-44 base58 chars');
      }
      const chain = p('chain') || 'solana';
      upstreamPath = `/token-pairs/v1/${chain}/${addr}`;
      kind = 'pairs';
      break;
    }
    case 'orders': {
      const addr = p('address').trim();
      if (!isMint(addr)) {
        return fail('`address` is not a valid mint', 400, 'expected 32-44 base58 chars');
      }
      const chain = p('chain') || 'solana';
      upstreamPath = `/orders/v1/${chain}/${addr}`;
      kind = 'orders';
      break;
    }
  }

  const r = await upstream(upstreamPath, type);
  if ('error' in r) return r.error;
  const json = r.json;

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
    });
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
    });
  }

  // --- pairs: {schemaVersion, pairs} envelope or a bare array ---
  const pairs = asPairs(json);
  if (pairs === null) {
    return fail(`upstream ${type} returned an unrecognised shape`, 502);
  }
  const rows = pairs.slice(0, limit);
  return NextResponse.json({
    kind: 'pairs',
    type,
    data: rows,
    returned: rows.length,
    total: pairs.length,
    upstream: DEX + upstreamPath,
    fetchedAt: Math.floor(Date.now() / 1000),
  });
}
