import type { FeedSource } from './client';

// The feeds panel's editable projection of one source: the fields an OPERATOR owns, plus the
// poller's report carried along so a row can show its health without re-reading the list.
//
// This module is deliberately free of React and of the wire's rules: `toSource` turns a draft
// back into a source, and the one place that decides what the POST body may contain is
// `writableFeeds` in client.ts. A panel that built its own body would be a second
// implementation of the write rule, which is how the poller's report ends up in a save.
//
// Note what is NOT here: the url guard, the name bound, the cadence bounds, the snowflake
// shape. The url rules have two owners already — the api's `validateFeedSource` shapes the
// refusal an operator sees at the point of entry, and the worker's `feeds::guard` vets EVERY
// hop of EVERY poll, including a name that resolves into private space. A third copy in the
// browser could pass something the worker then blocks; here the shape is a placeholder and the
// refusal is the server's sentence.
//
// One limitation worth naming, inherited from the wire and not fixable here: a source whose
// `scheduled_jobs` row carries a CRON expression instead of an interval is reported by the api
// as 900 seconds (its SQL guards the cast, so one hand-made row cannot break the panel's load).
// The wire gives the panel no way to tell that 900 from a real 900, so the field shows it and a
// save would make it real. Reachable only by editing the database by hand — both panels write
// intervals — and the scheduler panel shows the truth about that row as owned by this one.

/** The adapters the api accepts, in the order the panel offers them. */
export const ADAPTERS = ['auto', 'rss', 'atom', 'json'] as const;

/** The cadence bounds, as the api states them (`pollIntervalSecs must be 60..604800`). Shown as
 *  the field's placeholder and its `min`/`max`, which is the browser's own feedback — never a
 *  refusal this panel invents. */
export const MIN_POLL_SECS = 60;
export const MAX_POLL_SECS = 604800;

/** 15 minutes: visible in the panel, kind to an external host, and fast enough that an operator
 *  sees a new feed work before they move on to something else. */
export const DEFAULT_POLL_SECS = 900;

export type FeedDraft = {
  /** React key AND row identity while editing: an index would re-mount every row below a
   *  delete, which loses focus mid-edit. */
  key: string;
  /** The stored row's id, so an operator can name the row; 0 for one not saved yet. */
  id: number;
  name: string;
  url: string;
  adapter: string;
  channelId: string;
  message: string;
  mentionRoleId: string;
  includeText: string;
  excludeText: string;
  enabled: boolean;
  pollIntervalSecs: number;
  // The poller's report: read-only in the UI, carried so the row renders without a re-read.
  primed: boolean;
  owed: number;
  consecutiveFailures: number;
  lastStatus: string;
  lastError: string;
};

/** draftFrom projects a source the panel read into an editable draft. The nullable optionals
 *  become empty strings, which is what an input holds and what `blankToNull` sends back as null
 *  — one empty representation in the draft, the wire's own on the way out. */
export function draftFrom(row: FeedSource, key: string): FeedDraft {
  return {
    key,
    id: row.id,
    name: row.name,
    url: row.url,
    adapter: row.adapter,
    channelId: row.channelId,
    message: row.message,
    mentionRoleId: row.mentionRoleId ?? '',
    includeText: row.includeText ?? '',
    excludeText: row.excludeText ?? '',
    enabled: row.enabled,
    pollIntervalSecs: row.pollIntervalSecs,
    primed: row.primed,
    owed: row.owed ?? 0,
    consecutiveFailures: row.consecutiveFailures ?? 0,
    lastStatus: row.lastStatus ?? '',
    lastError: row.lastError ?? '',
  };
}

/** newFeedDraft is a blank source. It starts ENABLED, on `auto` — the adapter that needs no
 *  decision from an operator — and on the default cadence, because a feed that saves disabled
 *  is the "I added it and nothing happened" bug, and the empty state of every other field is
 *  something the server names when it refuses. */
export function newFeedDraft(key: string): FeedDraft {
  return {
    key,
    id: 0,
    name: '',
    url: '',
    adapter: 'auto',
    channelId: '',
    message: '',
    mentionRoleId: '',
    includeText: '',
    excludeText: '',
    enabled: true,
    pollIntervalSecs: DEFAULT_POLL_SECS,
    primed: false,
    owed: 0,
    consecutiveFailures: 0,
    lastStatus: '',
    lastError: '',
  };
}

/** toSource turns a draft back into the wire item the client sends. The poller's fields are
 *  carried through and then dropped by `writableFeeds` — this function's job is the draft's
 *  shape, not the body's rule. */
export function toSource(d: FeedDraft): FeedSource {
  return {
    id: d.id,
    name: d.name,
    url: d.url,
    adapter: d.adapter,
    channelId: d.channelId,
    message: d.message,
    mentionRoleId: d.mentionRoleId,
    includeText: d.includeText,
    excludeText: d.excludeText,
    enabled: d.enabled,
    pollIntervalSecs: d.pollIntervalSecs,
    primed: d.primed,
    owed: d.owed,
    consecutiveFailures: d.consecutiveFailures,
    lastStatus: d.lastStatus,
    lastError: d.lastError,
  };
}

/** intervalLabel says what a cadence MEANS, so an operator never has to do arithmetic on a
 *  number of seconds. It is a label, not a validator: 90 renders "every 90 seconds" and the
 *  server decides whether that is acceptable. */
export function intervalLabel(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return 'no cadence set';
  if (secs % 86400 === 0) return `every ${count(secs / 86400, 'day')}`;
  if (secs % 3600 === 0) return `every ${count(secs / 3600, 'hour')}`;
  if (secs % 60 === 0) return `every ${count(secs / 60, 'minute')}`;
  return `every ${count(secs, 'second')}`;
}

function count(n: number, unit: string): string {
  return n === 1 ? unit : `${n} ${unit}s`;
}

/** healthLine is the poller's half of a row, as one line of text — the answer to "is this feed
 *  actually working", which is the question the panel exists for.
 *
 *  `primed` is the one that reads like a bug when it is not explained: until the first
 *  successful poll has absorbed the pre-existing backlog, a working feed announces nothing. */
export function healthLine(d: FeedDraft): string {
  const parts: string[] = [];
  parts.push(d.lastStatus === '' ? 'never polled' : d.lastStatus);
  if (!d.primed) parts.push('baseline not absorbed yet — the first poll announces nothing');
  if (d.owed > 0) parts.push(`${d.owed} owed (recorded, not yet announced)`);
  if (d.consecutiveFailures > 0) parts.push(`${count(d.consecutiveFailures, 'consecutive failure')}`);
  if (d.lastError !== '') parts.push(`error: ${d.lastError}`);
  return parts.join(' · ');
}

/** adapterHint says what the field is for. It is documentation, not a switch: every adapter
 *  goes through the same parser, and `auto` is the one that asks nothing of an operator. */
export function adapterHint(adapter: string): string {
  return adapter === 'auto'
    ? 'the worker sniffs the body — the choice for any ordinary feed'
    : 'declared for documentation: all four go through the same parser';
}
