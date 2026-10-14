import { describe, expect, test } from "bun:test";

import {
  DEFAULTS,
  capsRatio,
  compileSafeRegex,
  countEmoji,
  domainMatches,
  evaluateRules,
  extractUrls,
  hostOf,
  matcherMatches,
  normalize,
  type AutomodRule,
  type MatchContext,
  type Matcher,
  type MessageEvent,
} from "../src/automod/matchers.ts";
import { explain, scoreSpam, severityOf } from "../src/automod/score.ts";
import { parseRule, parseRules, RuleValidationError } from "../src/automod/rules.ts";

function msg(over: Partial<MessageEvent> = {}): MessageEvent {
  return {
    kind: "message",
    guildId: "100",
    channelId: "200",
    authorId: "300",
    authorIsBot: false,
    content: "hello",
    mentionIds: [],
    roleIds: [],
    attachments: 0,
    recentContents: ["hello"],
    ...over,
  };
}

const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({ now: 1_700_000_000_000, ...over });

const match = (m: Matcher, ev: MessageEvent, c: MatchContext = ctx()): boolean => matcherMatches(m, ev, c);

describe("matchers", () => {
  test("mentions fires at or above the threshold", () => {
    expect(match({ type: "mentions" }, msg({ mentionIds: Array(7).fill("1") }))).toBe(true);
    expect(match({ type: "mentions" }, msg({ mentionIds: Array(6).fill("1") }))).toBe(false);
    expect(match({ type: "mentions", threshold: 3 }, msg({ mentionIds: ["1", "2", "3"] }))).toBe(true);
  });

  test("duplicate counts the current message in the window", () => {
    const ev = msg({ content: "buy now", recentContents: ["buy now", "BUY NOW", "buy  now"] });
    expect(match({ type: "duplicate" }, ev)).toBe(true); // 3 >= default 3, whitespace/case folded
    expect(match({ type: "duplicate" }, msg({ content: "buy now", recentContents: ["buy now"] }))).toBe(false);
  });

  test("duplicate ignores an empty message", () => {
    expect(match({ type: "duplicate" }, msg({ content: "   ", recentContents: ["", ""] }))).toBe(false);
  });

  test("caps needs enough letters before it judges", () => {
    expect(capsRatio("OK")).toBeNull();
    expect(capsRatio("THIS IS SHOUTING")).toBeCloseTo(1, 5);
    expect(match({ type: "caps" }, msg({ content: "THIS IS ALL SHOUTING" }))).toBe(true);
    expect(match({ type: "caps" }, msg({ content: "this is normal text here" }))).toBe(false);
  });

  test("emoji counts unicode and custom emoji", () => {
    expect(countEmoji("😀😀😀")).toBe(3);
    expect(countEmoji("<:party:123456789012345678>")).toBe(1);
    expect(match({ type: "emoji" }, msg({ content: "😀😀😀😀😀" }))).toBe(true);
    expect(match({ type: "emoji" }, msg({ content: "😀" }))).toBe(false);
  });

  test("invite matches discord.gg and discord.com/invite", () => {
    expect(match({ type: "invite" }, msg({ content: "join discord.gg/abc123" }))).toBe(true);
    expect(match({ type: "invite" }, msg({ content: "see https://discord.com/invite/xyz" }))).toBe(true);
    expect(match({ type: "invite" }, msg({ content: "no link here" }))).toBe(false);
  });

  test("url and blocked_domain", () => {
    expect(extractUrls("go https://a.example/x and http://b.test")).toHaveLength(2);
    expect(hostOf("https://Sub.Example.COM/x")).toBe("sub.example.com");
    expect(hostOf("not a url")).toBeNull();
    expect(domainMatches("sub.evil.com", "evil.com")).toBe(true);
    expect(domainMatches("evil.com", "evil.com")).toBe(true);
    expect(domainMatches("notevil.com", "evil.com")).toBe(false);
    expect(match({ type: "blocked_domain", values: ["evil.com"] }, msg({ content: "https://sub.evil.com/x" }))).toBe(true);
    expect(match({ type: "blocked_domain", values: ["evil.com"] }, msg({ content: "https://good.com/x" }))).toBe(false);
    expect(match({ type: "blocked_domain", values: [] }, msg({ content: "https://evil.com" }))).toBe(false);
  });

  test("blocked_word is case-insensitive", () => {
    expect(match({ type: "blocked_word", values: ["badword"] }, msg({ content: "you BADWORD you" }))).toBe(true);
    expect(match({ type: "blocked_word", values: ["badword"] }, msg({ content: "totally fine" }))).toBe(false);
  });

  test("regex uses the safe compiler", () => {
    expect(match({ type: "regex", pattern: "free\\s+nitro" }, msg({ content: "FREE  NITRO" }))).toBe(true);
    expect(match({ type: "regex", pattern: "free\\s+nitro" }, msg({ content: "nothing" }))).toBe(false);
  });

  test("attachment, new_account, rapid_join, spam", () => {
    expect(match({ type: "attachment" }, msg({ attachments: 1 }))).toBe(true);
    expect(match({ type: "attachment" }, msg({ attachments: 0 }))).toBe(false);
    const now = 1_700_000_000_000;
    expect(match({ type: "new_account" }, msg({ accountCreatedAt: now - 3_600_000 }), ctx({ now }))).toBe(true);
    expect(match({ type: "new_account" }, msg({ accountCreatedAt: now - 48 * 3_600_000 }), ctx({ now }))).toBe(false);
    expect(match({ type: "new_account" }, msg({ accountCreatedAt: undefined }), ctx({ now }))).toBe(false);
    const join = { kind: "member_join" as const, guildId: "100", userId: "300", recentJoinCount: 5 };
    expect(matcherMatches({ type: "rapid_join" }, join, ctx())).toBe(true);
    expect(matcherMatches({ type: "rapid_join" }, { ...join, recentJoinCount: 4 }, ctx())).toBe(false);
    expect(match({ type: "spam" }, msg(), ctx({ spamScore: 70 }))).toBe(true);
    expect(match({ type: "spam" }, msg(), ctx({ spamScore: 20 }))).toBe(false);
  });

  test("a message matcher never fires on a join event and vice-versa", () => {
    const join = { kind: "member_join" as const, guildId: "100", userId: "300", recentJoinCount: 9 };
    expect(matcherMatches({ type: "mentions" }, join, ctx())).toBe(false);
    expect(matcherMatches({ type: "rapid_join" }, msg(), ctx())).toBe(false);
  });
});

