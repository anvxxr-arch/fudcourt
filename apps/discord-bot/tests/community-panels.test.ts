import { describe, expect, test } from "bun:test";

import { PanelService } from "../src/community/panels.ts";
import { customId } from "../src/community/panel.ts";
import { RoleService } from "../src/community/roles.ts";
import type { RolePanel } from "../src/community/types.ts";
import type { GuildRole } from "../src/framework/types.ts";

const role = (id: string, position = 1): GuildRole => ({ id, name: id, color: 0, position, managed: false });

function build(panels: RolePanel[], held: string[] = [], roles: GuildRole[] = [role("a"), role("b"), role("c")]) {
  const replies: string[] = [];
  const calls: string[] = [];
  const roleSvc = new RoleService({
    listRoles: async () => roles,
    botTop: async () => 10,
    addRole: async (u, r) => void calls.push(`add:${r}`),
    removeRole: async (u, r) => void calls.push(`remove:${r}`),
    record: async () => {},
    log: () => {},
  });
  const svc = new PanelService({
    panels: async () => panels,
    roles: roleSvc,
    memberRoles: async () => held,
    reply: async (c) => void replies.push(c),
    log: () => {},
  });
  return { svc, replies, calls };
}

const buttonPanel = (mode: RolePanel["mode"]): RolePanel => ({
  id: "7",
  channelId: "c",
  messageId: "m",
  title: "Roles",
  description: "",
  kind: "button",
  mode,
  enabled: true,
  options: [
    { roleId: "a", label: "A", emoji: "", style: "secondary", position: 0, exclusiveGroup: "" },
    { roleId: "b", label: "B", emoji: "", style: "secondary", position: 1, exclusiveGroup: "" },
  ],
});

describe("handleComponent", () => {
  test("a toggle button grants the role and replies", async () => {
    const { svc, replies, calls } = build([buttonPanel("toggle")]);
    expect(await svc.handleComponent(customId("7", "a"), undefined, "u1")).toBe(true);
    expect(calls).toEqual(["add:a"]);
    expect(replies[0]).toContain("added");
  });

  test("an unknown panel id is still handled (a panel id, but stale)", async () => {
    const { svc, replies } = build([buttonPanel("toggle")]);
    expect(await svc.handleComponent(customId("999", "a"), undefined, "u1")).toBe(true);
    expect(replies[0]).toContain("no longer available");
  });

  test("a non-panel custom id is not handled", async () => {
    const { svc } = build([buttonPanel("toggle")]);
    expect(await svc.handleComponent("other:x:y", undefined, "u1")).toBe(false);
  });

  test("a disabled panel is not handled", async () => {
    const p = buttonPanel("toggle");
    p.enabled = false;
    const { svc, replies } = build([p]);
    expect(await svc.handleComponent(customId("7", "a"), undefined, "u1")).toBe(true);
    expect(replies[0]).toContain("no longer available");
  });

  test("select mode applies the chosen set", async () => {
    const { svc, calls } = build([buttonPanel("multiple")], ["b"]);
    expect(await svc.handleComponent(customId("7"), ["a"], "u1")).toBe(true);
    expect(calls.sort()).toEqual(["add:a", "remove:b"]);
  });
});

describe("handleReaction", () => {
  const reactionPanel = (): RolePanel => ({ ...buttonPanel("toggle"), kind: "reaction", options: [{ roleId: "a", label: "A", emoji: "👍", style: "secondary", position: 0, exclusiveGroup: "" }] });

  test("a mapped reaction grants", async () => {
    const { svc, calls } = build([reactionPanel()]);
    expect(await svc.handleReaction("m", { name: "👍" }, "u1", true)).toBe(true);
    expect(calls).toEqual(["add:a"]);
  });

  test("removing revokes", async () => {
    const { svc, calls } = build([reactionPanel()]);
    expect(await svc.handleReaction("m", { name: "👍" }, "u1", false)).toBe(true);
    expect(calls).toEqual(["remove:a"]);
  });

  test("an unmapped emoji on a panel message is handled (no-op)", async () => {
    const { svc, calls } = build([reactionPanel()]);
    expect(await svc.handleReaction("m", { name: "🔥" }, "u1", true)).toBe(true);
    expect(calls).toEqual([]);
  });

  test("an unknown message is not a panel", async () => {
    const { svc } = build([reactionPanel()]);
    expect(await svc.handleReaction("nope", { name: "👍" }, "u1", true)).toBe(false);
  });

  test("a custom emoji matches name:id", async () => {
    const p = reactionPanel();
    p.options[0]!.emoji = "star:1234";
    const { svc, calls } = build([p]);
    expect(await svc.handleReaction("m", { name: "star", id: "1234" }, "u1", true)).toBe(true);
    expect(calls).toEqual(["add:a"]);
  });
});
