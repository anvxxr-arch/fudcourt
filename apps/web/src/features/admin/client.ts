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
