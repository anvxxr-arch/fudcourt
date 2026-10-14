import { describe, expect, test } from "bun:test";

import { applyRemoteConfig, fetchRemoteConfig, loadConfig, missingForGateway } from "../src/config.ts";
import { Command, parseOptions } from "../src/framework/command.ts";
import { Gateway } from "../src/framework/gateway.ts";
import { Rest, DiscordAPIError } from "../src/framework/rest.ts";
import { CommandStore, ListenerStore, PreconditionStore } from "../src/framework/store.ts";
import { FudzieClient } from "../src/framework/client.ts";
import type { Interaction } from "../src/framework/types.ts";
import { AdminOnly } from "../src/preconditions/AdminOnly.ts";
import { PingCommand } from "../src/commands/core/ping.ts";
import { weiToEther } from "../src/lib/rpc.ts";
import { probe, fudServices } from "../src/lib/probe.ts";

// ---------------------------------------------------------------- config
describe("config", () => {
  test("loadConfig reads the FUDCOURT_* keys and defaults", () => {
    const cfg = loadConfig({
      FUDCOURT_BOT_TOKEN: "tok",
      FUDCOURT_CLIENT_ID: "app1",
      FUDCOURT_GUILD_ID: "g1",
      FUDCOURT_ROLE_ADMIN: "r1,r2",
      FUDCOURT_ROLE_TEAM: "r3",
      FUD_WALLETS: "Main:0xabc,Hanif:0xdef",
      EVM_RPC_URL: "https://rpc",
    } as Record<string, string>);
    expect(cfg.token).toBe("tok");
    expect(cfg.applicationId).toBe("app1");
    expect(cfg.adminRoleIds).toEqual(["r1", "r2"]);
    expect(cfg.teamRoleIds).toEqual(["r3"]);
    expect(cfg.wallets.length).toBe(2);
    expect(cfg.wallets[0]).toEqual({ label: "Main", address: "0xabc" });
    expect(cfg.evmRpc).toBe("https://rpc");
    expect(cfg.dataUrl).toBe("http://127.0.0.1:3101");
  });

  test("missingForGateway names the absent keys", () => {
    const cfg = loadConfig({} as Record<string, string>);
    expect(missingForGateway(cfg)).toEqual(["FUDCOURT_BOT_TOKEN", "FUDCOURT_CLIENT_ID"]);
  });

  test("loadConfig reads the admin-editable keys and the api loopback default", () => {
    const cfg = loadConfig({
      FUDCOURT_ROLE_MAGANG: "m1 m2",
      FUDCOURT_API_URL: "http://127.0.0.1:9999/",
    } as Record<string, string>);
    expect(cfg.magangRoleIds).toEqual(["m1", "m2"]);
    expect(cfg.apiUrl).toBe("http://127.0.0.1:9999");
    expect(loadConfig({} as Record<string, string>).apiUrl).toBe("http://127.0.0.1:3103");
  });
});

// ------------------------------------------------- admin-editable config
describe("applyRemoteConfig", () => {
  const base = loadConfig({
    FUDCOURT_GUILD_ID: "g1",
    FUDCOURT_ROLE_ADMIN: "envadmin",
    FUDCOURT_ROLE_TEAM: "envteam",
    FUDCOURT_ROLE_MAGANG: "envmagang",
  } as Record<string, string>);

  test("a null remote keeps the env baseline object untouched", () => {
    expect(applyRemoteConfig(base, null)).toBe(base);
  });

  test("a stored value wins; a blank field keeps the env value", () => {
    const got = applyRemoteConfig(base, { roleAdmin: "dbadmin", roleTeam: "", guildId: "g2" });
    expect(got.adminRoleIds).toEqual(["dbadmin"]);
    expect(got.teamRoleIds).toEqual(["envteam"]);
    expect(got.magangRoleIds).toEqual(["envmagang"]);
    expect(got.guildId).toBe("g2");
    expect(got.memberGuildId).toBe("g2");
  });

  test("re-derives from the baseline, so clearing a role in the panel clears it here", () => {
    const withDb = applyRemoteConfig(base, { roleAdmin: "dbadmin" });
    expect(withDb.adminRoleIds).toEqual(["dbadmin"]);
    // The panel clears the role → blank remote → the ENV value returns, never
    // the previously fetched db value (the bug a live-config overlay would have).
    const cleared = applyRemoteConfig(base, { roleAdmin: "" });
    expect(cleared.adminRoleIds).toEqual(["envadmin"]);
  });
});

