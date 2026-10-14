import type { ScheduleDefinition } from './client';

// The scheduler panel's editable projection of one definition: the fields an OPERATOR owns
// (name, kind, schedule, timezone, payload, enabled) plus the worker's report, carried along
// so a row renders without re-reading the list.
//
// This module is deliberately free of React and of the wire types' rules: `toDefinition`
// turns a draft back into a definition, and the single place that decides what the POST body
// may contain is `writableDefinitions` in client.ts. A panel that built its own body would be
// a second implementation of the write rule, which is how a read-only row ends up in a save.

/** The job kinds this panel offers. Both are registered by the worker without any
 *  configuration: `health.ping` is how an operator proves schedule → tick → claim → run →
 *  history before Discord is even reachable. Anything else materializes into a job that no
 *  handler claims, so it is not offered (and the server refuses it too). */
export const JOB_KINDS = ['discord.message', 'health.ping'] as const;

/** The three schedule kinds, in the order the panel offers them. */
export const SCHEDULE_KINDS = ['once', 'interval', 'cron'] as const;

/** Zone SUGGESTIONS, not a list: the worker's tz database has hundreds, the field stays free
 *  text, and an unknown zone is the server's to refuse — with a message naming it. */
export const TIMEZONE_HINTS = [
  'UTC',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'America/New_York',
];

/** The payload fields the panel edits, per job kind. A kind absent from this table has no
 *  editable payload, and its stored payload is passed through untouched (see
 *  `writablePayload`) rather than deleted. */
export const PAYLOAD_FIELDS: Record<string, readonly { key: string; label: string }[]> = {
  'discord.message': [
    { key: 'channel_id', label: 'channel id' },
    { key: 'content', label: 'message' },
  ],
};

export type Draft = {
  /** React key AND row identity while editing: an index would re-mount every row below a
   *  delete, which loses focus mid-edit. */
  key: string;
  /** The stored row's id, so an operator can name the row; 0 for one not saved yet. */
  id: number;
  readOnly: boolean;
  owner: string;
  name: string;
  jobKind: string;
  scheduleKind: string;
  scheduleExpr: string;
  timezone: string;
  enabled: boolean;
  payload: Record<string, unknown>;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastError?: string;
  attempts: number;
  maxAttempts: number;
};

/** draftFrom projects a definition the panel read into an editable draft. */
export function draftFrom(row: ScheduleDefinition, key: string): Draft {
  return {
    key,
    id: row.id,
    readOnly: row.readOnly,
    owner: row.owner,
    name: row.name,
    jobKind: row.jobKind,
    scheduleKind: row.scheduleKind,
    scheduleExpr: row.scheduleExpr,
    timezone: row.timezone,
    enabled: row.enabled,
    payload: row.payload ?? {},
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    attempts: row.attempts ?? 0,
    maxAttempts: row.maxAttempts ?? 0,
  };
}

/** newDraft is a blank definition. It starts ENABLED and as an hourly interval in UTC: the
 *  operator created it in a panel that shows every field, and a definition that saves as
 *  disabled is the "I saved it and nothing happened" bug. UTC is explicit and editable rather
 *  than a guess at the operator's zone. */
export function newDraft(key: string): Draft {
  return {
    key,
    id: 0,
    readOnly: false,
    owner: 'scheduler',
    name: '',
    jobKind: 'discord.message',
    scheduleKind: 'interval',
    scheduleExpr: '3600',
    timezone: 'UTC',
    enabled: true,
    payload: {},
    attempts: 0,
    maxAttempts: 0,
  };
}

/** payloadValue reads one payload field as the string an input holds. A non-string stored
 *  value (a number a hand-written row carried) is shown as JSON rather than as "[object]".
 *
 *  This is also why every payload field is a STRING end to end: a Discord snowflake is not
 *  representable as a JS number (1234567890123456789 → 1234567890123456800), so coercing would
 *  silently rewrite an id into a channel that does not exist. The panel shows what was stored and
 *  lets the server refuse what it cannot accept. */
