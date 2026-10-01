import { NextRequest, NextResponse } from 'next/server';
/**
 * khala read proxy. Mode-only input (never a raw path).
 *
 * Runtime path: this route is a THIN, HONEST PROXY to the Go service
 * `fudcourt-data` (backend/data, 127.0.0.1:3101), exactly like
 * app/api/cryptorank/route.ts. The Go service does the real work: mode
 * validation, the `key`/`limit` scoping, the strict 1..50 limit, the report
 * slug regex, the HTML acquisition of khala.io, the block extraction and the
 * disk cache. Everything it returns is forwarded VERBATIM — status, body and
 * the X-KH-Upstream / X-KH-Cache / Cache-Control headers — so the public
 * surface on :3100 is
 * GET /api/khala?mode=<reports|report|latest>[&key=<slug>][&limit=<n>][&fresh=1]
 * with the wire contract the Go side froze. Unlike the cryptorank route there
 * is no pre-migration consumer to stay byte-compatible with; the consumer is
 * src/components/KhalaPage.tsx.
 *
 * Single source of truth: the mode list, the `key`-only-for-`report` /
 * `limit`-only-for-`latest` scoping and every 400 live in Go ONLY.
 * Re-validating here would be a second implementation waiting to drift (this is
 * the same reasoning the cryptorank route records, and the same reason
 * scripts/verify/check-contract.py asserts the two cryptorank mode tables can never
 * diverge). If this route ever grows a param guard, that guard is the bug.
 *
 * No HTML crosses this route. `mode=report` ships the article as a STRUCTURED
 * block array (`body: {type: h2|h3|h4|p|li, text}[]`, inline emphasis already
 * flattened to text) and never as `bodyHtml`. That is why the board can render
 * the full report as React elements with no `dangerouslySetInnerHTML` and no
 * sanitizer dependency — third-party markup never reaches the app's DOM. The
 * bodyText/bodyHtml/sanitize question this family used to carry is therefore
 * closed by the wire contract, not by a decision in this file.
 *
 * Upstreams: this family reads TWO origins (the homepage + sitemap.xml to
 * enumerate reports, then one report page). The Go envelope keeps `upstream` a
 * single primary-origin string and names the auxiliary enumeration and the
 * per-row date resolution in `slice`, which the board renders verbatim —
 * `CrEnvelope.upstream` is scalar the same way, so a consumer reads both
 * families' labels identically. The response header carries that same string.
 *
 * Failure policy (house rule): fail loud. If the sidecar is unreachable or
 * times out -> 502 carrying the real reason. Never a fake 200, never an empty
 * envelope, never a substituted payload.
 */
export const dynamic = 'force-dynamic';
/** Go sidecar base URL. Runtime read: a restart picks up changes without a rebuild. */
const DATA_URL = process.env.FUDCOURT_DATA_URL ?? 'http://127.0.0.1:3101';
/**
 * Largest payload is `mode=report` over the longest report at 84,315 B
 * (x402, 506 blocks — measured 2026-09-29; see lib/rate-limit-inbound.ts for
 * the full spread). That payload is small, but the sidecar has to fetch and
 * parse a 579,989 B khala.io report page to build it, so it gets the same room
 * as cryptorank's biggest mode.
 */
const TIMEOUT_MS = 60_000;
/* -------------------------------- handler ------------------------------- */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode');
  const upstream = `${DATA_URL}/api/khala`;
  // Exact same query string, untouched: the sidecar owns mode/key/limit/fresh
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
    // Unreachable, refused, DNS failure or our 60s timeout — real reason only.
    // Node's fetch reports a generic "fetch failed"; the actionable cause
    // (ECONNREFUSED, ENOTFOUND, our AbortSignal timeout, …) is on err.cause.
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
  // Verbatim pass-through: parse nothing, interpret nothing. A 400 (strict
  // param), a 404 (no such report) and a 502 (wall or layout drift) all reach
  // the board as the sidecar wrote them, which is what makes the UI's error
  // text the sidecar's own words.
  const body = await res.text();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of ['X-KH-Upstream', 'X-KH-Cache', 'Cache-Control']) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return new NextResponse(body, { status: res.status, headers });
}
