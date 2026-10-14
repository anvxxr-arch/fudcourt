import { describe, expect, test } from "bun:test";

import { DEFAULT_TRACKER, InMemoryWindowStore, SpamTracker } from "../src/automod/state.ts";

const T = 1_700_000_000_000;

function tracker(): SpamTracker {
  return new SpamTracker(new InMemoryWindowStore(), { windowSeconds: 30, burstSeconds: 5, duplicateWindowSeconds: 30 });
}

describe("SpamTracker", () => {
  test("counts messages in the window and prunes the ones that age out", async () => {
    const t = tracker();
    const base = { guildId: "1", userId: "9", channelId: "c", mentions: 0 };
    expect((await t.observeMessage({ ...base, content: "a", now: T })).signals.messagesInWindow).toBe(1);
    expect((await t.observeMessage({ ...base, content: "b", now: T + 1_000 })).signals.messagesInWindow).toBe(2);
    expect((await t.observeMessage({ ...base, content: "c", now: T + 2_000 })).signals.messagesInWindow).toBe(3);
    // 40s later the earlier three have aged out of the 30s window.
    expect((await t.observeMessage({ ...base, content: "d", now: T + 40_000 })).signals.messagesInWindow).toBe(1);
  });

  test("the burst sub-window is shorter than the rate window", async () => {
    const t = tracker();
    const base = { guildId: "1", userId: "9", channelId: "c", mentions: 0 };
    for (let i = 0; i < 6; i++) await t.observeMessage({ ...base, content: `m${i}`, now: T + i * 100 });
    const r = await t.observeMessage({ ...base, content: "m6", now: T + 700 });
    expect(r.signals.burst).toBe(7); // all within 5s
    const later = await t.observeMessage({ ...base, content: "m7", now: T + 6_000 });
    expect(later.signals.burst).toBe(1); // only the new one is within 5s
  });

  test("counts distinct channels for cross-channel spam", async () => {
    const t = tracker();
    const base = { guildId: "1", userId: "9", mentions: 0, now: T };
    await t.observeMessage({ ...base, channelId: "A", content: "x" });
    await t.observeMessage({ ...base, channelId: "B", content: "y" });
    const r = await t.observeMessage({ ...base, channelId: "A", content: "z" });
    expect(r.signals.channels).toBe(2);
  });

  test("duplicates folds case and whitespace and includes the current message", async () => {
    const t = tracker();
    const base = { guildId: "1", userId: "9", channelId: "c", mentions: 0 };
    await t.observeMessage({ ...base, content: "buy now", now: T });
    await t.observeMessage({ ...base, content: "BUY  NOW", now: T + 100 });
    const r = await t.observeMessage({ ...base, content: "buy now", now: T + 200 });
    expect(r.signals.duplicates).toBe(3);
    expect(r.recentContents).toContain("buy now");
  });

  test("observeJoin counts joins in the window", async () => {
    const t = tracker();
    expect(await t.observeJoin("1", T)).toBe(1);
    expect(await t.observeJoin("1", T + 100)).toBe(2);
    expect(await t.observeJoin("1", T + 40_000)).toBe(1); // aged out
  });

  test("cooldown lifecycle: absent → set → cooling → expires", async () => {
    const t = tracker();
    expect(await t.isCoolingDown("1", 5, "9", T)).toBe(false);
    await t.markFired("1", 5, "9", 60, T);
    expect(await t.isCoolingDown("1", 5, "9", T + 1_000)).toBe(true);
    expect(await t.isCoolingDown("1", 5, "9", T + 61_000)).toBe(false);
  });

  test("a zero cooldown never blocks", async () => {
    const t = tracker();
    await t.markFired("1", 5, "9", 0, T);
    expect(await t.isCoolingDown("1", 5, "9", T)).toBe(false);
  });

  test("per-rule and per-user cooldowns are independent", async () => {
    const t = tracker();
    await t.markFired("1", 5, "9", 60, T);
    expect(await t.isCoolingDown("1", 6, "9", T)).toBe(false); // different rule
    expect(await t.isCoolingDown("1", 5, "8", T)).toBe(false); // different user
    expect(await t.isCoolingDown("1", 5, "9", T)).toBe(true);
  });

  test("the default tracker config is the documented one", () => {
    expect(DEFAULT_TRACKER).toEqual({ windowSeconds: 30, burstSeconds: 5, duplicateWindowSeconds: 30 });
  });
});
