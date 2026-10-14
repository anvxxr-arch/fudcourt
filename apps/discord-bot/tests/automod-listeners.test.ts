import { describe, expect, test } from "bun:test";

import type { FudzieClient } from "../src/framework/client.ts";
import type { IncomingJoin, IncomingMessage } from "../src/automod/service.ts";
import guildMemberAdd from "../src/listeners/guildMemberAdd.ts";
import messageCreate from "../src/listeners/messageCreate.ts";

interface Spy {
  client: FudzieClient;
  messages: IncomingMessage[];
  joins: IncomingJoin[];
}

function spy(guildId = "g1"): Spy {
  const messages: IncomingMessage[] = [];
  const joins: IncomingJoin[] = [];
  const client = {
    config: { guildId },
    logger: { async emitEvent() { return true; } },
    automod: {
      async onMessage(m: IncomingMessage) {
        messages.push(m);
        return [];
      },
      async onJoin(j: IncomingJoin) {
        joins.push(j);
        return [];
      },
    },
  } as unknown as FudzieClient;
  return { client, messages, joins };
}

const GUILD_MSG = {
  id: "m1",
  channel_id: "c1",
  guild_id: "g1",
  content: "hello",
  author: { id: "175928847299117063", username: "u" },
  mentions: [{ id: "9" }],
  member: { roles: ["r1"] },
};

describe("MessageCreateListener", () => {
  test("routes a guild message to AutoMod", async () => {
    const s = spy();
    await messageCreate.run(s.client, GUILD_MSG);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.messageId).toBe("m1");
    expect(s.messages[0]?.authorId).toBe("175928847299117063");
  });

  test("ignores a DM (no guild_id)", async () => {
    const s = spy();
    await messageCreate.run(s.client, { ...GUILD_MSG, guild_id: undefined });
    expect(s.messages).toHaveLength(0);
  });

  test("ignores a bot's own message", async () => {
    const s = spy();
    await messageCreate.run(s.client, { ...GUILD_MSG, author: { id: "1", username: "bot", bot: true } });
    expect(s.messages).toHaveLength(0);
  });

  test("ignores a payload with no author", async () => {
    const s = spy();
    await messageCreate.run(s.client, { id: "m", channel_id: "c", guild_id: "g1" });
    expect(s.messages).toHaveLength(0);
  });
});

describe("GuildMemberAddListener", () => {
  test("routes a join to AutoMod with the account age", async () => {
    const s = spy();
    await guildMemberAdd.run(s.client, { user: { id: "175928847299117063", username: "u" }, guild_id: "g1" });
    expect(s.joins).toHaveLength(1);
    expect(s.joins[0]?.userId).toBe("175928847299117063");
    expect(s.joins[0]?.accountCreatedAt).toBeGreaterThan(1_400_000_000_000);
  });

  test("falls back to the configured guild when the payload omits it", async () => {
    const s = spy("g-configured");
    await guildMemberAdd.run(s.client, { user: { id: "1", username: "u" } });
    expect(s.joins[0]?.guildId).toBe("g-configured");
  });

  test("ignores a payload with no user", async () => {
    const s = spy();
    await guildMemberAdd.run(s.client, { guild_id: "g1" });
    expect(s.joins).toHaveLength(0);
  });
});
