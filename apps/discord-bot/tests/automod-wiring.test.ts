import { describe, expect, test } from "bun:test";

import type { GuildRole } from "../src/framework/types.ts";
import { fetchRules, orPermissions, toIncomingJoin, toIncomingMessage } from "../src/automod/wiring.ts";

function jsonRes(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

const VALID_ROW = {
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
};

describe("fetchRules", () => {
  test("empty apiUrl yields no rules and never fetches", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return jsonRes([]);
    }) as unknown as typeof fetch;
    expect(await fetchRules("", f)).toEqual([]);
    expect(called).toBe(false);
  });

  test("a non-ok response yields no rules", async () => {
    const f = (async () => jsonRes({}, false)) as unknown as typeof fetch;
    expect(await fetchRules("http://x", f)).toEqual([]);
  });

  test("a network failure yields no rules", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchRules("http://x", f)).toEqual([]);
  });

  test("valid rows parse; an invalid row is skipped and logged, not fatal", async () => {
    const logs: string[] = [];
    const f = (async () => jsonRes([VALID_ROW, { id: 2, name: "broken" }])) as unknown as typeof fetch;
    const rules = await fetchRules("http://x", f, 3000, (m) => logs.push(m));
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe("mass-mention");
    expect(rules[0]?.matchers[0]).toEqual({ type: "mentions", threshold: 3 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("rejected");
  });

  test("accepts a {rules:[...]} envelope as well as a bare array", async () => {
    const f = (async () => jsonRes({ rules: [VALID_ROW] })) as unknown as typeof fetch;
    expect(await fetchRules("http://x", f)).toHaveLength(1);
  });
});

describe("orPermissions", () => {
  const roles: GuildRole[] = [
    { id: "everyone", name: "@everyone", color: 0, position: 0, managed: false, permissions: "104324673" }, // includes view/send/etc
    { id: "mod", name: "mod", color: 0, position: 1, managed: false, permissions: "1099511627776" }, // 1<<40
    { id: "other", name: "other", color: 0, position: 2, managed: false, permissions: "8" },
  ];

  test("ORs only the roles the member holds", () => {
    // everyone (104324673) | mod (1<<40)
    const expected = (104324673n | (1n << 40n)).toString();
    expect(orPermissions(["everyone", "mod"], roles)).toBe(expected);
  });

  test("a member with no roles gets 0", () => {
    expect(orPermissions([], roles)).toBe("0");
  });

  test("an unparseable bitfield is ignored, not fatal", () => {
    const weird: GuildRole[] = [{ id: "x", name: "x", color: 0, position: 0, managed: false, permissions: "not-a-number" }];
    expect(orPermissions(["x"], weird)).toBe("0");
  });
});

describe("payload converters", () => {
  test("toIncomingMessage maps ids, mentions, roles and bot flag", () => {
    const m = toIncomingMessage({
      id: "m1",
      channel_id: "c1",
      guild_id: "g1",
      content: "hi @a @b",
      author: { id: "175928847299117063", username: "u", bot: false },
      mentions: [{ id: "1" }, { id: "2" }],
      member: { roles: ["r1", "r2"] },
      attachments: [{}],
    });
    expect(m.guildId).toBe("g1");
    expect(m.channelId).toBe("c1");
    expect(m.messageId).toBe("m1");
    expect(m.authorId).toBe("175928847299117063");
    expect(m.authorIsBot).toBe(false);
    expect(m.mentionIds).toEqual(["1", "2"]);
    expect(m.roleIds).toEqual(["r1", "r2"]);
    expect(m.attachments).toBe(1);
    // 175928847299117063 → 2016-08-16 (a known snowflake)
    expect(m.accountCreatedAt).toBeGreaterThan(1_400_000_000_000);
  });

  test("toIncomingMessage tolerates a missing author", () => {
    const m = toIncomingMessage({ id: "m", channel_id: "c" });
    expect(m.authorId).toBe("");
    expect(m.authorIsBot).toBe(false);
    expect(m.accountCreatedAt).toBeUndefined();
  });

  test("toIncomingJoin derives the account age from the user snowflake", () => {
    const j = toIncomingJoin({ user: { id: "175928847299117063", username: "u" }, guild_id: "g9" }, "fallback");
    expect(j.guildId).toBe("g9");
    expect(j.userId).toBe("175928847299117063");
    expect(j.accountCreatedAt).toBeGreaterThan(1_400_000_000_000);
  });

  test("toIncomingJoin falls back to the configured guild id", () => {
    const j = toIncomingJoin({ user: { id: "1", username: "u" } }, "g-configured");
    expect(j.guildId).toBe("g-configured");
  });
});
