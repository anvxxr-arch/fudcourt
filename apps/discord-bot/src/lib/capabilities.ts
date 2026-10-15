// Capabilities — what a member may do, resolved by the Go api, not by Discord.
//
// A Discord role is not a capability and neither is a Discord permission: Discord has no idea that
// this guild wants its "Trial Mod" role to warn but not to ban. That mapping is configuration an
// operator edits in the dashboard, and the api owns it (`apps/api/capabilities.go`, keyed to role
// IDS so renaming a role cannot change who may do what). So the bot asks the api over the loopback
// hop — the SAME resolver the dashboard runs, which is the whole point of §9: a slash command and a
// panel action must not disagree about who may ban someone.
//
// Three things this file refuses to do:
//
//   1. It never throws. A capability check runs in front of a moderation command, and a sidecar that
//      is down must not turn into a bot that crashes instead of answering.
//   2. It never fails OPEN in the sense that matters. When the api cannot answer, `ok` is false and
//      the caller falls back to the command's own gate (an admin role, or Discord's Moderate Members
//      permission) — which is a CLOSED gate that already passed. It is not "allow anyone".
//   3. It never guesses. An unmapped guild (`mappingEmpty`) is reported as such instead of being
//      reported as "this member holds nothing", because those two states mean opposite things: the
//      first says the engine is not in charge yet, the second says it is and refused.

/** The api's answer about one member. `ok:false` means the api did not answer at all. */
export interface CapabilityAnswer {
  ok: boolean;
  capabilities: string[];
  /** owner | admin_baseline | roles | none | unreachable */
  source: string;
  mappingEmpty: boolean;
}

/** The answer when the api could not be reached: not a refusal, an absence of information. */
export const UNREACHABLE: CapabilityAnswer = {
  ok: false,
  capabilities: [],
  source: "unreachable",
  mappingEmpty: false,
};

/** The one method the framework needs, so tests supply a stub instead of a network. */
export interface CapabilityReader {
  read(userId: string, roles: string[]): Promise<CapabilityAnswer>;
}

/** Why a capability check passed or failed — logged, and the difference matters to an operator. */
export type CapabilityVerdict =
  | { ok: true; why: "granted" }
  | { ok: true; why: "unmapped" }
  | { ok: true; why: "unreachable" }
  | { ok: false; why: "denied" };

/**
 * decide is the entire policy, with the network already resolved, so it is testable without one.
 *
 * The order IS the design:
 *   1. the api granted it → pass;
 *   2. nothing is mapped yet → pass, because the command's own preconditions already passed and the
 *      capability layer is not in charge of anything until an operator maps a role;
 *   3. the api did not answer → pass, for the same reason, and the caller logs it;
 *   4. otherwise → refuse.
 *
 * Step 3 is the one worth arguing about, so here is the argument: the fallback is not "allow", it is
 * the command's EXISTING gate, which is a Discord permission or an admin role id — a closed gate that
 * already refused everyone else before this feature existed. Replacing a working gate with "refuse
 * everything while a sidecar restarts" would make the bot less safe in practice, not more.
 */
export function decide(answer: CapabilityAnswer, capability: string): CapabilityVerdict {
  if (answer.ok && answer.capabilities.includes(capability)) return { ok: true, why: "granted" };
  if (answer.mappingEmpty) return { ok: true, why: "unmapped" };
  if (!answer.ok) return { ok: true, why: "unreachable" };
  return { ok: false, why: "denied" };
}

/** How long an answer is reused. Short: an operator who revokes a role expects it to bite. */
const DEFAULT_TTL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 2_000;

export interface CapabilityClientOptions {
  apiUrl: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  ttlMs?: number;
  timeoutMs?: number;
}

/**
 * CapabilityClient asks the api. Successes are cached for a few seconds (a command prefix like `,ban`
 * runs several times a minute and the mapping changes rarely); failures are NOT cached, because the
 * next call should be the one that discovers the api came back.
 */
export class CapabilityClient implements CapabilityReader {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { at: number; answer: CapabilityAnswer }>();

  constructor(opts: CapabilityClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async read(userId: string, roles: string[]): Promise<CapabilityAnswer> {
    const key = `${userId}:${[...roles].sort().join(",")}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.answer;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.apiUrl}/api/internal/capabilities`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ userId, roles }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.log(`capabilities: api answered ${res.status}; falling back to the command's own gate`);
        return UNREACHABLE;
      }
      const body = (await res.json()) as Partial<CapabilityAnswer>;
      // An answer this file cannot read must never become a permission: a body with no capabilities
      // array is treated as "no information", which sends the caller back to the command's own gate.
      if (!Array.isArray(body.capabilities)) {
        this.log("capabilities: api answer had no capabilities array; falling back");
        return UNREACHABLE;
      }
      const answer: CapabilityAnswer = {
        ok: true,
        capabilities: body.capabilities,
        source: typeof body.source === "string" ? body.source : "unrecognised",
        mappingEmpty: body.mappingEmpty === true,
      };
      this.cache.set(key, { at: Date.now(), answer });
      return answer;
    } catch (err) {
      this.log(`capabilities: api unreachable (${err instanceof Error ? err.message : String(err)})`);
      return UNREACHABLE;
    } finally {
      clearTimeout(timer);
    }
  }
}
