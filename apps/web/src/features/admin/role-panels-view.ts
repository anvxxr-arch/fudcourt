import type { RolePanel, RolePanelOption } from './client';

/**
 * Role panels — the editor's job is to make three invisible things visible.
 *
 * 1. WHAT A MODE ACTUALLY DOES. `toggle`/`single`/`multiple`/`exclusive` are decided in the bot's pure
 *    `pickOption`, and the differences are not guessable from the names: `single` removes every OTHER
 *    option's role panel-wide, `exclusive` removes only the siblings sharing the option's
 *    `exclusive_group`, and an empty group is the group "", not "no group". A select submission is
 *    different again: the chosen set becomes exactly what the member holds FOR THIS PANEL, so
 *    deselecting revokes.
 * 2. WHAT A DEAD OPTION IS. A reaction option is matched by `emojiKey` EXACTLY, so an option with no
 *    emoji — or one carrying a pasted `<:name:id>` where the bot compares `name:id` — can never fire.
 *    The api's validator is happy with both; nothing else would ever tell the operator.
 * 3. WHO OWNS A FIELD. `position` is inserted verbatim by the api, so the client owns the order;
 *    `style` must be one of four words or the DB CHECK refuses the write; `message_id` belongs to the
 *    message the bot reacts to, not to the editor.
 */

export const PANEL_KINDS = ['reaction', 'button', 'select'] as const;
export const PANEL_MODES = ['toggle', 'single', 'multiple', 'exclusive'] as const;
/** The DB CHECK constraint's four words. The api does NOT validate style, so an empty one 500s. */
export const OPTION_STYLES = ['primary', 'secondary', 'success', 'danger'] as const;
export const DEFAULT_STYLE = 'secondary';

/** The api's own ceilings (validatePanels). */
export const LIMITS = { panels: 50, options: 25, idLength: 64, label: 100, emoji: 64 } as const;

/** The api's isSnowflake: 15–21 ASCII digits, verbatim. */
export function isSnowflake(v: string): boolean {
  if (v.length < 15 || v.length > 21) return false;
  for (const c of v) if (c < '0' || c > '9') return false;
  return true;
}

export function describeKind(kind: string): string {
  switch (kind) {
    case 'reaction':
      return 'React on the posted message. Works today: post the message yourself, add the reactions, then paste the message id and each emoji below.';
    case 'button':
      return 'One button per option. The interaction handler is live, but nothing posts buttons into Discord yet — see the note at the bottom.';
    case 'select':
      return 'One multi-select menu for the whole panel; the chosen set becomes exactly what the member holds for this panel, so deselecting revokes.';
    default:
      return '';
  }
}

export function describeMode(mode: string): string {
  switch (mode) {
    case 'toggle':
      return 'Click flips it: grants if missing, revokes if held.';
    case 'single':
      return 'Grants the pick and revokes every OTHER option of this panel.';
    case 'multiple':
      return 'Grants the pick and leaves everything else alone — clicking a held role changes nothing. A select submission still replaces the whole set.';
    case 'exclusive':
      return 'Like single, but scoped to the pick\u2019s exclusiveGroup: only options sharing that group are revoked.';
    default:
      return '';
  }
}

/**
 * emojiKey mirrors the bot's own: `<:name:id>`/`<a:name:id>` (what Discord copies to the clipboard)
 * becomes the `name:id` it compares against, and anything else is left as typed.
 */
export function emojiKey(raw: string): string {
  const m = raw.trim().match(/^<a?:([^:>]*):(\d+)>$/);
  if (m && m[1] !== undefined && m[2] !== undefined) return `${m[1]}:${m[2]}`;
  return raw.trim();
}

export type PanelDraft = {
  id: string;
  channelId: string;
  messageId: string;
  title: string;
  description: string;
  kind: string;
  mode: string;
  enabled: boolean;
  options: OptionDraft[];
};
export type OptionDraft = {
  roleId: string;
  label: string;
  emoji: string;
  style: string;
  exclusiveGroup: string;
};

function optionToDraft(o: RolePanelOption): OptionDraft {
  return {
    roleId: o.roleId ?? '',
    label: o.label ?? '',
    emoji: o.emoji ?? '',
    style: o.style !== undefined && o.style !== '' ? o.style : DEFAULT_STYLE,
    exclusiveGroup: o.exclusiveGroup ?? '',
  };
}

export function toDraft(panels: RolePanel[]): PanelDraft[] {
  return panels.map((p) => ({
    id: p.id ?? '',
    channelId: p.channelId ?? '',
    messageId: p.messageId ?? '',
    title: p.title ?? '',
    description: p.description ?? '',
    kind: p.kind !== undefined && p.kind !== '' ? p.kind : 'button',
    mode: p.mode !== undefined && p.mode !== '' ? p.mode : 'toggle',
    enabled: p.enabled !== false,
    options: (p.options ?? []).map(optionToDraft),
  }));
}

/**
 * fromDraft encodes the set the api will store. Two fields are the CLIENT's call, not the api's:
 * `position` (inserted verbatim, so the array order IS the stored order) and a non-empty `style`
 * (the DB CHECK rejects "" — the api's validator would let it through and the write would 500).
 */
