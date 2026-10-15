import type { CommandResponse, CustomCommand } from './client';

/**
 * Custom commands — declarative config, and the panel's real job is to keep it that way.
 *
 * A custom command is a trigger (plus aliases), an allow-list, a cooldown and one or more responses.
 * The bot renders a response through the SHARED pure template engine and sends the result. There is
 * no expression evaluation, no function calls, no includes, and no code path that reads the stored
 * text as anything but a string — a custom command cannot execute JS, Lua, shell or SQL. That is not
 * a policy this panel enforces; it is a property of the runtime, and the panel states it where an
 * operator will read it rather than leaving them to wonder what `{user}` might do.
 *
 * The grammar is the engine's own (`apps/discord-bot/src/community/templates.ts`): `{name}` where
 * name is `[a-z_]+`. Anything else — `{Evil}`, `{a{b}}`, a lone `{` — is not a token at all, so it is
 * passed through as literal text. A token the engine does not know is ALSO passed through verbatim,
 * deliberately: a typo shows up in the message instead of vanishing. So the worst a brace can do is
 * be displayed. The panel's job is to point at the typos, not to fear them.
 */

/** The variable set the bot supplies to a custom command (service.vars + memberVars). */
export const VARIABLES: ReadonlyArray<{ name: string; what: string }> = [
  { name: 'user', what: 'a mention of the invoker' },
  { name: 'username', what: "the invoker's username" },
  { name: 'display_name', what: 'display name, falling back to username' },
  { name: 'server', what: 'the server name' },
  { name: 'member_count', what: 'member count (empty when unknown)' },
  { name: 'created_at', what: 'account age, as Discord timestamp markup' },
  { name: 'channel', what: 'a mention of the channel' },
  { name: 'args', what: 'everything typed after the trigger' },
  { name: 'mention', what: 'the first user pinged, else the invoker' },
];

/** The engine's token grammar, copied so the panel flags exactly what the bot would substitute. */
export const TOKEN = /\{([a-z_]+)\}/g;

/** The limits the api enforces; a mirror for fast feedback, not a second authority. */
export const LIMITS = {
  commands: 100,
  aliases: 10,
  responses: 20,
  responseText: 2000,
  cooldownSeconds: 86400,
} as const;

/** nameRe mirrors the api's trigger grammar exactly (`[a-z0-9][a-z0-9_-]{0,31}`, lowercased). */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** placeholders lists the tokens the engine would substitute, in order, without duplicates. */
export function placeholders(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const name = m[1] ?? '';
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** unknownPlaceholders are the tokens the engine will send EXACTLY AS WRITTEN — i.e. typos. */
export function unknownPlaceholders(text: string): string[] {
  return placeholders(text).filter((name) => !VARIABLES.some((v) => v.name === name));
}

/** responseKind names what an operator will actually see sent. */
export function responseKind(r: CommandResponse): 'text' | 'embed' | 'text + embed' {
  const hasText = (r.text ?? '').trim() !== '';
  const hasEmbed = r.embed !== undefined && r.embed !== null;
  if (hasText && hasEmbed) return 'text + embed';
  return hasEmbed ? 'embed' : 'text';
}

/** preview collapses whitespace so a table row stays one line. */
export function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** describeTriggers is every word that answers: the name, then its aliases. */
export function describeTriggers(c: CustomCommand): { name: string; aliases: string[] } {
  return { name: c.name, aliases: c.aliases ?? [] };
}

/** splitList parses a comma/whitespace separated list, order-preserving and de-duplicated. */
export function splitList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const v = part.trim();
    if (v !== '' && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * triggerProblem mirrors the api's own two rules for a trigger namespace that is shared between names
 * and aliases, so a mistake is named before the round trip. The api stays the authority: this is a
 * subset of `validateCustomCommands`, never stricter than it.
 */
export function triggerProblem(cmds: CustomCommand[]): string | null {
  const taken = new Map<string, string>();
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i]!;
    const name = c.name.trim().toLowerCase();
    if (!NAME_RE.test(name)) {
      return `command ${i + 1}: "${c.name}" — a trigger is 1-32 chars of a-z, 0-9, _ or -, starting alphanumeric`;
    }
    const prev = taken.get(name);
    if (prev !== undefined) return `"${name}" is answered by two commands (${prev} and itself)`;
    taken.set(name, name);

    const aliases = [...new Set((c.aliases ?? []).map((a) => a.trim().toLowerCase()).filter((a) => a !== ''))];
    if (aliases.length > LIMITS.aliases) return `command ${i + 1}: at most ${LIMITS.aliases} aliases`;
    for (const a of aliases) {
      if (!NAME_RE.test(a)) return `command ${i + 1}: alias "${a}" — same grammar as a trigger`;
      const owner = taken.get(a);
      if (owner !== undefined) return `"${a}" is both an alias of ${name} and a trigger of ${owner}`;
      taken.set(a, name);
    }
    if ((c.responses ?? []).length === 0) return `command ${i + 1}: at least one response is required`;
    if ((c.responses ?? []).length > LIMITS.responses) return `command ${i + 1}: at most ${LIMITS.responses} responses`;
  }
  return null;
}

