import { describe, expect, test } from "bun:test";

import { InMemoryCooldownStore } from "../src/customcommands/cooldown.ts";
import { CustomCommandService, parseTrigger, type OutgoingMessage } from "../src/customcommands/service.ts";
import { parseCustomCommands, type CustomCommand } from "../src/customcommands/types.ts";
import type { DiscordMessage } from "../src/framework/types.ts";

// --- pure parsing ---------------------------------------------------------

describe("parseTrigger", () => {
  test("splits the name from the args", () => {
    expect(parseTrigger("rules")).toEqual({ name: "rules", args: "" });
    expect(parseTrigger("rules a b c")).toEqual({ name: "rules", args: "a b c" });
  });

  test("lowercases the name so a trigger is case-insensitive", () => {
    expect(parseTrigger("RULES")?.name).toBe("rules");
  });

  test("tolerates leading whitespace", () => {
    expect(parseTrigger("   website")).toEqual({ name: "website", args: "" });
  });

  test("yields nothing for an empty or whitespace-only body", () => {
    expect(parseTrigger("")).toBeUndefined();
    expect(parseTrigger("   ")).toBeUndefined();
  });
});

describe("parseCustomCommands", () => {
  test("drops a row with no usable name", () => {
    expect(parseCustomCommands([{ responses: [{ text: "x" }] }, { name: "ok", responses: [{ text: "y" }] }])).toHaveLength(1);
  });

  test("defaults reply to true and the rest to falsy", () => {
    const [c] = parseCustomCommands([{ name: "rules", responses: [{ text: "x" }] }]);
    expect(c?.reply).toBe(true);
    expect(c?.dm).toBe(false);
    expect(c?.deleteTrigger).toBe(false);
    expect(c?.enabled).toBe(true);
  });

  test("drops a response that is neither text nor an embed", () => {
    const [c] = parseCustomCommands([{ name: "x", responses: [{}, { text: "keep" }] }]);
    expect(c?.responses).toHaveLength(1);
  });

  test("returns an empty list for a non-array body", () => {
    expect(parseCustomCommands(null)).toEqual([]);
    expect(parseCustomCommands({})).toEqual([]);
  });
});

// --- service --------------------------------------------------------------

const RULES: CustomCommand = {
  id: "1",
  name: "rules",
  aliases: ["rulebook"],
  responses: [{ text: "Read {server} rules, {mention}!" }],
  allowedRoles: [],
  allowedChannels: [],
  cooldownSeconds: 0,
  deleteTrigger: false,
  reply: true,
  dm: false,
  enabled: true,
};

interface Harness {
  svc: CustomCommandService;
  sent: Array<{ channelId: string; data: OutgoingMessage }>;
  dms: Array<{ userId: string; data: OutgoingMessage }>;
  deleted: string[];
  clock: { now: number };
}

function harness(cmds: CustomCommand[], over: Partial<{ prefix: string; pick: (n: number) => number; failList: boolean }> = {}): Harness {
  const sent: Array<{ channelId: string; data: OutgoingMessage }> = [];
  const dms: Array<{ userId: string; data: OutgoingMessage }> = [];
  const deleted: string[] = [];
  const clock = { now: 1_000 };
  const svc = new CustomCommandService({
    commands: async () => {
      if (over.failList) throw new Error("api down");
      return cmds;
    },
    prefix: () => over.prefix ?? "!",
    send: async (channelId, data) => {
      sent.push({ channelId, data });
    },
    directMessage: async (userId, data) => {
      dms.push({ userId, data });
    },
    deleteMessage: async (_c, id) => {
      deleted.push(id);
    },
    guildInfo: async () => ({ name: "FUD Court", memberCount: 42 }),
    cooldown: new InMemoryCooldownStore(),
    now: () => clock.now,
    pick: over.pick,
    log: () => {},
  });
  return { svc, sent, dms, deleted, clock };
}

function msg(over: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "m1",
    channel_id: "c1",
    guild_id: "g1",
    content: "!rules",
    author: { id: "42", username: "dwi", global_name: "Dwi" },
    member: { roles: [] },
    ...over,
  };
}

