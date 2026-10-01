import { NextResponse } from 'next/server';
import { getSession, type Tier } from '@/platform/auth/session';
import { hasTier } from '@/platform/auth/guard';

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
