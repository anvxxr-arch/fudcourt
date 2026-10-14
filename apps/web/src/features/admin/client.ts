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

/** One stored moderation case, as the Go api returns it (snowflakes are strings). */
export type ModerationCase = {
  id: number;
  caseNumber: number;
  guildId: string;
  action: string;
  targetUserId: string;
  moderatorUserId: string;
  reason: string;
  durationSeconds?: number;
  source: string;
  status: string;
  createdAt: string;
  expiresAt?: string;
  updatedAt: string;
};

export type CasesQuery = { target?: string; number?: number; limit?: number };

/**
 * fetchCases reads the moderation-case log through the BFF proxy. The Go api
 * owns the admin-tier check; a refusal arrives as `detail` on the thrown error
 * (getJSON rejects on a non-2xx, mirroring the settings panel).
 */
export function fetchCases(q: CasesQuery = {}): Promise<{ cases?: ModerationCase[]; detail?: string }> {
  const params = new URLSearchParams();
  if (q.target) params.set('target', q.target);
  if (q.number !== undefined) params.set('number', String(q.number));
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  const qs = params.toString();
  return getJSON<{ cases?: ModerationCase[]; detail?: string }>(
    `/api/admin/moderation/cases${qs ? `?${qs}` : ''}`,
    { cache: 'no-store' },
  );
}

/**
 * One scheduler definition, mirroring apps/api's `scheduleDefinition` struct on the wire
 * (camelCase tags, snowflakes as strings). The WORKER owns `nextRunAt`, `lastRunAt`,
 * `lastStatus`, `lastError` and `attempts`: the panel reports them and never sends them
 * back. `nextRunAt` is absent on a spent `once` and on a `cron` nothing has anchored yet.
 */
export type ScheduleDefinition = {
  id: number;
  name: string;
  jobKind: string;
  scheduleKind: string;
  scheduleExpr: string;
  timezone: string;
  payload: Record<string, unknown>;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastError?: string;
  attempts: number;
  maxAttempts: number;
  /** Which panel writes this row, derived server-side from `jobKind`. */
  owner: string;
  /** `owner` in the form a control needs: a read-only row has no edit affordance, and
   *  sending it back is a guaranteed 409. */
  readOnly: boolean;
};

/** The writable subset the POST accepts — an operator's fields, nothing else. */
export type ScheduleWrite = Pick<
  ScheduleDefinition,
  'name' | 'jobKind' | 'scheduleKind' | 'scheduleExpr' | 'timezone' | 'payload' | 'enabled'
>;

export type SchedulerView = { definitions?: ScheduleDefinition[]; detail?: string };

export function fetchSchedules(): Promise<SchedulerView> {
  return getJSON<SchedulerView>('/api/admin/scheduler', { cache: 'no-store' });
}

/**
 * writableDefinitions is the write body's rule, in ONE place: only this panel's rows are
 * sent, and only the fields an operator owns.
 *
 * Sending a read-only row back would be a guaranteed 409 — the server derives ownership
 * from `job_kind` and the feeds' rows are not ours to write — and sending a worker column
 * (`nextRunAt`, `attempts`) would look like an edit this panel cannot make. Both are
 * dropped here rather than left to the server to ignore, because a body that contains a
 * field the server ignores is a lie about what the save does.
 *
 * `name`, `scheduleExpr` and `timezone` are trimmed: the stored name is trimmed too, so
 * "news " and "news" must not become two rows that collide on the next save.
 */
export function writableDefinitions(defs: ScheduleDefinition[]): ScheduleWrite[] {
  return defs
    .filter((d) => !d.readOnly)
    .map((d) => ({
      name: d.name.trim(),
      jobKind: d.jobKind,
      scheduleKind: d.scheduleKind,
      scheduleExpr: d.scheduleExpr.trim(),
      timezone: d.timezone.trim(),
      payload: d.payload ?? {},
      enabled: d.enabled,
    }));
}

export function saveSchedules(defs: ScheduleDefinition[]): Promise<SchedulerView> {
  return getJSON<SchedulerView>('/api/admin/scheduler', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ definitions: writableDefinitions(defs) }),
  });
}

