import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
/**
 * GET /api/auth/callback — THIN PROXY to the Go api (backend/api/cmd/api,
 * handleAuthCallback). The Go service does the real work: state comparison,
 * the code->token->/users/@me->guild-roles exchange, tier resolution and the
 * signed session cookie. This route forwards the request and replays the
 * upstream response VERBATIM — status, body, Location and Set-Cookie — so the
 * OAuth round-trip keeps the exact wire contract the pre-migration route had.
 *
 * The Cookie header (the parked OAuth state) travels to Go untouched and is
 * the ONLY state input: the proxy never parses it. Redirects pass through
 * with `redirect: 'manual'` so the 307s are never rewritten. Unreachable api
 * is a loud 502 (house rule — never a fake 200).
 */
const FUDCOURT_API = process.env.FUDCOURT_API_URL ?? 'http://127.0.0.1:3103';

export const GET = proxy;

async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  // Forwarded verbatim: cookie (identity + OAuth state), content-type,
  // x-request-id (end-to-end correlation). Nothing else is an input.
  for (const name of ['cookie', 'content-type', 'x-request-id']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The Go listener only sees the loopback hop, so the public scheme/host ride
  // along (Go builds the post-login and failure redirects from these).
  headers.set('x-forwarded-proto', request.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1));
  headers.set('x-forwarded-host', request.headers.get('x-forwarded-host') ?? url.host);
  let upstream: Response;
  try {
    upstream = await fetch(`${FUDCOURT_API}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (err) {
    const reason =
      err instanceof Error
        ? [err.message, (err.cause as Error | undefined)?.message].filter((s): s is string => Boolean(s)).join(': ')
        : String(err);
    return NextResponse.json({ error: `api unreachable: ${reason}` }, { status: 502 });
  }
  const out = new Headers();
  for (const name of ['content-type', 'location', 'allow', 'x-request-id', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  const cookieHeaders = upstream.headers as Headers & { getSetCookie?: () => string[] };
  for (const cookie of cookieHeaders.getSetCookie?.() ?? []) out.append('set-cookie', cookie);
  return new NextResponse(await upstream.text(), { status: upstream.status, headers: out });
}
