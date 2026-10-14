import { describe, expect, test } from "bun:test";

import { ActivityLogger } from "../src/logging/service.ts";
import { AuditLog } from "../src/logging/audit.ts";
import type { APIEmbed } from "../src/framework/types.ts";

// ActivityLogger routes one embed to the channel an operator pointed a category
// at, and NEVER throws into the action that triggered it. These tests pin both
// the routing decision and the best-effort failure contract.

const EMBED: APIEmbed = { title: "x" };

describe("ActivityLogger.emit", () => {
  test("delivers to the routed channel", async () => {
    const sent: Array<{ channel: string; embed: APIEmbed }> = [];
    const logger = new ActivityLogger({
      destinations: async () => ({ message: "c-logs" }),
      send: async (channel, embed) => {
        sent.push({ channel, embed });
      },
      log: () => {},
    });
    expect(await logger.emit("message", EMBED)).toBe(true);
    expect(sent).toEqual([{ channel: "c-logs", embed: EMBED }]);
  });

  test("an unrouted category is a no-op, not an error", async () => {
    let called = false;
    const logger = new ActivityLogger({
      destinations: async () => ({}),
      send: async () => {
        called = true;
      },
      log: () => {},
    });
    expect(await logger.emit("voice", EMBED)).toBe(false);
    expect(called).toBe(false);
  });

  test("a send failure is swallowed and reported as false", async () => {
    const logs: string[] = [];
    const logger = new ActivityLogger({
      destinations: async () => ({ member: "c1" }),
      send: async () => {
        throw new Error("429 rate limited");
      },
      log: (m) => logs.push(m),
    });
    expect(await logger.emit("member", EMBED)).toBe(false);
    expect(logs.some((l) => l.includes("429"))).toBe(true);
  });

  test("a destination-lookup failure is swallowed too", async () => {
    const logger = new ActivityLogger({
      destinations: async () => {
        throw new Error("api down");
      },
      send: async () => {},
      log: () => {},
    });
    expect(await logger.emit("message", EMBED)).toBe(false);
  });

  test("emitEvent ignores a null mapping", async () => {
    let called = false;
    const logger = new ActivityLogger({
      destinations: async () => ({ message: "c1" }),
      send: async () => {
        called = true;
      },
      log: () => {},
    });
    expect(await logger.emitEvent(null)).toBe(false);
    expect(called).toBe(false);
  });
});

describe("AuditLog.record", () => {
  test("POSTs the entry to the loopback audit route", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const audit = new AuditLog("http://127.0.0.1:3199", () => {}, fetchImpl);
    const ok = await audit.record({ action: "settings.update", resourceType: "settings", source: "discord", actorId: "u1", after: { prefix: "!" } });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3199/api/internal/audit");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.action).toBe("settings.update");
    expect(body.source).toBe("discord");
    expect(body.after).toEqual({ prefix: "!" });
  });

  test("a non-2xx response is a false, not a throw", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    const audit = new AuditLog("http://127.0.0.1:3199", () => {}, fetchImpl);
    expect(await audit.record({ action: "a", resourceType: "b" })).toBe(false);
  });

  test("a network failure is a false, not a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const audit = new AuditLog("http://127.0.0.1:3199", () => {}, fetchImpl);
    expect(await audit.record({ action: "a", resourceType: "b" })).toBe(false);
  });

  test("an empty api url short-circuits to false", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const audit = new AuditLog("", () => {}, fetchImpl);
    expect(await audit.record({ action: "a", resourceType: "b" })).toBe(false);
    expect(called).toBe(false);
  });
});
