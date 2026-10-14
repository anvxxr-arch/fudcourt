import { describe, expect, test } from "bun:test";

import type { AutomodRule } from "../src/automod/matchers.ts";
import { AutomodService, type AutomodDeps, type IncomingMessage } from "../src/automod/service.ts";
import { InMemoryWindowStore, SpamTracker } from "../src/automod/state.ts";
import type { ModRequest, ModResult } from "../src/moderation/service.ts";

const T = 1_700_000_000_000;

function rule(over: Partial<AutomodRule> = {}): AutomodRule {
  return {
    id: 1,
    name: "mass-mention",
    enabled: true,
    priority: 10,
    event: "message",
    matchers: [{ type: "mentions", threshold: 3 }],
    actions: ["delete", "timeout"],
    exemptRoles: [],
    exemptUsers: [],
    exemptChannels: [],
    cooldownSeconds: 0,
    timeoutSeconds: 600,
    ...over,
  };
}

interface Harness {
  svc: AutomodService;
  modCalls: ModRequest[];
  deleted: Array<[string, string]>;
  roles: Array<[string, string, string]>;
  logs: string[];
}

function harness(rules: AutomodRule[], opts: { modRefuse?: boolean; deliveryThrows?: boolean } = {}): Harness {
  const modCalls: ModRequest[] = [];
  const deleted: Array<[string, string]> = [];
  const roles: Array<[string, string, string]> = [];
  const logs: string[] = [];
  const deps: AutomodDeps = {
    rules: async () => rules,
    tracker: new SpamTracker(new InMemoryWindowStore()),
    moderation: {
      async run(req: ModRequest): Promise<ModResult> {
        modCalls.push(req);
        return opts.modRefuse
          ? { ok: false, action: req.action, refusal: "target above me" }
          : { ok: true, action: req.action, summary: `${req.action} ok`, caseNumber: 7 };
      },
    },
    delivery: {
      async deleteMessage(c, m) {
        if (opts.deliveryThrows) throw new Error("boom");
        deleted.push([c, m]);
      },
      async addRole(g, u, r) {
        roles.push(["add", u, r]);
        void g;
      },
      async removeRole(g, u, r) {
        roles.push(["remove", u, r]);
        void g;
      },
    },
    actor: async () => ({ id: "bot", roles: ["999"], permissions: "8" }),
    log: (m) => logs.push(m),
    now: () => T,
  };
  return { svc: new AutomodService(deps), modCalls, deleted, roles, logs };
}

function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    guildId: "1",
    channelId: "c",
    messageId: "m1",
    authorId: "u1",
    authorIsBot: false,
    content: "hello",
    mentionIds: [],
    roleIds: [],
    attachments: 0,
    ...over,
  };
}

