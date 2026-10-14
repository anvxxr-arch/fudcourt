// AutomodService — the orchestration layer that turns a message/join into actions.
//
// It does NOT reimplement moderation: warn/timeout/kick/ban are handed to the same
// ModerationService every slash command uses (so hierarchy + permission checks and
// the case log are shared, and the case's `source` is "automod"). Deletion and role
// add/remove are delivered directly through a narrow port. Every collaborator is
// injected, so the whole flow is testable with fakes and no gateway.

import type { ModAction, ModRequest, ModResult } from "../moderation/service.ts";
import { automodEvent } from "../logging/events.ts";
import type { ActivityEvent } from "../logging/types.ts";
import {
  evaluateRules,
  type AutomodAction,
  type AutomodRule,
  type FiredRule,
  type JoinEvent,
  type MessageEvent,
} from "./matchers.ts";
import { scoreSpam } from "./score.ts";
import type { SpamTracker } from "./state.ts";

/** The moderation actions AutoMod routes through the shared service. */
const ROUTED_ACTIONS = new Set<AutomodAction>(["warn", "timeout", "kick", "ban"]);

/** The narrow activity-log port (satisfied by ActivityLogger). */
export interface ActivityPort {
  emitEvent(ev: ActivityEvent | null): Promise<boolean>;
}

export interface ModerationPort {
  run(req: ModRequest): Promise<ModResult>;
}

export interface DeliveryPort {
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  addRole(guildId: string, userId: string, roleId: string): Promise<void>;
  removeRole(guildId: string, userId: string, roleId: string): Promise<void>;
}

export interface ActorIdentity {
  id: string;
  roles: readonly string[];
  permissions: string;
}

export interface AutomodDeps {
  /** The active rules (already validated). Loaded per event; the caller caches. */
  rules: () => Promise<AutomodRule[]>;
  tracker: SpamTracker;
  moderation: ModerationPort;
  delivery: DeliveryPort;
  /** The acting identity for moderation actions (the bot itself). */
  actor: () => Promise<ActorIdentity>;
  /** Optional activity-log port: mirrors each rule firing to the automod channel. */
  activity?: ActivityPort;
  log: (msg: string) => void;
  now?: () => number;
}

export interface IncomingMessage {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  mentionIds: string[];
  roleIds: string[];
  attachments: number;
  accountCreatedAt?: number;
}

export interface IncomingJoin {
  guildId: string;
  userId: string;
  accountCreatedAt?: number;
}

export interface AutomodOutcome {
  rule: AutomodRule;
  actions: AutomodAction[];
  /** One short line per action: what happened (or why it was refused). */
  results: string[];
}

interface Target {
  guildId: string;
  channelId: string;
  messageId: string;
  targetId: string;
}

