import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
/**
 * GET|POST /api/auth/logout — THIN PROXY to the Go api (services/api/cmd/api,
 * handleAuthLogout). The Go service does the real work: the session-cookie
 * retire (Set-Cookie maxAge 0) and the redirect home. This route forwards the
 * request and replays the upstream response VERBATIM — status, Location and
 * Set-Cookie — so `<a href>` and form callers keep the exact wire contract the
 * pre-migration route had. Redirects pass through with `redirect: 'manual'`.
 * Unreachable api is a loud 502 (house rule — never a fake 200).
 */
const FUDCOURT_API = process.env.FUDCOURT_API_URL ?? 'http://127.0.0.1:3103';

export const GET = proxy;
export const POST = proxy;

async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  // Forwarded verbatim: cookie (identity), content-type, x-request-id
  // (end-to-end correlation). Nothing else is an input.
  for (const name of ['cookie', 'content-type', 'x-request-id']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The Go listener only sees the loopback hop, so the public scheme/host ride
  // along (Go builds the redirect home from these).
  headers.set('x-forwarded-proto', request.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1));
  headers.set('x-forwarded-host', request.headers.get('x-forwarded-host') ?? url.host);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${FUDCOURT_API}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
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