describe("AutomodService.onMessage", () => {
  test("fires a rule and routes the moderation action through the shared service with source=automod", async () => {
    const h = harness([rule()]);
    const out = await h.svc.onMessage(message({ mentionIds: ["1", "2", "3"] }));
    expect(out).toHaveLength(1);
    expect(h.deleted).toEqual([["c", "m1"]]);
    expect(h.modCalls).toHaveLength(1);
    expect(h.modCalls[0]?.action).toBe("timeout");
    expect(h.modCalls[0]?.source).toBe("automod");
    expect(h.modCalls[0]?.reason).toContain("mass-mention");
    expect(h.modCalls[0]?.durationSeconds).toBe(600);
    expect(h.modCalls[0]?.actorId).toBe("bot");
  });

  test("ignores messages from bots", async () => {
    const h = harness([rule()]);
    const out = await h.svc.onMessage(message({ authorIsBot: true, mentionIds: ["1", "2", "3"] }));
    expect(out).toHaveLength(0);
    expect(h.modCalls).toHaveLength(0);
  });

  test("a non-matching message fires nothing", async () => {
    const h = harness([rule()]);
    expect(await h.svc.onMessage(message({ mentionIds: ["1"] }))).toHaveLength(0);
    expect(h.modCalls).toHaveLength(0);
  });

  test("exempt roles short-circuit before any action", async () => {
    const h = harness([rule({ exemptRoles: ["777"] })]);
    const out = await h.svc.onMessage(message({ mentionIds: ["1", "2", "3"], roleIds: ["777"] }));
    expect(out).toHaveLength(0);
    expect(h.modCalls).toHaveLength(0);
  });

  test("a cooldown suppresses the immediate re-fire", async () => {
    const h = harness([rule({ cooldownSeconds: 60 })]);
    expect(await h.svc.onMessage(message({ mentionIds: ["1", "2", "3"] }))).toHaveLength(1);
    expect(await h.svc.onMessage(message({ mentionIds: ["1", "2", "3"] }))).toHaveLength(0);
    expect(h.modCalls).toHaveLength(1);
  });

  test("log_only logs and never touches moderation", async () => {
    const h = harness([rule({ actions: ["log_only"] })]);
    const out = await h.svc.onMessage(message({ mentionIds: ["1", "2", "3"] }));
    expect(out[0]?.results).toEqual(["log_only:done"]);
    expect(h.modCalls).toHaveLength(0);
    expect(h.deleted).toHaveLength(0);
  });

  test("a role action delivers through the delivery port", async () => {
    const h = harness([rule({ actions: ["add_role"], roleId: "555" })]);
    await h.svc.onMessage(message({ mentionIds: ["1", "2", "3"] }));
    expect(h.roles).toEqual([["add", "u1", "555"]]);
  });

  test("a moderation refusal is reported, not thrown", async () => {
    const h = harness([rule()], { modRefuse: true });
    const out = await h.svc.onMessage(message({ mentionIds: ["1", "2", "3"] }));
    expect(out[0]?.results).toContain("timeout:refused (target above me)");
  });

  test("a delivery failure is caught and surfaced as an error line", async () => {
    const h = harness([rule({ actions: ["delete"] })], { deliveryThrows: true });
    const out = await h.svc.onMessage(message({ mentionIds: ["1", "2", "3"] }));
    expect(out[0]?.results[0]).toContain("delete:error");
  });

  test("the spam matcher uses the computed score", async () => {
    // A lone message scores ~1 (normal); a flood in one window clears 25.
    const single = harness([rule({ matchers: [{ type: "spam", threshold: 25 }], actions: ["log_only"] })]);
    expect(await single.svc.onMessage(message({ content: "hi" }))).toHaveLength(0);

    const h = harness([rule({ matchers: [{ type: "spam", threshold: 25 }], actions: ["log_only"] })]);
    for (let i = 0; i < 12; i++) await h.svc.onMessage(message({ content: `m${i}`, messageId: `m${i}` }));
    const out = await h.svc.onMessage(message({ content: "m-final", messageId: "mf" }));
    expect(out).toHaveLength(1);
    expect(out[0]?.rule.name).toBe("mass-mention");
  });
});

describe("AutomodService.onJoin", () => {
  test("fires a rapid-join rule", async () => {
    const h = harness([
      rule({
        id: 9,
        name: "raid",
        event: "member_join",
        matchers: [{ type: "rapid_join", threshold: 3 }],
        actions: ["kick"],
      }),
    ]);
    expect(await h.svc.onJoin({ guildId: "1", userId: "a" })).toHaveLength(0);
    expect(await h.svc.onJoin({ guildId: "1", userId: "b" })).toHaveLength(0);
    const out = await h.svc.onJoin({ guildId: "1", userId: "c" });
    expect(out).toHaveLength(1);
    expect(h.modCalls[0]?.action).toBe("kick");
    expect(h.modCalls[0]?.targetId).toBe("c");
  });

  test("a new-account rule fires for a fresh account", async () => {
    const h = harness([
      rule({
        id: 4,
        name: "newbie",
        event: "member_join",
        matchers: [{ type: "new_account", threshold: 24 }],
        actions: ["log_only"],
      }),
    ]);
    const out = await h.svc.onJoin({ guildId: "1", userId: "a", accountCreatedAt: T - 3_600_000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.rule.name).toBe("newbie");
  });
});
