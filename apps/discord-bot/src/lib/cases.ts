// CaseLog — the bot's client for the moderation-case store, over the api
// loopback hop.
//
// The bot is a zero-dependency Bun program with no Postgres driver of its own,
// so it neither reads nor writes the `moderation_cases` table directly. It calls
// the Go api (apps/api/moderation_cases.go), the SAME service the dashboard
// reads through, so a case recorded by a Discord command and one shown in the
// panel are one row — the single-writer invariant the spec's §9 dependency rule
// requires (Discord handler → service → api → Postgres).
//
// Every method is BEST-EFFORT: a case store that is down must never fail the
// moderation action itself (the ban already happened in Discord). A failed
// record logs one line and returns null; a failed read returns empty. Nothing
// here throws.

import type { ModAction } from "../moderation/service.ts";

/** One stored moderation case, as the api returns it (snowflakes are strings). */
export interface ModerationCase {
  id: number;
  caseNumber: number;
  guildId: string;
  action: string;
  targetUserId: string;
  moderatorUserId: string;
  reason: string;
  durationSeconds?: number;
  source: string;
  status: string;
  createdAt: string;
  expiresAt?: string;
  updatedAt: string;
}

/** What the service asks the log to persist. */
export interface CaseInput {
  action: string;
  targetUserId: string;
  moderatorUserId: string;
  reason: string;
  durationSeconds?: number;
  /** slash | prefix | context_menu | dashboard | automod | system */
  source?: string;
}

/** The surface the service depends on, so tests can supply a stub. */
export interface CaseLogLike {
  record(input: CaseInput): Promise<ModerationCase | null>;
  history(targetId: string, limit?: number): Promise<ModerationCase[]>;
  byNumber(caseNumber: number): Promise<ModerationCase | null>;
}

/**
 * caseActionName maps the service's internal action vocabulary onto the case
 * store's canonical names. The service calls a nickname change "nick" (its REST
 * verb); the store and the product spec call it "nickname". Everything else is
 * identical, so this is the ONE place the two vocabularies meet.
 */
export function caseActionName(action: ModAction): string {
  return action === "nick" ? "nickname" : action;
}

/** Actions that open a case. Channel-only actions (purge/lock/…) do too. */
export function recordsCase(action: ModAction): boolean {
  return true;
}

export class CaseLog implements CaseLogLike {
  constructor(
    private readonly apiUrl: string,
    private readonly log: (msg: string) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 3000,
  ) {}

  /** record persists one case. Returns the stored row, or null on any failure. */
  async record(input: CaseInput): Promise<ModerationCase | null> {
    if (!this.apiUrl) return null;
    const body: Record<string, unknown> = {
      action: input.action,
      targetUserId: input.targetUserId,
      moderatorUserId: input.moderatorUserId,
      reason: input.reason,
      source: input.source ?? "slash",
    };
    if (input.durationSeconds !== undefined) body.durationSeconds = input.durationSeconds;
    const res = await this.request("POST", "/api/internal/moderation/cases", body);
    if (!res) return null;
    try {
      return (await res.json()) as ModerationCase;
    } catch {
      return null;
    }
  }

  /** history returns a member's cases, newest first. Empty on any failure. */
  async history(targetId: string, limit = 10): Promise<ModerationCase[]> {
    if (!this.apiUrl || !targetId) return [];
    const path = `/api/internal/moderation/cases?target=${encodeURIComponent(targetId)}&limit=${clampLimit(limit)}`;
    const res = await this.request("GET", path);
    if (!res) return [];
    try {
      const body = (await res.json()) as { cases?: ModerationCase[] };
      return Array.isArray(body.cases) ? body.cases : [];
    } catch {
      return [];
    }
  }

  /** byNumber returns one case by its human number, or null when absent. */
  async byNumber(caseNumber: number): Promise<ModerationCase | null> {
    if (!this.apiUrl || !Number.isFinite(caseNumber) || caseNumber <= 0) return null;
    const res = await this.request("GET", `/api/internal/moderation/cases?number=${Math.trunc(caseNumber)}`);
    if (!res) return null;
    try {
      return (await res.json()) as ModerationCase;
    } catch {
      return null;
    }
  }

  /** request performs one loopback call. Returns null on any non-2xx or error. */
  private async request(method: string, path: string, body?: unknown): Promise<Response | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.log(`case ${method} ${path} → ${res.status}`);
        return null;
      }
      return res;
    } catch (err) {
      this.log(`case ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** clampLimit bounds a history page: 1..25. */
function clampLimit(n: number): number {
  const v = Math.trunc(Number.isFinite(n) ? n : 10);
  return Math.min(Math.max(v, 1), 25);
}
