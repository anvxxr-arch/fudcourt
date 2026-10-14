import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import { FudzieClient } from "../src/framework/client.ts";
import type { Rest } from "../src/framework/rest.ts";
import type { GuildMember, GuildRole } from "../src/framework/types.ts";
import { CaseLog, caseActionName, type CaseInput, type CaseLogLike, type ModerationCase } from "../src/lib/cases.ts";
import { union, Perm } from "../src/lib/permissions.ts";
import { ModerationService, type ModRequest } from "../src/moderation/service.ts";

// ---------------------------------------------------------------- CaseLog
// A stub fetch that records the request and returns a canned Response.
function stubFetch(
  status: number,
  body: unknown,
): { fetch: typeof fetch; calls: Array<{ url: string; method: string; body?: unknown }> } {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    let parsed: unknown;
    if (typeof init?.body === "string") parsed = JSON.parse(init.body);
    calls.push({ url: u, method: init?.method ?? "GET", body: parsed });
    return Promise.resolve(
      new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const oneCase: ModerationCase = {
  id: 1,
  caseNumber: 7,
  guildId: "g1",
  action: "ban",
  targetUserId: "111111111111111111",
  moderatorUserId: "222222222222222222",
  reason: "spam",
  source: "slash",
  status: "active",
  createdAt: "2026-01-01 00:00:00",
  updatedAt: "2026-01-01 00:00:00",
};

describe("CaseLog", () => {
  test("record posts the closed body and returns the stored case", async () => {
    const { fetch, calls } = stubFetch(201, oneCase);
    const log = new CaseLog("http://127.0.0.1:3103", () => {}, fetch);
    const stored = await log.record({
      action: "ban",
      targetUserId: "111111111111111111",
      moderatorUserId: "222222222222222222",
      reason: "spam",
      source: "slash",
    });
    expect(stored?.caseNumber).toBe(7);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://127.0.0.1:3103/api/internal/moderation/cases");
    expect(calls[0]?.body).toMatchObject({ action: "ban", source: "slash" });
  });

  test("record omits durationSeconds when absent, includes it when set", async () => {
    const { fetch, calls } = stubFetch(201, oneCase);
    const log = new CaseLog("http://127.0.0.1:3103", () => {}, fetch);
    await log.record({ action: "warn", targetUserId: "1", moderatorUserId: "2", reason: "" });
    expect((calls[0]?.body as Record<string, unknown>).durationSeconds).toBeUndefined();
    await log.record({ action: "timeout", targetUserId: "1", moderatorUserId: "2", reason: "", durationSeconds: 600 });
    expect((calls[1]?.body as Record<string, unknown>).durationSeconds).toBe(600);
  });

  test("history parses the cases envelope and clamps the limit", async () => {
    const { fetch, calls } = stubFetch(200, { cases: [oneCase] });
    const log = new CaseLog("http://127.0.0.1:3103", () => {}, fetch);
    const out = await log.history("111111111111111111", 999);
    expect(out).toHaveLength(1);
    expect(calls[0]?.url).toContain("limit=25");
    expect(calls[0]?.url).toContain("target=111111111111111111");
  });

  test("byNumber returns null on a 404", async () => {
    const { fetch } = stubFetch(404, { error: "not_found" });
    const log = new CaseLog("http://127.0.0.1:3103", () => {}, fetch);
    expect(await log.byNumber(999)).toBeNull();
  });

  test("a network failure never throws — record/history degrade", async () => {
    const boom = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const log = new CaseLog("http://127.0.0.1:3103", () => {}, boom);
    expect(await log.record({ action: "ban", targetUserId: "1", moderatorUserId: "2", reason: "" })).toBeNull();
    expect(await log.history("1")).toEqual([]);
    expect(await log.byNumber(1)).toBeNull();
  });

  test("an empty apiUrl disables the log without a call", async () => {
    const { fetch, calls } = stubFetch(201, oneCase);
    const log = new CaseLog("", () => {}, fetch);
    expect(await log.record({ action: "ban", targetUserId: "1", moderatorUserId: "2", reason: "" })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("caseActionName maps nick → nickname and leaves the rest", () => {
    expect(caseActionName("nick")).toBe("nickname");
    expect(caseActionName("ban")).toBe("ban");
    expect(caseActionName("timeout")).toBe("timeout");
  });
});

// ------------------------------------------------------- service recording
class FakeRest {
  guild = { id: "g1", name: "G", owner_id: "owner" };
  roles: GuildRole[] = [
    { id: "e", name: "@everyone", color: 0, position: 0, managed: false },
    { id: "mod", name: "Mod", color: 0, position: 5, managed: false },
    { id: "bot", name: "Fudzie", color: 0, position: 20, managed: false },
  ];
  members: Record<string, GuildMember> = {
    bot: { roles: ["bot"] },
    victim: { roles: [] },
    mod: { roles: ["mod"] },
    owner: { roles: [] },
  };
  messages = [{ id: "m1" }];
  getCurrentUser() {
    return Promise.resolve({ id: "bot", username: "Fudzie" });
  }
  getGuild() {
    return Promise.resolve(this.guild);
  }
  listGuildRoles() {
    return Promise.resolve(this.roles);
  }
  getGuildMember(_g: string, u: string) {
    const m = this.members[u];
    if (!m) return Promise.reject(Object.assign(new Error("404"), { status: 404, notFound: true }));
    return Promise.resolve(m);
  }
  banMember() {
    return Promise.resolve();
  }
  kickMember() {
    return Promise.resolve();
  }
  modifyMember() {
    return Promise.resolve();
  }
  listMessages(_c: string, limit: number) {
    return Promise.resolve(this.messages.slice(0, limit));
  }
  deleteMessage() {
    return Promise.resolve();
  }
  bulkDeleteMessages() {
    return Promise.resolve();
  }
}

/** A stub case store that records what it was asked to persist. */
class StubCaseLog implements CaseLogLike {
  readonly recorded: CaseInput[] = [];
  constructor(private readonly result: ModerationCase | null = null, private readonly throws = false) {}
  record(input: CaseInput): Promise<ModerationCase | null> {
    if (this.throws) return Promise.reject(new Error("store down"));
    this.recorded.push(input);
    return Promise.resolve(this.result);
  }
  history(): Promise<ModerationCase[]> {
    return Promise.resolve([]);
  }
  byNumber(): Promise<ModerationCase | null> {
    return Promise.resolve(null);
  }
}

function svcWith(cases: CaseLogLike): ModerationService {
  const cfg = loadConfig({ FUDCOURT_GUILD_ID: "g1" } as Record<string, string>);
  const client = new FudzieClient({ config: cfg, rest: new FakeRest() as unknown as Rest, log: () => {}, cases });
  return new ModerationService(client);
}

function modReq(over: Partial<ModRequest>): ModRequest {
  return {
    action: "ban",
    guildId: "g1",
    actorId: "mod",
    actorRoles: ["mod"],
    actorPermissions: union([
      Perm.BAN_MEMBERS.toString(),
      Perm.KICK_MEMBERS.toString(),
      Perm.MANAGE_MESSAGES.toString(),
      Perm.MANAGE_CHANNELS.toString(),
      Perm.MANAGE_NICKNAMES.toString(),
      Perm.MODERATE_MEMBERS.toString(),
    ]).toString(),
    ...over,
  };
}

describe("ModerationService case recording", () => {
  test("a successful ban is recorded and the case number is stamped", async () => {
    const log = new StubCaseLog({ ...oneCase, caseNumber: 42 });
    const res = await svcWith(log).run(modReq({ action: "ban", targetId: "victim", reason: "spam" }));
    expect(res.ok).toBe(true);
    expect(res.caseNumber).toBe(42);
    expect(log.recorded).toHaveLength(1);
    expect(log.recorded[0]).toMatchObject({ action: "ban", targetUserId: "victim", moderatorUserId: "mod", reason: "spam" });
  });

  test("nick is recorded under the canonical 'nickname' action", async () => {
    const log = new StubCaseLog(oneCase);
    await svcWith(log).run(modReq({ action: "nick", targetId: "victim", nick: "Bad" }));
    expect(log.recorded[0]?.action).toBe("nickname");
  });

  test("a refusal is never recorded", async () => {
    const log = new StubCaseLog(oneCase);
    // The owner can never be moderated → refused before any REST call.
    const res = await svcWith(log).run(modReq({ action: "ban", targetId: "owner" }));
    expect(res.ok).toBe(false);
    expect(log.recorded).toHaveLength(0);
  });

  test("a channel action is not recorded as a user case", async () => {
    const log = new StubCaseLog(oneCase);
    const res = await svcWith(log).run(modReq({ action: "purge", targetId: undefined, channelId: "c1", count: 1 }));
    expect(res.ok).toBe(true);
    expect(log.recorded).toHaveLength(0);
  });

  test("a throwing case store never fails the action", async () => {
    const log = new StubCaseLog(null, true);
    const res = await svcWith(log).run(modReq({ action: "ban", targetId: "victim" }));
    expect(res.ok).toBe(true);
    expect(res.caseNumber).toBeUndefined();
  });

  test("the source defaults to slash and is overridable", async () => {
    const log = new StubCaseLog(oneCase);
    const svc = svcWith(log);
    await svc.run(modReq({ action: "kick", targetId: "victim" }));
    await svc.run(modReq({ action: "kick", targetId: "victim", source: "context_menu" }));
    expect(log.recorded[0]?.source).toBe("slash");
    expect(log.recorded[1]?.source).toBe("context_menu");
  });

  test("a timeout records its duration", async () => {
    const log = new StubCaseLog(oneCase);
    await svcWith(log).run(modReq({ action: "timeout", targetId: "victim", durationSeconds: 600 }));
    expect(log.recorded[0]?.durationSeconds).toBe(600);
  });
});