export class AutomodService {
  constructor(private readonly deps: AutomodDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** onMessage scores a message, evaluates message rules and applies their actions. */
  async onMessage(msg: IncomingMessage): Promise<AutomodOutcome[]> {
    if (msg.authorIsBot) return [];
    const now = this.now();
    const obs = await this.deps.tracker.observeMessage({
      guildId: msg.guildId,
      userId: msg.authorId,
      channelId: msg.channelId,
      content: msg.content,
      mentions: msg.mentionIds.length,
      now,
    });
    const score = scoreSpam(obs.signals);
    const ev: MessageEvent = {
      kind: "message",
      guildId: msg.guildId,
      channelId: msg.channelId,
      authorId: msg.authorId,
      authorIsBot: msg.authorIsBot,
      content: msg.content,
      mentionIds: msg.mentionIds,
      roleIds: msg.roleIds,
      attachments: msg.attachments,
      ...(msg.accountCreatedAt !== undefined ? { accountCreatedAt: msg.accountCreatedAt } : {}),
      recentContents: obs.recentContents,
    };
    const fired = await this.evaluate(ev, msg.guildId, msg.authorId, now, score.score);
    return this.apply(fired, {
      guildId: msg.guildId,
      channelId: msg.channelId,
      messageId: msg.messageId,
      targetId: msg.authorId,
    }, now);
  }

  /** onJoin evaluates member_join rules (new-account, rapid-join). */
  async onJoin(j: IncomingJoin): Promise<AutomodOutcome[]> {
    const now = this.now();
    const recentJoinCount = await this.deps.tracker.observeJoin(j.guildId, now);
    const ev: JoinEvent = {
      kind: "member_join",
      guildId: j.guildId,
      userId: j.userId,
      ...(j.accountCreatedAt !== undefined ? { accountCreatedAt: j.accountCreatedAt } : {}),
      recentJoinCount,
    };
    const fired = await this.evaluate(ev, j.guildId, j.userId, now, undefined);
    return this.apply(fired, { guildId: j.guildId, channelId: "", messageId: "", targetId: j.userId }, now);
  }

  /** evaluate loads the rules, precomputes the cooling set and runs the pure engine. */
  private async evaluate(
    ev: MessageEvent | JoinEvent,
    guildId: string,
    userId: string,
    now: number,
    spamScore: number | undefined,
  ): Promise<FiredRule[]> {
    const rules = await this.deps.rules();
    const cooling = new Set<number>();
    for (const r of rules) {
      if (r.cooldownSeconds > 0 && (await this.deps.tracker.isCoolingDown(guildId, r.id, userId, now))) {
        cooling.add(r.id);
      }
    }
    return evaluateRules(rules, ev, {
      now,
      ...(spamScore !== undefined ? { spamScore } : {}),
      isCoolingDown: (id) => cooling.has(id),
    });
  }

  /** apply executes each fired rule's actions in order and starts its cooldown. */
  private async apply(fired: FiredRule[], t: Target, now: number): Promise<AutomodOutcome[]> {
    const outcomes: AutomodOutcome[] = [];
    for (const f of fired) {
      const results: string[] = [];
      for (const action of f.actions) {
        results.push(await this.perform(f, action, t));
      }
      await this.deps.tracker.markFired(t.guildId, f.rule.id, t.targetId, f.rule.cooldownSeconds, now);
      this.deps.log(`automod "${f.rule.name}" fired on ${t.targetId}: ${results.join(", ")}`);
      outcomes.push({ rule: f.rule, actions: f.actions, results });
      // Mirror the firing to the automod activity-log channel (one embed per
      // rule, covering delete/log_only which never reach the moderation
      // service). Best-effort — a log failure never affects the action.
      await this.deps.activity?.emitEvent(
        automodEvent({
          ruleName: f.rule.name,
          targetId: t.targetId,
          channelId: t.channelId || undefined,
          results,
        }),
      );
    }
    return outcomes;
  }

  private async perform(f: FiredRule, action: AutomodAction, t: Target): Promise<string> {
    try {
      switch (action) {
        case "delete":
          if (!t.messageId) return "delete:skipped (no message)";
          await this.deps.delivery.deleteMessage(t.channelId, t.messageId);
          return "delete:done";
        case "log_only":
        case "notify_mod":
          return `${action}:done`;
        case "add_role":
        case "remove_role": {
          const roleId = f.rule.roleId;
          if (!roleId) return `${action}:skipped (no role)`;
          if (action === "add_role") await this.deps.delivery.addRole(t.guildId, t.targetId, roleId);
          else await this.deps.delivery.removeRole(t.guildId, t.targetId, roleId);
          return `${action}:done`;
        }
        default: {
          if (!ROUTED_ACTIONS.has(action)) return `${action}:unsupported`;
          const actor = await this.deps.actor();
          const req: ModRequest = {
            action: action as ModAction,
            guildId: t.guildId,
            actorId: actor.id,
            actorRoles: actor.roles,
            actorPermissions: actor.permissions,
            targetId: t.targetId,
            reason: f.reason,
            source: "automod",
            ...(action === "timeout" && f.rule.timeoutSeconds ? { durationSeconds: f.rule.timeoutSeconds } : {}),
          };
          const res = await this.deps.moderation.run(req);
          return res.ok ? `${action}:${res.summary ?? "done"}` : `${action}:refused (${res.refusal ?? "not permitted"})`;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log(`automod action ${action} failed: ${msg}`);
      return `${action}:error (${msg.slice(0, 120)})`;
    }
  }
}
