import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import { Command } from "../src/framework/command.ts";
import { FudzieClient } from "../src/framework/client.ts";
import type { Rest } from "../src/framework/rest.ts";
import { CommandStore } from "../src/framework/store.ts";
import { ApplicationCommandType, type GuildMember, type GuildRole, type Interaction } from "../src/framework/types.ts";
import { has, Perm, union } from "../src/lib/permissions.ts";
import { guardTarget, topPosition } from "../src/moderation/hierarchy.ts";
import { ModerationService, type ModRequest } from "../src/moderation/service.ts";
import { userContext } from "../src/commands/moderation/_context.ts";
import { ModOnly } from "../src/preconditions/ModOnly.ts";

// ------------------------------------------------------------ permissions
describe("permissions", () => {
  test("a granted bit is detected; an absent bit is not", () => {
    const perms = Perm.BAN_MEMBERS.toString();
    expect(has(perms, Perm.BAN_MEMBERS)).toBe(true);
    expect(has(perms, Perm.KICK_MEMBERS)).toBe(false);
  });

  test("ADMINISTRATOR implies every permission", () => {
    const admin = Perm.ADMINISTRATOR.toString();
    expect(has(admin, Perm.BAN_MEMBERS)).toBe(true);
    expect(has(admin, Perm.MANAGE_ROLES)).toBe(true);
  });

  test("a bit above 2^31 is handled with BigInt, not a truncated number", () => {
    // MODERATE_MEMBERS is bit 40 — a `number` AND would silently drop it.
    const only = Perm.MODERATE_MEMBERS.toString();
    expect(has(only, Perm.MODERATE_MEMBERS)).toBe(true);
    expect(has(only, Perm.BAN_MEMBERS)).toBe(false);
  });

  test("missing, empty, or garbage permissions fail closed", () => {
    expect(has(undefined, Perm.BAN_MEMBERS)).toBe(false);
    expect(has(null, Perm.BAN_MEMBERS)).toBe(false);
    expect(has("", Perm.BAN_MEMBERS)).toBe(false);
    expect(has("not-a-number", Perm.BAN_MEMBERS)).toBe(false);
    expect(has("-8", Perm.BAN_MEMBERS)).toBe(false);
  });

  test("union ORs several role bitfields", () => {
    const a = Perm.KICK_MEMBERS.toString();
    const b = Perm.BAN_MEMBERS.toString();
    const merged = union([a, b, undefined, "garbage"]);
    expect((merged & Perm.KICK_MEMBERS) !== 0n).toBe(true);
    expect((merged & Perm.BAN_MEMBERS) !== 0n).toBe(true);
    expect((merged & Perm.MANAGE_ROLES) !== 0n).toBe(false);
  });
});

// -------------------------------------------------------------- hierarchy
describe("hierarchy", () => {
  const roles: GuildRole[] = [
    { id: "e", name: "@everyone", color: 0, position: 0, managed: false },
    { id: "mod", name: "Mod", color: 0, position: 5, managed: false },
    { id: "admin", name: "Admin", color: 0, position: 10, managed: false },
    { id: "bot", name: "Fudzie", color: 0, position: 20, managed: false },
  ];

  test("topPosition returns the highest held role, 0 when unroled", () => {
    expect(topPosition(["mod", "e"], roles)).toBe(5);
    expect(topPosition(["admin", "mod"], roles)).toBe(10);
    expect(topPosition(["e"], roles)).toBe(0);
    expect(topPosition([], roles)).toBe(0);
    expect(topPosition(["ghost"], roles)).toBe(0);
  });

  const base = {
    actorId: "actor",
    targetId: "target",
    ownerId: "owner",
    botUserId: "bot",
    actorTop: 10,
    botTop: 20,
    targetTop: 5,
    actorIsOwner: false,
  };

  test("the guild owner can never be moderated", () => {
    expect(guardTarget({ ...base, targetId: "owner" }).ok).toBe(false);
  });

  test("you cannot moderate yourself", () => {
    expect(guardTarget({ ...base, targetId: "actor" }).ok).toBe(false);
  });

  test("the bot cannot moderate itself", () => {
    expect(guardTarget({ ...base, targetId: "bot" }).ok).toBe(false);
  });

  test("a target at or above the bot's role is refused", () => {
    expect(guardTarget({ ...base, targetTop: 20 }).ok).toBe(false);
    expect(guardTarget({ ...base, targetTop: 25 }).ok).toBe(false);
  });

  test("a target at or above the actor's role is refused (unless owner)", () => {
    expect(guardTarget({ ...base, targetTop: 10 }).ok).toBe(false);
    expect(guardTarget({ ...base, targetTop: 10, actorIsOwner: true }).ok).toBe(true);
  });

  test("a valid lower-ranked target passes", () => {
    expect(guardTarget(base).ok).toBe(true);
  });
});

