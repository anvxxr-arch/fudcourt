import { getJSON } from '@/lib/fetch';

export type MemberRow = {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  tier: string;
};

export type MemberRole = 'team' | 'admin';
export type MemberAction = 'add' | 'remove';

export function fetchMembers(): Promise<{ members?: MemberRow[]; detail?: string }> {
  return getJSON<{ members?: MemberRow[]; detail?: string }>('/api/admin/members', { cache: 'no-store' });
}

export function setMemberRole(userId: string, role: MemberRole, action: MemberAction): Promise<{ detail?: string }> {
  return getJSON<{ detail?: string }>('/api/admin/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, role, action }),
  });
}

/** The admin-editable Discord wiring (DB-backed, env is only the default). */
export type DiscordConfig = {
  guildId: string;
  roleAdmin: string;
  roleTeam: string;
  roleMagang: string;
};

/** One guild role for the pickers; managed roles cannot be assigned by hand. */
export type DiscordRole = {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
};

export type AdminSettings = {
  config?: DiscordConfig;
  defaults?: DiscordConfig;
  roles?: DiscordRole[];
  configured?: boolean;
  detail?: string;
};

export function fetchSettings(): Promise<AdminSettings> {
  return getJSON<AdminSettings>('/api/admin/settings', { cache: 'no-store' });
}

export function saveSettings(
  config: Partial<DiscordConfig>,
): Promise<{ ok?: boolean; config?: DiscordConfig; detail?: string }> {
  return getJSON<{ ok?: boolean; config?: DiscordConfig; detail?: string }>('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}
