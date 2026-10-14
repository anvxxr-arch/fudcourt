import type { RoleAssignment } from './client';

/**
 * The role-assignment log, read out of the wire.
 *
 * This panel is READ-ONLY and its whole value is in the failures: `role_assignments` is the only
 * place that answers "why didn't this member get the role?", and the answer is a sentence the BOT
 * wrote (a hierarchy refusal, a Discord error, a failed hierarchy lookup). So the panel's job is not
 * to summarise those sentences but to make them findable — a window, a failures-only view, and the
 * one question an eye cannot answer: is the SAME role failing over and over?
 */

/** The api's closed set of sources (apps/api/community_handlers.go `assignmentSources`). A source it
 *  does not list is refused, so this is the whole vocabulary the panel can ever be shown. */
export const SOURCE_LABEL: Record<string, string> = {
  autorole: 'autorole',
  panel: 'role panel',
  'panel-reaction': 'reaction role',
  verification: 'verification',
  manual: 'manual',
};

/** What each source means in one clause, for the note under the table. */
export const SOURCE_NOTE: Record<string, string> = {
  autorole: 'granted by an autorole rule when the member joined or its wait elapsed',
  panel: 'granted from a button or select menu on a role panel',
  'panel-reaction': 'granted by reacting to (or unreacting from) a role panel message',
  verification: 'granted by the verification bucket of an autorole rule',
  manual: 'written by hand rather than by a bot action',
};

/** The api accepts 1..200 and falls back to its default of 50 for anything else — these are the
 *  values it actually honours, so the selector cannot ask for a window the api will silently ignore. */
export const LIMITS = [25, 50, 100, 200] as const;
export const DEFAULT_LIMIT = 50;

/** The window note. A read of `limit` rows is the newest `limit`, oldest dropped — never a total. */
export function windowNote(limit: number): string {
  return `the newest ${limit} attempts — older ones are not returned by the api`;
}

/** `error` is absent on a success; the panel always wants a string to render. */
export function reasonOf(a: RoleAssignment): string {
  return a.error ?? '';
}

export function isFailure(a: RoleAssignment): boolean {
  return a.status === 'failed';
}

export function summarize(rows: readonly RoleAssignment[]): { total: number; failed: number; ok: number } {
  let failed = 0;
  for (const row of rows) if (isFailure(row)) failed++;
  return { total: rows.length, failed, ok: rows.length - failed };
}

export function failuresOnly(rows: readonly RoleAssignment[]): RoleAssignment[] {
  return rows.filter(isFailure);
}

export type FailureGroup = { roleId: string; count: number; reason: string; lastAt: string };

/**
 * groupFailures answers what a list of rows does not: whether one role is failing repeatedly. That is
 * the §17 signal — the bot refuses an impossible assignment on EVERY attempt rather than giving up,
 * so a role above the bot's own position produces a failure per join, forever, and the fix is either
 * the hierarchy or the rule. Newest first (the api returns `id` descending), so the first reason seen
 * for a role is its most recent one.
 */
export function groupFailures(rows: readonly RoleAssignment[]): FailureGroup[] {
  const byRole = new Map<string, FailureGroup>();
  for (const row of rows) {
    if (!isFailure(row)) continue;
    const existing = byRole.get(row.roleId);
    if (existing) {
      existing.count++;
      continue;
    }
    byRole.set(row.roleId, { roleId: row.roleId, count: 1, reason: reasonOf(row), lastAt: row.createdAt });
  }
  return [...byRole.values()].sort((a, b) => (b.count !== a.count ? b.count - a.count : a.roleId.localeCompare(b.roleId)));
}

/**
 * formatWhen renders the api's RFC3339 timestamp. An input this cannot parse is returned VERBATIM
 * rather than swallowed into "Invalid Date" — a timestamp the panel cannot read is a fact worth
 * seeing, not one worth hiding.
 */
export function formatWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** A short label for a source, falling back to the raw string the api sent. */
export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}
