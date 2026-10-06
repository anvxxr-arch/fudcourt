import { NextResponse } from 'next/server';
import { publicOrigin } from '../../_lib/http';


export const dynamic = 'force-dynamic';
/**
 * GET /api/auth/login — THIN PROXY to the Go api (apps/api/cmd/api,
 * handleAuthLogin). The Go service does the real work: the OAuth state nonce,
 * the `next` open-redirect filter (identity.IsSafeNext) and the Discord
 * authorize redirect. This route forwards the request and replays the
 * upstream response VERBATIM — status, body, Location and Set-Cookie — so the
 * public surface keeps the exact wire contract the pre-migration route had.
 *
 * The Cookie header travels to Go untouched and is the ONLY identity input:
 * the proxy never reads it, never trusts a header identity, and never
 * re-implements a decision. Redirects pass through with `redirect: 'manual'`
 * so the 307 is never rewritten. Unreachable api is a loud 502 (house rule —
 * never a fake 200).
 *
 * Graceful degradation (r8): when Go reports `auth_unconfigured` (owner has
 * not set Discord OAuth env), a raw JSON 500 on a CTA click reads as broken.
 * Bounce back to /login instead, where the panel already renders the
 * auth_unconfigured message plus the browse-first link. The `next` value is
 * re-validated by the login panel's isSafeNext, so no open redirect is added.
 */
const FUDCOURT_API = process.env.FUDCOURT_API_URL ?? 'http://127.0.0.1:3103';

/**
 * Bound the loopback hop. The Go listener's own WriteTimeout is 30 s, so a hang
 * past that means the api itself is stuck; aborting at 35 s turns an unbounded
 * pin of this worker into the same loud 502 the catch below already emits.
 */
const TIMEOUT_MS = 35_000;

export const GET = proxy;

async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  // Forwarded verbatim: cookie (identity), content-type (POST bodies),
  // x-request-id (end-to-end correlation). Nothing else is an input.
  for (const name of ['cookie', 'content-type', 'x-request-id']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The Go listener only sees the loopback hop, so the public scheme/host ride
  // along (Go builds post-login redirects from these).
  const { scheme, host } = publicOrigin(url);
  headers.set('x-forwarded-proto', scheme);
  headers.set('x-forwarded-host', host);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${FUDCOURT_API}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error
        ? [err.message, (err.cause as Error | undefined)?.message].filter((s): s is string => Boolean(s)).join(': ')
        : String(err);
    return NextResponse.json({ error: `api unreachable: ${reason}` }, { status: 502 });
  }
  const text = await upstream.text();
  if (upstream.status === 500 && text.includes('"auth_unconfigured"')) {
    const params = new URLSearchParams({ error: 'auth_unconfigured' });
    const next = url.searchParams.get('next');
    if (next !== null && next !== '' && next !== '/') params.set('next', next);
    return new NextResponse(null, { status: 303, headers: { location: '/login?' + params } });
  }
  const out = new Headers();
  for (const name of ['content-type', 'location', 'allow', 'x-request-id', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  const cookieHeaders = upstream.headers as Headers & { getSetCookie?: () => string[] };
  for (const cookie of cookieHeaders.getSetCookie?.() ?? []) out.append('set-cookie', cookie);
  return new NextResponse(text, { status: upstream.status, headers: out });
}
