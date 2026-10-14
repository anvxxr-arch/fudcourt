import { describe, expect, test } from "bun:test";

import { selectAutoroles } from "../src/community/autorole.ts";
import type { AutoroleRule } from "../src/community/types.ts";

const rule = (over: Partial<AutoroleRule>): AutoroleRule => ({
  id: "1",
  roleId: "r",
  kind: "on_join",
  delaySeconds: 0,
  appliesTo: "all",
  enabled: true,
  priority: 0,
  ...over,
});

describe("selectAutoroles", () => {
  test("on_join is immediate", () => {
    const sel = selectAutoroles([rule({ roleId: "a" })], false);
    expect(sel.immediate.map((r) => r.roleId)).toEqual(["a"]);
    expect(sel.delayed).toEqual([]);
    expect(sel.deferred).toEqual([]);
  });

  test("after_duration with a delay goes to delayed, with 0 to immediate", () => {
    const sel = selectAutoroles(
      [rule({ id: "1", roleId: "d", kind: "after_duration", delaySeconds: 300 }), rule({ id: "2", roleId: "z", kind: "after_duration", delaySeconds: 0 })],
      false,
    );
    expect(sel.delayed).toHaveLength(1);
    expect(sel.delayed[0]).toMatchObject({ delaySeconds: 300 });
    expect(sel.delayed[0]!.rule.roleId).toBe("d");
    expect(sel.immediate.map((r) => r.roleId)).toEqual(["z"]);
  });

  test("after_verification is deferred", () => {
    const sel = selectAutoroles([rule({ roleId: "v", kind: "after_verification" })], false);
    expect(sel.deferred.map((r) => r.roleId)).toEqual(["v"]);
    expect(sel.immediate).toEqual([]);
  });

  test("a disabled rule is dropped", () => {
    const sel = selectAutoroles([rule({ roleId: "a", enabled: false })], false);
    expect(sel.immediate).toEqual([]);
  });

  test("human-only rules skip bots", () => {
    const sel = selectAutoroles([rule({ roleId: "h", appliesTo: "human" })], true);
    expect(sel.immediate).toEqual([]);
  });

  test("bot-only rules skip humans", () => {
    const sel = selectAutoroles([rule({ roleId: "b", appliesTo: "bot" })], false);
    expect(sel.immediate).toEqual([]);
  });

  test("higher priority comes first", () => {
    const sel = selectAutoroles([rule({ id: "1", roleId: "lo", priority: 1 }), rule({ id: "2", roleId: "hi", priority: 9 })], false);
    expect(sel.immediate.map((r) => r.roleId)).toEqual(["hi", "lo"]);
  });
});
