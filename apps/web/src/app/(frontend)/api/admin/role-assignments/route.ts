import { NextResponse } from 'next/server';
import { publicOrigin } from '../../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
/**
 * GET /api/admin/role-assignments — THIN PROXY to the Go api (apps/api,
 * handleAdminRoleAssignments). The Go service owns everything: the admin tier
 * check from the signed session cookie and the `role_assignments` read (newest
 * first, `limit` 1..200). This route forwards the request and replays the
 * upstream response VERBATIM — status, body and headers — so the dashboard reads
 * the exact wire contract (`{assignments: [...]}` on success, `body.detail` on a
 * refusal).
 *
 * The Cookie header is the ONLY identity input; the proxy holds no auth logic.
 * Unreachable api is a loud 502 (house rule — never a fake 200).
 */
const FUDCOURT_API = process.env.FUDCOURT_API_URL ?? 'http://127.0.0.1:3103';
const TIMEOUT_MS = 35_000;

export const GET = proxy;

async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of ['cookie', 'content-type', 'x-request-id']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
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
  const out = new Headers();
  for (const name of ['content-type', 'location', 'allow', 'x-request-id', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  const cookieHeaders = upstream.headers as Headers & { getSetCookie?: () => string[] };
  for (const cookie of cookieHeaders.getSetCookie?.() ?? []) out.append('set-cookie', cookie);
  return new NextResponse(await upstream.text(), { status: upstream.status, headers: out });
}
