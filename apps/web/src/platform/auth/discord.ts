// Discord REST helpers shared by the OAuth callback and the admin control
// panel. The bot token never leaves the server: every helper returns
// normalised data or an empty/typed result, never a raw Discord payload, so
// no caller can accidentally serialise a token or an upstream error body.

const DISCORD_API = 'https://discord.com/api/v10';

export type DiscordMember = {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  roleIds: string[];
};

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function discordConfigured(): boolean {
  return Boolean(process.env.FUDCOURT_BOT_TOKEN && process.env.FUDCOURT_GUILD_ID);
}

/**
 * Read a guild member's role ids with the bot token (the user OAuth grant only
 * covers /users/@me/guilds). Missing env, a non-member, or an API failure all
 * yield an empty list — the caller tiers down rather than escalating.
 */
export async function fetchGuildRoleIds(userId: string): Promise<string[]> {
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

/** List every member of the configured guild, or null when unavailable. */
export async function listGuildMembers(limit = 100): Promise<DiscordMember[] | null> {
  const guildId = process.env.FUDCOURT_GUILD_ID;
  const botToken = process.env.FUDCOURT_BOT_TOKEN;
  if (!guildId || !botToken) return null;
  const res = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/members?limit=${limit}`,
    { headers: { Authorization: `Bot ${botToken}` }, cache: 'no-store' },
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const body = await readJson(res);
  if (!Array.isArray(body)) return null;
  return body.flatMap((entry): DiscordMember[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    if (!('user' in entry) || !('roles' in entry)) return [];
    const { user, roles } = entry;
    if (typeof user !== 'object' || user === null) return [];
    if (!('id' in user) || typeof user.id !== 'string') return [];
    const avatar = 'avatar' in user ? user.avatar : null;
    const globalName = 'global_name' in user ? user.global_name : null;
    const username = 'username' in user ? user.username : null;
    return [{
      id: user.id,
      username: typeof username === 'string' ? username : user.id,
      globalName: typeof globalName === 'string' ? globalName : null,
      avatar: typeof avatar === 'string' ? avatar : null,
      roleIds: Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [],
    }];
  });
}

/**
 * Add or remove a role on a member. Discord requires the bot to hold the role
 * and the Manage Roles permission; both failures are reported as an error
 * string rather than an exception, so the panel can render the reason.
 */
export type RoleResult = { ok: boolean; error?: string };

export async function setMemberRole(
  userId: string,
  roleId: string,
  action: 'add' | 'remove',
): Promise<RoleResult> {
  const guildId = process.env.FUDCOURT_GUILD_ID;
  const botToken = process.env.FUDCOURT_BOT_TOKEN;
  if (!guildId || !botToken) return { ok: false, error: 'Discord is not configured' };
  const member = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bot ${botToken}` }, cache: 'no-store' },
  ).catch(() => null);
  if (!member || !member.ok) return { ok: false, error: 'Could not read that guild member' };
  const body = await readJson(member);
  const memberRoles =
    typeof body === 'object' && body !== null && 'roles' in body && Array.isArray(body.roles)
      ? body.roles.filter((r): r is string => typeof r === 'string')
      : [];
  const alreadySet = memberRoles.includes(roleId);
  const next = action === 'add'
    ? alreadySet ? memberRoles : [...memberRoles, roleId]
    : memberRoles.filter(r => r !== roleId);
  if (action === 'add' ? alreadySet : !alreadySet) return { ok: true };
  const res = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: next }),
    },
  ).catch(() => null);
  if (!res || !res.ok) {
    const detail = res ? await readJson(res) : null;
    const message =
      typeof detail === 'object' && detail !== null && 'message' in detail && typeof detail.message === 'string'
        ? detail.message
        : `Discord returned ${res ? res.status : 'no response'}`;
    return { ok: false, error: message };
  }
  return { ok: true };
}
