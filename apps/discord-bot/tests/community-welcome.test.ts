import { describe, expect, test } from "bun:test";

import { buildPayload, WelcomeService, type WelcomeMember } from "../src/community/welcome.ts";
import type { WelcomeConfig } from "../src/community/types.ts";
import { memberVars } from "../src/community/templates.ts";

const member: WelcomeMember = { userId: "123", username: "bob", displayName: "Bobby", isBot: false, guildName: "Fud", memberCount: 10, createdAt: "1750000000000" };

function cfg(over: Partial<WelcomeConfig> = {}): WelcomeConfig {
  return {
    joinEnabled: true,
    joinChannelId: "c1",
    joinMessage: "welcome {user}",
    joinDm: false,
    joinDmMessage: "hi {username}",
    leaveEnabled: true,
    leaveChannelId: "c2",
    leaveMessage: "bye {username}",
    ...over,
  };
}

describe("buildPayload", () => {
  test("content + templated embed", () => {
    const p = buildPayload("hi {username}", { title: "{server}" }, memberVars(member));
    expect(p?.content).toBe("hi bob");
    expect(p?.embeds?.[0]).toMatchObject({ title: "Fud" });
  });
  test("empty message + no embed yields undefined (no empty post)", () => {
    expect(buildPayload("   ", undefined, memberVars(member))).toBeUndefined();
  });
});

describe("WelcomeService", () => {
  test("onJoin posts to the join channel and DMs when enabled", async () => {
    const sent: string[] = [];
    const dms: string[] = [];
    const svc = new WelcomeService({
      config: async () => cfg({ joinDm: true }),
      send: async (ch, d) => void sent.push(`${ch}:${d.content}`),
      dm: async (u, d) => void dms.push(`${u}:${d.content}`),
      log: () => {},
    });
    await svc.onJoin(member);
    expect(sent).toEqual(["c1:welcome <@123>"]);
    expect(dms).toEqual(["123:hi bob"]);
  });

  test("onJoin with the feature disabled sends nothing", async () => {
    const sent: string[] = [];
    const svc = new WelcomeService({ config: async () => cfg({ joinEnabled: false }), send: async () => void sent.push("x"), dm: async () => {}, log: () => {} });
    await svc.onJoin(member);
    expect(sent).toEqual([]);
  });

  test("onLeave posts the goodbye", async () => {
    const sent: string[] = [];
    const svc = new WelcomeService({ config: async () => cfg(), send: async (ch, d) => void sent.push(`${ch}:${d.content}`), dm: async () => {}, log: () => {} });
    await svc.onLeave(member);
    expect(sent).toEqual(["c2:bye bob"]);
  });

  test("a send failure never throws out of onJoin", async () => {
    const svc = new WelcomeService({ config: async () => cfg(), send: async () => { throw new Error("boom"); }, dm: async () => {}, log: () => {} });
    await expect(svc.onJoin(member)).resolves.toBeUndefined();
  });

  test("a config lookup failure degrades to no-op", async () => {
    const svc = new WelcomeService({ config: async () => { throw new Error("db down"); }, send: async () => {}, dm: async () => {}, log: () => {} });
    await expect(svc.onJoin(member)).resolves.toBeUndefined();
  });
});
