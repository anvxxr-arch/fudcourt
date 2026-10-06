import 'server-only';
import { cookies } from 'next/headers';

// Discord OAuth session spine (R-9). No auth dependency is installed, so the
// session is a self-contained HMAC-SHA256 signed cookie:
//   base64url(payload).base64url(hmac), payload = SessionUser + `exp`.
// Every secret is read from process.env (server-only, never NEXT_PUBLIC_).
// Fail-closed: without a FUDCOURT_SESSION_SECRET of at least 32 chars there is
// no session at all — reads return null and signing refuses, so a missing or
// truncated secret can never degrade into unsigned/forgeable cookies.
//
// The HMAC uses the Web Crypto API rather than node:crypto on purpose: this
// module is imported by the request middleware, which Next 16 compiles for the
// Edge runtime, and node:crypto is not available there. `readSession` is
// therefore async, and `timingSafeEqual` is its constant-time counterpart on
// the raw bytes (Node's `crypto.timingSafeEqual` is unavailable in the Edge
// runtime for the same reason).

export type Tier = 'public' | 'member' | 'team' | 'admin';

export const TIER_RANK: Record<Tier, number> = { public: 0, member: 1, team: 2, admin: 3 };

export type SessionUser = {
  id: string;            // Discord user snowflake
  username: string;      // Discord unique handle
  globalName: string | null;
  avatar: string | null; // resolved CDN url, null when the account has no avatar
  tier: Tier;
  roles: string[];       // raw Discord role ids held in FUDCOURT_GUILD_ID
};

export const SESSION_COOKIE = 'fud_session';

export const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, matches the cookie maxAge

// Shared by login/callback/logout so all three emit byte-identical attributes.
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

export function sessionSecret(): string | null {
  const secret = process.env.FUDCOURT_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function encodeBase64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64url');
}

// Constant-time string comparison, byte for byte. A length mismatch is not a
// secret leak here (the signature length is fixed by the algorithm) and cannot
// be handled by the usual short-circuit, so it fails immediately.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function hmacBase64Url(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(secret, 'utf8'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return encodeBase64Url(await crypto.subtle.sign('HMAC', key, Buffer.from(payload, 'utf8')));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((r: unknown): r is string => typeof r === 'string') : [];
}

function tierOrNull(value: unknown): Tier | null {
  return typeof value === 'string' && TIER_RANK[value as Tier] !== undefined ? (value as Tier) : null;
}

type SessionClaims = SessionUser & { exp: number };

// Parse once at the boundary: anything not matching the SessionUser contract
// (missing id/username/exp, non-numeric exp, unknown tier) is not a session.
function parseClaims(payload: string): SessionClaims | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const c = raw as Partial<Record<keyof SessionClaims, unknown>>;
  const tier = tierOrNull(c.tier);
  if (typeof c.id !== 'string' || typeof c.username !== 'string') return null;
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) return null;
  if (tier === null) return null;

  return {
    id: c.id,
    username: c.username,
    globalName: typeof c.globalName === 'string' ? c.globalName : null,
    avatar: typeof c.avatar === 'string' ? c.avatar : null,
    tier,
    roles: stringArray(c.roles),
    exp: c.exp,
  };
}

export async function createSessionToken(
  user: SessionUser,
  ttlSeconds: number = SESSION_MAX_AGE,
): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error('FUDCOURT_SESSION_SECRET is missing or shorter than 32 characters');
  const payload = Buffer.from(
    JSON.stringify({ ...user, roles: stringArray(user.roles), exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${await hmacBase64Url(secret, payload)}`;
}

// Any parse, shape, signature or expiry failure means "no session": a forged or
// stale cookie degrades to anonymous instead of throwing at the client.
export async function readSession(value?: string | null): Promise<SessionUser | null> {
  const secret = sessionSecret();
  if (!secret || !value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), await hmacBase64Url(secret, payload))) return null;

  const claims = parseClaims(payload);
  if (!claims || claims.exp * 1000 <= Date.now()) return null;

  const { exp: _exp, ...user } = claims;
  return user;
}

export async function getSession(): Promise<SessionUser | null> {
  try {
    const store = await cookies();
    return await readSession(store.get(SESSION_COOKIE)?.value);
  } catch {
    return null;
  }
}

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
// `state`, the callback re-checks before redirecting). Pure string check, no
// cookies/crypto/next imports, so it is safe to call anywhere server-side.
// Accepts only a site-relative path: a leading `/`, never a second one (which
// would make the value protocol-relative, i.e. another host), no `..` (which
// would climb out of the intended prefix once the browser normalises the path),
// and no `?`, `#` or `%` (which would either smuggle in a second target or make
// the value ambiguous across the cookie + query round-trip). No backslash:
// browsers treat '\\' as '/' during URL parsing, so `/\evil.example` would
// otherwise normalize to the protocol-relative `//evil.example`. Any value
// whose percent-decoded + backslash-normalized form begins with `//` is
// refused too — the exact same predicate identity.IsSafeNext implements.
export function isSafeNext(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  if (value.includes('..')) return false;
  if (/[?#%]/.test(value)) return false;
  if (value.includes('\\')) return false;
  let decoded = value;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A malformed decode leaves the value as-is; the checks above still apply.
  }
  if (decoded.replaceAll('\\', '/').startsWith('//')) return false;
  return true;
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
  const user = await getSession();
  if (hasTier(user, need)) return user as SessionUser;
  const { redirect } = await import('next/navigation');
  redirect('/login');
}

import { NextResponse } from 'next/server';

// Mutation auth (NFR-4, R-6): write methods are fail-closed on the signed
// Discord session, replacing the retired `x-fud-token` header.
//
// Why the token is gone: NEXT_PUBLIC_FUD_MUTATION_TOKEN was inlined at build
// time, so the value shipped verbatim inside a public JS chunk — anyone who
// viewed source held full write access to wallets and transactions. The
// session cookie is httpOnly and never reaches the client bundle, so it
// cannot be exfiltrated that way.
//
//   const denied = await requireMutationAuth(req, 'team');
//   if (denied) return denied;
//
// Reads are gated separately by lib/guard.ts (requiredTierForPath), which
// middleware.ts enforces before a handler runs. A write that slips past
// middleware still has to pass here, because this check is server-side and
// reads the cookie directly rather than trusting any client-supplied header.
export async function requireMutationAuth(req: Request, need: Tier = 'team'): Promise<NextResponse | null> {
  const user = await getSession();
  if (hasTier(user, need)) return null;
  return NextResponse.json(
    {
      error: 'unauthorized',
      detail: user
        ? `requires ${need} tier (session is ${user.tier})`
        : `requires ${need} tier (no session)`,
    },
    { status: 401 },
  );
}