// -------------------------------------------------- ModerationService
// A hand-rolled Rest double: it records every call and returns canned data, so
// the service's permission + hierarchy + dispatch logic is exercised end to end
// without touching discord.com.
interface Call {
  method: string;
  path: string;
  body?: unknown;
  reason?: string;
}

class FakeRest {
  readonly calls: Call[] = [];
  guild: { id: string; name: string; owner_id?: string } = { id: "g1", name: "G", owner_id: "owner" };
  roles: GuildRole[] = [
    { id: "e", name: "@everyone", color: 0, position: 0, managed: false },
    { id: "mod", name: "Mod", color: 0, position: 5, managed: false },
    { id: "bot", name: "Fudzie", color: 0, position: 20, managed: false },
  ];
  members: Record<string, GuildMember> = {
    bot: { roles: ["bot"] },
    victim: { roles: [] },
    mod: { roles: ["mod"] },
    owner: { roles: [] },
    above: { roles: ["bot"] },
  };
  messages: Array<{ id: string }> = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
  unbanNotFound = false;

  private rec(method: string, path: string, body?: unknown, reason?: string): void {
    this.calls.push({ method, path, body, reason });
  }

  getCurrentUser(): Promise<{ id: string; username: string }> {
    return Promise.resolve({ id: "bot", username: "Fudzie" });
  }
  getGuild(): Promise<typeof this.guild> {
    return Promise.resolve(this.guild);
  }
  listGuildRoles(): Promise<GuildRole[]> {
    return Promise.resolve(this.roles);
  }
  getGuildMember(_g: string, u: string): Promise<GuildMember> {
    const m = this.members[u];
    if (!m) return Promise.reject(Object.assign(new Error("Discord 404 member"), { status: 404, notFound: true }));
    return Promise.resolve(m);
  }
  banMember(_g: string, u: string, o: { reason?: string; deleteMessageSeconds?: number } = {}): Promise<void> {
    this.rec("PUT", `/guilds/g1/bans/${u}`, o.deleteMessageSeconds, o.reason);
    return Promise.resolve();
  }
  unbanMember(_g: string, u: string, o: { reason?: string } = {}): Promise<void> {
    if (this.unbanNotFound) {
      return Promise.reject(Object.assign(new Error("Discord 404"), { status: 404, notFound: true }));
    }
    this.rec("DELETE", `/guilds/g1/bans/${u}`, undefined, o.reason);
    return Promise.resolve();
  }
  kickMember(_g: string, u: string, o: { reason?: string } = {}): Promise<void> {
    this.rec("DELETE", `/guilds/g1/members/${u}`, undefined, o.reason);
    return Promise.resolve();
  }
  modifyMember(_g: string, u: string, b: unknown, o: { reason?: string } = {}): Promise<void> {
    this.rec("PATCH", `/guilds/g1/members/${u}`, b, o.reason);
    return Promise.resolve();
  }
  listMessages(_c: string, limit: number): Promise<Array<{ id: string }>> {
    this.rec("GET", `/channels/c1/messages?limit=${limit}`);
    return Promise.resolve(this.messages.slice(0, limit));
  }
  bulkDeleteMessages(_c: string, ids: string[]): Promise<void> {
    this.rec("POST", `/channels/c1/messages/bulk-delete`, ids);
    return Promise.resolve();
  }
  deleteMessage(_c: string, id: string): Promise<void> {
    this.rec("DELETE", `/channels/c1/messages/${id}`);
    return Promise.resolve();
  }
  modifyChannel(_c: string, b: unknown): Promise<void> {
    this.rec("PATCH", `/channels/c1`, b);
    return Promise.resolve();
  }
  editChannelPermissions(_c: string, o: string, b: unknown): Promise<void> {
    this.rec("PUT", `/channels/c1/permissions/${o}`, b);
    return Promise.resolve();
  }
  /** The interaction reply — recorded so routing tests can assert it happened. */
  readonly responses: Array<{ type: number; data?: { content?: string } }> = [];
  createInteractionResponse(_id: string, _token: string, type: number, data?: { content?: string }): Promise<void> {
    this.responses.push({ type, data });
    return Promise.resolve();
  }
  createFollowup(): Promise<unknown> {
    return Promise.resolve({});
  }
}

