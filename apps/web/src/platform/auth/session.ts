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

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

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
