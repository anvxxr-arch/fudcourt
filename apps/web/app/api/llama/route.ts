import { NextResponse } from 'next/server';
import {
  LLAMA_UPSTREAM,
  LLAMA_MODES,
  PROTOCOLS_TOP_DEFAULT,
  PROTOCOLS_TOP_MAX,
  HISTORICAL_DAYS_DEFAULT,
  HISTORICAL_DAYS_MAX,
  type LlamaMode,
} from '../../../lib/llama';
import { limitedFetch } from '../../../lib/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const TIMEOUT_MS = 20_000;

function fail(message: string, status: number, detail?: string) {
  return NextResponse.json(
    { error: message, ...(detail ? { detail } : {}) },
    { status }
  );
}

/**
 * Read-only proxy to api.llama.fi (public, keyless). Measured 2026-09-27.
 *
 * Honest-by-construction choices:
 *  - `top` / `days` are OUR parameters, so they are validated strictly
 *    (integer in range, else 400) -- never silently clamped. Upstream params
 *    would be relayed verbatim; these never reach upstream.
 *  - sorting / trimming is reported in `derived` + `upstreamTotal`: chains
 *    arrive UNSORTED from upstream and protocols is 8.9MB trimmed to a head,
 *    so neither body may pretend to be verbatim upstream.
 *  - non-2xx / non-JSON upstream keeps its real status, never a fake 200.
 *  - shared limiter: min-gap + 15s TTL + single-flight, so the 3-mode UI poll
 *    collapses to at most 3 upstream calls per window.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = (url.searchParams.get('mode') || 'chains') as LlamaMode;
  if (!LLAMA_MODES.includes(mode)) {
    return fail(`unknown mode '${mode}'`, 400, `expected one of ${LLAMA_MODES.join(', ')}`);
  }

  // Strict integer parse -- our own params get our own 400s, not clamping.
  // Returns the number, or the error message as a string (typeof narrowing;
  // a boolean-literal discriminated union did not narrow here).
  const intParam = (name: string, raw: string | null, dflt: number, max: number): number | string => {
    if (raw === null) return dflt;
    if (!/^\d+$/.test(raw)) return `${name} must be an integer, got '${raw}'`;
    const v = Number(raw);
    if (v < 1 || v > max) return `${name} must be between 1 and ${max}, got ${v}`;
    return v;
  };

  let upstreamPath: string;
  let top = 0;
  let days = 0;

  if (mode === 'chains') {
    upstreamPath = '/v2/chains';
  } else if (mode === 'protocols') {
    const t = intParam('top', url.searchParams.get('top'), PROTOCOLS_TOP_DEFAULT, PROTOCOLS_TOP_MAX);
    if (typeof t === 'string') return fail(t, 400);
    top = t;
    upstreamPath = '/protocols';
  } else {
    const d = intParam('days', url.searchParams.get('days'), HISTORICAL_DAYS_DEFAULT, HISTORICAL_DAYS_MAX);
    if (typeof d === 'string') return fail(d, 400);
    days = d;
    upstreamPath = '/v2/historicalChainTvl';
  }

  const upstreamUrl = LLAMA_UPSTREAM + upstreamPath;

  let res: Response;
  let cacheState: 'HIT' | 'MISS' | 'COALESCED' = 'MISS';
  try {
    res = await limitedFetch(upstreamUrl, {
      cache: 'no-store',
      headers: { 'User-Agent': 'fudcourt-web/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const mark = res.headers.get('X-Cache');
    cacheState = mark === 'HIT' || mark === 'COALESCED' ? mark : 'MISS';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`upstream ${mode} unreachable: ${msg}`, 502);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 429) {
      return fail(`upstream ${mode} rate limited (429) — back off and retry`, 429, body.slice(0, 200));
    }
    return fail(`upstream ${mode} HTTP ${res.status}`, res.status, body.slice(0, 200));
  }

  const text = await res.text().catch(() => '');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(`upstream ${mode} returned a non-JSON body`, 502, text.slice(0, 200));
  }
  if (!Array.isArray(json)) {
    return fail(`upstream ${mode} returned an unrecognised shape (expected a list)`, 502);
  }

  const headers = { 'X-Cache': cacheState };
  const base = {
    upstream: upstreamUrl,
    fetchedAt: Math.floor(Date.now() / 1000),
    upstreamTotal: json.length,
  };

  if (mode === 'chains') {
    // Upstream sends the list UNSORTED (Moonbeam with $78k TVL was row 0).
    // Sorting is a pure order change over the FULL set -- nothing dropped.
    const rows = [...json].sort(
      (a, b) => ((b as { tvl?: number }).tvl ?? -1) - ((a as { tvl?: number }).tvl ?? -1)
    );
    return NextResponse.json(
      { kind: 'chains', rows, ...base, derived: 'sorted by tvl desc (upstream sends unsorted)' },
      { headers }
    );
  }

  if (mode === 'protocols') {
    // 8.9MB fetched in full (one cached copy), head relayed. Sorting here too,
    // so "top" means top by tvl regardless of upstream's ordering.
    const sorted = [...json].sort(
      (a, b) => ((b as { tvl?: number }).tvl ?? -1) - ((a as { tvl?: number }).tvl ?? -1)
    );
    const rows = sorted.slice(0, top).map((p) => {
      const r = p as Record<string, unknown>;
      return {
        name: r.name,
        slug: r.slug,
        category: r.category ?? null,
        tvl: r.tvl ?? null,
        change_1d: r.change_1d ?? null,
        change_7d: r.change_7d ?? null,
        mcap: r.mcap ?? null,
        chains: Array.isArray(r.chains) ? r.chains : [],
        url: r.url ?? null,
        logo: r.logo ?? null,
      };
    });
    return NextResponse.json(
      {
        kind: 'protocols',
        rows,
        ...base,
        derived: `head ${top} of ${json.length} sorted by tvl desc (upstream body is 8.9MB, trimmed here)`,
      },
      { headers }
    );
  }

  // historical: tail `days` points (upstream is oldest-first).
  const rows = json.slice(-days).map((p) => {
    const r = p as Record<string, unknown>;
    return { date: r.date, tvl: r.tvl };
  });
  return NextResponse.json(
    {
      kind: 'historical',
      rows,
      ...base,
      derived: `last ${days} of ${json.length} days (upstream is oldest-first)`,
    },
    { headers }
  );
}
