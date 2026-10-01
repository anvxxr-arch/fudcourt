import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, readSession } from '@/platform/auth/session';
import { hasTier, requiredTierForPath } from '@/platform/auth/guard';
import { checkInbound, clientKey, rateHeaders } from '@/platform/http/rate-limit-inbound';
// Route policy lives in @/platform/auth/guard.ts (single source of truth); this file only
// enforces it on the way in. The session cookie is HMAC-signed, so an unreadable
// or forged cookie is simply "no session" here — readSession never throws.
//
// Every `/api/*` request passes two checks, in this order:
//  1. the inbound rate limit (@/platform/http/rate-limit-inbound.ts) — a per-client budget
//     charged by the payload the route can serve, so one client cannot pull
//     921 KB twenty-five times a minute. A refusal is a 429 with Retry-After,
//     never an HTML page.
//  2. the tier gate (@/platform/auth/guard.ts) — a JSON 401 for a fetch caller.
// Order matters: an unauthorised flood is throttled like any other flood, and
// the session is read once for both checks (signed-in callers get a larger
// budget, not a free pass).
//
// Page paths are deliberately NOT rate limited. They are static/SSR shells with
// no upstream fan-out — every board's data arrives through the API calls above —
// so a per-IP page budget would only make a slow-loading tab fail, and would do
// it on a path an attacker cannot amplify. The surface this closes is API cost,
// which is measured; the absence of rate headers on a page is the record of the
// decision.
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const need = requiredTierForPath(pathname);
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  // Payload's API is rate-limited too (see `costForRequest`): it is the same
  // class of data-shaped endpoint, just served under the blog's prefix (DR-017).
  const isApi = pathname.startsWith('/api/') || pathname.startsWith('/blog/cms/api/');
  if (isApi) {
    const { key, scope } = clientKey(request.headers);
    const rate = checkInbound(key, pathname, {
      authed: session !== null,
      scope,
      params: request.nextUrl.searchParams,
    });
    const headers = rateHeaders(rate);
    if (!rate.allowed) {
      return NextResponse.json(
        {
          error: 'rate_limited',
          detail: `this client spent its ${rate.limit}-unit budget for the current ${rate.resetSeconds}s window`,
          retryAfterSeconds: rate.retryAfterSeconds,
        },
        { status: 429, headers: { ...headers, 'Retry-After': String(rate.retryAfterSeconds) } },
      );
    }
    // `need` is null on the public market routes and 'team' on the treasury
    // ones; hasTier(null, 'public') is true, so one branch covers both.
    if (!hasTier(session, need ?? 'public')) {
      return NextResponse.json(
        { error: 'unauthorized', detail: `requires ${need} tier` },
        { status: 401, headers },
      );
    }
    // Headers are set on the way through, so a caller can see its own budget
    // before a refusal ever happens.
    const pass = NextResponse.next();
    for (const [name, value] of Object.entries(headers)) pass.headers.set(name, value);
    return pass;
  }
  if (need === null) return NextResponse.next();
  if (hasTier(session, need)) return NextResponse.next();
  const login = new URL('/login', request.url);
  login.searchParams.set('next', pathname);
  return NextResponse.redirect(login);
}
export const config = {
  // The matcher is an OPTIMISATION, not the policy: @/platform/auth/guard.ts decides access
  // and @/platform/http/rate-limit-inbound.ts decides cost, and a request can only avoid
  // both by never reaching the middleware. `/api/:path*` is deliberately broad —
  // the limiter must see every API route, including ones the tier table does not
  // gate.
  //
  // `/blog/cms/api/:path*` was added by the DR-017 merge: Payload's REST and
  // GraphQL endpoints are data-acquisition-shaped `/api` routes that this
  // matcher's `/api/` prefix no longer covers, because they sit under the blog's
  // prefix. Leaving them out would have silently REMOVED Payload's API from the
  // inbound rate limit — a cost surface the limiter exists to price — so they are
  // matched here. They are NOT tier-gated (lib/guard.ts gates nothing under
  // /blog), which is correct: Payload enforces its own auth from the `users`
  // collection, and the public read path (`/blog/cms/api/posts`) must stay
  // reachable so the blog's own pages can render.
  matcher: [
    '/team/:path*',
    '/admin/:path*',
    '/member/:path*',
    '/executor/:path*',
    '/api/:path*',
    '/blog/cms/api/:path*',
  ],
};
