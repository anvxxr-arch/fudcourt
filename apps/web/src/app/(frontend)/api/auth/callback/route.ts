import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  SESSION_MAX_AGE,
  createSessionToken,
  type SessionUser,
} from '@/platform/auth/session';
import { isSafeNext, tierFromRoles } from '@/platform/auth/guard';

export const dynamic = 'force-dynamic';

// Discord OAuth2 callback: code -> token -> /users/@me -> guild member roles ->
// tier -> signed session cookie. Every failure path ends at /login?error=... with
// a coarse code; no token, secret or Discord payload is ever echoed into a
// response body, a URL or a log line.

const STATE_COOKIE = 'fud_oauth_state';
const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN_ENDPOINT = 'https://discord.com/api/oauth2/token';

type DiscordUser = { id: string; username: string; globalName: string | null; avatar: string | null };

function failure(origin: string, error: string, next: string): NextResponse {
  const login = new URL('/login', origin);
  login.searchParams.set('error', error);
  if (next !== '/') login.searchParams.set('next', next);
  return NextResponse.redirect(login.toString());
}

// Discord only ever redirects back to a registered URI, but `next` reaches us
// through the state cookie, so it is re-validated with the same predicate the
// login route applied before it can become a redirect target.
function safeNext(value: string | null | undefined): string {
  return isSafeNext(value) ? value : '/';
}

// The state cookie holds `${nonce}.${next}`: the callback only accepts a code
// whose nonce matches, which is what stops another app from feeding us a code it
// minted for itself.
function splitState(value: string | null | undefined): { state: string | null; next: string } {
  if (!value) return { state: null, next: '/' };
  const dot = value.indexOf('.');
  if (dot <= 0) return { state: null, next: '/' };
  return { state: value.slice(0, dot), next: safeNext(decodeURIComponent(value.slice(dot + 1))) };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const jar = await cookies();
  const expected = splitState(jar.get(STATE_COOKIE)?.value);
  const clearState = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 0 };

  const reject = (error: string): NextResponse => {
    const res = failure(origin, error, expected.next);
    res.cookies.set(STATE_COOKIE, '', clearState);
    return res;
  };

  if (url.searchParams.get('error')) return reject('discord_denied');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== expected.state) return reject('bad_state');

  const clientId = process.env.FUDCOURT_CLIENT_ID;
  const clientSecret = process.env.FUDCOURT_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return reject('auth_unconfigured');

  const token = await exchangeCode(code, clientId, clientSecret, redirectUri).catch(() => null);
  if (!token) return reject('token_exchange_failed');

  const profile = await fetchCurrentUser(token).catch(() => null);
  if (!profile) return reject('discord_api_failed');
  const roles = await fetchGuildRoles(profile.id);

  // `public` from tierFromRoles means the guild/role env is unset — a
  // successful OAuth identity is at least a member, never anonymous.
  const resolved = tierFromRoles(roles);
  const user: SessionUser = {
    id: profile.id,
    username: profile.username,
    globalName: profile.globalName,
    avatar: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : null,
    tier: resolved === 'public' ? 'member' : resolved,
    roles,
  };

  // No (or a too-short) FUDCOURT_SESSION_SECRET: refuse rather than mint a
  // session nobody can verify.
  let signed: string;
  try {
    signed = await createSessionToken(user, SESSION_MAX_AGE);
  } catch {
    return reject('session_secret_missing');
  }

  const res = NextResponse.redirect(new URL(expected.next, origin));
  res.cookies.set(STATE_COOKIE, '', clearState);
  res.cookies.set(SESSION_COOKIE, signed, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE });
  return res;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

async function exchangeCode(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`token exchange returned ${res.status}`);
  const body = await readJson(res);
  if (typeof body !== 'object' || body === null || !('access_token' in body)) {
    throw new Error('token response carried no access_token');
  }
  const { access_token } = body;
  if (typeof access_token !== 'string' || !access_token) throw new Error('token response had no access_token');
  return access_token;
}

// Discord payloads are untrusted input: every field the session depends on is
// type-checked before use, so a shape change degrades into a redirect instead
// of writing garbage into a signed cookie.
async function fetchCurrentUser(token: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`/users/@me returned ${res.status}`);
  const body = await readJson(res);
  if (typeof body !== 'object' || body === null) throw new Error('/users/@me returned a non-object body');
  const { id, username, global_name, avatar } = body as Record<string, unknown>;
  if (typeof id !== 'string' || !id || typeof username !== 'string' || !username) {
    throw new Error('/users/@me returned no id/username');
  }
  return {
    id,
    username,
    globalName: typeof global_name === 'string' ? global_name : null,
    avatar: typeof avatar === 'string' ? avatar : null,
  };
}

// Role ids are read with the bot token (the user OAuth grant covers
// /users/@me/guilds only). Missing guild/bot env, a non-member user, or an API
// error all yield an empty role list, which tiers down to `member` — the
// callback can neither crash nor escalate.
async function fetchGuildRoles(userId: string): Promise<string[]> {
  const guildId = process.env.FUDCOURT_GUILD_ID;
  const botToken = process.env.FUDCOURT_BOT_TOKEN;
  if (!guildId || !botToken) return [];
  const res = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bot ${botToken}` }, cache: 'no-store' },
  ).catch(() => null);
  if (!res || !res.ok) return [];
  const body = await readJson(res);
  if (typeof body !== 'object' || body === null || !('roles' in body)) return [];
  const { roles } = body;
  if (!Array.isArray(roles)) return [];
  return roles.flatMap(entry =>
    typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string' ? [entry.id] : [],
  );
}
