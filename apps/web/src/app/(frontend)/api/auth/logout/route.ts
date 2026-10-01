import { NextResponse } from 'next/server';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '@/platform/auth/session';

export const dynamic = 'force-dynamic';

// Drops the signed session cookie by overwriting it with the same attributes and
// maxAge 0 — a `delete` on the request store would be redundant, the outgoing
// Set-Cookie is what actually retires it in the browser. GET and POST both work
// so a plain <a href> and a form button share one endpoint.

function logout(request: Request): NextResponse {
  const res = NextResponse.redirect(new URL('/', request.url));
  res.cookies.set(SESSION_COOKIE, '', { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
  return res;
}

export async function GET(request: Request) {
  return logout(request);
}

export async function POST(request: Request) {
  return logout(request);
}
