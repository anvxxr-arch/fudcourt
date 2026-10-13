import { NextRequest, NextResponse } from 'next/server';

/**
 * `GET /api/data/news` — the DURABLE news surface.
 *
 * This is deliberately NOT the same thing as `GET /api/news`:
 *   - `/api/news` is the research read proxy (apps/data/internal/research/news):
 *     a verbatim, stateless relay of one publisher's RSS feed. Its wire contract
 *     (sources table, 400 detail text, healthz feed count) is pinned by
 *     scripts/verify-news.py and must not move.
 *   - `/api/data/news` reads the STORE — every article the newsfeed ingestion
 *     adapter has ever written to data.news_article, across all sources, with
 *     the filters and keyset cursor the sidecar exposes.
 *
 * The `[...path]` gateway now forwards the `/api/data` family WITH its subpath
 * (the subpath-drop it used to have was fixed on 2026-10-12), so this path is
 * also reachable through the gateway. It keeps its own handler because Next
 * resolves a concrete route ahead of a catch-all: the dedicated file is the
 * faster path and its relays are pinned by the news tests. The gateway's
 * `data` family serves every OTHER `/api/data/*` sub-path.
 *
 * `dynamic = 'force-dynamic'`: the response depends entirely on the live store,
 * so Next must never serve it from a build-time cache.
 */
export const dynamic = 'force-dynamic';

/** `:3101` data sidecar base URL (apps/data). Runtime read: a restart picks it up. */
const DATA_URL = process.env.FUDCOURT_DATA_URL ?? 'http://127.0.0.1:3101';

/** Loopback hop budget (the store read is fast; the sidecar owns upstreams). */
const TIMEOUT_MS = 15_000;

/** The real reason a loopback hop failed (Node's fetch hides it on `err.cause`). */
function realReason(err: unknown): string {
  return err instanceof Error
    ? [err.message, (err.cause as Error | undefined)?.message].filter((s): s is string => Boolean(s)).join(': ')
    : String(err);
}

async function forward(req: NextRequest): Promise<Response> {
  const upstream = `${DATA_URL}/api/data/news`;
  // Verbatim query string: source/category/asset/search/before/limit are the
  // sidecar's contract, and it owns the validation of each.
  const target = `${upstream}${req.nextUrl.search}`;
  let res: Response;
  try {
    res = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `fudcourt-data unreachable: ${realReason(err)}`, upstream },
      { status: 502 },
    );
  }
  const body = await res.text();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  // Relay the store's read-freshness contract and the keyset cursor hint.
  for (const h of ['Cache-Control', 'Link', 'ETag']) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  if (res.status === 200 && !headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'public, max-age=60');
  }
  return new NextResponse(body, { status: res.status, headers });
}

export async function GET(req: NextRequest): Promise<Response> {
  return forward(req);
}

export async function HEAD(req: NextRequest): Promise<Response> {
  const res = await forward(req);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
