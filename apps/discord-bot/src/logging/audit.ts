// AuditLog — the bot's client for the audit trail, over the api loopback hop.
//
// The bot records a change IT originated (a prefix edit through a command, an
// AutoMod rule toggle) so the audit history is complete regardless of whether
// the change came from the dashboard or Discord. It is the SAME store the
// dashboard reads (apps/api/logging.go: `audit_logs`), so one change is one row.
//
// Best-effort like CaseLog: an unreachable api must never fail the operation the
// operator asked for. A failed record logs one line; nothing here throws.

import type { AuditInput } from "./types.ts";

export const AUDIT_PATH = "/api/internal/audit";

export class AuditLog {
  constructor(
    private readonly apiUrl: string,
    private readonly log: (msg: string) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 3000,
  ) {}

  /** record persists one audit entry. Returns true on success, false otherwise. */
  async record(input: AuditInput): Promise<boolean> {
    if (!this.apiUrl) return false;
    const body: Record<string, unknown> = {
      action: input.action,
      resourceType: input.resourceType,
      source: input.source ?? "discord",
    };
    if (input.actorId) body.actorId = input.actorId;
    if (input.actorName) body.actorName = input.actorName;
    if (input.resourceId) body.resourceId = input.resourceId;
    if (input.before !== undefined) body.before = input.before;
    if (input.after !== undefined) body.after = input.after;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.apiUrl}${AUDIT_PATH}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.log(`audit POST ${AUDIT_PATH} → ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.log(`audit POST ${AUDIT_PATH} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