describe("fetchRemoteConfig", () => {
  test("parses the loopback payload", async () => {
    const f = (async () => new Response(JSON.stringify({ roleAdmin: "a" }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchRemoteConfig("http://x", f)).toEqual({ roleAdmin: "a" });
  });

  test("a non-2xx yields null", async () => {
    const f = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchRemoteConfig("http://x", f)).toBeNull();
  });

  test("a transport error yields null", async () => {
    const f = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await fetchRemoteConfig("http://x", f)).toBeNull();
  });

  test("an empty api url yields null without a call", async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchRemoteConfig("", f)).toBeNull();
    expect(called).toBe(false);
  });
});

describe("client config refresh", () => {
  test("refreshConfig overlays the api config, then falls back to env on clear", async () => {
    const orig = globalThis.fetch;
    let payload: unknown = { roleAdmin: "dbadmin", guildId: "g2" };
    globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    try {
      const client = new FudzieClient({
        config: loadConfig({ FUDCOURT_ROLE_ADMIN: "envadmin", FUDCOURT_GUILD_ID: "g1" } as Record<string, string>),
      });
      await client.refreshConfig();
      expect(client.config.adminRoleIds).toEqual(["dbadmin"]);
      expect(client.config.guildId).toBe("g2");

      // Panel clears the role → the client re-derives from the RAW env baseline.
      payload = { roleAdmin: "" };
      await client.refreshConfig();
      expect(client.config.adminRoleIds).toEqual(["envadmin"]);
      expect(client.config.guildId).toBe("g1");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("an unreachable api keeps the last good config", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    try {
      const client = new FudzieClient({ config: loadConfig({ FUDCOURT_ROLE_ADMIN: "envadmin" } as Record<string, string>) });
      await client.refreshConfig();
      expect(client.config.adminRoleIds).toEqual(["envadmin"]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// ---------------------------------------------------------------- stores
describe("stores", () => {
  test("CommandStore dedups by name and keeps order", () => {
    const s = new CommandStore();
    s.add(new PingCommand());
    s.add(new PingCommand());
    expect(s.size).toBe(1);
    expect(s.has("ping")).toBe(true);
    expect(s.get("ping")!.name).toBe("ping");
  });

  test("ListenerStore filters by event", () => {
    const s = new ListenerStore();
    s.add({ event: "READY", once: true, run: () => {} } as never);
    s.add({ event: "INTERACTION_CREATE", once: false, run: () => {} } as never);
    expect(s.forEvent("READY").length).toBe(1);
    expect(s.forEvent("NOPE").length).toBe(0);
    expect(s.all().length).toBe(2);
  });

  test("PreconditionStore add/get", () => {
    const s = new PreconditionStore();
    s.add(new AdminOnly());
    expect(s.get("AdminOnly")!.name).toBe("AdminOnly");
    expect(s.size).toBe(1);
  });
});

// ---------------------------------------------------------------- options
describe("parseOptions", () => {
  test("flattens nested options", () => {
    const o = parseOptions({ id: "x", name: "cmd", options: [{ name: "amount", type: 4, value: 5 }] });
    expect(o.integer("amount")).toBe(5);
    expect(o.string("missing")).toBeUndefined();
  });
});

// ---------------------------------------------------------------- gateway
class FakeWS {
  readyState = 1;
  sent: string[] = [];
  closed: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  send(d: string): void {
    this.sent.push(d);
  }
  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }
  frame(op: number, d: unknown, t?: string, s?: number): void {
    this.onmessage?.({ data: JSON.stringify({ op, d, t: t ?? null, s: s ?? null }) });
  }
}

describe("gateway state machine", () => {
  function makeGw() {
    const sockets: FakeWS[] = [];
    const events: string[] = [];
    const gw = new Gateway({
      token: "tok",
      gatewayUrl: "wss://fake",
      wsFactory: (url: string) => {
        const ws = new FakeWS(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });
    gw.on("READY", () => events.push("READY"));
    gw.connect();
    return { gw, sockets, events };
  }

  test("HELLO triggers IDENTIFY", () => {
    const { sockets } = makeGw();
    sockets[0]!.frame(10, { heartbeat_interval: 100000 });
    const identify = JSON.parse(sockets[0]!.sent[0]!);
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe("tok");
    expect(identify.d.intents).toBe(1);
  });

  test("READY dispatch marks the gateway ready and emits the event", () => {
    const { gw, sockets, events } = makeGw();
    sockets[0]!.frame(10, { heartbeat_interval: 100000 });
    sockets[0]!.frame(0, { v: 10, session_id: "sess", user: { id: "1", username: "bot" }, guilds: [] }, "READY", 1);
    expect(gw.isReady).toBe(true);
    expect(events).toEqual(["READY"]);
  });

  test("server HEARTBEAT makes the client reply with op 1", () => {
    const { sockets } = makeGw();
    sockets[0]!.frame(10, { heartbeat_interval: 100000 });
    sockets[0]!.sent.length = 0;
    sockets[0]!.frame(1, null, undefined, 7);
    const hb = JSON.parse(sockets[0]!.sent[0]!);
    expect(hb.op).toBe(1);
    expect(hb.d).toBe(7);
  });

  test("op 7 reconnect closes the socket", () => {
    const { sockets } = makeGw();
    sockets[0]!.frame(10, { heartbeat_interval: 100000 });
    sockets[0]!.frame(7, null);
    expect(sockets[0]!.closed).not.toBeNull();
  });
});

// ---------------------------------------------------------------- rest
describe("rest request shaping", () => {
  function fakeFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return new Response(text, { status });
    };
    return { fn: fn as unknown as typeof fetch, calls };
  }

  test("registerGuildCommands PUTs the payload to the guild scope", async () => {
    const { fn, calls } = fakeFetch(200, []);
    const rest = new Rest("tok", { apiBase: "https://api.test", fetcher: fn });
    await rest.registerGuildCommands("app1", "g1", [{ name: "ping", description: "p" }]);
    expect(calls[0]!.url).toBe("https://api.test/applications/app1/guilds/g1/commands");
    expect(calls[0]!.init.method).toBe("PUT");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bot tok");
    expect(JSON.parse(String(calls[0]!.init.body))[0].name).toBe("ping");
  });

  test("createInteractionResponse nests data under type", async () => {
    const { fn, calls } = fakeFetch(204, "");
    const rest = new Rest("tok", { apiBase: "https://api.test", fetcher: fn });
    await rest.createInteractionResponse("i1", "t1", 4, { content: "hi", flags: 64 });
    expect(calls[0]!.url).toBe("https://api.test/interactions/i1/t1/callback");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.type).toBe(4);
    expect(body.data.content).toBe("hi");
  });

  test("a non-2xx becomes a DiscordAPIError with status + code", async () => {
    const { fn } = fakeFetch(403, { message: "Missing Permissions", code: 50013 });
    const rest = new Rest("tok", { apiBase: "https://api.test", fetcher: fn });
    let err: unknown;
    try {
      await rest.listGuildRoles("g1");
    } catch (e) {
      err = e;
    }
    expect(err instanceof DiscordAPIError).toBe(true);
    expect((err as DiscordAPIError).status).toBe(403);
    expect((err as DiscordAPIError).code).toBe(50013);
  });
});

// ---------------------------------------------------------------- preconditions
describe("AdminOnly precondition", () => {
  function ctxWithRoles(roles: string[], adminRoleIds: string[]) {
    const client = new FudzieClient({ config: loadConfig({ FUDCOURT_ROLE_ADMIN: adminRoleIds.join(",") } as Record<string, string>) });
    return {
      client,
      member: { roles },
      user: { id: "u", username: "u" },
    } as never as Parameters<typeof AdminOnly.prototype.check>[0];
  }

  test("passes when the member holds a configured admin role", () => {
    const ctx = ctxWithRoles(["r1", "r9"], ["r1"]);
    expect(AdminOnly.prototype.check(ctx).ok).toBe(true);
  });

  test("refuses without the role", () => {
    const ctx = ctxWithRoles(["r9"], ["r1"]);
    expect(AdminOnly.prototype.check(ctx).ok).toBe(false);
  });

  test("fail-closed when no admin role is configured", () => {
    const ctx = ctxWithRoles(["r1"], []);
    const r = AdminOnly.prototype.check(ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("FUDCOURT_ROLE_ADMIN");
  });
});

// ---------------------------------------------------------------- rpc math
describe("weiToEther", () => {
  test("converts 18-decimal wei without float loss", () => {
    expect(weiToEther("0x0")).toBe(0);
    expect(weiToEther("0xde0b6b3a7640000")).toBe(1); // 1e18 wei
    expect(weiToEther("0x16345785d8a0000")).toBe(0.1); // 1e17 wei
    expect(weiToEther("")).toBe(0);
  });
});

// ---------------------------------------------------------------- probe
describe("probe", () => {
  test("reports ok on 2xx", async () => {
    const f = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await probe({ label: "web", url: "http://x/" }, f);
    expect(r.ok).toBe(true);
  });

  test("reports the status on non-2xx", async () => {
    const f = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const r = await probe({ label: "api", url: "http://x/" }, f);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("http 500");
  });

  test("reports down on a transport error", async () => {
    const f = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const r = await probe({ label: "api", url: "http://x/" }, f);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("down");
  });

  test("fudServices lists the four loopback tiers", () => {
    const svcs = fudServices("http://127.0.0.1:3101");
    expect(svcs.map((s) => s.label)).toEqual(["web", "data", "reconciled", "api"]);
  });
});

// ---------------------------------------------------------------- routing
class RecordingRest {
  calls: Array<Record<string, unknown>> = [];
  async createInteractionResponse(id: string, token: string, type: number, data?: unknown): Promise<void> {
    this.calls.push({ kind: "callback", id, token, type, data });
  }
  async createFollowup(appId: string, token: string, data: unknown): Promise<void> {
    this.calls.push({ kind: "followup", appId, token, data });
  }
}

function interaction(name: string, roles: string[] = []): Interaction {
  return {
    id: "i1",
    token: "t1",
    application_id: "app1",
    type: 2,
    guild_id: "g1",
    channel_id: "c1",
    data: { id: "d1", name },
    member: { user: { id: "u1", username: "u" }, roles },
  };
}

describe("interaction routing", () => {
  function makeClient(rest: RecordingRest) {
    const client = new FudzieClient({
      config: loadConfig({ FUDCOURT_ROLE_ADMIN: "admin" } as Record<string, string>),
      rest: rest as never,
    });
    client.commands.add(new PingCommand());
    client.preconditions.add(new AdminOnly());
    return client;
  }

  test("unknown command → ephemeral unknown reply", async () => {
    const rest = new RecordingRest();
    const client = makeClient(rest);
    await client.handleInteraction(interaction("nope"));
    const cb = rest.calls[0]!;
    expect(cb.type).toBe(4);
    expect((cb.data as { content: string }).content).toContain("Unknown command");
  });

  test("known command runs and replies", async () => {
    const rest = new RecordingRest();
    const client = makeClient(rest);
    await client.handleInteraction(interaction("ping"));
    const cb = rest.calls[0]!;
    expect(cb.type).toBe(4);
    expect((cb.data as { embeds: unknown[] }).embeds.length).toBe(1);
  });

  test("a failing precondition short-circuits the command", async () => {
    class AdminCmd extends Command {
      ran = false;
      constructor() {
        super({ name: "admincmd", description: "x", adminOnly: true });
      }
      run(): void {
        this.ran = true;
      }
    }
    const rest = new RecordingRest();
    const client = makeClient(rest);
    const cmd = new AdminCmd();
    client.commands.add(cmd);
    await client.handleInteraction(interaction("admincmd", []));
    expect(cmd.ran).toBe(false);
    const cb = rest.calls[0]!;
    expect((cb.data as { content: string }).content).toContain("admin-only");
  });
});
