// Panel posting — PURE. Turns a stored role panel into the message the bot
// posts: the body, the action rows Discord accepts, and the reactions to add.
// No client, no REST, so the shape is asserted directly instead of only through
// a live guild.
//
// WHY THIS EXISTS: a panel could be configured but never posted. Nothing in the
// bot called `customId()`, because the REST layer could not carry components at
// all (InteractionCallbackData had no `components` field) — so a button/select
// panel was unreachable, and a reaction panel needed a human to post the message
// and paste its id into the config. The poster closes both: the bot posts the
// message, adds the reactions, and records the message id back over loopback.

import { ButtonStyle, ComponentType, type ActionRow, type ButtonComponent, type APIEmoji } from "../framework/types.ts";
import { customId } from "./panel.ts";
import type { RolePanel } from "./types.ts";

export type { ActionRow };

/**
 * The stored button style names, mapped to Discord's style numbers. The four
 * names are the schema's CHECK set — so the mapping is 1:1 and a stored style is
 * always postable; an unknown value (a hand-written row) falls back to secondary
 * rather than being posted as a style Discord would reject.
 */
export const BUTTON_STYLES: Record<string, number> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};
export const DEFAULT_BUTTON_STYLE = ButtonStyle.Secondary;

/** Discord's own ceilings for one message. */
export const MAX_CONTENT = 2000;
export const MAX_BUTTONS_PER_ROW = 5;
export const MAX_ROWS = 5;
export const MAX_SELECT_OPTIONS = 25;
export const MAX_BUTTON_LABEL = 80;
export const MAX_SELECT_LABEL = 100;

export interface PanelPost {
  /** The message body: the panel's title and description, one per line. */
  content: string;
  /** Ready for `createMessage` — empty for a reaction panel. */
  components: ActionRow[];
  /** The emoji keys to react with, in option order (reaction panels only). */
  reactions: string[];
}

/**
 * parseEmoji turns a stored emoji key back into the object Discord wants: a
 * custom emoji is stored as `name:id` (see emojiKey) and posts as `{name, id}`;
 * anything else is a unicode emoji and posts as `{name}`.
 */
export function parseEmoji(key: string): APIEmoji | undefined {
  const trimmed = key.trim();
  if (trimmed === "") return undefined;
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const name = trimmed.slice(0, colon);
    const id = trimmed.slice(colon + 1);
    if (name !== "" && /^\d+$/.test(id)) return { name, id };
  }
  return { name: trimmed };
}

/**
 * panelPostProblem reports why a panel CANNOT be posted ("" when it can). It is
 * deliberately narrower than the api's validator: everything here is a
 * platform-side limit the api does not know about, or a stale row the api would
 * have refused. Problems that only make an option DEAD are warnings, not
 * refusals — see panelPostNotes.
 */
export function panelPostProblem(panel: RolePanel): string {
  if (panel.id.trim() === "") return "the panel has no id";
  if (panel.kind !== "reaction" && panel.kind !== "button" && panel.kind !== "select")
    return `unknown panel kind "${panel.kind}" — expected reaction, button or select`;
  if (panel.options.length === 0) return "the panel has no options";
  const content = panelContent(panel);
  if (content.length > MAX_CONTENT)
    return `the title and description are ${content.length} characters; Discord allows ${MAX_CONTENT} per message`;
  if (panel.kind === "select" && panel.options.length > MAX_SELECT_OPTIONS)
    return `a select menu holds at most ${MAX_SELECT_OPTIONS} options, this panel has ${panel.options.length}`;
  if (panel.kind === "button" && panel.options.length > MAX_ROWS * MAX_BUTTONS_PER_ROW)
    return `Discord shows at most ${MAX_ROWS * MAX_BUTTONS_PER_ROW} buttons (${MAX_ROWS} rows of ${MAX_BUTTONS_PER_ROW}), this panel has ${panel.options.length}`;
  return "";
}
/**
 * panelPostNotes lists what will make the posted panel behave worse than it
 * looks: options that can never fire, invisible buttons, and a panel that is
 * switched off (whose controls answer "no longer available"). The post still
 * goes out — an operator may be mid-setup — but the command says all of it.
 */
export function panelPostNotes(panel: RolePanel): string[] {
  const notes: string[] = [];
  if (!panel.enabled) notes.push("this panel is switched off — members will be told it is no longer available");
  if (panel.kind === "reaction") {
    const dead = panel.options.filter((o) => o.emoji.trim() === "").map((o) => o.roleId);
    if (dead.length > 0) notes.push(`${dead.length} option(s) have no emoji and can never fire: ${dead.join(", ")}`);
  }
  if (panel.kind === "button") {
    const blank = panel.options.filter((o) => o.label.trim() === "" && o.emoji.trim() === "").map((o) => o.roleId);
    if (blank.length > 0) notes.push(`${blank.length} button(s) would have neither a label nor an emoji: ${blank.join(", ")}`);
  }
  return notes;
}

/** The message body a panel posts: the title, then the description. */
export function panelContent(panel: RolePanel): string {
  return [panel.title.trim(), panel.description.trim()].filter((line) => line !== "").join("\n");
}

/**
 * buildPanelPost renders the message payload. Buttons are chunked into rows of
 * five (Discord's per-row limit); a select is one row carrying every option in
 * order, with max_values following the mode so a single-choice panel cannot be
 * submitted with several picks.
 */
export function buildPanelPost(panel: RolePanel): PanelPost {
  const content = panelContent(panel);
  if (panel.kind === "reaction") {
    return { content, components: [], reactions: panel.options.map((o) => o.emoji.trim()).filter((e) => e !== "") };
  }
  if (panel.kind === "select") {
    return {
      content,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: customId(panel.id),
              options: panel.options.map((o) => {
                const emoji = parseEmoji(o.emoji);
                return {
                  label: (o.label.trim() || o.roleId).slice(0, MAX_SELECT_LABEL),
                  value: o.roleId,
                  ...(emoji ? { emoji } : {}),
                };
              }),
              min_values: 0,
              max_values: panel.mode === "multiple" ? panel.options.length : 1,
              placeholder: panel.title.trim() === "" ? "Pick your roles" : panel.title.trim().slice(0, MAX_SELECT_LABEL),
            },
          ],
        },
      ],
      reactions: [],
    };
  }
  const buttons: ButtonComponent[] = panel.options.map((o) => {
    const label = o.label.trim().slice(0, MAX_BUTTON_LABEL);
    const emoji = parseEmoji(o.emoji);
    return {
      type: ComponentType.Button,
      style: BUTTON_STYLES[o.style] ?? DEFAULT_BUTTON_STYLE,
      custom_id: customId(panel.id, o.roleId),
      ...(label !== "" ? { label } : {}),
      ...(emoji ? { emoji } : {}),
    };
  });
  const rows: ActionRow[] = [];
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push({ type: ComponentType.ActionRow, components: buttons.slice(i, i + MAX_BUTTONS_PER_ROW) });
  }
  return { content, components: rows, reactions: [] };
}
