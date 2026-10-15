import type { AuditEntry } from './client';

/**
 * The audit trail, read out of the wire.
 *
 * `audit_logs` records changes to the bot ITSELF, as opposed to the Discord activity log which
 * records things happening in the server. Two facts shape this view:
 *
 *  1. The trail is BEST-EFFORT. `recordAudit` writes after the mutation it describes has already
 *     stood, and a failed write is only logged — so a missing row may be a change that never
 *     happened OR a change whose evidence was lost. The panel says so instead of implying a complete
 *     history.
 *  2. `resource_type` is FREE-FORM (any non-empty string up to 64 chars), unlike the audit `source`,
 *     which the api validates against a closed set. So the labels below are a convenience for the
 *     types the code writes today, not a vocabulary: an unknown type is shown as itself.
 *
 * The interesting column is the diff. `before`/`after` are structured snapshots and either may be
 * absent — a create has no before, a delete no after — and a whole-configuration replacement (join
 * roles, role panels, custom commands) has an ARRAY on each side, which is one change, not one per
 * element.
 */

/** The windows the api honours: it defaults to 25 and refuses to go past 100. */
export const WINDOWS = [25, 50, 100] as const;
export const DEFAULT_WINDOW = 25;

/** The audit sources — a closed set the api validates on every write. */
export const SOURCE_LABEL: Record<string, string> = {
  dashboard: 'dashboard',
  discord: 'Discord command',
  automod: 'AutoMod action',
  system: 'bot (no operator)',
};

/**
 * Labels for the resource types the code writes today. NOT an enum: the column accepts any string, so
 * a type missing here renders as its raw wire value rather than as an error.
 */
export const RESOURCE_LABEL: Record<string, string> = {
  settings: 'settings',
  welcome: 'welcome & goodbye',
  autorole: 'join roles',
  role_panel: 'role panels',
  custom_command: 'custom commands',
  log_destination: 'log routing',
};

export const GAP_NOTE =
  'Best-effort trail: a change stands even when its audit row cannot be written (a failed write is only logged), so a gap here is a failed write as easily as a change that never happened.';

export const FILTER_NOTE =
  'The filter is an exact match on the resource type and the api does not validate it — a name nothing ever wrote returns an empty list, which reads the same as "nothing happened".';

export const ACTOR_NOTE =
  'The actor is the dashboard session that made the change; a row with no name falls back to the operator id, and a row with neither says so instead of showing an empty cell.';

/** A single observable difference between two snapshots. */
export type Change = {
  /** The top-level key that moved; empty when the whole value was replaced (an array, say). */
  key: string;
  kind: 'changed' | 'added' | 'removed';
  before: string;
  after: string;
};

/**
 * diffSnapshots reports what moved between two snapshots.
 *
 * Objects are compared key by key; anything else (an array, a scalar, a snapshot that is not there)
 * is reported whole, because a replaced list of join roles is one change an operator needs to see,
 * not a synthetic diff of two arrays.
 */
export function diffSnapshots(before: unknown, after: unknown): Change[] {
  const hasBefore = before !== undefined;
  const hasAfter = after !== undefined;
  if (!hasBefore && !hasAfter) {
    return [];
  }
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return [wholeChange(hasBefore, hasAfter, before, after)];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: Change[] = [];
  for (const key of keys) {
    const had = Object.prototype.hasOwnProperty.call(before, key);
    const has = Object.prototype.hasOwnProperty.call(after, key);
    const b = formatSnapshot(before[key]);
    const a = formatSnapshot(after[key]);
    if (had && has && b === a) {
      continue;
    }
    out.push({
      key,
      kind: !had ? 'added' : !has ? 'removed' : 'changed',
      before: had ? b : '',
      after: has ? a : '',
    });
  }
  return out;
}

function wholeChange(hasBefore: boolean, hasAfter: boolean, before: unknown, after: unknown): Change {
  return {
    key: '',
    kind: !hasBefore ? 'added' : !hasAfter ? 'removed' : 'changed',
    before: hasBefore ? formatSnapshot(before) : '',
    after: hasAfter ? formatSnapshot(after) : '',
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** formatSnapshot renders one snapshot value as a compact single line, capped for the table. */
export function formatSnapshot(value: unknown, cap = 120): string {
  const json = JSON.stringify(value ?? null);
  if (json === undefined) {
    return '';
  }
  return json.length > cap ? `${json.slice(0, cap - 1)}…` : json;
}

/** actorLabel names the operator, falling back to the id and then to an admission. */
export function actorLabel(entry: AuditEntry): string {
  const name = (entry.actorName ?? '').trim();
  if (name !== '') {
    return name;
  }
  const id = (entry.actorId ?? '').trim();
  return id === '' ? 'not recorded' : id;
}

export function resourceLabel(resourceType: string): string {
  return RESOURCE_LABEL[resourceType] ?? resourceType;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

/** describeChange renders one change as a line an operator can read without parsing JSON. */
export function describeChange(c: Change): string {
  const key = c.key === '' ? '' : `${c.key}: `;
  if (c.kind === 'added') {
    return `${key}${c.after} (added)`;
  }
  if (c.kind === 'removed') {
    return `${key}${c.before} (removed)`;
  }
  return `${key}${c.before} → ${c.after}`;
}

/** windowNote states what the window is, so a short list is not read as an empty history. */
export function windowNote(limit: number): string {
  return `the newest ${limit} changes; older ones are not shown`;
}

/** typesIn lists the resource types present, for a filter built from what is actually there. */
export function typesIn(entries: AuditEntry[]): string[] {
  return [...new Set(entries.map((e) => e.resourceType))].sort();
}

export type AuditSummary = {
  total: number;
  /** Change counts per actor, busiest first — shown only when more than one actor is present. */
  actors: { label: string; count: number }[];
  /** The newest change's timestamp, or '' when there is nothing. */
  newest: string;
};

/** summarize counts a page: how many changes, by whom, and how recent. */
export function summarize(entries: AuditEntry[]): AuditSummary {
  const byActor = new Map<string, number>();
  for (const e of entries) {
    const label = actorLabel(e);
    byActor.set(label, (byActor.get(label) ?? 0) + 1);
  }
  const actors = [...byActor.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.label.localeCompare(b.label)));
  return { total: entries.length, actors, newest: entries[0]?.createdAt ?? '' };
}
