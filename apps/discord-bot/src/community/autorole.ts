// Autorole — which roles a member gets on join, split by WHEN they land.
//
// The selection is PURE (`selectAutoroles`): given the guild's rules and whether
// the joiner is a bot, it returns three buckets —
//   immediate — granted now (on_join, or after_duration with delay 0)
//   delayed   — granted after N seconds (after_duration with delay > 0)
//   deferred  — granted once verification passes (after_verification)
// The service then applies each bucket through RoleService (hierarchy-checked,
// recorded). Keeping the split pure is what makes "a bot does not get the human
// role" and "a 5-minute delay is not applied at once" directly testable.

import type { AutoroleRule } from "./types.ts";
import type { RoleService } from "./roles.ts";

export interface AutoroleSelection {
  immediate: AutoroleRule[];
  delayed: { rule: AutoroleRule; delaySeconds: number }[];
  deferred: AutoroleRule[];
}

/** selectAutoroles buckets the enabled, applicable rules for a joiner. */
export function selectAutoroles(rules: readonly AutoroleRule[], isBot: boolean): AutoroleSelection {
  const immediate: AutoroleRule[] = [];
  const delayed: { rule: AutoroleRule; delaySeconds: number }[] = [];
  const deferred: AutoroleRule[] = [];
  // Apply in priority order (highest first) so an operator's ordering is honoured.
  const ordered = [...rules].sort((a, b) => b.priority - a.priority || Number(a.id) - Number(b.id));
  for (const rule of ordered) {
    if (!rule.enabled) continue;
    if (rule.appliesTo === "human" && isBot) continue;
    if (rule.appliesTo === "bot" && !isBot) continue;
    switch (rule.kind) {
      case "on_join":
        immediate.push(rule);
        break;
      case "after_duration":
        if (rule.delaySeconds <= 0) immediate.push(rule);
        else delayed.push({ rule, delaySeconds: rule.delaySeconds });
        break;
      case "after_verification":
        deferred.push(rule);
        break;
    }
  }
  return { immediate, delayed, deferred };
}

export interface AutoroleDeps {
  /** The guild's autorole rules (read fresh). */
  rules: () => Promise<AutoroleRule[]>;
  roles: RoleService;
  /** Schedule a delayed grant; the scheduler owns durability, this just fires it. */
  schedule: (delaySeconds: number, fn: () => Promise<void>) => void;
  log: (msg: string) => void;
}

export class AutoroleService {
  constructor(private readonly deps: AutoroleDeps) {}

  /** onJoin applies the immediate rules now and schedules the delayed ones. */
  async onJoin(userId: string, isBot: boolean): Promise<void> {
    let rules: AutoroleRule[];
    try {
      rules = await this.deps.rules();
    } catch (err) {
      this.deps.log(`autorole: rule lookup failed: ${errText(err)}`);
      return;
    }
    const sel = selectAutoroles(rules, isBot);
    for (const rule of sel.immediate) await this.deps.roles.grant(userId, rule.roleId, "autorole");
    for (const { rule, delaySeconds } of sel.delayed) {
      this.deps.schedule(delaySeconds, async () => {
        await this.deps.roles.grant(userId, rule.roleId, "autorole");
      });
    }
    // `deferred` (after_verification) is granted by verify(), not here.
  }

  /** onVerified grants the after_verification roles once a member passes verification. */
  async onVerified(userId: string, isBot: boolean): Promise<void> {
    let rules: AutoroleRule[];
    try {
      rules = await this.deps.rules();
    } catch (err) {
      this.deps.log(`autorole: rule lookup failed: ${errText(err)}`);
      return;
    }
    const sel = selectAutoroles(rules, isBot);
    for (const rule of sel.deferred) await this.deps.roles.grant(userId, rule.roleId, "verification");
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