describe("safe regex", () => {
  test("rejects a catastrophic nested-quantifier pattern", () => {
    expect(compileSafeRegex("(a+)+$")).toBeNull();
    expect(compileSafeRegex("(.*)*")).toBeNull();
    expect(compileSafeRegex("a".repeat(300))).toBeNull();
    expect(compileSafeRegex("(")).toBeNull();
    expect(compileSafeRegex("free\\s+nitro")).not.toBeNull();
  });
});

describe("spam score", () => {
  test("bands match the brief's thresholds (inclusive)", () => {
    expect(severityOf(0)).toBe("normal");
    expect(severityOf(30)).toBe("normal");
    expect(severityOf(31)).toBe("suspicious");
    expect(severityOf(60)).toBe("suspicious");
    expect(severityOf(61)).toBe("spam");
    expect(severityOf(80)).toBe("spam");
    expect(severityOf(81)).toBe("severe");
  });

  test("is deterministic and the breakdown sums to the score", () => {
    const signals = { messagesInWindow: 12, windowSeconds: 10, duplicates: 4, channels: 3, mentions: 5, burst: 6 };
    const a = scoreSpam(signals);
    const b = scoreSpam(signals);
    expect(a).toEqual(b);
    const sum = a.breakdown.rate + a.breakdown.duplicates + a.breakdown.crossChannel + a.breakdown.mentions + a.breakdown.burst;
    expect(a.score).toBe(Math.round(sum));
    expect(a.score).toBeLessThanOrEqual(100);
  });

  test("a quiet user scores normal; a flood scores severe", () => {
    expect(scoreSpam({ messagesInWindow: 1, windowSeconds: 10, duplicates: 1, channels: 1, mentions: 0, burst: 1 }).severity).toBe("normal");
    const flood = scoreSpam({ messagesInWindow: 60, windowSeconds: 10, duplicates: 10, channels: 5, mentions: 10, burst: 20 });
    expect(flood.severity).toBe("severe");
    expect(explain(flood)).toContain("spam score");
  });

  test("negative/invalid numbers never escape 0..100", () => {
    const s = scoreSpam({ messagesInWindow: 0, windowSeconds: 0, duplicates: 0, channels: 0, mentions: 0, burst: 0 });
    expect(s.score).toBe(0);
  });
});

