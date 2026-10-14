import { describe, expect, test } from "bun:test";

import { RoleService, type RoleAssignment } from "../src/community/roles.ts";
import type { GuildRole } from "../src/framework/types.ts";

const role = (id: string, position: number): GuildRole => ({ id, name: id, color: 0, position, managed: false });

function harness(roles: GuildRole[], botTop: number, opts: { addFails?: boolean } = {}) {
  const recorded: RoleAssignment[] = [];
  const calls: string[] = [];
  const svc = new RoleService({
    listRoles: async () => roles,
    botTop: async () => botTop,
    addRole: async (u, r) => {
      calls.push(`add:${u}:${r}`);
      if (opts.addFails) throw new Error("Missing Permissions");
    },
    removeRole: async (u, r) => {
      calls.push(`remove:${u}:${r}`);
    },
    record: async (a) => {
      recorded.push(a);
    },
    log: () => {},
  });
  return { svc, recorded, calls };
}

describe("canManage", () => {
  const roles = [role("low", 1), role("high", 9)];
  test("a role below the bot top is manageable", () => {
    const { svc } = harness(roles, 10);
    expect(svc.canManage("low", roles, 10)).toEqual({ ok: true, reason: "" });
  });
  test("a role at the bot top is refused", () => {
    const { svc } = harness(roles, 10);
    expect(svc.canManage("high", roles, 9).ok).toBe(false);
  });
  test("a missing role is refused", () => {
    const { svc } = harness(roles, 10);
    expect(svc.canManage("nope", roles, 10).ok).toBe(false);
  });
});

describe("grant / revoke", () => {
  test("grant records an ok assignment and calls addRole", async () => {
    const { svc, recorded, calls } = harness([role("r", 1)], 10);
    expect(await svc.grant("u1", "r", "autorole")).toBe(true);
    expect(calls).toEqual(["add:u1:r"]);
    expect(recorded[0]).toMatchObject({ userId: "u1", roleId: "r", action: "add", status: "ok" });
  });

  test("a role above the bot is refused AND recorded as failed", async () => {
    const { svc, recorded, calls } = harness([role("r", 50)], 10);
    expect(await svc.grant("u1", "r", "autorole")).toBe(false);
    expect(calls).toEqual([]);
    expect(recorded[0]).toMatchObject({ status: "failed" });
    expect(recorded[0]!.error).toContain("highest role");
  });

  test("a Discord API failure is recorded with the error text", async () => {
    const { svc, recorded } = harness([role("r", 1)], 10, { addFails: true });
    expect(await svc.grant("u1", "r", "panel")).toBe(false);
    expect(recorded[0]).toMatchObject({ status: "failed" });
    expect(recorded[0]!.error).toContain("Missing Permissions");
  });

  test("revoke removes", async () => {
    const { svc, calls } = harness([role("r", 1)], 10);
    expect(await svc.revoke("u1", "r", "panel")).toBe(true);
    expect(calls).toEqual(["remove:u1:r"]);
  });
});

describe("apply", () => {
  test("grants then revokes, counting each", async () => {
    const { svc, calls } = harness([role("a", 1), role("b", 2)], 10);
    const res = await svc.apply("u1", ["a"], ["b"], "panel");
    expect(res).toEqual({ ok: 2, failed: 0 });
    expect(calls).toEqual(["add:u1:a", "remove:u1:b"]);
  });
});
