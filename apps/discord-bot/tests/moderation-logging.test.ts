import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import { FudzieClient } from "../src/framework/client.ts";
import type { Rest } from "../src/framework/rest.ts";
import type { ActivityEvent } from "../src/logging/types.ts";
import type { ActivityLogger } from "../src/logging/service.ts";
import { Perm, union } from "../src/lib/permissions.ts";
import { ModerationService, type ModRequest } from "../src/moderation/service.ts";

// A FakeRest that only implements what a ban/kick needs, plus a logger spy. The
// point is the log-emission contract: a completed member action emits ONE
// activity event (moderation), and an AutoMod-sourced action emits none here
// (the AutoMod service logs it instead) — so a firing is never double-logged.

class MinimalRest {
  getCurrentUser() {
    return Promise.resolve({ id: "bot", username: "Fudzie" });
  }
  getGuild() {
    return Promise.resolve({ id: "g1", name: "G", owner_id: "owner" });
  }
  listGuildRoles() {
    return Promise.resolve([
      { id: "e", name: "@everyone", color: 0, position: 0, managed: false },
      { id: "mod", name: "Mod", color: 0, position: 5, managed: false },
      { id: "bot", name: "Fudzie", color: 0, position: 20, managed: false },
    ]);
  }
  getGuildMember(_g: string, u: string) {
    if (u === "victim") return Promise.resolve({ roles: [] });
    if (u === "bot") return Promise.resolve({ roles: ["bot"] });
    return Promise.reject(Object.assign(new Error("404"), { status: 404, notFound: true }));
  }
  banMember() {
    return Promise.resolve();
  }
  kickMember() {
    return Promise.resolve();
  }
}

function harness(): { svc: ModerationService; events: ActivityEvent[] } {
  const events: ActivityEvent[] = [];
  const logger = {
    async emitEvent(ev: ActivityEvent | null) {
      if (ev) events.push(ev);
      return true;
    },
    async emit() {
      return true;
    },
  } as unknown as ActivityLogger;
  const cfg = loadConfig({ FUDCOURT_GUILD_ID: "g1", FUDCOURT_ROLE_ADMIN: "role-admin" } as Record<string, string>);
  const client = new FudzieClient({ config: cfg, rest: new MinimalRest() as unknown as Rest, log: () => {}, logger });
  return { svc: new ModerationService(client), events };
}

function req(over: Partial<ModRequest>): ModRequest {
  return {
    action: "ban",
    guildId: "g1",
    actorId: "mod",
    actorRoles: ["mod"],
    actorPermissions: union([Perm.BAN_MEMBERS.toString(), Perm.KICK_MEMBERS.toString()]).toString(),
    ...over,
  };
}

describe("ModerationService activity logging", () => {
  test("a completed ban emits one moderation event", async () => {
    const { svc, events } = harness();
    const res = await svc.run(req({ action: "ban", targetId: "victim", reason: "spam" }));
    expect(res.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe("moderation");
    expect((events[0]?.embed.fields ?? []).find((f) => f.name === "Target")?.value).toBe("<@victim>");
  });

  test("an automod-sourced action emits no moderation event here", async () => {
    const { svc, events } = harness();
    const res = await svc.run(req({ action: "kick", targetId: "victim", source: "automod" }));
    expect(res.ok).toBe(true);
    expect(events).toHaveLength(0);
  });

  test("a refused action emits nothing", async () => {
    const { svc, events } = harness();
    const res = await svc.run(req({ action: "ban", targetId: "owner" }));
    expect(res.ok).toBe(false);
    expect(events).toHaveLength(0);
  });
});
