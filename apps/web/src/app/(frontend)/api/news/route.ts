import { NextRequest, NextResponse } from 'next/server';
/**
 * news read proxy (Cointelegraph RSS). Source/limit input, never a raw path.
 *
 * Runtime path: this route is a THIN, HONEST PROXY to the Go service
 * `fudcourt-data` (backend/data, 127.0.0.1:3101), exactly like
 * app/api/llama/route.ts and
 * app/api/cryptorank/route.ts. The Go side owns the feed table, the strict
 * `source`/`limit` validation (known source; integer, 1..100, never clamped),
 * the 15s TTL cache + single-flight keyed on the FEED URL, the RSS parse and
 * the honest `total` (the full parsed count, while `items` is the limit head).
 * Everything is forwarded VERBATIM — status, body and the `X-Cache` /
 * `Cache-Control` headers — so the public surface on :3100 is
 * GET /api/news?source=<cointelegraph>[&limit=<n>]
 * with the wire contract the Go side froze (backend/data/internal/news).
 *
 * Single source of truth: the feed table and every refusal live in Go ONLY.
 * Re-validating here would be a second implementation waiting to drift, which
 * is the same reasoning app/api/cryptorank/route.ts records. If this route ever
 * grows a param guard, that guard is the bug.
 *
 * This route used to parse the feed itself with an RSS regex. The parse moved
 * to Go with the rest of the family (DR-012); the TS behaviour it replaced is
 * the reason the strict 400s and the loud empty-feed 502 exist at all: the
 * original version silently coerced an unknown source into an empty 200 and
 * clamped `limit`, i.e. it lied about what the request did.
 *
 * Failure policy (house rule): fail loud — the sidecar unreachable or timed out
 * is a 502 carrying the real reason, never a fake 200 and never an empty list
 * standing in for a broken feed.
 */
export const dynamic = 'force-dynamic';
/** Go sidecar base URL. Runtime read: a restart picks up changes without a rebuild. */
const DATA_URL = process.env.FUDCOURT_DATA_URL ?? 'http://127.0.0.1:3101';
/**
 * The sidecar's own per-upstream timeout is 20s, so the proxy waits longer than
 * that before calling it unreachable.
 */
const TIMEOUT_MS = 60_000;
/* -------------------------------- handler ------------------------------- */
export async function GET(req: NextRequest) {
  const source = req.nextUrl.searchParams.get('source');
  const upstream = `${DATA_URL}/api/news`;
  // Exact same query string, untouched: the sidecar owns source/limit
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
      { error: `fudcourt-data unreachable: ${reason}`, upstream, kind: source },
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
