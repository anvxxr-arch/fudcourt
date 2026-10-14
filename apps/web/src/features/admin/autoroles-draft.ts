import type { AutoroleApplies, AutoroleKind, AutoroleRule } from './autorole-select';

// The autorole editor's draft rules, and the constants the form and the hints are built from.
//
// The whole set is replaced in one transaction, like schedules and feeds — and, like those, the
// write shape is NOT the read shape. `replaceAutoroles` (apps/api/community.go) deletes every rule
// for the guild and re-inserts them in the order they arrive, letting the identity column hand out
// new ids, so the `id` the api reported is dead the moment it is written. The draft keeps it anyway,
// for exactly one reason: the bot's ordering tiebreak for equal priorities is the ROW ID, and a row
// id is list order — so keeping the loaded id is what makes the preview reproduce the bot's order
// before the first save, and dropping it from the BODY is what keeps the panel from implying the
// column means something. See `autorole-select.ts` for the comparator.

/** A rule as the editor holds it. `key` is local (React identity); `id` is read-only and unsent. */
export type AutoroleDraftRule = {
  key: string;
  id: string;
  roleId: string;
  kind: AutoroleKind;
  delaySeconds: number;
  appliesTo: AutoroleApplies;
  enabled: boolean;
  priority: number;
};

/** The write shape: the read shape MINUS the id, which the api assigns and ignores. */
export type AutoroleWrite = Omit<AutoroleRule, 'id'>;

export const MAX_RULES = 100;
/** 30 days, the api's own cap on `delaySeconds`. */
export const MAX_DELAY = 2592000;

export const KINDS: { value: AutoroleKind; label: string; hint: string }[] = [
  { value: 'on_join', label: 'on join', hint: 'granted the moment the member lands' },
  { value: 'after_duration', label: 'after a wait', hint: 'granted once the wait below has passed' },
  { value: 'after_verification', label: 'after verification', hint: 'granted when verification passes' },
];

export const APPLIES: { value: AutoroleApplies; label: string }[] = [
  { value: 'all', label: 'everyone' },
  { value: 'human', label: 'humans only' },
  { value: 'bot', label: 'bots only' },
];

export const ORDER_NOTE =
  'Rules run in this order: highest priority first, and equal priorities keep the list order below — the api re-inserts them in that order, and that insertion order is what the bot sorts by.';

export const DELAY_NOTE =
  'A wait of 0 grants the role straight away rather than eventually — the bot treats "after a wait" with no wait as immediate.';

/**
 * The one thing the panel says about a bucket it cannot make work. `AutoroleService.onVerified`
 * exists, is tested, and is called by NOTHING in the bot: no verification flow is wired, so this
 * bucket never fires. Saying so is the whole point — an operator who picks this kind would otherwise
 * wait for a role that is never coming, with nothing anywhere to tell them why.
 */
export const DEFERRED_NOTE =
  'Nothing asks for verification yet — the bot implements this rule and no flow in it triggers verification, so a role set up this way will not arrive.';

/** A local key that stays stable across reorders, so React never confuses two rules. */
let nextKey = 1;
export function newKey(): string {
  return `rule-${nextKey++}`;
}

export function blankRule(): AutoroleDraftRule {
  return { key: newKey(), id: '', roleId: '', kind: 'on_join', delaySeconds: 0, appliesTo: 'all', enabled: true, priority: 0 };
}

export function fromRules(rules: readonly AutoroleRule[]): AutoroleDraftRule[] {
  return rules.map((r) => ({ ...r, key: newKey() }));
}

/** toRules drops the id, coerces the numbers (a form field hands back strings) and leaves the array
 *  ORDER alone: that order is the tiebreak the api will persist. */
export function toRules(drafts: readonly AutoroleDraftRule[]): AutoroleWrite[] {
  return drafts.map(valueOf);
}

/** previewRules is what the preview hands the mirror: the same values, but KEEPING whatever id the
 *  api last reported, because the bot's tiebreak for equal priorities uses it. The write shape drops
 *  it; the ordering question does not. */
export function previewRules(drafts: readonly AutoroleDraftRule[]): AutoroleRule[] {
  return drafts.map((d) => ({ id: d.id, ...valueOf(d) }));
}

function valueOf(d: AutoroleDraftRule): AutoroleWrite {
  return {
    roleId: d.roleId.trim(),
    kind: d.kind,
    delaySeconds: Number.isFinite(d.delaySeconds) ? Math.trunc(d.delaySeconds) : 0,
    appliesTo: d.appliesTo,
    enabled: d.enabled,
    priority: Number.isFinite(d.priority) ? Math.trunc(d.priority) : 0,
  };
}

/**
 * duplicateRoleIds reports the api's own refusal before the round trip, as a WARNING rather than a
 * block: the api refuses the same role twice whatever its kind, which is stricter than the table's
 * `(guild_id, role_id, kind)` index, and the sentence the operator sees on save is the api's. The
 * panel shows it early so the fix happens before the save, not instead of it.
 */
export function duplicateRoleIds(drafts: readonly AutoroleDraftRule[]): string[] {
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const d of drafts) {
    const id = d.roleId.trim();
    if (id === '') continue;
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    if (count === 2) dupes.push(id);
  }
  return dupes;
}

/** A rule with no role id is not a rule: the api refuses it, so the panel says which row to fix
 *  instead of letting the save fail with `rule 3: roleId must be a Discord id`. */
export function missingRoleIds(drafts: readonly AutoroleDraftRule[]): number[] {
  return drafts.map((d, i) => (d.roleId.trim() === '' ? i : -1)).filter((i) => i >= 0);
}
