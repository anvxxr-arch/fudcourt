import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { isSafeNext } from '@/platform/auth/guard';

export const dynamic = 'force-dynamic';

// Starts the Discord OAuth2 flow (scopes: identify + guilds). The `state` is a
// per-attempt nonce parked in a short-lived httpOnly cookie: the callback only
// accepts a code whose state matches, which is what stops a third party from
// feeding us a code minted for another app.

const STATE_COOKIE = 'fud_oauth_state';
const STATE_TTL = 10 * 60; // 10 minutes — long enough for a Discord consent round-trip
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';

export async function GET(request: Request) {
  const clientId = process.env.FUDCOURT_CLIENT_ID;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: 'auth_unconfigured', detail: 'FUDCOURT_CLIENT_ID and DISCORD_REDIRECT_URI must be set' },
      { status: 500 },
    );
  }

  // 32 bytes of CSPRNG entropy, hex encoded. Web Crypto rather than node:crypto
  // so this route shares one signing story with lib/auth.ts.
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

  // Carry the post-login destination through the round-trip: it is not a secret,
  // but it is attacker-supplied, so it rides inside the opaque state cookie
  // instead of a query parameter Discord would have to echo back. The callback
  // re-checks it with the same predicate before it is ever redirected to.
  const rawNext = new URL(request.url).searchParams.get('next');
  const state = `${nonce}.${isSafeNext(rawNext) ? rawNext : '/'}`;

  (await cookies()).set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_TTL,
  });

  const authorize = new URL(DISCORD_AUTHORIZE);
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('scope', 'identify guilds');
  authorize.searchParams.set('state', state);

  return NextResponse.redirect(authorize.toString());
}
