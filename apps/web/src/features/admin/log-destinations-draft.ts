/**
 * Log destinations — the draft the activity-log routing editor edits.
 *
 * The api owns the closed category set and sends it on every read (`categories`), so this module never
 * hardcodes the list: a category added to the Go set shows up in the panel without a web deploy, and a
 * label missing here renders as the raw name instead of disappearing.
 *
 * What this file owns is the WRITE, and the write has one trap worth naming:
 *
 *   an EMPTY channelId DELETES the routing row — the category becomes unrouted and its channel is
 *   forgotten (`channel_id` is NOT NULL: there is no such row as "a destination with no destination").
 *
 * So "turn this off" has two different meanings and the panel must not blur them:
 *   • stop delivery, keep the wiring → send the SAME channel with `enabled: false` (the toggle);
 *   • forget the routing entirely     → clear the channel, which is a DELETION and says so first.
 *
 * The api validates, and its refusal sentence names the field — the panel shows it rather than
 * re-implementing the checks. This file only decides what to SEND, which is what makes it testable
 * without a network.
 */

export type LogDestination = {
  category: string;
  channelId: string;
  enabled: boolean;
  updatedAt: string;
};

export type LogDestinationsBody = {
  destinations?: LogDestination[];
  categories?: string[];
  detail?: string;
};

export type LogDestinationWrite = {
  category: string;
  /** A Discord snowflake routes the category; an EMPTY value deletes the row. */
  channelId: string;
  /** Always sent on a route: an omitted value would let the api default decide the operator's intent. */
  enabled?: boolean;
};

/** What each category carries, for an operator who did not write the router. */
export const CATEGORY_LABEL: Record<string, string> = {
  message: 'Messages',
  member: 'Members',
  role: 'Roles',
  voice: 'Voice',
  channel: 'Channels',
  moderation: 'Moderation',
  automod: 'AutoMod',
};

export const CATEGORY_NOTE: Record<string, string> = {
  message: 'edits and deletions',
  member: 'joins, leaves, nickname changes',
  role: 'roles added to and removed from a member',
  voice: 'voice channel activity',
  channel: 'channel and permission changes',
  moderation: 'warnings, timeouts, kicks, bans — what a moderator did',
  automod: 'rules that fired and the action they took',
};

export type Row = {
  category: string;
  /** The edited channel: what the field holds right now. */
  channelId: string;
  /** The edited delivery switch. */
  enabled: boolean;
  /** The routed row as the api has it, or null when the category is unrouted. */
  stored: LogDestination | null;
};

export type Draft = {
  rows: Row[];
  /** Categories the api sent that have no label here — reported, never silently dropped. */
  unlabelled: string[];
};

/** draftFrom merges the server's category set with the stored rows: every category gets a row. */
export function draftFrom(body: LogDestinationsBody): Draft {
  const stored = new Map<string, LogDestination>();
  for (const d of body.destinations ?? []) stored.set(d.category, d);

  const order: string[] = [];
  for (const c of body.categories ?? []) if (!order.includes(c)) order.push(c);
  // A stored row for a category the api did not list still has to be visible: it is a live routing.
  for (const d of body.destinations ?? []) if (!order.includes(d.category)) order.push(d.category);

  const rows = order.map<Row>((category) => {
    const d = stored.get(category) ?? null;
    return {
      category,
      channelId: d?.channelId ?? '',
      enabled: d?.enabled ?? true,
      stored: d,
    };
  });

  return { rows, unlabelled: rows.map((r) => r.category).filter((c) => CATEGORY_LABEL[c] === undefined) };
}

export function labelFor(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

export function noteFor(category: string): string | null {
  return CATEGORY_NOTE[category] ?? null;
}

/** isRouted is the api's own test: a channel is set. `enabled` does not enter into it. */
export function isRouted(row: Row): boolean {
  return row.channelId.trim() !== '';
}

export function isOff(row: Row): boolean {
  return isRouted(row) && !row.enabled;
}

export function summarize(rows: Row[]): { routed: number; off: number; total: number } {
  return {
    routed: rows.filter(isRouted).length,
    off: rows.filter(isOff).length,
    total: rows.length,
  };
}

export type Intent =
  | { kind: 'save'; body: LogDestinationWrite }
  /** A deletion: the api removes the row and the channel is forgotten. */
  | { kind: 'clear'; body: LogDestinationWrite }
  /** Nothing to send — the row already says this. */
  | { kind: 'none' };

/**
 * intentFor reads one row's intent against what the api stores. Blank channel:
 *   • never routed → nothing to send (clearing again would be a no-op request);
 *   • routed       → a DELETE, not a disable.
 * Otherwise a save, and `enabled` travels with the channel so the api never has to guess.
 */
export function intentFor(row: Row): Intent {
  const channelId = row.channelId.trim();
  if (channelId === '') {
    if (row.stored === null) return { kind: 'none' };
    // `enabled` is deliberately absent: the api's delete path ignores it, and sending it would
    // suggest this request can keep anything.
    return { kind: 'clear', body: { category: row.category, channelId: '' } };
  }
  if (row.stored !== null && row.stored.channelId === channelId && row.stored.enabled === row.enabled) {
    return { kind: 'none' };
  }
  return { kind: 'save', body: { category: row.category, channelId, enabled: row.enabled } };
}

/** What the api answered, said back to the operator in its terms. */
export function outcomeSentence(body: {
  ok?: boolean;
  destination?: LogDestination;
  cleared?: string;
}): string {
  if (typeof body.cleared === 'string' && body.cleared !== '') {
    return `${labelFor(body.cleared)} is now unrouted — the row is deleted and the channel is forgotten`;
  }
  const d = body.destination;
  if (d === undefined) return 'saved';
  const head = `${labelFor(d.category)} → ${d.channelId}`;
  return d.enabled
    ? `${head} — delivery on`
    : `${head} — delivery off, the channel is kept (switch it back on to resume)`;
}

/** The sentence shown before a clear, because the operator is about to lose the channel id. */
export function clearWarning(category: string): string {
  const name = labelFor(category);
  return (
    `clearing the channel DELETES the ${name} routing — the bot then reports ${name.toLowerCase()} to ` +
    `nobody, and the channel id is forgotten. To stop delivery but keep the wiring, leave the channel ` +
    `in place and switch the toggle off.`
  );
}

/** How a change reaches the bot. Read fresh per event, so the panel's save is live immediately. */
export const ROUTING_NOTE =
  'The bot reads this routing on every event, so a change applies to the next one — no restart. ' +
  'An unrouted category is the default: nothing is sent anywhere.';

/** An unrouted row still needs the operator to know what a channel id is. */
export const CHANNEL_HINT = 'a Discord channel id (digits) — the bot posts the embed there';
