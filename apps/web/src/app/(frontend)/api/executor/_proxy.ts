/**
 * _proxy.ts — the single always-on forwarder for every `/api/executor/*`
 * request. Lives at the route boundary so the web tier is a one-line
 * pass-through to the Go executor surface.
 *
 * THE GATE (objective §52, cutover). With DR-042 the Go service
 * `fudcourt-executor.service` is the live executor, and the previous
 * `FUDCOURT_EXECUTOR_PROXY=go` flip has been removed — the web tier no
 * longer carries the choice, so the only consumer of this forwarder is
 * every one of the 15 `route.ts` shells and nothing else.
 *
 * WHY THE AUTH CALL IS SKIPPED ON THE FORWARD PATH. The Go surface
 * (`apps/executor/internal/api`) verifies the SAME signed
 * session cookie from the SAME `FUDCOURT_SESSION_SECRET` (DR-035) and
 * answers the byte-identical 401. If this module pre-authenticated and
 * then forwarded anyway, there would be two authorities and the Go
 * side's own refusal would be unreachable; instead the `Cookie` header
 * travels through untouched and the Go surface is the single authority
 * for session, tier and ownership. No identity header is ever minted,
 * rewritten or injected — a proxy-supplied identity is spoofable, which
 * is precisely why the Go side trusts only the signed cookie.
 *
 * NEVER FALL BACK. When the upstream is unreachable — the unit is not
 * provisioned yet, the listener died, the loopback hop timed out — this
 * module answers a loud 502 naming the real reason. There is no TS
 * fallback: mid-request that would swap one backend's committed state
 * for another's (the TS runtime and the Go store do not share a
 * connection), which is the failure mode the house refuses.
 *
 * The forward is faithful: method, path, query string, headers and body
 * go through unchanged, and the upstream status/body/content-type come
 * back with the envelopes intact — the Go surface already emits
 * byte-shaped TS envelopes (`internal/api/routes_test.go`, 29 tests), so
 * nothing here re-shapes, re-parses or interprets a body.
 */
import { NextResponse } from 'next/server';
/**
 * Loopback address of the Go executor surface. Mirrors the Go side's own
 * default (`apps/executor/api.go`:
 * FUDCOURT_EXECUTOR_API_ADDR, default 127.0.0.1:3105) and the
 * `Environment=` pin in `deploy/systemd/fudcourt-executor.service`.
 * Resolved ONCE at module load (env is immutable after
 * `fudcourt-web.service` start), so a per-request `process.env` parse is
 * avoided.
 */
const UPSTREAM_ADDR: string = (() => {
  const raw = (process.env.FUDCOURT_EXECUTOR_API_ADDR ?? '').trim();
  const address = raw === '' ? '127.0.0.1:3105' : raw;
  return /^https?:\/\//i.test(address) ? address : `http://${address}`;
})();
/**
 * Bound the loopback hop to the Go executor surface. The Go listener's
 * own WriteTimeout is 30 s, so a hang past that means the executor
 * itself is stuck; aborting at 35 s turns an unbounded pin of this
 * worker into the loud 502 the catch below already emits.
 */
const TIMEOUT_MS = 35_000;
/** Hop-by-hop headers (RFC 9110 §7.6.1) plus the loopback Host: not forwarded. */
const HOP_BY_HOP = [
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
];
/**
 * Response headers replayed verbatim. Everything the executor surface
 * can legitimately set is here: the JSON content type, `Allow` for a
 * 405, `Retry-After`, a redirect target, a challenge, and every
 * `Set-Cookie` (a bare `set-cookie` lookup would collapse a multi-cookie
 * response, so those are appended via getSetCookie()).
 */
const RELAYED_RESPONSE_HEADERS = [
  'content-type',
  'allow',
  'location',
  'retry-after',
  'www-authenticate',
];
/**
 * Forward one `/api/executor/*` request to the Go executor surface and
 * return its response. Called from each of the 15 `route.ts` shells.
 */
export async function forwardExecutor(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = `${UPSTREAM_ADDR}${url.pathname}${url.search}`;
  try {
    // Headers arrive as the browser sent them, minus the hop-by-hop
    // framing names of THIS loopback hop. `Cookie` (the one identity
    // input) and `Content-Type` are therefore forwarded unchanged.
    const headers = new Headers(request.headers);
    for (const name of HOP_BY_HOP) headers.delete(name);
    const body =
      request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The response is relayed as text so the body is byte-identical
    // (nothing is parsed or re-encoded); the status, content type and
    // Set-Cookie come with it.
    const out = new Headers();
    for (const name of RELAYED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
    return new Response(await upstream.text(), { status: upstream.status, headers: out });
  } catch (err) {
    // Unreachable listener, refused connection, DNS failure, a timed-out
    // body read or a failed relay: report the REAL reason and fail loud.
    const reason =
      err instanceof Error
        ? [err.message, (err.cause as Error | undefined)?.message]
            .filter((s): s is string => Boolean(s))
            .join(': ')
        : String(err);
    return NextResponse.json(
      { error: `executor unreachable: ${reason}`, upstream: target },
      { status: 502 },
    );
  }
}