/** The editable row shape. Numbers stay text so a half-typed value is never coerced to 0. */
export type ResponseDraft = { text: string; embed?: unknown };
export type CommandDraft = {
  id?: number;
  name: string;
  aliases: string;
  responses: ResponseDraft[];
  allowedRoles: string;
  allowedChannels: string;
  cooldownSeconds: string;
  deleteTrigger: boolean;
  reply: boolean;
  dm: boolean;
  enabled: boolean;
};

export function toDraft(cmds: CustomCommand[]): CommandDraft[] {
  return cmds.map((c) => ({
    id: c.id,
    name: c.name,
    aliases: (c.aliases ?? []).join(', '),
    responses: (c.responses ?? []).map((r) => ({ text: r.text ?? '', embed: r.embed })),
    allowedRoles: (c.allowedRoles ?? []).join(', '),
    allowedChannels: (c.allowedChannels ?? []).join(', '),
    cooldownSeconds: String(c.cooldownSeconds ?? 0),
    deleteTrigger: !!c.deleteTrigger,
    reply: !!c.reply,
    dm: !!c.dm,
    enabled: !!c.enabled,
  }));
}

/**
 * fromDraft builds the payload the api validates. An embed is carried through UNTOUCHED and a
 * response that is only an embed is sent without a text field, because this dashboard edits text and
 * must not rewrite — or silently drop — an embed it cannot edit.
 */
export function fromDraft(rows: CommandDraft[]): CustomCommand[] {
  return rows.map((r) => {
    const responses: CommandResponse[] = [];
    for (const rp of r.responses) {
      const text = rp.text.trim();
      const embed = rp.embed === null ? undefined : rp.embed;
      if (text === '' && embed === undefined) continue; // an entry with neither cannot be stored
      responses.push(text === '' ? { embed } : embed === undefined ? { text } : { text, embed });
    }
    return {
      id: r.id,
      name: r.name.trim().toLowerCase(),
      aliases: splitList(r.aliases.toLowerCase()),
      responses,
      allowedRoles: splitList(r.allowedRoles),
      allowedChannels: splitList(r.allowedChannels),
      cooldownSeconds: Number.parseInt(r.cooldownSeconds, 10) || 0,
      deleteTrigger: r.deleteTrigger,
      reply: r.reply,
      dm: r.dm,
      enabled: r.enabled,
    };
  });
}

export function summarize(cmds: CustomCommand[]): { total: number; disabled: number; embedded: number } {
  return {
    total: cmds.length,
    disabled: cmds.filter((c) => !c.enabled).length,
    embedded: cmds.filter((c) => (c.responses ?? []).some((r) => r.embed !== undefined && r.embed !== null)).length,
  };
}

export const RCE_NOTE =
  'A response is DATA, never code: the bot renders it through the same pure template engine as welcome messages and sends the result. There is no JavaScript, Lua, shell or SQL path, no expression evaluation and no function call — nothing between the braces is executed, so a response cannot run anything.';

export const GRAMMAR_NOTE =
  'Only `{name}` with a name of a-z/0-9/_ is a token. `{Evil}` or a stray `{` is text the bot passes through untouched, and a token with no matching variable is sent EXACTLY AS WRITTEN — so a typo appears in the message rather than disappearing. The panel flags those typos; it never treats them as a threat.';

export const NORMALISE_NOTE =
  'Saving replaces the whole set in one transaction. The api lowercases names and trims, lowercases and de-duplicates aliases, and refuses two commands that answer the same word — the trigger namespace is shared between names and aliases. What comes back is what is stored, so the editor adopts it.';

export const EMBED_NOTE =
  'This editor writes text. A response that carries an embed (`jsonb`) is preserved byte-for-byte and never rewritten — the embed is shown as read-only, because an editor that cannot read a field must not replace it.';
