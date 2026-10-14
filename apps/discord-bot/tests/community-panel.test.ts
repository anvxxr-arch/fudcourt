import { describe, expect, test } from "bun:test";

import { applySelect, customId, panelIdFromCustomId, pickOption } from "../src/community/panel.ts";
import type { RolePanel } from "../src/community/types.ts";

const panel = (mode: RolePanel["mode"], opts: Array<{ roleId: string; exclusiveGroup?: string }>): RolePanel => ({
  id: "7",
  channelId: "c",
  messageId: "m",
  title: "",
  description: "",
  kind: "button",
  mode,
  enabled: true,
  options: opts.map((o, i) => ({ roleId: o.roleId, label: "", emoji: "", style: "secondary", position: i, exclusiveGroup: o.exclusiveGroup ?? "" })),
});

describe("pickOption — toggle", () => {
  const p = panel("toggle", [{ roleId: "a" }]);
  test("adds when not held", () => {
    expect(pickOption(p, p.options[0]!, [])).toEqual({ add: ["a"], remove: [] });
  });
  test("removes when held", () => {
    expect(pickOption(p, p.options[0]!, ["a"])).toEqual({ add: [], remove: ["a"] });
  });
});

describe("pickOption — single", () => {
  const p = panel("single", [{ roleId: "a" }, { roleId: "b" }]);
  test("adds the pick and removes the other held option", () => {
    expect(pickOption(p, p.options[1]!, ["a"])).toEqual({ add: ["b"], remove: ["a"] });
  });
  test("re-picking a held option is a no-op", () => {
    expect(pickOption(p, p.options[1]!, ["b"])).toEqual({ add: [], remove: [] });
  });
});

describe("pickOption — exclusive groups", () => {
  const p = panel("exclusive", [{ roleId: "asia", exclusiveGroup: "region" }, { roleId: "europe", exclusiveGroup: "region" }, { roleId: "pc", exclusiveGroup: "platform" }]);
  test("removes only same-group siblings", () => {
    expect(pickOption(p, p.options[1]!, ["asia", "pc"])).toEqual({ add: ["europe"], remove: ["asia"] });
  });
  test("a different group is untouched", () => {
    expect(pickOption(p, p.options[2]!, ["asia"])).toEqual({ add: ["pc"], remove: [] });
  });
});

describe("applySelect", () => {
  const p = panel("multiple", [{ roleId: "a" }, { roleId: "b" }, { roleId: "c" }]);
  test("adds chosen, removes un-chosen panel roles, ignores foreign roles", () => {
    expect(applySelect(p, ["a", "foreign"], ["b"])).toEqual({ add: ["a"], remove: ["b"] });
  });
  test("dropping everything removes all held panel roles", () => {
    expect(applySelect(p, [], ["a", "c"])).toEqual({ add: [], remove: ["a", "c"] });
  });
});

describe("custom id", () => {
  test("round-trips", () => {
    expect(panelIdFromCustomId(customId("7", "123"))).toEqual({ panelId: "7", roleId: "123" });
  });
  test("a select id (no role) is a panel id with an empty role", () => {
    expect(panelIdFromCustomId(customId("7"))).toEqual({ panelId: "7", roleId: "" });
  });
  test("a non-panel id is rejected", () => {
    expect(panelIdFromCustomId("other:x:y")).toBeUndefined();
    expect(panelIdFromCustomId("rp:")).toBeUndefined();
    expect(panelIdFromCustomId("rp::1")).toBeUndefined();
  });
});
