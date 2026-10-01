import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
/**
 * GET|POST /api/admin/members — THIN PROXY to the Go api (services/api/cmd/api,
 * handleAdminMembers). The Go service does the real work: the admin tier check
 * from the signed session cookie (never a client-supplied identity), the guild
 * member listing and the role grant/revoke. This route forwards the request
 * and replays the upstream response VERBATIM — status, body and headers — so
 * the admin surface keeps the exact wire contract the pre-migration route had
 * (consumers read `body.detail` on refusals and `{members, roleIds}` /
 * `{ok, userId, role, action}` on success).
 *
 * The Cookie header travels to Go untouched and is the ONLY identity input:
 * the proxy holds no auth logic at all. The POST body is forwarded
 * byte-for-byte. Unreachable api is a loud 502 (house rule — never a fake 200).
 */
const FUDCOURT_API = process.env.FUDCOURT_API_URL ?? 'http://127.0.0.1:3103';

export const GET = proxy;
export const POST = proxy;

async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  // Forwarded verbatim: cookie (identity), content-type (the JSON body),
  // x-request-id (end-to-end correlation). Nothing else is an input.
  for (const name of ['cookie', 'content-type', 'x-request-id']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The Go listener only sees the loopback hop, so the public scheme/host ride
  // along.
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
