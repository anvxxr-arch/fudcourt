import { NextRequest, NextResponse } from 'next/server';
/**
 * CoinGlass read proxy (capi.coinglass.com). Mode + symbol input, never a raw path.
 *
 * Runtime path: this route is a THIN, HONEST PROXY to the Go service
 * `fudcourt-data` (backend/data, 127.0.0.1:3101), exactly like
 * app/api/cryptorank/route.ts and app/api/llama/route.ts.
 * The Go side owns the mode table, the upstream URL construction, the AES
 * decryption, the 15s TTL cache + single-flight keyed on that URL, the
 * param-scoping matrix and the honest `upstream` / `cipher` provenance. Everything
 * is forwarded VERBATIM -- status, body and the X-CG-* / Cache-Control headers --
 * so the public surface on :3100 is
 *   GET /api/coinglass?mode=<statistics|openInterest|fundingRate|markets>[&symbol=<SYM>][&fresh=1]
 * with the wire contract the Go side froze (backend/data/internal/research/coinglass).
 *
 * Single source of truth: the mode table and every refusal live in Go ONLY.
 * Re-validating here would be a second implementation waiting to drift, which is
 * the same reasoning app/api/cryptorank/route.ts records. If this route ever grows a
 * param guard, that guard is the bug.
 *
 * Failure policy (house rule): fail loud -- the sidecar unreachable or timed out is
 * a 502 carrying the real reason, never a fake 200 and never an empty envelope
 * standing in for a broken board.
 */
export const dynamic = 'force-dynamic';
/** Go sidecar base URL. Runtime read: a restart picks up changes without a rebuild. */
const DATA_URL = process.env.FUDCOURT_DATA_URL ?? 'http://127.0.0.1:3101';
/**
 * The sidecar's own per-request timeout is 60s (a cold CoinGlass fetch decrypts two
 * AES layers), so the proxy waits longer than that before calling it unreachable.
 */
const TIMEOUT_MS = 75_000;
/* -------------------------------- handler ------------------------------- */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode');
  const upstream = `${DATA_URL}/api/coinglass`;
  // Exact same query string, untouched: the sidecar owns mode/symbol/fresh
  // semantics (validation, refusal, and the upstream URL itself). We never rewrite
  // params.
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
  // Verbatim pass-through: a 400 (strict param), a 502 (real upstream refusal) and
  // a 200 all reach the caller as the sidecar wrote them. X-CG-Cipher is forwarded
  // because it names the `v` rotation slot that produced the payload -- transport
  // state a consumer debugging a decode needs, and not derivable from the body.
  const body = await res.text();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of ['X-CG-Upstream', 'X-CG-Cache', 'X-CG-Cipher', 'Cache-Control']) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return new NextResponse(body, { status: res.status, headers });
}
