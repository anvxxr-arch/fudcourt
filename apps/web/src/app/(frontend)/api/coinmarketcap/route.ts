import { NextRequest, NextResponse } from 'next/server';
/**
 * CoinMarketCap read proxy (api.coinmarketcap.com/data-api/v3). Mode + pagination
 * input, never a raw path.
 *
 * Runtime path: this route is a THIN, HONEST PROXY to the Go service
 * `fudcourt-data` (apps/data, 127.0.0.1:3101), exactly like
 * app/api/coinglass/route.ts and app/api/coinank/route.ts. The Go side owns the
 * mode table, the upstream URL construction, the LOCAL pagination bounds, the
 * param-scoping matrix, the TTL cache + single-flight and the honest `upstream`
 * provenance. Everything is forwarded VERBATIM -- status, body and the X-CMC-* /
 * Cache-Control headers -- so the public surface on :3100 is
 *   GET /api/coinmarketcap?mode=<listing|global|marketPairs|exchanges>[&slug=<S>][&start=<n>][&limit=<n>][&fresh=1]
 * with the wire contract the Go side froze
 * (apps/data/internal/research/coinmarketcap).
 *
 * The relay-verbatim rule is why this route must NOT clamp pagination: the sidecar
 * validates `start`/`limit` against its own frozen bounds BEFORE any fetch (because
 * upstream answers `limit=0` with a SUCCESS envelope carrying an EMPTY list), and a
 * local clamp would produce a response indistinguishable from the sidecar's own
 * answer while actually being OUR guess. Same reasoning as app/api/cryptorank/route.ts.
 *
 * Single source of truth: the mode table, the bounds and every refusal live in Go
 * ONLY. Re-validating here would be a second implementation waiting to drift. If
 * this route ever grows a param guard, that guard is the bug.
 *
 * Failure policy (house rule): fail loud -- the sidecar unreachable or timed out is
 * a 502 carrying the real reason, never a fake 200 and never an empty envelope
 * standing in for a broken board.
 */
export const dynamic = 'force-dynamic';
/** Go sidecar base URL. Runtime read: a restart picks up changes without a rebuild. */
const DATA_URL = process.env.FUDCOURT_DATA_URL ?? 'http://127.0.0.1:3101';
/** The sidecar's own per-request timeout is 60s, so the proxy waits longer. */
const TIMEOUT_MS = 75_000;
/* -------------------------------- handler ------------------------------- */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode');
  const upstream = `${DATA_URL}/api/coinmarketcap`;
  // Exact same query string, untouched: the sidecar owns mode/slug/start/limit/fresh
  // semantics (validation, defaults, refusal, and the upstream URL itself). We never
  // rewrite params -- including the pagination values the sidecar validates itself.
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
    // Unreachable, refused, DNS failure or our timeout -- the real reason only.
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
  // Verbatim pass-through: a 400 (strict param / out-of-bounds page), a 502
  // (upstream's own refusal, which arrives as HTTP 200 upstream) and a 200 all reach
  // the caller as the sidecar wrote them.
  const body = await res.text();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of ['X-CMC-Upstream', 'X-CMC-Cache', 'Cache-Control']) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return new NextResponse(body, { status: res.status, headers });
}