export function fromDraft(rows: PanelDraft[]): RolePanel[] {
  return rows.map((r) => ({
    id: r.id.trim(),
    channelId: r.channelId.trim(),
    messageId: r.messageId.trim(),
    title: r.title,
    description: r.description,
    kind: r.kind,
    mode: r.mode,
    enabled: r.enabled,
    options: r.options
      .filter((o) => o.roleId.trim() !== '')
      .map((o, i) => ({
        roleId: o.roleId.trim(),
        label: o.label,
        emoji: o.emoji.trim(),
        style: OPTION_STYLES.includes(o.style as (typeof OPTION_STYLES)[number]) ? o.style : DEFAULT_STYLE,
        position: i,
        exclusiveGroup: o.exclusiveGroup.trim(),
      })),
  }));
}

/**
 * panelProblem mirrors validatePanels, including its wording, so the operator gets the api's own
 * sentence without a round trip. It is never STRICTER than the api: anything the api accepts is
 * accepted here (only the empty-style and blank-emoji cases go beyond it, and those are flagged
 * rather than refused).
 */
export function panelProblem(panels: RolePanel[]): string | null {
  if (panels.length > LIMITS.panels) return `at most ${LIMITS.panels} role panels`;
  const seenID = new Set<string>();
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i]!;
    // Every field but `id` is optional on the wire, and `undefined !== ''` is TRUE — so a missing
    // channelId would reach isSnowflake(undefined) and throw. Normalise once, here.
    const options = p.options ?? [];
    const channelId = p.channelId ?? '';
    if (p.id === '' || p.id.length > LIMITS.idLength) return `panel ${i}: id is required (<= ${LIMITS.idLength} chars)`;
    if (seenID.has(p.id)) return `panel ${i}: duplicate id ${p.id}`;
    seenID.add(p.id);
    if (!PANEL_KINDS.includes(p.kind as (typeof PANEL_KINDS)[number]))
      return `panel ${i}: kind must be reaction, button or select`;
    if (!PANEL_MODES.includes(p.mode as (typeof PANEL_MODES)[number]))
      return `panel ${i}: mode must be toggle, single, multiple or exclusive`;
    if (channelId !== '' && !isSnowflake(channelId)) return `panel ${i}: channelId must be a Discord id`;
    if (options.length === 0) return `panel ${i}: at least one option is required`;
    if (options.length > LIMITS.options) return `panel ${i}: at most ${LIMITS.options} options`;
    const seenRole = new Set<string>();
    for (let j = 0; j < options.length; j++) {
      const o = options[j]!;
      if (!isSnowflake(o.roleId)) return `panel ${i} option ${j}: roleId must be a Discord id`;
      if (seenRole.has(o.roleId)) return `panel ${i} option ${j}: duplicate roleId ${o.roleId}`;
      seenRole.add(o.roleId);
      if ((o.label ?? '').length > LIMITS.label || (o.emoji ?? '').length > LIMITS.emoji)
        return `panel ${i} option ${j}: label/emoji too long`;
    }
  }
  return null;
}

/** Option indexes a reaction panel can never fire on: matched by exact emoji key, so blank is dead. */
export function deadReactionOptions(panel: PanelDraft): number[] {
  if (panel.kind !== 'reaction') return [];
  const out: number[] = [];
  panel.options.forEach((o, i) => {
    if (emojiKey(o.emoji) === '') out.push(i);
  });
  return out;
}

/** Option indexes whose emoji was pasted in Discord's clipboard form and will be normalised. */
export function normalisedEmojiOptions(panel: PanelDraft): number[] {
  const out: number[] = [];
  panel.options.forEach((o, i) => {
    if (o.emoji.trim() !== '' && emojiKey(o.emoji) !== o.emoji) out.push(i);
  });
  return out;
}

/**
 * groups describes what `exclusive` will actually do: the distinct exclusive_group values, and how
 * many options sit in each. The empty string is a real group — options that share it revoke each
 * other exactly like `single`, which is why the editor labels it rather than showing a blank.
 */
export function groups(panel: PanelDraft): { name: string; count: number; blank: boolean }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const o of panel.options) {
    const g = o.exclusiveGroup.trim();
    if (!counts.has(g)) order.push(g);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return order.map((g) => ({ name: g === '' ? '(ungrouped)' : g, count: counts.get(g) ?? 0, blank: g === '' }));
}

/** Role ids repeated inside one panel — the api refuses these; the editor says which. */
export function duplicateRoleIds(panel: PanelDraft): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const o of panel.options) {
    const id = o.roleId.trim();
    if (id !== '' && seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

export function summarize(panels: PanelDraft[]): { total: number; disabled: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {};
  let disabled = 0;
  for (const p of panels) {
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    if (!p.enabled) disabled++;
  }
  return { total: panels.length, disabled, byKind };
}

export const OWNERSHIP_NOTE =
  'Position is stored verbatim by the api, so this list order IS the order members see — the editor sends it as the index. Style must be one of four words or the DB CHECK refuses the write, so an unrecognised value is saved as secondary.';
export const MESSAGE_ID_NOTE =
  'messageId is the message the bot listens on for a reaction panel — it belongs to Discord, not to this editor, and is shown read-only.';
export const POSTER_GAP =
  'Honest gap: nothing renders button or select panels into Discord yet. The interaction handler (custom id rp:<panelId>:<roleId>) is live and tested, so a panel configured here is honoured the moment it exists — but no command or dashboard action posts the message, so today only reaction panels are reachable end to end.';
