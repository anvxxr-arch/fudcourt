import { NextRequest, NextResponse } from 'next/server';
/**
 * chainrank read proxy (chainrank.fyi). Mode + pagination input, never a raw path.
 *
 * Runtime path: this route is a THIN, HONEST PROXY to the Go service
 * `apicalls` (services/data, 127.0.0.1:3101), exactly like
 * app/api/khala/route.ts, app/api/llama/route.ts, app/api/news/route.ts and
 * app/api/cryptorank/route.ts. The Go side owns the mode table, the upstream
 * URL construction, the 15s TTL cache + single-flight keyed on that URL, the
 * shape check and the honest `upstream` label. Everything is forwarded
 * VERBATIM — status, body and the `X-Cache` / `Cache-Control` headers — so the
 * public surface on :3100 is
 * GET /api/chainrank?mode=<stats|listings>[&page=<n>][&pageSize=<n>]
 * with the wire contract the Go side froze (services/data/internal/chainrank).
 *
 * The relay-verbatim rule is why this route must NOT clamp pagination:
 * upstream silently clamps page<1 to 1 and caps pageSize at 200, so a local
 * clamp would produce a response indistinguishable from upstream's own answer
 * while actually being OUR guess. That rule is why the proxy passes
 * `page`/`pageSize` through untouched and lets the Go side rebuild the same
 * query for upstream.
 *
 * Single source of truth: the mode table and every refusal live in Go ONLY.
 * Re-validating here would be a second implementation waiting to drift, which
 * is the same reasoning app/api/khala/route.ts records. If this route ever
 * grows a param guard, that guard is the bug.
 *
 * Writes are never proxied: POST /api/click|presence|claim/*|upload each have a
 * real side effect on someone else's production service (their click counters,
 * a pending payment row, their CDN), so neither this route nor the sidecar's
 * mux knows those paths. `lib/chainrank.ts` documents them for readers.
 *
 * Failure policy (house rule): fail loud — the sidecar unreachable or timed out
 * is a 502 carrying the real reason, never a fake 200 and never an empty
 * envelope standing in for a broken board.
 */
export const dynamic = 'force-dynamic';
/** Go sidecar base URL. Runtime read: a restart picks up changes without a rebuild. */
const APICALLS = process.env.APICALLS_URL ?? 'http://127.0.0.1:3101';
/**
 * The sidecar's own per-upstream timeout is 20s, so the proxy waits longer than
 * that before calling it unreachable.
 */
const TIMEOUT_MS = 60_000;
/* -------------------------------- handler ------------------------------- */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode');
  const upstream = `${APICALLS}/api/chainrank`;
  // Exact same query string, untouched: the sidecar owns mode/page/pageSize
  // semantics (validation, defaults, refusal, and the upstream URL itself).
  // We never rewrite params — including the pagination values upstream will
  // clamp on its own terms.
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
      { error: `apicalls unreachable: ${reason}`, upstream, kind: mode },
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
  return new NextResponse(body, { status: res.status, headers });
}
