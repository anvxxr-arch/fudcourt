import { TIER_RANK, type SessionUser, type Tier } from '@/platform/auth/session';

// Tier gating on top of the signed session, in three layers:
// - `requiredTierForPath` is the single route policy, consumed by middleware.ts
//   before the request reaches a route, so an unauthenticated API call gets a
//   401 JSON body and an unauthenticated page hit gets a redirect — never HTML
//   for an API.
// - `hasTier` is the rank comparison shared by the middleware and `requireTier`.
// - `requireTier` is the server-component / route-handler entry point.

// Page prefixes and the API paths that carry treasury data, each with the tier
// required to reach it. `/member` is listed so it is enforced in middleware
// like the others, not only by the page's own requireTier() call.
const TIER_PAGES: Array<[string, Tier]> = [
  ['/team', 'team'],
  ['/admin', 'admin'],
  ['/member', 'member'],
  // CEX Executor (PRD §108): per-user BYOK trading controls — same tier as the
  // treasury surface it moves money beside. Ownership rows key on the session's
  // Discord id regardless (DR-020); this gate is reachability only.
  ['/executor', 'team'],
];
const TEAM_API_ROUTES = [
  '/api/all',
  '/api/wallets',
  '/api/coins',
  '/api/reconcile',
  '/api/transactions',
  '/api/executor',
];

function under(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

// null = public surface, no gate. This is the single route policy; the
// middleware matcher only narrows which requests reach it.
export function requiredTierForPath(pathname: string): Tier | null {
  for (const [base, tier] of TIER_PAGES) if (under(pathname, base)) return tier;
  for (const base of TEAM_API_ROUTES) if (under(pathname, base)) return 'team';
  return null;
}

export function hasTier(user: SessionUser | null, need: Tier): boolean {
  if (need === 'public') return true;
  return user !== null && TIER_RANK[user.tier] >= TIER_RANK[need];
}

// The post-login destination is attacker-supplied, so both ends of the OAuth
// round-trip run it through this one predicate (login puts the result in
// `state`, the callback re-checks before redirecting). Kept free of cookies,
// crypto and next/* so it is safe to import from the middleware bundle and
// directly testable.
//
// Accepts only a site-relative path: a leading `/`, never a second one (which
// would make the value protocol-relative, i.e. another host), no `..` (which
// would climb out of the intended prefix once the browser normalises the path),
// and no `?`, `#` or `%` (which would either smuggle in a second target or make
// the value ambiguous across the cookie + query round-trip). Plain paths also
// need no encode/decode on the way through the state cookie, so what the login
// route writes is byte-for-byte what the callback reads back.
export function isSafeNext(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  return !value.includes('..') && !/[?#%]/.test(value);
}

// Discord role ids -> tier. Pure apart from reading the guild/role env, so it
// is unit-testable and safe to call before any network call.
// admin > team > member; with no guild/role env there is nothing to resolve
// against and the answer is `public` (the OAuth callback maps that to `member`,
// because an authenticated account is never anonymous).
export function tierFromRoles(roleIds: string[]): Tier {
  const admin = process.env.FUDCOURT_ROLE_ADMIN;
  const team = process.env.FUDCOURT_ROLE_TEAM;
  if (!process.env.FUDCOURT_GUILD_ID || !admin || !team) return 'public';
  const roles = new Set(roleIds);
  if (roles.has(admin)) return 'admin';
  if (roles.has(team)) return 'team';
  return 'member';
}

// DOCUMENTED FAILURE MODE: on refusal this throws Next's redirect error (307 to
// `/login`), which Next converts into a real redirect from a server component,
// a server action or a route handler. It is deliberately not a thrown
// `Response`: Next's app-route handler only rescues redirect/access errors, so
// a thrown Response would surface as a 500. API handlers that want a JSON 401
// body use `getSession()` + `hasTier()` and build the response themselves —
// the middleware already answers protected API paths with 401 before a handler
// runs.
//
// `next/*` is imported dynamically so this module carries no framework import
// and can be bundled into the middleware entry alongside `readSession`.
export async function requireTier(need: Tier): Promise<SessionUser> {
  const { getSession } = await import('@/platform/auth/session');
  const user = await getSession();
  if (hasTier(user, need)) return user as SessionUser;
  const { redirect } = await import('next/navigation');
  redirect('/login');
}
