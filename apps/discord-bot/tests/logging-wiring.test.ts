import { describe, expect, test } from "bun:test";

import { fetchLogConfig, LOG_CONFIG_PATH } from "../src/logging/wiring.ts";
import type { FudzieClient } from "../src/framework/client.ts";
import messageDelete from "../src/listeners/messageDelete.ts";
import messageUpdate from "../src/listeners/messageUpdate.ts";
import guildMemberRemove from "../src/listeners/guildMemberRemove.ts";
import guildMemberUpdate from "../src/listeners/guildMemberUpdate.ts";
import voiceStateUpdate from "../src/listeners/voiceStateUpdate.ts";
import channelCreate from "../src/listeners/channelCreate.ts";
import channelUpdate from "../src/listeners/channelUpdate.ts";
import channelDelete from "../src/listeners/channelDelete.ts";
import guildMemberAdd from "../src/listeners/guildMemberAdd.ts";
import type { ActivityEvent } from "../src/logging/types.ts";

function fetchJSON(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("fetchLogConfig", () => {
  test("reads the enabled category → channel map from the loopback route", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ destinations: { message: "c1", member: "c2" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const map = await fetchLogConfig("http://127.0.0.1:3199", fetchImpl);
    expect(map).toEqual({ message: "c1", member: "c2" });
    expect(calls[0]).toBe(`http://127.0.0.1:3199${LOG_CONFIG_PATH}`);
  });

  test("drops non-string / empty channel values", async () => {
    const fetchImpl = fetchJSON({ destinations: { message: "c1", member: "", voice: 7, bogus: null } });
    const map = await fetchLogConfig("http://127.0.0.1:3199", fetchImpl);
    expect(map).toEqual({ message: "c1" });
  });

  test("an unreachable api yields an empty map (never throws)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchLogConfig("http://127.0.0.1:3199", fetchImpl)).toEqual({});
  });

  test("a non-2xx response yields an empty map", async () => {
    expect(await fetchLogConfig("http://127.0.0.1:3199", fetchJSON({}, 500))).toEqual({});
  });

  test("an empty api url short-circuits without a fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchLogConfig("", fetchImpl)).toEqual({});
    expect(called).toBe(false);
  });
});

// The listeners are one-liners over the mappers; a spy client captures the
// {category, embed} each one routes, so the wiring (event → mapper → logger) is
// pinned without a gateway.
function spyClient(): { client: FudzieClient; events: Array<ActivityEvent | null> } {
  const events: Array<ActivityEvent | null> = [];
  const client = {
    config: { guildId: "g1" },
    logger: {
      async emitEvent(ev: ActivityEvent | null) {
        events.push(ev);
        return true;
      },
    },
    automod: { async onJoin() { return []; } },
    welcome: { async onJoin() {}, async onLeave() {} },
    autorole: { async onJoin() {} },
  } as unknown as FudzieClient;
  return { client, events };
}

describe("logging listeners", () => {
  test("messageDelete routes a delete to the message category", async () => {
    const { client, events } = spyClient();
    await messageDelete.run(client, { id: "m1", channel_id: "c1" });
    expect(events[0]?.category).toBe("message");
  });

  test("messageUpdate routes an edit", async () => {
    const { client, events } = spyClient();
    await messageUpdate.run(client, { id: "m1", channel_id: "c1", content: "x" });
    expect(events[0]?.embed.title).toBe("Message edited");
  });

  test("guildMemberRemove routes a leave", async () => {
    const { client, events } = spyClient();
    await guildMemberRemove.run(client, { user: { id: "u1", username: "u" } });
    expect(events[0]?.category).toBe("member");
  });

  test("guildMemberUpdate routes a role change to the role category", async () => {
    const { client, events } = spyClient();
    await guildMemberUpdate.run(client, { user: { id: "u1", username: "u" }, roles: ["r1"] });
    expect(events[0]?.category).toBe("role");
  });

  test("voiceStateUpdate routes a voice join", async () => {
    const { client, events } = spyClient();
    await voiceStateUpdate.run(client, { guild_id: "g1", user_id: "u1", channel_id: "v1" });
    expect(events[0]?.category).toBe("voice");
  });

  test("channel create/update/delete each route to the channel category", async () => {
    for (const l of [channelCreate, channelUpdate, channelDelete]) {
      const { client, events } = spyClient();
      await l.run(client, { id: "c1", name: "general" });
      expect(events[0]?.category).toBe("channel");
    }
  });

  test("guildMemberAdd logs the join AND still runs AutoMod", async () => {
    const events: Array<ActivityEvent | null> = [];
    const joins: unknown[] = [];
    const client = {
      config: { guildId: "g1" },
      logger: { async emitEvent(ev: ActivityEvent | null) { events.push(ev); return true; } },
      automod: { async onJoin(j: unknown) { joins.push(j); return []; } },
      welcome: { async onJoin() {}, async onLeave() {} },
      autorole: { async onJoin() {} },
    } as unknown as FudzieClient;
    await guildMemberAdd.run(client, { guild_id: "g1", user: { id: "175928847299117063", username: "new" } });
    expect(events[0]?.category).toBe("member");
    expect(joins).toHaveLength(1);
  });
});
