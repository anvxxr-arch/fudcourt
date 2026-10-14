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

/**
 * One feed source, mirroring apps/api's `feedSource` struct on the wire (camelCase,
 * snowflakes as strings). The WORKER owns `primed`, `owed`, `consecutiveFailures`,
 * `lastStatus` and `lastError`: the panel reports the health and never sends it back.
 *
 * `pollIntervalSecs` is not a column either — the api reads it from the source's `feed.poll`
 * `scheduled_jobs` row, which is the same definition the SCHEDULER panel shows read-only as
 * owned by this panel.
 */
export type FeedSource = {
  id: number;
  name: string;
  url: string;
  adapter: string;
  channelId: string;
  message: string;
  mentionRoleId?: string | null;
  includeText?: string | null;
  excludeText?: string | null;
  enabled: boolean;
  pollIntervalSecs: number;
  primed: boolean;
  owed: number;
  consecutiveFailures: number;
  lastStatus?: string | null;
  lastError?: string | null;
};

/** The writable subset the POST accepts — an operator's fields, nothing else. `id` is not
 *  among them: the store keys the list on `name`, so an id in the body would name a row this
 *  save does not address. (The api zeroes it for the same reason.) */
export type FeedWrite = Pick<
  FeedSource,
  | 'name'
  | 'url'
  | 'adapter'
  | 'channelId'
  | 'message'
  | 'mentionRoleId'
  | 'includeText'
  | 'excludeText'
  | 'enabled'
  | 'pollIntervalSecs'
>;

export type FeedsView = { feeds?: FeedSource[]; detail?: string };

export function fetchFeeds(): Promise<FeedsView> {
  return getJSON<FeedsView>('/api/admin/feeds', { cache: 'no-store' });
}

/**
 * writableFeeds is the write body's rule, in ONE place: an operator's fields only.
 *
 * Unlike `writableDefinitions` there is no ownership FILTER here — the feeds panel owns the
 * whole feed set, and the scheduler's read-only rows are `feed.poll` DEFINITIONS, not sources.
 * So this is a projection, not a filter. What it does drop is the poller's report (`primed`,
 * `owed`, `consecutiveFailures`, `lastStatus`, `lastError`), rather than leaving it for the
 * server to zero: a body carrying the poller's own report is a lie about what the save does.
 *
 * `name` and `url` are trimmed because the api trims them before storing, so "news " and
 * "news" must not collide on the next save. `message` is NOT trimmed: it is a template, the
 * api stores it verbatim, and whitespace in it may be deliberate. The three optional fields
 * become `null` rather than "" — that is the wire's own "no value", and the api stores both
 * as NULL, so the panel sends the honest one.
 */
export function writableFeeds(feeds: FeedSource[]): FeedWrite[] {
  return feeds.map((f) => ({
    name: f.name.trim(),
    url: f.url.trim(),
    adapter: f.adapter,
    channelId: f.channelId,
    message: f.message,
    mentionRoleId: blankToNull(f.mentionRoleId),
    includeText: blankToNull(f.includeText),
    excludeText: blankToNull(f.excludeText),
    enabled: f.enabled,
    pollIntervalSecs: f.pollIntervalSecs,
  }));
}

/** blankToNull is the optional-field mapping: absent, null and whitespace all mean "not set". */
function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function saveFeeds(feeds: FeedSource[]): Promise<FeedsView> {
  return getJSON<FeedsView>('/api/admin/feeds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feeds: writableFeeds(feeds) }),
  });
}

