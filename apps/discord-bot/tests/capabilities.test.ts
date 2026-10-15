// The capability gate: the half of §9 that runs in front of a Discord command.
//
// Three things are checked here, in increasing order of how much they would hurt to get wrong:
// the policy itself (decision table, no network), the client's failure behaviour (an api that is down
// must not become a bot that refuses everything), and the WIRING — that a command declaring a
// capability is actually stopped by the router, which is the only part a wrong unit test would miss.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { Command } from "../src/framework/command.ts";
import { FudzieClient } from "../src/framework/client.ts";
import type { Interaction } from "../src/framework/types.ts";
import { loadConfig } from "../src/config.ts";
import {
  CapabilityClient,
  decide,
  UNREACHABLE,
  type CapabilityAnswer,
  type CapabilityReader,
} from "../src/lib/capabilities.ts";
import { ACTION_CAPABILITY } from "../src/moderation/capabilities.ts";

const GRANTED: CapabilityAnswer = { ok: true, capabilities: ["moderation.ban"], source: "roles", mappingEmpty: false };

describe("decide", () => {
  test("a granted capability passes", () => {
    expect(decide(GRANTED, "moderation.ban")).toEqual({ ok: true, why: "granted" });
  });

  test("a capability the member does not hold is refused once a mapping exists", () => {
    expect(decide(GRANTED, "moderation.kick")).toEqual({ ok: false, why: "denied" });
  });

  test("an unmapped guild keeps the command's own gate in charge", () => {
    // `mappingEmpty` is not "this member holds nothing": it is "the engine is not in charge yet".
    // Reading the two as the same thing would silently disable moderation on every guild whose roles
    // nobody has mapped — the failure this whole field exists to prevent.
    expect(decide({ ok: true, capabilities: [], source: "admin_baseline", mappingEmpty: true }, "moderation.ban"))
      .toEqual({ ok: true, why: "unmapped" });
  });

  test("an api that cannot answer leaves the pre-existing gate in charge", () => {
    expect(decide(UNREACHABLE, "moderation.ban")).toEqual({ ok: true, why: "unreachable" });
  });

  test("an unmapped guild is reported as unmapped even when the api is unreachable", () => {
    // Both fall through to the same outcome, but the LOG differs, and an operator reading it needs to
    // tell "nobody has mapped a role" from "the api is sick".
    expect(decide({ ok: false, capabilities: [], source: "unreachable", mappingEmpty: true }, "x.y"))
      .toEqual({ ok: true, why: "unmapped" });
  });
});

