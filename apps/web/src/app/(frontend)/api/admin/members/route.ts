import { NextResponse } from 'next/server';
import { getSession } from '@/platform/auth/session';
import { hasTier, tierFromRoles } from '@/platform/auth/guard';
import { listGuildMembers, setMemberRole } from '@/platform/auth/discord';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Admin control plane: list guild members with their resolved tier, and
// grant/revoke the team and admin roles. Every path re-checks the admin tier
// server-side from the session cookie — the page's own gate is not the
// boundary, and no client-supplied identity is trusted. requireTier() is
// deliberately not used here: it throws a redirect, which is wrong for an API.

const ROLES: Record<'team' | 'admin', string | undefined> = {
  team: process.env.FUDCOURT_ROLE_TEAM,
  admin: process.env.FUDCOURT_ROLE_ADMIN,
};

async function isAdmin(): Promise<boolean> {
  return hasTier(await getSession(), 'admin');
}

export async function GET() {
  if (!await isAdmin()) {
    return NextResponse.json({ error: 'unauthorized', detail: 'requires admin tier' }, { status: 401 });
  }
  const members = await listGuildMembers();
  if (members === null) {
    return NextResponse.json(
      {
        error: 'discord_unavailable',
        detail: 'FUDCOURT_BOT_TOKEN / FUDCOURT_GUILD_ID are not set, or Discord refused the request',
      },
      { status: 503 },
    );
  }
  return NextResponse.json({
    members: members.map(m => ({
      id: m.id,
      username: m.username,
      globalName: m.globalName,
      avatar: m.avatar,
      tier: tierFromRoles(m.roleIds),
    })),
    roleIds: ROLES,
  });
}

export async function POST(req: Request) {
  if (!await isAdmin()) {
    return NextResponse.json({ error: 'unauthorized', detail: 'requires admin tier' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'bad_request', detail: 'JSON body required' }, { status: 400 });
  }
  const userId = 'userId' in body ? body.userId : null;
  const role = 'role' in body ? body.role : null;
  const action = 'action' in body ? body.action : null;

  if (typeof userId !== 'string' || !userId) {
    return NextResponse.json({ error: 'bad_request', detail: 'userId is required' }, { status: 400 });
  }
  if (role !== 'team' && role !== 'admin') {
    return NextResponse.json({ error: 'bad_request', detail: 'role must be team or admin' }, { status: 400 });
  }
  if (action !== 'add' && action !== 'remove') {
    return NextResponse.json({ error: 'bad_request', detail: 'action must be add or remove' }, { status: 400 });
  }
  const roleId = ROLES[role];
  if (!roleId) {
    return NextResponse.json(
      { error: 'discord_unconfigured', detail: `FUDCOURT_ROLE_${role.toUpperCase()} is not set` },
      { status: 503 },
    );
  }

  const result = await setMemberRole(userId, roleId, action);
  if (result.ok) return NextResponse.json({ ok: true, userId, role, action });
  return NextResponse.json(
    { error: 'discord_error', detail: result.error ?? 'Discord rejected the role change' },
    { status: 502 },
  );
}