export function payloadValue(d: Draft, key: string): string {
  const value = d.payload?.[key];
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** setPayloadValue returns a NEW draft with one payload field set. Immutable so React state
 *  updates detect the change. */
export function setPayloadValue(d: Draft, key: string, value: string): Draft {
  return { ...d, payload: { ...d.payload, [key]: value } };
}

/** writablePayload is what a save stores: for a kind whose payload this panel shows, exactly
 *  those fields (so clearing a message really clears it); for any other kind, the payload it
 *  read, untouched — the panel must not delete data it cannot display. */
export function writablePayload(d: Draft): Record<string, unknown> {
  const fields = PAYLOAD_FIELDS[d.jobKind];
  if (fields === undefined) return d.payload ?? {};
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.key] = payloadValue(d, field.key);
  return out;
}

/** toDefinition turns a draft back into the wire item the client sends. The worker-owned
 *  fields are carried through and then dropped by `writableDefinitions` — this function's job
 *  is the draft's shape, not the body's rule. */
export function toDefinition(d: Draft): ScheduleDefinition {
  return {
    id: d.id,
    name: d.name,
    jobKind: d.jobKind,
    scheduleKind: d.scheduleKind,
    scheduleExpr: d.scheduleExpr,
    timezone: d.timezone,
    payload: writablePayload(d),
    enabled: d.enabled,
    nextRunAt: d.nextRunAt,
    lastRunAt: d.lastRunAt,
    lastStatus: d.lastStatus,
    lastError: d.lastError,
    attempts: d.attempts,
    maxAttempts: d.maxAttempts,
    owner: d.owner,
    readOnly: d.readOnly,
  };
}

/** expressionHint is the placeholder for the expression field: the shape the server accepts,
 *  not a re-implementation of its rules. */
export function expressionHint(kind: string): string {
  switch (kind) {
    case 'once':
      return 'an instant, RFC3339, in the future — 2026-11-01T09:00:00Z';
    case 'interval':
      return 'seconds, 60 to 604800 — 3600';
    case 'cron':
      return '5, 6 or 7 fields of digits and * , - / — 0 9 * * *';
    default:
      return '';
  }
}

/** scheduleHint explains anchoring, which is the one thing about this panel an operator
 *  cannot infer from the fields: a cron has no next occurrence until the worker's tick has
 *  parsed it once. */
export function scheduleHint(kind: string): string {
  switch (kind) {
    case 'once':
      return 'runs at that instant, then disables itself. A past instant is refused, never fired late.';
    case 'interval':
      return 'the first run is one interval away — a "every 24h" definition does not fire the second you save it.';
    case 'cron':
      return 'stored without a next occurrence: the worker anchors it with its own cron parser on the next tick.';
    default:
      return '';
  }
}

/** The wording a scheduler 409 needs, as the one argument a panel passes to
 *  `describeSaveFailure` (save-error.ts): the name belongs to another panel, so the fix is to
 *  rename it — worth saying, because the raw message reads like a crash. */
export const SCHEDULER_CONFLICT = {
  detail: 'the name is owned by another panel',
  hint: 'rename it, or manage it in the panel that owns it.',
};

/** reportLine is the worker-owned half of a row, as one line of text. It answers the only
 *  question worth asking of a schedule that has not run: why not. */
export function reportLine(d: Draft): string {
  const parts: string[] = [];
  parts.push(d.nextRunAt === undefined || d.nextRunAt === '' ? 'next run: not anchored yet' : `next: ${d.nextRunAt}`);
  if (d.lastRunAt !== undefined && d.lastRunAt !== '') parts.push(`last: ${d.lastRunAt}`);
  if (d.lastStatus !== undefined && d.lastStatus !== '') parts.push(d.lastStatus);
  if (d.attempts > 0) parts.push(`attempts ${d.attempts}/${d.maxAttempts}`);
  if (d.lastError !== undefined && d.lastError !== '') parts.push(`error: ${d.lastError}`);
  return parts.join(' · ');
}
