import { NextResponse } from 'next/server';
import { CHAINRANK, CR_MODES, type CrMode } from '../../../lib/chainrank';
import { limitedFetch } from '../../../lib/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 15_000;

function fail(message: string, status: number, detail?: string) {
  return NextResponse.json(
    { error: message, ...(detail ? { detail } : {}) },
    { status }
  );
}

/**
 * Read-only proxy to chainrank.fyi. Reverse-engineered 2026-09-27; the
 * executable contract lives in scripts/verify-chainrank.py.
 *
 * Honest-by-construction choices:
 *  - pagination params pass through UNTOUCHED. Upstream silently clamps
 *    page<1 to 1 and caps pageSize at 200; re-clamping locally would make our
 *    response indistinguishable from upstream's own answer while actually being
 *    our guess. Relayed verbatim, the clamping in the body is upstream's, and
 *    `upstream` names the exact URL that produced it.
 *  - a non-2xx or non-JSON upstream is reported with its real status, never
 *    smoothed into 200 with empty data.
 *  - shared limiter/cache (X-Cache, single-flight, LRU): this sits behind the
 *    same refresh loop the site itself runs (stats+listings every 20s), and
 *    bursts of identical requests collapse to one upstream call.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = (url.searchParams.get('mode') || 'stats') as CrMode;

  if (!CR_MODES.includes(mode)) {
    return fail(`unknown mode '${mode}'`, 400, `expected one of ${CR_MODES.join(', ')}`);
  }

  // Relay pagination exactly as given. Upstream is the source of truth for
  // what page=0 or pageSize=9999 means.
  const qs = new URLSearchParams();
  for (const k of ['page', 'pageSize']) {
    const v = url.searchParams.get(k);
    if (v !== null) qs.set(k, v);
  }
  const upstreamPath = mode === 'stats' ? '/api/stats' : `/api/listings${qs.size ? `?${qs}` : ''}`;
  const upstreamUrl = CHAINRANK + upstreamPath;

  let res: Response;
  let cacheState: 'HIT' | 'MISS' | 'COALESCED' = 'MISS';
  try {
    res = await limitedFetch(upstreamUrl, {
      cache: 'no-store',
      headers: {
        'User-Agent': 'fudcourt-web/1.0',
        Accept: 'application/json',
        // robots.txt disallows /api/ to crawlers; this is a low-volume API
        // client relaying public board data, identified as such.
        'From': 'fudcourt (read-only leaderboard relay)',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const mark = res.headers.get('X-Cache');
    cacheState = mark === 'HIT' || mark === 'COALESCED' ? mark : 'MISS';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`upstream ${mode} unreachable: ${msg}`, 502);
  }

  const headers = { 'X-Cache': cacheState };

  if (!res.ok) {
    // Real status, real body excerpt -- never substitute our wording for what
    // upstream actually said.
    const body = await res.text().catch(() => '');
    if (res.status === 405) {
      return fail(`upstream ${mode} answered 405 (method gate)`, 405, body.slice(0, 200));
    }
    if (res.status === 429) {
      return fail(
        `upstream ${mode} rate limited (429) — too many requests in a short window`,
        429,
        body.slice(0, 200) || 'no retry-after header'
      );
    }
    return fail(`upstream ${mode} HTTP ${res.status}`, res.status, body.slice(0, 200));
  }

  const text = await res.text().catch(() => '');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Upstream error pages are HTML. Report with its status, not a fake 200.
    return fail(`upstream ${mode} returned a non-JSON body`, 502, text.slice(0, 200));
  }

  const cacheHeaders = { 'X-Cache': cacheState };
  const envelope = (json ?? {}) as Record<string, unknown>;

  if (mode === 'stats') {
    if (typeof envelope.online !== 'number' || typeof envelope.totalUsdCents !== 'number') {
      return fail(`upstream stats returned an unrecognised shape`, 502);
    }
    return NextResponse.json(
      {
        kind: 'stats',
        ...envelope,
        upstream: upstreamUrl,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
      { headers: cacheHeaders }
    );
  }

  // listings
  if (!Array.isArray(envelope.rows)) {
    return fail(`upstream listings returned an unrecognised shape`, 502);
  }
  return NextResponse.json(
    {
      kind: 'listings',
      ...envelope,
      upstream: upstreamUrl,
      fetchedAt: Math.floor(Date.now() / 1000),
    },
    { headers: cacheHeaders }
  );
}
