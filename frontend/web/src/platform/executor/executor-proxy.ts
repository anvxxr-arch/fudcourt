/**
 * executor-proxy.ts — the ONE switch that decides which backend serves
 * `/api/executor/*`, and the forwarder used when it says Go.
 *
 * THE GATE (objective §52, cutover step). Every one of the 15 executor route
 * handlers begins with `if (executorProxyEnabled()) return proxyExecutorRequest(req)`,
 * so the decision lives in exactly one place and no request can pick a backend
 * implicitly:
 *
 *   FUDCOURT_EXECUTOR_PROXY = 'go'  → forward the whole request to the Go
 *                                    executor surface (the cutover).
 *   unset, '' or anything else      → the TypeScript runtime serves the request,
 *                                    exactly as it did before this module existed.
 *
 * Only the exact string 'go' turns the forward on. There is deliberately no
 * 'auto', no reachability probe and no first-success memo: a request must never
 * choose its backend from anything but this one operator-set value, because a
 * silent per-request flip would serve one client's state from a different
 * process than the next client's.
 *
 * WHY THE AUTH CALL IS SKIPPED ON THE FORWARD PATH. The Go surface
 * (`backend/workers/executor/internal/api`) verifies the SAME signed session
 * cookie from the SAME `FUDCOURT_SESSION_SECRET` (DR-035) and answers the
 * byte-identical 401. If this module pre-authenticated and then forwarded
 * anyway, there would be two authorities and the Go side's own refusal would be
 * unreachable; instead the `Cookie` header travels through untouched and the Go
 * surface is the single authority for session, tier and ownership. No identity
 * header is ever minted, rewritten or injected — a proxy-supplied identity is
 * spoofable, which is precisely why the Go side trusts only the signed cookie.
 *
 * NEVER FALL BACK. When the gate is 'go' and the upstream is unreachable — the
 * unit is not provisioned yet, the listener died, the loopback hop timed out —
 * this module answers a loud 502 naming the real reason. It does NOT run the TS
 * runtime as a consolation: mid-request that would swap one backend's committed
 * state for another's (a row the Go store just wrote is invisible to the TS
 * `store.ts` connection and vice versa), which is the failure mode the house
 * refuses. Same rule as `api/reconcile/route.ts`.
 *
 * The forward is faithful: method, path, query string, headers and body go
 * through unchanged, and the upstream status/body/content-type come back with
 * the envelopes intact — the Go surface already emits byte-shaped TS
 * envelopes (`internal/api/routes_test.go`, 29 tests), so nothing here
 * re-shapes, re-parses or interprets a body.
 */
import { NextResponse } from 'next/server';

/**
 * Loopback address of the Go executor surface. Mirrors the Go side's own
 * default (`backend/workers/executor/cmd/executor/api.go`: FUDCOURT_EXECUTOR_API_ADDR,
 * default 127.0.0.1:3105) and the `Environment=` pin in
 * `infrastructure/systemd/fudcourt-executor.service`. Documented in
 * `frontend/web/.env.example` under the executor-process block.
 */
const DEFAULT_UPSTREAM_ADDR = '127.0.0.1:3105';

/**
 * Bound the loopback hop to the Go executor surface. The Go listener's own
 * WriteTimeout is 30 s, so a hang past that means the executor itself is stuck;
 * aborting at 35 s turns an unbounded pin of this worker into the loud 502 the
 * catch below already emits (never a silent TS fallback -- see the module head).
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
 * Response headers replayed verbatim. Everything the executor surface can
 * legitimately set is here: the JSON content type, `Allow` for a 405,
 * `Retry-After`, a redirect target, a challenge, and every `Set-Cookie` (a
 * bare `set-cookie` lookup would collapse a multi-cookie response, so those are
 * appended via getSetCookie()).
 */
const RELAYED_RESPONSE_HEADERS = [
  'content-type',
  'allow',
  'location',
  'retry-after',
  'www-authenticate',
];

/**
 * The gate. Read from `process.env` on every call (a route handler is
 * `force-dynamic`, and the web tier's other env reads — e.g. session.ts,
 * runtime.ts — work the same way), so a restart picks up a flip.
 */
export function executorProxyEnabled(): boolean {
  return process.env.FUDCOURT_EXECUTOR_PROXY === 'go';
}

/** The upstream base URL, from FUDCOURT_EXECUTOR_API_ADDR (an address or a URL). */
function upstreamBase(): string {
  const raw = (process.env.FUDCOURT_EXECUTOR_API_ADDR ?? '').trim();
  const address = raw === '' ? DEFAULT_UPSTREAM_ADDR : raw;
  return /^https?:\/\//i.test(address) ? address : `http://${address}`;
}

/**
 * Forward one `/api/executor/*` request to the Go executor surface and return
 * its response. Call ONLY when `executorProxyEnabled()` is true.
 */
export async function proxyExecutorRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = `${upstreamBase()}${url.pathname}${url.search}`;
  try {
    // Headers arrive as the browser sent them, minus the hop-by-hop framing
    // names of THIS loopback hop. `Cookie` (the one identity input) and
    // `Content-Type` are therefore forwarded unchanged.
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
    // The response is relayed as text so the body is byte-identical (nothing is
    // parsed or re-encoded); the status, content type and Set-Cookie come with it.
    const out = new Headers();
    for (const name of RELAYED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
    return new Response(await upstream.text(), { status: upstream.status, headers: out });
  } catch (err) {
    // Unreachable listener, refused connection, DNS failure, a timed-out body
    // read or a failed relay: report the REAL reason and fail loud. There is
    // deliberately no TS fallback here — see the module header.
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
