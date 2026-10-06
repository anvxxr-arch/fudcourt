import { NextRequest, NextResponse } from 'next/server';
/**
 * llama read proxy (DeFiLlama). Mode-only input, never a raw path.
 *
 * Runtime path: this route is a THIN, HONEST PROXY to the Go service
 * `fudcourt-data` (backend/data, 127.0.0.1:3101), exactly like
 * app/api/cryptorank/route.ts and app/api/news/route.ts. The Go side owns the
 * mode table, the strict `top`/`days` validation (integer, 1..200 / 1..3288,
 * never clamped), the 15s TTL cache + single-flight, the sort/trim and the
 * honest `derived`/`upstreamTotal` labels. Everything is forwarded VERBATIM —
 * status, body and the `X-Cache` / `Cache-Control` headers — so the public
 * surface on :3100 is
 * GET /api/llama?mode=<chains|protocols|historical>[&top=<n>][&days=<n>]
 * with the wire contract the Go side froze (backend/data/internal/llama).
 *
 * Single source of truth: the mode list and every refusal live in Go ONLY.
 * Re-validating here would be a second implementation waiting to drift, which
 * is the same reasoning app/api/cryptorank/route.ts records. If this route ever
 * grows a param guard, that guard is the bug.
 *
 * Failure policy (house rule): fail loud — the sidecar unreachable or timed out
 * is a 502 carrying the real reason, never a fake 200 and never an empty
 * envelope standing in for a trimmed board.
 */
export const dynamic = 'force-dynamic';
/** Go sidecar base URL. Runtime read: a restart picks up changes without a rebuild. */
const DATA_URL = process.env.FUDCOURT_DATA_URL ?? 'http://127.0.0.1:3101';
/**
 * `mode=protocols` fetches an 8.9MB upstream body and `mode=chains` the 64KB
 * list; the sidecar's own timeout is 20s per upstream call, so the proxy waits
 * longer than that before calling it unreachable.
 */
const TIMEOUT_MS = 60_000;
/* -------------------------------- handler ------------------------------- */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode');
  const upstream = `${DATA_URL}/api/llama`;
  // Exact same query string, untouched: the sidecar owns mode/top/days
  // semantics (validation, defaults, refusal). We never rewrite params.
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
    // Unreachable, refused, DNS failure or our timeout — the real reason only.
    const reason =
      err instanceof Error
        ? [err.message, (err.cause as Error | undefined)?.message]
            .filter((s): s is string => Boolean(s))
            .join(': ')
        : String(err);
    return NextResponse.json(
      { error: `fudcourt-data unreachable: ${reason}`, upstream, kind: mode },
      { status: 502 },
    );
  }
  // Verbatim pass-through: a 400 (strict param), a 429/5xx (real upstream
  // verdict) and a 200 all reach the board as the sidecar wrote them.
  const body = await res.text();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of ['X-Cache', 'Cache-Control']) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  // The sidecar owns a 15s TTL but sends no Cache-Control of its own, so a
  // 200 without one gets the mirror value. Non-200s stay untouched.
  if (res.status === 200 && !headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'public, max-age=15');
  }
  return new NextResponse(body, { status: res.status, headers });
}