describe("CapabilityClient", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  test("reads the api's answer", async () => {
    let seen = "";
    const client = new CapabilityClient({
      apiUrl: "http://127.0.0.1:3103/",
      fetchImpl: (async (url: string) => {
        seen = url;
        return jsonResponse({ capabilities: ["moderation.ban"], source: "roles", mappingEmpty: false, unknown: [] });
      }) as unknown as typeof fetch,
    });
    const answer = await client.read("u1", ["r1"]);
    expect(seen).toBe("http://127.0.0.1:3103/api/internal/capabilities");
    expect(answer).toEqual({ ok: true, capabilities: ["moderation.ban"], source: "roles", mappingEmpty: false });
  });

  test("reuses an answer for the same role set, and does not confuse two members", async () => {
    let calls = 0;
    const client = new CapabilityClient({
      apiUrl: "http://127.0.0.1:3103",
      ttlMs: 60_000,
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({ capabilities: [], source: "roles", mappingEmpty: false });
      }) as unknown as typeof fetch,
    });
    await client.read("u1", ["r1", "r2"]);
    await client.read("u1", ["r2", "r1"]); // same set, different order
    expect(calls).toBe(1);
    await client.read("u2", ["r1", "r2"]); // a different member is a different question
    expect(calls).toBe(2);
  });

  test("does not cache a failure: the next call must be the one that discovers the api came back", async () => {
    let calls = 0;
    const client = new CapabilityClient({
      apiUrl: "http://127.0.0.1:3103",
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect((await client.read("u1", [])).ok).toBe(false);
    expect((await client.read("u1", [])).ok).toBe(false);
    expect(calls).toBe(2);
  });

  test("a body without a capabilities array is not a permission", async () => {
    const client = new CapabilityClient({
      apiUrl: "http://127.0.0.1:3103",
      fetchImpl: (async () => jsonResponse({ oops: true })) as unknown as typeof fetch,
    });
    expect((await client.read("u1", [])).ok).toBe(false);
  });

  test("a non-2xx is treated as no information, not as a refusal", async () => {
    const client = new CapabilityClient({
      apiUrl: "http://127.0.0.1:3103",
      fetchImpl: (async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch,
    });
    expect((await client.read("u1", [])).ok).toBe(false);
  });
});

// ------------------------------------------------------- the wiring, not the policy

class RecordingRest {
  calls: Array<Record<string, unknown>> = [];
  async createInteractionResponse(id: string, token: string, type: number, data?: unknown): Promise<void> {
    this.calls.push({ kind: "callback", id, token, type, data });
  }
  async createFollowup(appId: string, token: string, data: unknown): Promise<void> {
    this.calls.push({ kind: "followup", appId, token, data });
  }
}

class GatedCommand extends Command {
  ran = false;
  constructor(capability: string) {
    super({ name: "gated", description: "gated", capability });
  }
  run(): void {
    this.ran = true;
  }
}

function interaction(name: string, roles: string[] = []): Interaction {
  return {
    id: "i1",
    application_id: "app1",
    type: 2,
    guild_id: "g1",
    channel_id: "c1",
    data: { id: "d1", name },
    member: { user: { id: "u1", username: "u" }, roles },
  } as unknown as Interaction;
}

function clientWith(reader: CapabilityReader, capability: string): { client: FudzieClient; rest: RecordingRest; cmd: GatedCommand } {
  const rest = new RecordingRest();
  const client = new FudzieClient({
    config: loadConfig({ FUDCOURT_ROLE_ADMIN: "admin" } as Record<string, string>),
    rest: rest as never,
    capabilities: reader,
  });
  const cmd = new GatedCommand(capability);
  client.commands.add(cmd);
  return { client, rest, cmd };
}

describe("the router honours a command's capability", () => {
  const reader = (answer: CapabilityAnswer): CapabilityReader => ({ read: async () => answer });

  test("denied: the command does not run and the reply names the capability", async () => {
    const { client, rest, cmd } = clientWith(reader(GRANTED), "moderation.kick");
    await client.handleInteraction(interaction("gated", ["r1"]));
    expect(cmd.ran).toBe(false);
    const content = (rest.calls[0]!.data as { content: string }).content;
    expect(content).toContain("moderation.kick");
  });

  test("granted: the command runs and nothing is said about capabilities", async () => {
    const { client, cmd } = clientWith(reader(GRANTED), "moderation.ban");
    await client.handleInteraction(interaction("gated", ["r1"]));
    expect(cmd.ran).toBe(true);
  });

  test("unmapped guild: the command still runs", async () => {
    const { client, cmd } = clientWith(
      reader({ ok: true, capabilities: [], source: "admin_baseline", mappingEmpty: true }),
      "moderation.ban",
    );
    await client.handleInteraction(interaction("gated", ["r1"]));
    expect(cmd.ran).toBe(true);
  });

  test("api unreachable: the command still runs (its own gate already passed)", async () => {
    const { client, cmd } = clientWith(reader(UNREACHABLE), "moderation.ban");
    await client.handleInteraction(interaction("gated", ["r1"]));
    expect(cmd.ran).toBe(true);
  });

  test("the member's role ids are what get asked about", async () => {
    let asked: string[] = [];
    const { client } = clientWith({ read: async (_id, roles) => { asked = roles; return GRANTED; } }, "moderation.ban");
    await client.handleInteraction(interaction("gated", ["r1", "r2"]));
    expect(asked).toEqual(["r1", "r2"]);
  });
});

// ------------------------------------------------------- vocabulary drift (bot ↔ contract)

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("the capabilities the bot names are real", () => {
  test("every declared capability exists in the contract's vocabulary", () => {
    // The api refuses to store a capability outside its vocabulary, so a typo here would not fail
    // loudly — it would simply make the command ungrantable, and a second operator-facing bug report
    // ("the panel will not let me give my mods this") would be the only symptom. Read the text, compare
    // the two lists, fail on the difference.
    const contract = readFileSync(new URL("../../../contracts/openapi/fudcourt.yaml", import.meta.url), "utf8");
    const block = contract.slice(contract.indexOf("    Capability:"));
    const enumBlock = block.slice(block.indexOf("enum: ["), block.indexOf("]", block.indexOf("enum: [")));
    const known = new Set(
      enumBlock
        .replace("enum: [", "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    expect(known.size).toBeGreaterThan(10);

    const declared = new Set<string>();
    for (const file of [...walk(new URL("../src/commands", import.meta.url).pathname),
                          join(new URL("../src/moderation", import.meta.url).pathname, "capabilities.ts")]) {
      for (const m of readFileSync(file, "utf8").matchAll(/"([a-z]+\.[a-z_]+)"/g)) declared.add(m[1]!);
    }
    expect(declared.size).toBeGreaterThan(4);

    const orphans = [...declared].filter((c) => !known.has(c));
    expect(orphans).toEqual([]);
  });

  test("the action map agrees with the contract too", () => {
    const contract = readFileSync(new URL("../../../contracts/openapi/fudcourt.yaml", import.meta.url), "utf8");
    for (const cap of Object.values(ACTION_CAPABILITY)) {
      expect(contract).toContain(cap!);
    }
  });
});
