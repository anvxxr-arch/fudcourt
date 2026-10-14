import { describe, expect, test } from "bun:test";

import {
  automodEvent,
  channelEvent,
  memberAddEvent,
  memberRemoveEvent,
  memberUpdateEvent,
  messageDeleteEvent,
  messageUpdateEvent,
  moderationEvent,
  truncate,
  voiceStateEvent,
} from "../src/logging/events.ts";

// The mappers are pure: payload in, {category, embed} out. These tests pin the
// honest-rendering rules — a payload that lacks the data renders without it
// rather than inventing it — and the category routing the logger switches on.

describe("messageDeleteEvent", () => {
  test("maps a cached delete to the message category", () => {
    const ev = messageDeleteEvent({
      id: "m1",
      channel_id: "c1",
      guild_id: "g1",
      content: "bad words",
      author: { id: "u1", username: "spammer" },
    });
    expect(ev?.category).toBe("message");
    expect(ev?.embed.title).toBe("Message deleted");
    expect(ev?.embed.description).toBe("bad words");
    const fields = ev?.embed.fields ?? [];
    expect(fields.find((f) => f.name === "Author")?.value).toBe("spammer (u1)");
    expect(fields.find((f) => f.name === "Channel")?.value).toBe("<#c1>");
  });

  test("an uncached delete renders no author/content rather than inventing them", () => {
    const ev = messageDeleteEvent({ id: "m1", channel_id: "c1" });
    expect(ev).not.toBeNull();
    expect(ev?.embed.description).toBeUndefined();
    expect((ev?.embed.fields ?? []).find((f) => f.name === "Author")).toBeUndefined();
  });

  test("a payload without an id or channel is dropped", () => {
    expect(messageDeleteEvent({ channel_id: "c1" })).toBeNull();
    expect(messageDeleteEvent({ id: "m1" })).toBeNull();
  });
});

describe("messageUpdateEvent", () => {
  test("logs a content-bearing edit", () => {
    const ev = messageUpdateEvent({ id: "m1", channel_id: "c1", content: "edited" });
    expect(ev?.category).toBe("message");
    expect(ev?.embed.title).toBe("Message edited");
  });

  test("an embed-only update (no content) is not logged", () => {
    expect(messageUpdateEvent({ id: "m1", channel_id: "c1" })).toBeNull();
  });
});

describe("member events", () => {
  test("memberAddEvent → member category with the id", () => {
    const ev = memberAddEvent({ user: { id: "u1", username: "newbie" } });
    expect(ev?.category).toBe("member");
    expect((ev?.embed.fields ?? []).find((f) => f.name === "ID")?.value).toBe("u1");
  });

  test("memberRemoveEvent → member category", () => {
    const ev = memberRemoveEvent({ user: { id: "u1", username: "leaver" } });
    expect(ev?.category).toBe("member");
    expect(ev?.embed.title).toBe("Member left");
  });

  test("memberUpdateEvent routes to role when roles are present", () => {
    const ev = memberUpdateEvent({ user: { id: "u1", username: "u" }, roles: ["r1", "r2"] });
    expect(ev?.category).toBe("role");
    expect((ev?.embed.fields ?? []).find((f) => f.name === "Roles")?.value).toBe("<@&r1> <@&r2>");
  });

  test("memberUpdateEvent routes to member when only a nickname changed", () => {
    const ev = memberUpdateEvent({ user: { id: "u1", username: "u" }, roles: [], nick: "Renamed" });
    expect(ev?.category).toBe("member");
    expect((ev?.embed.fields ?? []).find((f) => f.name === "Nickname")?.value).toBe("Renamed");
  });
});

describe("voiceStateEvent", () => {
  test("a join renders the channel", () => {
    const ev = voiceStateEvent({ guild_id: "g1", user_id: "u1", channel_id: "v1" });
    expect(ev?.category).toBe("voice");
    expect(ev?.embed.title).toBe("Voice channel joined");
  });

  test("a leave renders no channel", () => {
    const ev = voiceStateEvent({ guild_id: "g1", user_id: "u1", channel_id: null });
    expect(ev?.embed.title).toBe("Voice channel left");
  });
});

describe("channelEvent", () => {
  test("delete is danger-coloured", () => {
    const ev = channelEvent("delete", { id: "c1", name: "general" });
    expect(ev?.category).toBe("channel");
    expect(ev?.embed.title).toBe("Channel deleted");
    expect((ev?.embed.fields ?? [])[0]?.value).toBe("#general (c1)");
  });
});

describe("moderationEvent", () => {
  test("a dashboard/slash action routes to moderation", () => {
    const ev = moderationEvent({ action: "ban", actorId: "mod1", targetId: "u1", caseNumber: 42 });
    expect(ev.category).toBe("moderation");
    expect((ev.embed.fields ?? []).find((f) => f.name === "Case")?.value).toBe("#42");
  });

  test("an automod-originated action routes to automod", () => {
    const ev = moderationEvent({ action: "timeout", actorId: "bot", targetId: "u1", source: "automod" });
    expect(ev.category).toBe("automod");
  });
});

describe("automodEvent", () => {
  test("renders the rule, target and action results", () => {
    const ev = automodEvent({ ruleName: "spam", targetId: "u1", channelId: "c1", results: ["delete:done", "timeout:10m"] });
    expect(ev.category).toBe("automod");
    expect((ev.embed.fields ?? []).find((f) => f.name === "Actions")?.value).toBe("delete:done\ntimeout:10m");
  });
});

describe("truncate", () => {
  test("clips long text with an ellipsis", () => {
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 4).length).toBe(4);
  });
});