function service(): { svc: ModerationService; rest: FakeRest } {
  const rest = new FakeRest();
  const cfg = loadConfig({ FUDCOURT_GUILD_ID: "g1", FUDCOURT_ROLE_ADMIN: "role-admin" } as Record<string, string>);
  const client = new FudzieClient({ config: cfg, rest: rest as unknown as Rest, log: () => {} });
  return { svc: new ModerationService(client), rest };
}

/** A base request for a moderator holding a full permission set. */
function modReq(over: Partial<ModRequest>): ModRequest {
  return {
    action: "ban",
    guildId: "g1",
    actorId: "mod",
    actorRoles: ["mod"],
    actorPermissions: union([Perm.BAN_MEMBERS.toString(), Perm.KICK_MEMBERS.toString(), Perm.MANAGE_MESSAGES.toString(), Perm.MANAGE_CHANNELS.toString(), Perm.MODERATE_MEMBERS.toString()]).toString(),
    ...over,
  };
}

describe("ModerationService", () => {
  test("a permitted ban of a lower-ranked member succeeds and hits the ban route", async () => {
    const { svc, rest } = service();
    const res = await svc.run(modReq({ action: "ban", targetId: "victim", reason: "spam" }));
    expect(res.ok).toBe(true);
    const call = rest.calls.find((c) => c.method === "PUT" && c.path.includes("/bans/"));
    expect(call).toBeDefined();
    expect(call?.path).toContain("victim");
    expect(call?.reason).toBe("spam");
  });

  test("the server owner cannot be moderated", async () => {
    const { svc, rest } = service();
    const res = await svc.run(modReq({ action: "ban", targetId: "owner" }));
    expect(res.ok).toBe(false);
    expect(res.refusal).toContain("owner");
    expect(rest.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("a moderator without the permission is refused before any REST call", async () => {
    const { svc, rest } = service();
    const res = await svc.run(modReq({ action: "ban", targetId: "victim", actorPermissions: "0" }));
    expect(res.ok).toBe(false);
    expect(res.refusal).toContain("Ban Members");
    expect(rest.calls.length).toBe(0);
  });

  test("a target at or above the actor's role is refused", async () => {
    const { svc } = service();
    const res = await svc.run(modReq({ action: "ban", targetId: "above" }));
    expect(res.ok).toBe(false);
  });

  test("a target not in the guild is reported clearly", async () => {
    const { svc } = service();
    const res = await svc.run(modReq({ action: "kick", targetId: "ghost" }));
    expect(res.ok).toBe(false);
    expect(res.refusal).toContain("not in this server");
  });

  test("unban succeeds, and a 404 means 'not banned'", async () => {
    const { svc, rest } = service();
    const ok = await svc.run(modReq({ action: "unban", targetId: "victim" }));
    expect(ok.ok).toBe(true);
    expect(rest.calls.some((c) => c.method === "DELETE" && c.path.includes("/bans/"))).toBe(true);

    rest.unbanNotFound = true;
    const bad = await svc.run(modReq({ action: "unban", targetId: "victim" }));
    expect(bad.ok).toBe(false);
    expect(bad.refusal).toContain("not banned");
  });

  test("timeout sets communication_disabled_until in the future", async () => {
    const { svc, rest } = service();
    const res = await svc.run(modReq({ action: "timeout", targetId: "victim", durationSeconds: 600 }));
    expect(res.ok).toBe(true);
    const call = rest.calls.find((c) => c.method === "PATCH" && c.path.includes("victim"));
    const body = call?.body as { communication_disabled_until?: string };
    expect(body?.communication_disabled_until).toBeDefined();
    expect(new Date(body!.communication_disabled_until!).getTime()).toBeGreaterThan(Date.now());
  });

  test("untimeout clears the timeout", async () => {
    const { svc, rest } = service();
    const res = await svc.run(modReq({ action: "untimeout", targetId: "victim" }));
    expect(res.ok).toBe(true);
    const body = rest.calls.find((c) => c.method === "PATCH")?.body as { communication_disabled_until?: string | null };
    expect(body?.communication_disabled_until).toBeNull();
  });

  test("purge clamps the count to 100 and bulk-deletes", async () => {
    const { svc, rest } = service();
    const res = await svc.run(modReq({ action: "purge", targetId: undefined, channelId: "c1", count: 5000 }));
    expect(res.ok).toBe(true);
    expect(rest.calls.some((c) => c.path.includes("limit=100"))).toBe(true);
    expect(rest.calls.some((c) => c.path.includes("bulk-delete"))).toBe(true);
  });

  test("purge of a single message deletes it directly (Discord forbids a 1-item bulk)", async () => {
    const { svc, rest } = service();
    rest.messages = [{ id: "only" }];
    const res = await svc.run(modReq({ action: "purge", targetId: undefined, channelId: "c1", count: 1 }));
    expect(res.ok).toBe(true);
    expect(rest.calls.some((c) => c.method === "DELETE" && c.path.includes("/messages/only"))).toBe(true);
    expect(rest.calls.some((c) => c.path.includes("bulk-delete"))).toBe(false);
  });

  test("slowmode writes rate_limit_per_user and clamps to the 6h ceiling", async () => {
    const { svc, rest } = service();
    const res = await svc.run(modReq({ action: "slowmode", targetId: undefined, channelId: "c1", seconds: 999999 }));
    expect(res.ok).toBe(true);
    const body = rest.calls.find((c) => c.path === "/channels/c1")?.body as { rate_limit_per_user?: number };
    expect(body?.rate_limit_per_user).toBe(21600);
  });

  test("lock denies Send Messages to @everyone (overwrite id = guild id)", async () => {
    const { svc, rest } = service();
    const res = await svc.run(modReq({ action: "lock", targetId: undefined, channelId: "c1" }));
    expect(res.ok).toBe(true);
    const call = rest.calls.find((c) => c.path.includes("/permissions/"));
    expect(call?.path).toContain("/permissions/g1");
    expect((call?.body as { deny?: string })?.deny).toBe((1n << 11n).toString());
  });

  test("a channel action used outside a channel is refused", async () => {
    const { svc } = service();
    const res = await svc.run(modReq({ action: "lock", targetId: undefined, channelId: undefined }));
    expect(res.ok).toBe(false);
    expect(res.refusal).toContain("inside a channel");
  });
});

// ----------------------------------------------------- context menus
describe("context-menu commands", () => {
  test("a USER context command registers with type 2 and no description/options", () => {
    const cmd = userContext("Warn", "warn");
    const json = cmd.toJSON();
    expect(json.type).toBe(ApplicationCommandType.User);
    expect(json.options).toBeUndefined();
    expect(json.description).toBe("");
  });

  test("the store keeps a slash /ban and a user-context Ban separate", () => {
    const store = new CommandStore();
    const slash = new (class extends Command {
      constructor() {
        super({ name: "ban", description: "slash ban" });
      }
      run(): void {}
    })();
    const ctx = userContext("Ban", "ban");
    store.add(slash);
    store.add(ctx);
    expect(store.size).toBe(2);
    expect(store.get("ban", ApplicationCommandType.ChatInput)?.description).toBe("slash ban");
    expect(store.get("Ban", ApplicationCommandType.User)?.type).toBe(ApplicationCommandType.User);
  });

  test("routing a USER context command targets data.target_id", async () => {
    const rest = new FakeRest();
    const cfg = loadConfig({ FUDCOURT_GUILD_ID: "g1" } as Record<string, string>);
    const client = new FudzieClient({ config: cfg, rest: rest as unknown as Rest, log: () => {} });
    client.commands.add(userContext("Ban", "ban"));
    client.preconditions.add(new ModOnly());
    const interaction: Interaction = {
      id: "i1",
      application_id: "app1",
      type: 2,
      guild_id: "g1",
      channel_id: "c1",
      token: "tok",
      data: { id: "d1", name: "Ban", type: ApplicationCommandType.User, target_id: "victim" },
      member: {
        user: { id: "mod", username: "mod" },
        roles: ["mod"],
        permissions: union([Perm.BAN_MEMBERS.toString(), Perm.MODERATE_MEMBERS.toString()]).toString(),
      },
    };
    await client.handleInteraction(interaction);
    const call = rest.calls.find((c) => c.method === "PUT" && c.path.includes("/bans/"));
    expect(call?.path).toContain("victim");
  });
});