describe("evaluateRules", () => {
  const base: AutomodRule = {
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

  test("fires when every matcher matches", () => {
    const fired = evaluateRules([base], msg({ mentionIds: ["1", "2", "3"] }), ctx());
    expect(fired).toHaveLength(1);
    expect(fired[0]?.reason).toContain("mass-mention");
    expect(fired[0]?.actions).toEqual(["delete", "timeout"]);
  });

  test("a disabled rule, a wrong event, or an empty matcher list never fires", () => {
    expect(evaluateRules([{ ...base, enabled: false }], msg({ mentionIds: ["1", "2", "3"] }), ctx())).toHaveLength(0);
    expect(evaluateRules([{ ...base, event: "member_join" }], msg({ mentionIds: ["1", "2", "3"] }), ctx())).toHaveLength(0);
    expect(evaluateRules([{ ...base, matchers: [] }], msg({ mentionIds: ["1", "2", "3"] }), ctx())).toHaveLength(0);
  });

  test("all matchers are ANDed", () => {
    const rule: AutomodRule = { ...base, matchers: [{ type: "mentions", threshold: 3 }, { type: "url" }] };
    expect(evaluateRules([rule], msg({ mentionIds: ["1", "2", "3"], content: "no link" }), ctx())).toHaveLength(0);
    expect(evaluateRules([rule], msg({ mentionIds: ["1", "2", "3"], content: "http://x.y" }), ctx())).toHaveLength(1);
  });

  test("exempt users, roles and channels short-circuit", () => {
    const ev = msg({ mentionIds: ["1", "2", "3"] });
    expect(evaluateRules([{ ...base, exemptUsers: ["300"] }], ev, ctx())).toHaveLength(0);
    expect(evaluateRules([{ ...base, exemptRoles: ["777"] }], { ...ev, roleIds: ["777"] }, ctx())).toHaveLength(0);
    expect(evaluateRules([{ ...base, exemptChannels: ["200"] }], ev, ctx())).toHaveLength(0);
    expect(evaluateRules([{ ...base, exemptChannels: ["999"] }], ev, ctx())).toHaveLength(1);
  });

  test("cooldown suppresses a re-fire", () => {
    const ev = msg({ mentionIds: ["1", "2", "3"] });
    const cooling = ctx({ isCoolingDown: (id, uid) => id === 1 && uid === "300" });
    expect(evaluateRules([base], ev, cooling)).toHaveLength(0);
  });

  test("higher priority sorts first", () => {
    const low = { ...base, id: 2, name: "low", priority: 1 };
    const high = { ...base, id: 3, name: "high", priority: 99 };
    const fired = evaluateRules([low, high], msg({ mentionIds: ["1", "2", "3"] }), ctx());
    expect(fired.map((f) => f.rule.name)).toEqual(["high", "low"]);
  });
});

describe("rule validation", () => {
  const valid = {
    id: 1,
    name: "spam-links",
    enabled: true,
    priority: 5,
    event: "message",
    matchers: [{ type: "blocked_domain", values: ["evil.com"] }],
    actions: ["delete", "log_only"],
  };

  test("parses a valid rule and fills defaults", () => {
    const r = parseRule(valid);
    expect(r.name).toBe("spam-links");
    expect(r.exemptUsers).toEqual([]);
    expect(r.cooldownSeconds).toBe(0);
  });

  test("rejects the malformed cases that matter", () => {
    expect(() => parseRule({ ...valid, id: 0 })).toThrow(RuleValidationError);
    expect(() => parseRule({ ...valid, name: "" })).toThrow(RuleValidationError);
    expect(() => parseRule({ ...valid, event: "dm" })).toThrow(RuleValidationError);
    expect(() => parseRule({ ...valid, matchers: [] })).toThrow(RuleValidationError);
    expect(() => parseRule({ ...valid, matchers: [{ type: "nope" }] })).toThrow(RuleValidationError);
    expect(() => parseRule({ ...valid, matchers: [{ type: "blocked_word", values: [] }] })).toThrow(RuleValidationError);
    expect(() => parseRule({ ...valid, matchers: [{ type: "regex", pattern: "(a+)+" }] })).toThrow(RuleValidationError);
    expect(() => parseRule({ ...valid, actions: [] })).toThrow(RuleValidationError);
    expect(() => parseRule({ ...valid, actions: ["nuke"] })).toThrow(RuleValidationError);
    expect(() => parseRule({ ...valid, actions: ["timeout"] })).toThrow(RuleValidationError); // no timeoutSeconds
    expect(() => parseRule({ ...valid, actions: ["add_role"] })).toThrow(RuleValidationError); // no roleId
    expect(() => parseRule({ ...valid, exemptRoles: "mod" })).toThrow(RuleValidationError);
  });

  test("accepts a timeout rule with a duration and a role action with a roleId", () => {
    expect(parseRule({ ...valid, actions: ["timeout"], timeoutSeconds: 600 }).timeoutSeconds).toBe(600);
    expect(parseRule({ ...valid, actions: ["add_role"], roleId: "123" }).roleId).toBe("123");
  });

  test("parseRules validates a batch", () => {
    expect(parseRules([valid, { ...valid, id: 2 }])).toHaveLength(2);
    expect(() => parseRules([valid, { ...valid, id: 0 }])).toThrow(RuleValidationError);
  });

  test("normalize folds whitespace and case", () => {
    expect(normalize("  Hello   WORLD ")).toBe("hello world");
    expect(DEFAULTS.mentions).toBe(7);
  });
});