describe("CustomCommandService — matching", () => {
  test("answers a triggered command and reports it handled", async () => {
    const h = harness([RULES]);
    expect(await h.svc.handleMessage(msg())).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.channelId).toBe("c1");
  });

  test("matches an alias", async () => {
    const h = harness([RULES]);
    expect(await h.svc.handleMessage(msg({ content: "!rulebook" }))).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  test("ignores a message without the prefix", async () => {
    const h = harness([RULES]);
    expect(await h.svc.handleMessage(msg({ content: "rules" }))).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  test("ignores a message from a bot author", async () => {
    const h = harness([RULES]);
    expect(await h.svc.handleMessage(msg({ content: "!rules", author: { id: "9", username: "bot", bot: true } }))).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  test("ignores an unknown trigger", async () => {
    const h = harness([RULES]);
    expect(await h.svc.handleMessage(msg({ content: "!nope" }))).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  test("ignores a disabled command", async () => {
    const h = harness([{ ...RULES, enabled: false }]);
    expect(await h.svc.handleMessage(msg())).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  test("a bare prefix is not a trigger", async () => {
    const h = harness([RULES]);
    expect(await h.svc.handleMessage(msg({ content: "!" }))).toBe(false);
  });

  test("respects a custom prefix", async () => {
    const h = harness([{ ...RULES, name: "rules" }], { prefix: "?" });
    expect(await h.svc.handleMessage(msg({ content: "?rules" }))).toBe(true);
    expect(await h.svc.handleMessage(msg({ content: "!rules" }))).toBe(false);
  });
});

describe("CustomCommandService — gates", () => {
  test("ignores the command when the member lacks every allowed role", async () => {
    const h = harness([{ ...RULES, allowedRoles: ["r-mod"] }]);
    expect(await h.svc.handleMessage(msg({ member: { roles: ["r-other"] } }))).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  test("answers when the member holds an allowed role", async () => {
    const h = harness([{ ...RULES, allowedRoles: ["r-mod"] }]);
    expect(await h.svc.handleMessage(msg({ member: { roles: ["r-mod"] } }))).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  test("ignores the command in a channel that is not allowed", async () => {
    const h = harness([{ ...RULES, allowedChannels: ["c-allowed"] }]);
    expect(await h.svc.handleMessage(msg({ channel_id: "c-elsewhere" }))).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  test("answers in an allowed channel", async () => {
    const h = harness([{ ...RULES, allowedChannels: ["c1"] }]);
    expect(await h.svc.handleMessage(msg())).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  test("a member with no member record cannot pass a role gate", async () => {
    const h = harness([{ ...RULES, allowedRoles: ["r-mod"] }]);
    await h.svc.handleMessage(msg({ member: undefined }));
    expect(h.sent).toHaveLength(0);
  });
});

describe("CustomCommandService — cooldown", () => {
  test("answers once and suppresses a repeat inside the window", async () => {
    const h = harness([{ ...RULES, cooldownSeconds: 10 }]);
    await h.svc.handleMessage(msg());
    h.clock.now += 3_000;
    await h.svc.handleMessage(msg());
    expect(h.sent).toHaveLength(1);
  });

  test("answers again once the window has passed", async () => {
    const h = harness([{ ...RULES, cooldownSeconds: 10 }]);
    await h.svc.handleMessage(msg());
    h.clock.now += 11_000;
    await h.svc.handleMessage(msg());
    expect(h.sent).toHaveLength(2);
  });

  test("the cooldown is per member", async () => {
    const h = harness([{ ...RULES, cooldownSeconds: 60 }]);
    await h.svc.handleMessage(msg({ author: { id: "42", username: "a" } }));
    await h.svc.handleMessage(msg({ author: { id: "99", username: "b" } }));
    expect(h.sent).toHaveLength(2);
  });
});

describe("CustomCommandService — rendering", () => {
  test("renders the standard variables", async () => {
    const h = harness([{ ...RULES, responses: [{ text: "server={server} count={member_count} user={user} chan={channel} args={args}" }] }]);
    await h.svc.handleMessage(msg({ content: "!rules now please", mentions: [] }));
    expect(h.sent[0]?.data.content).toBe("server=FUD Court count=42 user=<@42> chan=<#c1> args=now please");
  });

  test("{mention} resolves to the pinged user", async () => {
    const h = harness([RULES]);
    await h.svc.handleMessage(msg({ mentions: [{ id: "777" }] }));
    expect(h.sent[0]?.data.content).toBe("Read FUD Court rules, <@777>!");
  });

  test("{mention} falls back to the invoker when nothing was pinged", async () => {
    const h = harness([{ ...RULES, responses: [{ text: "hi {mention}" }] }]);
    await h.svc.handleMessage(msg({ mentions: [] }));
    expect(h.sent[0]?.data.content).toBe("hi <@42>");
  });

  test("leaves an unknown placeholder verbatim", async () => {
    const h = harness([{ ...RULES, responses: [{ text: "start {oops} end" }] }]);
    await h.svc.handleMessage(msg());
    expect(h.sent[0]?.data.content).toBe("start {oops} end");
  });

  test("renders an embed response", async () => {
    const h = harness([
      { ...RULES, responses: [{ embed: { title: "Welcome to {server}", description: "hi {user}" } }] },
    ]);
    await h.svc.handleMessage(msg());
    expect(h.sent[0]?.data.content).toBeUndefined();
    expect(h.sent[0]?.data.embeds?.[0]?.title).toBe("Welcome to FUD Court");
    expect(h.sent[0]?.data.embeds?.[0]?.description).toBe("hi <@42>");
  });

  test("picks a random response deterministically when injected", async () => {
    const responses = [{ text: "one" }, { text: "two" }, { text: "three" }];
    const h = harness([{ ...RULES, responses }], { pick: () => 2 });
    await h.svc.handleMessage(msg());
    expect(h.sent[0]?.data.content).toBe("three");
  });
});

describe("CustomCommandService — delivery", () => {
  test("replies to the trigger by default", async () => {
    const h = harness([RULES]);
    await h.svc.handleMessage(msg());
    expect(h.sent[0]?.data.replyTo).toBe("m1");
  });

  test("does not reply when reply is false", async () => {
    const h = harness([{ ...RULES, reply: false }]);
    await h.svc.handleMessage(msg());
    expect(h.sent[0]?.data.replyTo).toBeUndefined();
  });

  test("sends a DM instead of posting in the channel", async () => {
    const h = harness([{ ...RULES, dm: true }]);
    await h.svc.handleMessage(msg());
    expect(h.sent).toHaveLength(0);
    expect(h.dms).toHaveLength(1);
    expect(h.dms[0]?.userId).toBe("42");
    expect(h.dms[0]?.data.replyTo).toBeUndefined();
  });

  test("deletes the trigger when delete_trigger is set", async () => {
    const h = harness([{ ...RULES, deleteTrigger: true }]);
    await h.svc.handleMessage(msg());
    expect(h.deleted).toEqual(["m1"]);
  });

  test("does not delete the trigger by default", async () => {
    const h = harness([RULES]);
    await h.svc.handleMessage(msg());
    expect(h.deleted).toHaveLength(0);
  });
});

describe("CustomCommandService — resilience", () => {
  test("an unreachable command list is not fatal and not handled", async () => {
    const h = harness([], { failList: true });
    expect(await h.svc.handleMessage(msg())).toBe(false);
  });

  test("a send failure is swallowed and still reported handled", async () => {
    const svc = new CustomCommandService({
      commands: async () => [RULES],
      prefix: () => "!",
      send: async () => {
        throw new Error("discord 403");
      },
      directMessage: async () => {},
      deleteMessage: async () => {},
      guildInfo: async () => ({ name: "x" }),
      cooldown: new InMemoryCooldownStore(),
      log: () => {},
    });
    expect(await svc.handleMessage(msg())).toBe(true);
  });

  test("ignores a message with no author id", async () => {
    const h = harness([RULES]);
    expect(await h.svc.handleMessage(msg({ author: undefined }))).toBe(false);
  });

  test("ignores a message with no guild (a DM)", async () => {
    const h = harness([RULES]);
    expect(await h.svc.handleMessage(msg({ guild_id: undefined }))).toBe(false);
  });
});

describe("InMemoryCooldownStore", () => {
  test("reports the remaining window, then frees it", async () => {
    const s = new InMemoryCooldownStore();
    expect(await s.remainingMs("k", 0)).toBe(0);
    await s.mark("k", 5, 0);
    expect(await s.remainingMs("k", 1_000)).toBe(4_000);
    expect(await s.remainingMs("k", 5_000)).toBe(0);
  });

  test("a zero-second mark never blocks", async () => {
    const s = new InMemoryCooldownStore();
    await s.mark("k", 0, 0);
    expect(await s.remainingMs("k", 0)).toBe(0);
  });
});
