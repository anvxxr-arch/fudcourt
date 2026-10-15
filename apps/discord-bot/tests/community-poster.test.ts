import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { emojiKey } from "../src/community/panels.ts";
import { customId, panelIdFromCustomId } from "../src/community/panel.ts";
import { ComponentType } from "../src/framework/types.ts";
import {
  BUTTON_STYLES,
  MAX_BUTTONS_PER_ROW,
  MAX_CONTENT,
  MAX_ROWS,
  MAX_SELECT_OPTIONS,
  buildPanelPost,
  panelContent,
  panelPostNotes,
  panelPostProblem,
  parseEmoji,
} from "../src/community/poster.ts";
import type { RolePanel, RolePanelOption } from "../src/community/types.ts";

const opt = (o: Partial<RolePanelOption> = {}): RolePanelOption => ({
  roleId: "100000000000000010",
  label: "",
  emoji: "",
  style: "secondary",
  position: 0,
  exclusiveGroup: "",
  ...o,
});

const panel = (o: Partial<RolePanel> = {}): RolePanel => ({
  id: "colors",
  channelId: "100000000000000001",
  messageId: "",
  title: "",
  description: "",
  kind: "button",
  mode: "toggle",
  enabled: true,
  options: [opt()],
  ...o,
});

describe("poster — the wire constants are Discord's own numbers", () => {
  test("component types and button styles are the values the API documents", () => {
    expect(ComponentType.ActionRow).toBe(1);
    expect(ComponentType.Button).toBe(2);
    expect(ComponentType.StringSelect).toBe(3);
    expect([...Object.values(BUTTON_STYLES)].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("poster — the styles it can emit are the styles the schema stores", () => {
  test("the button style names are exactly the schema's CHECK set", () => {
    const schema = readFileSync(new URL("../../../db/schema/pg-schema.sql", import.meta.url), "utf8");
    const m = schema.match(/CONSTRAINT\s+role_panel_options_style_chk\s+CHECK\s*\(style IN \(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    const names = [...m![1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
    expect(Object.keys(BUTTON_STYLES).sort()).toEqual(names as string[]);
  });

  test("an unknown stored style falls back to secondary instead of posting what Discord would reject", () => {
    const p = panel({ options: [opt({ style: "neon" }), opt({ roleId: "100000000000000011", style: "danger" })] });
    const rows = buildPanelPost(p).components;
    const styles = rows.flatMap((r) => r.components.map((c) => (c.type === ComponentType.Button ? c.style : -1)));
    expect(styles).toEqual([BUTTON_STYLES.secondary, BUTTON_STYLES.danger]);
  });
});

describe("poster — the ids it posts are the ids the handler parses", () => {
  test("every button's custom_id round-trips through panelIdFromCustomId", () => {
    const p = panel({ options: [opt({ roleId: "111111111111111111" }), opt({ roleId: "222222222222222222" })] });
    const buttons = buildPanelPost(p).components.flatMap((r) => r.components);
    expect(buttons).toHaveLength(2);
    for (const [i, b] of buttons.entries()) {
      expect(b.type).toBe(ComponentType.Button);
      const parsed = panelIdFromCustomId((b as { custom_id: string }).custom_id);
      expect(parsed).toEqual({ panelId: "colors", roleId: p.options[i]!.roleId });
    }
  });

  test("a select's custom_id is the panel id alone — the picks travel in values", () => {
    const sel = buildPanelPost(panel({ kind: "select" })).components[0]!.components[0]!;
    expect(sel.type).toBe(ComponentType.StringSelect);
    expect(panelIdFromCustomId((sel as { custom_id: string }).custom_id)).toEqual({ panelId: "colors", roleId: "" });
  });

  test("a posted emoji is the inverse of the handler's emojiKey", () => {
    expect(parseEmoji(emojiKey({ name: "rules", id: "42" }))).toEqual({ name: "rules", id: "42" });
    expect(parseEmoji(emojiKey({ name: "👍" }))).toEqual({ name: "👍" });
    expect(parseEmoji(emojiKey({ name: "rules", id: "42" }))).toEqual({ name: "rules", id: "42" });
    // the handler compares the KEY exactly, so the posted form must not add noise
    expect(emojiKey(parseEmoji("rules:42"))).toBe("rules:42");
    expect(emojiKey(parseEmoji("👍"))).toBe("👍");
  });
});

describe("poster — the message shape", () => {
  test("the body is the title then the description, blank lines dropped", () => {
    expect(panelContent(panel({ title: "Colours", description: "Pick one" }))).toBe("Colours\nPick one");
    expect(panelContent(panel({ title: "", description: "only" }))).toBe("only");
    expect(panelContent(panel())).toBe("");
  });

  test("buttons are chunked five per row", () => {
    const p = panel({ options: Array.from({ length: 7 }, (_, i) => opt({ roleId: `1000000000000000${10 + i}` })) });
    const rows = buildPanelPost(p).components;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.components).toHaveLength(MAX_BUTTONS_PER_ROW);
    expect(rows[1]!.components).toHaveLength(2);
    expect(rows.every((r) => r.type === ComponentType.ActionRow)).toBe(true);
    expect(rows.every((r) => r.components.length <= MAX_BUTTONS_PER_ROW)).toBe(true);
  });

  test("a label is dropped when it is blank, and an emoji alone is a valid button", () => {
    const p = panel({ options: [opt({ label: "", emoji: "👍" })] });
    const b = buildPanelPost(p).components[0]!.components[0]! as unknown as Record<string, unknown>;
    expect("label" in b).toBe(false);
    expect(b.emoji).toEqual({ name: "👍" });
  });

  test("a select carries every option in order and follows the mode for max_values", () => {
    const options = [opt({ roleId: "111111111111111111", label: "Red" }), opt({ roleId: "222222222222222222" })];
    const multi = buildPanelPost(panel({ kind: "select", mode: "multiple", options })).components[0]!.components[0]! as unknown as Record<string, unknown>;
    const opts = multi.options as Array<Record<string, unknown>>;
    expect(opts.map((o) => o.value)).toEqual(["111111111111111111", "222222222222222222"]);
    expect(opts[0]!.label).toBe("Red");
    expect(opts[1]!.label).toBe("222222222222222222"); // a select label is required, so the id stands in
    expect(multi.max_values).toBe(2);
    const single = buildPanelPost(panel({ kind: "select", mode: "single", options })).components[0]!.components[0]! as unknown as Record<string, unknown>;
    expect(single.max_values).toBe(1);
  });

  test("a reaction panel posts no components and reacts in option order, skipping blanks", () => {
    const p = panel({
      kind: "reaction",
      options: [opt({ emoji: "🍎" }), opt({ roleId: "100000000000000011", emoji: "" }), opt({ roleId: "100000000000000012", emoji: "rules:42" })],
    });
    const post = buildPanelPost(p);
    expect(post.components).toEqual([]);
    expect(post.reactions).toEqual(["🍎", "rules:42"]);
  });
});

describe("poster — what makes a panel unpostable, and what merely makes it bad", () => {
  test("a postable panel reports no problem", () => {
    expect(panelPostProblem(panel())).toBe("");
  });

  test("refusals name the platform limit, not a guess", () => {
    expect(panelPostProblem(panel({ id: "  " }))).toBe("the panel has no id");
    expect(panelPostProblem(panel({ kind: "vibes" as unknown as RolePanel["kind"] }))).toMatch(/unknown panel kind/);
    expect(panelPostProblem(panel({ options: [] }))).toBe("the panel has no options");
    const long = panel({ description: "x".repeat(MAX_CONTENT + 1) });
    expect(panelPostProblem(long)).toMatch(new RegExp(`^the title and description are ${MAX_CONTENT + 1} characters; Discord allows ${MAX_CONTENT}`));
    expect(panelPostProblem(panel({ kind: "select", options: Array.from({ length: MAX_SELECT_OPTIONS + 1 }, () => opt()) }))).toMatch(/select menu holds at most 25/);
    expect(panelPostProblem(panel({ options: Array.from({ length: MAX_ROWS * MAX_BUTTONS_PER_ROW + 1 }, () => opt()) }))).toMatch(/at most 25 buttons/);
  });

  test("an off panel, dead reaction options and invisible buttons are notes — the post still goes out", () => {
    expect(panelPostNotes(panel({ enabled: false, options: [opt({ label: "Red" })] }))).toEqual([
      "this panel is switched off — members will be told it is no longer available",
    ]);
    const dead = panel({ kind: "reaction", options: [opt({ roleId: "111111111111111111", emoji: "" }), opt({ emoji: "🍎" })] });
    expect(panelPostNotes(dead)).toEqual(["1 option(s) have no emoji and can never fire: 111111111111111111"]);
    const invisible = panel({ options: [opt({ roleId: "111111111111111111", label: "", emoji: "" })] });
    expect(panelPostNotes(invisible)).toEqual(["1 button(s) would have neither a label nor an emoji: 111111111111111111"]);
    expect(panelPostNotes(panel({ options: [opt({ label: "Red", emoji: "" })] }))).toEqual([]);
    // a note never blocks the post
    expect(panelPostProblem(dead)).toBe("");
  });

  test("parseEmoji keeps a colon that is not a custom-emoji id", () => {
    expect(parseEmoji("")).toBeUndefined();
    expect(parseEmoji("  ")).toBeUndefined();
    expect(parseEmoji("a:b")).toEqual({ name: "a:b" });
    expect(parseEmoji("🍎")).toEqual({ name: "🍎" });
  });
});

describe("poster — the built ids match what the handler is given", () => {
  test("customId is the same function the handler parses, for a button and a select", () => {
    expect(customId("p", "r")).toBe("rp:p:r");
    expect(customId("p")).toBe("rp:p");
    expect(panelIdFromCustomId(customId("p", "r"))).toEqual({ panelId: "p", roleId: "r" });
  });
});
