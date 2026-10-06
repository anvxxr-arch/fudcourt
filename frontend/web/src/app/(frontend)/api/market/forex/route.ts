import { NextResponse } from 'next/server';
import {
  FOREX_PAIRS,
  FOREX_TTL_MS,
  FOREX_UPSTREAM,
  buildPair,
  type ForexPair,
} from '@/features/market/forex-pairs';
import { limitedFetch } from '@/lib/rate-limit';
import { fail } from '../../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

/**
 * Read-only proxy to open.er-api.com (public, keyless) serving the forex board.
 *
 * Honest-by-construction (same rules as /api/markets):
 *  - the curated major pairs are DERIVED locally from the USD base rates and
 *    reported in `derived`; the body never pretends the provider shipped them.
 *  - a non-2xx upstream keeps its real status (429 passes through loud).
 *  - an empty rate set is a loud 502 -- never a fake 200 with zero pairs.
 *  - shared limiter (min-gap + TTL + single-flight): the daily feed is fetched
 *    at most once per FOREX_TTL_MS window.
 */
export async function GET() {
  let res: Response;
  try {
    res = await limitedFetch(FOREX_UPSTREAM, { signal: AbortSignal.timeout(TIMEOUT_MS) }, { ttlMs: FOREX_TTL_MS });
  } catch (e) {
    return fail('upstream request failed', 502, e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    return NextResponse.json({ error: `upstream ${res.status} from exchangerate-api` }, { status: res.status });
  }

  let body: {
    result?: string;
    base_code?: string;
    rates?: Record<string, number>;
    time_last_update_unix?: number;
  } | null = null;
  try {
    body = await res.json();
  } catch (e) {
    return fail('upstream returned non-JSON', 502, e instanceof Error ? e.message : String(e));
  }
  if (body?.result !== 'success' || !body.rates || typeof body.rates !== 'object') {
    return fail('upstream returned no rates', 502, JSON.stringify(body ?? null).slice(0, 120));
  }

  const base = body.base_code ?? 'USD';
  const pairs = FOREX_PAIRS.map((spec) => buildPair(spec, body!.rates!)).filter(
    (p): p is ForexPair => p !== null
  );
  if (pairs.length === 0) {
    return fail('no curated pair could be derived from the upstream rates', 502, `base=${base}`);
  }

  return NextResponse.json(
    {
      pairs,
      count: pairs.length,
      base,
      updated: typeof body.time_last_update_unix === 'number' ? body.time_last_update_unix : null,
      upstream: FOREX_UPSTREAM,
      derived: `curated majors derived locally from ${base} base rates`,
    },
    { status: 200, headers: { 'X-Cache': res.headers.get('X-Cache') ?? 'MISS' } }
  );
}
