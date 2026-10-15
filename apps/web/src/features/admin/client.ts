import { getJSON } from '@/lib/fetch';
import type { AutoroleRule } from './autorole-select';
import type { AutoroleWrite } from './autoroles-draft';

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

/**
 * The welcome/goodbye config, mirroring `apps/api/community.go`'s `welcomeConfig` on the wire. One
 * row per guild; GET answers `{welcome: ... | null}`, and null means "never configured" — the panel
 * shows an untouched form for that, not an error.
 *
 * The embeds are `object | null` HERE and `jsonb` there, and that difference is load-bearing: the
 * api validates their shape on write (`validateEmbed`), so an object this type accepts is one the
 * bot's renderer can walk without throwing.
 */
export type WelcomeConfig = {
  joinEnabled: boolean;
  joinChannelId: string;
  joinMessage: string;
  joinEmbed?: Record<string, unknown> | null;
  joinDm: boolean;
  joinDmMessage: string;
  leaveEnabled: boolean;
  leaveChannelId: string;
  leaveMessage: string;
  leaveEmbed?: Record<string, unknown> | null;
};

export type WelcomeView = { welcome?: WelcomeConfig | null; detail?: string; ok?: boolean };

/**
 * The autorole set, as the api puts it on the wire: GET answers `{autoroles}`, POST takes
 * `{autoroles}` and answers `{ok, autoroles}`. The write shape is the rule WITHOUT `id` — the api
 * deletes and re-inserts every rule, so the id it last reported is gone either way, and sending it
 * back would imply a column the write path does not read.
 */
export type AutoroleView = { autoroles?: AutoroleRule[]; ok?: boolean; detail?: string };

export function fetchAutoroles(): Promise<AutoroleView> {
  return getJSON<AutoroleView>('/api/admin/autoroles', { cache: 'no-store' });
}

export function saveAutoroles(rules: AutoroleWrite[]): Promise<AutoroleView> {
  return getJSON<AutoroleView>('/api/admin/autoroles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoroles: rules }),
  });
}

export function fetchWelcome(): Promise<WelcomeView> {
  return getJSON<WelcomeView>('/api/admin/welcome', { cache: 'no-store' });
}

/**
 * saveWelcome posts the config DIRECTLY, where the scheduler and feeds endpoints wrap their list in
 * a key. That is the wire, not a slip: wrapping it here would put a second shape between the panel
 * and the api, and the shape the api documents is the one it validates.
 */
export function saveWelcome(config: WelcomeConfig): Promise<WelcomeView> {
  return getJSON<WelcomeView>('/api/admin/welcome', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

/**
 * One attempted role grant or revoke, INCLUDING failures — an append-only record the bot writes over
 * loopback (apps/discord-bot/src/community/roles.ts records every attempt, refused or not). `id` is
 * the api's own row id and, unlike an autorole rule's, it is stable: nothing rewrites this table.
 *
 * `error` is absent on a success (`omitempty` on the Go side), and when it is present it is the
 * recorder's own sentence — a hierarchy refusal, a Discord error, or a failed hierarchy lookup.
 */
export type RoleAssignment = {
  id: number;
  userId: string;
  roleId: string;
  action: 'add' | 'remove';
  source: string;
  status: 'ok' | 'failed';
  error?: string;
  createdAt: string;
};

export type RoleAssignmentsView = { assignments?: RoleAssignment[]; detail?: string };

/**
 * fetchRoleAssignments reads the NEWEST attempts. The api caps `limit` at 200 and silently falls back
 * to its own default of 50 for a value it does not like (apps/api/community_handlers.go), so the
 * panel only ever offers values the api accepts and the note above the table says which window is on
 * screen.
 */
export function fetchRoleAssignments(limit: number): Promise<RoleAssignmentsView> {
  return getJSON<RoleAssignmentsView>(`/api/admin/role-assignments?limit=${limit}`, { cache: 'no-store' });
}

/**
 * One recorded change to the bot (bigint-safe: the id is a number, every Discord snowflake in the
 * row is a string). `before`/`after` are the structured snapshots and are ABSENT when the row has
 * none — a create has no before, a delete no after.
 */
export type AuditEntry = {
  id: number;
  guildId: string;
  actorId: string;
  actorName: string;
  action: string;
  resourceType: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
  source: string;
  createdAt: string;
};

export type AuditView = { entries?: AuditEntry[]; detail?: string };

/**
 * fetchAuditEntries reads the audit trail, newest first. `resourceType` is an EXACT match and the api
 * does not validate it, so an unknown name is an empty list rather than an error; pass '' for all.
 */
export function fetchAuditEntries(limit: number, resourceType = ''): Promise<AuditView> {
  const filter = resourceType === '' ? '' : `&resourceType=${encodeURIComponent(resourceType)}`;
  return getJSON<AuditView>(`/api/admin/logs/audit?limit=${limit}${filter}`, { cache: 'no-store' });
}

/**
 * One possible reply. `embed` is the optional rich embed (jsonb on the wire) and is carried through
 * untouched — this dashboard edits text, and never rewrites an embed it cannot edit.
 */
export type CommandResponse = { text?: string; embed?: unknown };

/**
 * A custom command. camelCase on the wire (`apps/api/customcommands.go`), snowflake ids as strings.
 */
export type CustomCommand = {
  id?: number;
  name: string;
  aliases: string[];
  responses: CommandResponse[];
  allowedRoles: string[];
  allowedChannels: string[];
  cooldownSeconds: number;
  deleteTrigger: boolean;
  reply: boolean;
  dm: boolean;
  enabled: boolean;
};

/** The save answers `{ok:true, commands:[…]}`; the read answers `{commands:[…]}`. */
export type CommandsView = { ok?: boolean; commands?: CustomCommand[]; detail?: string };

/** fetchCustomCommands reads the whole set; the bot reads the same set over the loopback hop. */
export function fetchCustomCommands(): Promise<CommandsView> {
  return getJSON<CommandsView>('/api/admin/custom-commands', { cache: 'no-store' });
}

/**
 * saveCustomCommands replaces the WHOLE set in one transaction (the dashboard edits the list as a
 * unit) and answers with the set the api actually stored — normalised. Adopt the answer: the api
 * lowercases names and trims/dedupes aliases, so what comes back can differ from what was sent.
 */
export function saveCustomCommands(commands: CustomCommand[]): Promise<CommandsView> {
  return getJSON<CommandsView>('/api/admin/custom-commands', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands }),
  });
}

