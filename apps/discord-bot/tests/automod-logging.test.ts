import { describe, expect, test } from "bun:test";

import { AutomodService, type AutomodDeps } from "../src/automod/service.ts";
import type { AutomodRule } from "../src/automod/matchers.ts";
import { SpamTracker, InMemoryWindowStore } from "../src/automod/state.ts";
import type { ActivityEvent } from "../src/logging/types.ts";

// The AutoMod service mirrors each rule firing to the automod activity channel
// via an optional port. These tests pin: one event per fired rule, delete-only
// rules are still logged (they never reach the moderation service), and the
// port is optional (a service with no port still runs).

const RULE: AutomodRule = {
  id: 1,
  name: "badword",
  enabled: true,
  priority: 100,
  event: "message",
  matchers: [{ type: "blocked_word", values: ["badword"] }],
  actions: ["delete", "log_only"],
  exemptRoles: [],
  exemptUsers: [],
  exemptChannels: [],
  cooldownSeconds: 60,
};

function svc(rules: AutomodRule[], activity?: { emitEvent(ev: ActivityEvent | null): Promise<boolean> }) {
  const deps: AutomodDeps = {
    rules: async () => rules,
    tracker: new SpamTracker(new InMemoryWindowStore()),
    moderation: { run: async () => ({ ok: true, action: "warn" as const }) },
    delivery: {
      deleteMessage: async () => {},
      addRole: async () => {},
      removeRole: async () => {},
    },
    actor: async () => ({ id: "bot", roles: [], permissions: "0" }),
    ...(activity ? { activity } : {}),
    log: () => {},
    now: () => 1_000_000,
  };
  return new AutomodService(deps);
}

function msg(content: string) {
  return {
    guildId: "g1",
    channelId: "c1",
    messageId: "m-" + content,
    authorId: "u1",
    authorIsBot: false,
    content,
    mentionIds: [],
    roleIds: [],
    attachments: 0,
  };
}

describe("AutomodService activity logging", () => {
  test("a fired rule emits one automod event covering delete-only actions", async () => {
    const events: ActivityEvent[] = [];
    const s = svc([RULE], {
      async emitEvent(ev) {
        if (ev) events.push(ev);
        return true;
      },
    });
    const outcomes = await s.onMessage(msg("this has a badword in it"));
    expect(outcomes).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe("automod");
    expect((events[0]?.embed.fields ?? []).find((f) => f.name === "Rule")?.value).toBe("badword");
  });

  test("a clean message emits nothing", async () => {
    const events: ActivityEvent[] = [];
    const s = svc([RULE], {
      async emitEvent(ev) {
        if (ev) events.push(ev);
        return true;
      },
    });
    await s.onMessage(msg("hello world"));
    expect(events).toHaveLength(0);
  });

  test("the activity port is optional", async () => {
    const s = svc([RULE]);
    const outcomes = await s.onMessage(msg("badword here"));
    expect(outcomes).toHaveLength(1);
  });
});
