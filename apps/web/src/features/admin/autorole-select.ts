// Which roles a joiner gets, and when — the panel's PREVIEW of the bot's own decision.
//
// This is a MIRROR of `apps/discord-bot/src/community/autorole.ts` (`selectAutoroles`), for the same
// reason the welcome preview mirrors the template engine: the selection is not readable off the
// form. Priority decides the order, a delay of zero collapses into "immediate", `appliesTo` drops
// whole rules for a joiner that is a bot, and one bucket never fires at all — none of which an
// operator can see by reading seven columns of a rule row.
//
// The mirror is pinned the same way the welcome one is: the tests replay the BOT'S OWN fixtures
// (same rules, same `isBot`, same buckets) and a drift guard reads the bot's source and fails if this
// file stops matching its comparator or its switch.
//
// One thing the mirror deliberately reproduces rather than improves: the bot's tiebreak for equal
// priorities is `Number(a.id) - Number(b.id)` — the ROW ID, not the array position. That looks like a
// detail of the database until you follow `replaceAutoroles`, which deletes every rule for the guild
// and re-inserts them in the order the dashboard sent. So the row id IS the list order, and an
// operator with two rules at the same priority gets them applied in the order they arranged them —
// which is why this file sorts with the bot's exact comparator instead of "priority only".
//
// `Number("")` is 0, so a rule that has never been saved (no id yet) ties with any other unsaved rule
// and `Array.prototype.sort` is stable: the panel's own order survives. That is what makes the
// preview agree with the bot BEFORE a save and after one.

export type AutoroleKind = 'on_join' | 'after_duration' | 'after_verification';
export type AutoroleApplies = 'all' | 'human' | 'bot';

/** The rule shape the api puts on the wire (`apps/api/community.go`'s `autoroleRule`). */
export type AutoroleRule = {
  /** The database's row id. OUTPUT ONLY: `replaceAutoroles` deletes and re-inserts, so every save
   *  reassigns it. The panel never sends it and never shows it, because it does not survive. */
  id: string;
  roleId: string;
  kind: AutoroleKind;
  delaySeconds: number;
  appliesTo: AutoroleApplies;
  enabled: boolean;
  priority: number;
};

export type AutoroleSelection = {
  /** Granted the moment the member lands. */
  immediate: AutoroleRule[];
  /** Granted after N seconds. */
  delayed: { rule: AutoroleRule; delaySeconds: number }[];
  /** Granted when verification passes — see `DEFERRED_NOTE`: nothing triggers this today. */
  deferred: AutoroleRule[];
};

/**
 * selectAutoroles mirrors the bot's bucketing exactly, including the two rules that surprise people:
 * `after_duration` with a delay of 0 or less counts as IMMEDIATE (a zero delay is not "later"), and
 * a disabled rule is dropped before anything else looks at it.
 */
export function selectAutoroles(rules: readonly AutoroleRule[], isBot: boolean): AutoroleSelection {
  const immediate: AutoroleRule[] = [];
  const delayed: { rule: AutoroleRule; delaySeconds: number }[] = [];
  const deferred: AutoroleRule[] = [];
  for (const rule of [...rules].sort(compareAutoroles)) {
    if (!rule.enabled) continue;
    if (rule.appliesTo === 'human' && isBot) continue;
    if (rule.appliesTo === 'bot' && !isBot) continue;
    switch (rule.kind) {
      case 'on_join':
        immediate.push(rule);
        break;
      case 'after_duration':
        if (rule.delaySeconds <= 0) immediate.push(rule);
        else delayed.push({ rule, delaySeconds: rule.delaySeconds });
        break;
      case 'after_verification':
        deferred.push(rule);
        break;
    }
  }
  return { immediate, delayed, deferred };
}

/** The bot's comparator: priority descending, then row id ascending — and the row id is list order. */
export function compareAutoroles(a: AutoroleRule, b: AutoroleRule): number {
  return b.priority - a.priority || Number(a.id) - Number(b.id);
}

/** delayLabel renders a delay the way the bucket needs it: seconds are what the api stores, and
 *  "5 minutes" is what the operator wrote down. Zero is called out because it means NOW. */
export function delayLabel(seconds: number): string {
  if (seconds <= 0) return 'immediately';
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return days === 1 ? 'after 1 day' : `after ${days} days`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? 'after 1 hour' : `after ${hours} hours`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? 'after 1 minute' : `after ${minutes} minutes`;
  }
  return `after ${seconds} seconds`;
}
