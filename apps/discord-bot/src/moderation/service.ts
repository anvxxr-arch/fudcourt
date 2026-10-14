// ModerationService — the ONE place a moderation action is executed.
//
// Every caller (slash command, context-menu command, and later the dashboard's
// HTTP layer and AutoMod) goes through here, so the permission check, the
// hierarchy check and the Discord REST call can never drift apart. The handler
// supplies the ACTION and its parameters; the service owns HOW it is validated
// and performed.
//
// The validation is ordered cheapest-and-safest first:
//   1. structural   — the guild/actor/target ids exist (a bad shape is a bug, not a refusal);
//   2. hierarchy    — a pure rule (hierarchy.ts) against the guild owner + role positions;
//   3. permission   — the actor holds the Discord permission the action needs.
// Only then is the REST call made. A refusal is a typed ModResult, never a throw,
// so the caller renders it as a friendly ephemeral reply.

import type { FudzieClient } from "../framework/client.ts";
import type { GuildMember, GuildRole } from "../framework/types.ts";
import { has, Perm } from "../lib/permissions.ts";
import { guardTarget, topPosition, type GuardResult } from "./hierarchy.ts";

/** The moderation actions this service can perform. */
export type ModAction =
  | "warn"
  | "timeout"
  | "untimeout"
  | "kick"
  | "ban"
  | "unban"
  | "purge"
  | "slowmode"
  | "lock"
  | "unlock"
  | "nick";

/** What the caller asks the service to do. Fields are action-specific. */
export interface ModRequest {
  action: ModAction;
  guildId: string;
  /** Acting moderator's user id (from the interaction). */
  actorId: string;
  /** Acting moderator's guild roles. */
  actorRoles: readonly string[];
  /** Acting moderator's computed permissions bitfield string (may be absent). */
  actorPermissions?: string;
  /** Target user id — absent for channel-scoped actions (purge/slowmode/lock). */
  targetId?: string;
  /** Target channel id — required for purge/slowmode/lock/unlock. */
  channelId?: string;
  reason?: string;
  /** timeout: how long, in seconds. */
  durationSeconds?: number;
  /** purge: how many recent messages to remove (1..100). */
  count?: number;
  /** slowmode: seconds between messages (0 clears). */
  seconds?: number;
  /** nick: the new nickname ("" clears it). */
  nick?: string;
  /** ban: also delete this many seconds of the target's recent messages. */
  deleteMessageSeconds?: number;
}

/** A moderation outcome. `ok:false` carries a user-facing refusal, never a stack. */
export interface ModResult {
  ok: boolean;
  /** The action performed (echoed for the caller's confirmation embed). */
  action: ModAction;
  /** Present when ok:false — a friendly, actionable reason. */
  refusal?: string;
  /** Present when ok:true — a short human summary of what happened. */
  summary?: string;
  /** Structured facts for logging/auditing (never contains secrets). */
  detail?: Record<string, string | number | boolean>;
}

/** refuse is the one constructor for a declined action. */
function refuse(action: ModAction, refusal: string): ModResult {
  return { ok: false, action, refusal };
}

/** The permission a simple (member-targeted) action requires from the actor. */
const ACTION_PERM: Partial<Record<ModAction, bigint>> = {
  timeout: Perm.MODERATE_MEMBERS,
  untimeout: Perm.MODERATE_MEMBERS,
  kick: Perm.KICK_MEMBERS,
  ban: Perm.BAN_MEMBERS,
  unban: Perm.BAN_MEMBERS,
  purge: Perm.MANAGE_MESSAGES,
  slowmode: Perm.MANAGE_CHANNELS,
  lock: Perm.MANAGE_CHANNELS,
  unlock: Perm.MANAGE_CHANNELS,
  nick: Perm.MANAGE_NICKNAMES,
};

/** Human label for a permission, used in refusal messages. */
const PERM_LABEL: Partial<Record<ModAction, string>> = {
  timeout: "Moderate Members",
  untimeout: "Moderate Members",
  kick: "Kick Members",
  ban: "Ban Members",
  unban: "Ban Members",
  purge: "Manage Messages",
  slowmode: "Manage Channels",
  lock: "Manage Channels",
  unlock: "Manage Channels",
  nick: "Manage Nicknames",
};

export class ModerationService {
  constructor(private readonly client: FudzieClient) {}

  /** run validates and executes one moderation request. Never throws. */
  async run(req: ModRequest): Promise<ModResult> {
    if (!req.guildId) return refuse(req.action, "this command only works inside the server");
    if (!req.actorId) return refuse(req.action, "I could not identify you in this server");

    // Channel-scoped actions resolve no target member; everything else does.
    if (req.action === "purge" || req.action === "slowmode" || req.action === "lock" || req.action === "unlock") {
      return this.runChannelAction(req);
    }
    return this.runMemberAction(req);
  }

  /**
   * guardMember resolves the guild, the bot, the actor and the target, applies
   * the hierarchy rule and the required permission, and returns either a refusal
   * or the resolved pieces the action needs. It is the single gate for every
   * member-targeted action, so kick/ban/timeout/warn/nick share one code path.
   */
  private async guardMember(req: ModRequest): Promise<
    | { ok: false; result: ModResult }
    | { ok: true; guild: { id: string; owner_id?: string }; bot: { id: string }; target: GuildMember; roles: GuildRole[] }
  > {
    const guildId = req.guildId;
    const targetId = req.targetId;
    if (!targetId) return { ok: false, result: refuse(req.action, "no target was given") };

    const rest = this.client.rest;
    let guild: { id: string; owner_id?: string };
    let roles: GuildRole[];
    let target: GuildMember;
    let me: { id: string };
    try {
      [guild, roles, target, me] = await Promise.all([
        rest.getGuild(guildId),
        rest.listGuildRoles(guildId),
        rest.getGuildMember(guildId, targetId),
        rest.getCurrentUser(),
      ]);
    } catch (err) {
      const e = err as { notFound?: boolean; status?: number };
      if (e?.notFound) return { ok: false, result: refuse(req.action, "that user is not in this server") };
      return { ok: false, result: refuse(req.action, "Discord refused the lookup — check my permissions") };
    }

    const botRoles = await this.botRoles(guildId, roles);
    const guard: GuardResult = guardTarget({
      actorId: req.actorId,
      targetId,
      ownerId: guild.owner_id ?? "",
      botUserId: me.id,
      actorTop: topPosition(req.actorRoles, roles),
      botTop: topPosition(botRoles, roles),
      targetTop: topPosition(target.roles ?? [], roles),
      actorIsOwner: req.actorId === guild.owner_id,
    });
    if (!guard.ok) return { ok: false, result: refuse(req.action, guard.reason ?? "not permitted") };

    const perm = ACTION_PERM[req.action];
    if (perm && !has(req.actorPermissions, perm)) {
      return { ok: false, result: refuse(req.action, `you need the **${PERM_LABEL[req.action]}** permission`) };
    }
    return { ok: true, guild, bot: me, target, roles };
  }

  /** botRoles reads the bot's own member record to learn its highest role. */
  private async botRoles(guildId: string, _roles: GuildRole[]): Promise<string[]> {
    try {
      const me = await this.client.rest.getCurrentUser();
      const member = await this.client.rest.getGuildMember(guildId, me.id);
      return member.roles ?? [];
    } catch {
      return [];
    }
  }

  /** runMemberAction handles warn/timeout/untimeout/kick/ban/nick. */
  private async runMemberAction(req: ModRequest): Promise<ModResult> {
    if (req.action === "unban") return this.runUnban(req);
    const g = await this.guardMember(req);
    if (!g.ok) return g.result;
    const targetId = req.targetId!;
    const reason = req.reason?.trim() || `action by ${req.actorId}`;
    const rest = this.client.rest;
    try {
      switch (req.action) {
        case "warn":
          return { ok: true, action: "warn", summary: `warned <@${targetId}>`, detail: { targetId } };
        case "timeout": {
          const secs = clampInt(req.durationSeconds ?? 600, 1, 28 * 86400);
          const until = new Date(Date.now() + secs * 1000).toISOString();
          await rest.modifyMember(req.guildId, targetId, { communication_disabled_until: until }, { reason });
          return {
            ok: true,
            action: "timeout",
            summary: `timed out <@${targetId}> for ${humanize(secs)}`,
            detail: { targetId, seconds: secs },
          };
        }
        case "untimeout":
          await rest.modifyMember(req.guildId, targetId, { communication_disabled_until: null }, { reason });
          return { ok: true, action: "untimeout", summary: `removed the timeout on <@${targetId}>`, detail: { targetId } };
        case "kick":
          await rest.kickMember(req.guildId, targetId, { reason });
          return { ok: true, action: "kick", summary: `kicked <@${targetId}>`, detail: { targetId } };
        case "ban": {
          const del = clampInt(req.deleteMessageSeconds ?? 0, 0, 7 * 86400);
          await rest.banMember(req.guildId, targetId, { reason, deleteMessageSeconds: del });
          return {
            ok: true,
            action: "ban",
            summary: `banned <@${targetId}>${del > 0 ? ` and removed ${humanize(del)} of messages` : ""}`,
            detail: { targetId, deleteMessageSeconds: del },
          };
        }
        case "nick": {
          const nick = req.nick?.trim() || null;
          await rest.modifyMember(req.guildId, targetId, { nick }, { reason });
          return {
            ok: true,
            action: "nick",
            summary: nick ? `set <@${targetId}>'s nickname to **${nick}**` : `cleared <@${targetId}>'s nickname`,
            detail: { targetId },
          };
        }
        default:
          return refuse(req.action, "that action is not supported yet");
      }
    } catch (err) {
      return refuse(req.action, discordReason(err));
    }
  }

  /**
   * runUnban lifts a ban. It deliberately does NOT use guardMember: a banned
   * user is usually not a guild member, so the member fetch would 404 and the
   * action would be refused for the wrong reason. Only the actor's permission
   * is checked; the ban list itself is the authority on whether the target is
   * actually banned.
   */
  private async runUnban(req: ModRequest): Promise<ModResult> {
    const targetId = req.targetId;
    if (!targetId) return refuse("unban", "no target was given");
    if (!has(req.actorPermissions, Perm.BAN_MEMBERS)) {
      return refuse("unban", "you need the **Ban Members** permission");
    }
    const reason = req.reason?.trim() || `action by ${req.actorId}`;
    try {
      await this.client.rest.unbanMember(req.guildId, targetId, { reason });
      return { ok: true, action: "unban", summary: `lifted the ban on <@${targetId}>`, detail: { targetId } };
    } catch (err) {
      const e = err as { notFound?: boolean };
      if (e?.notFound) return refuse("unban", "that user is not banned");
      return refuse("unban", discordReason(err));
    }
  }

  /** runChannelAction handles purge/slowmode/lock/unlock (no target member). */
  private async runChannelAction(req: ModRequest): Promise<ModResult> {
    const channelId = req.channelId;
    if (!channelId) return refuse(req.action, "this command must be used inside a channel");
    const perm = ACTION_PERM[req.action];
    if (perm && !has(req.actorPermissions, perm)) {
      return refuse(req.action, `you need the **${PERM_LABEL[req.action]}** permission`);
    }
    const reason = req.reason?.trim() || `action by ${req.actorId}`;
    const rest = this.client.rest;
    try {
      switch (req.action) {
        case "purge": {
          const count = clampInt(req.count ?? 10, 1, 100);
          const msgs = await rest.listMessages(channelId, count);
          const ids = msgs.map((m) => m.id);
          if (ids.length === 0) return refuse("purge", "there is nothing to delete here");
          if (ids.length === 1) await rest.deleteMessage(channelId, ids[0]!, { reason });
          else await rest.bulkDeleteMessages(channelId, ids, { reason });
          return {
            ok: true,
            action: "purge",
            summary: `deleted ${ids.length} message(s)`,
            detail: { channelId, count: ids.length },
          };
        }
        case "slowmode": {
          const secs = clampInt(req.seconds ?? 0, 0, 21600);
          await rest.modifyChannel(channelId, { rate_limit_per_user: secs }, { reason });
          return {
            ok: true,
            action: "slowmode",
            summary: secs === 0 ? "slowmode is off" : `slowmode set to ${humanize(secs)}`,
            detail: { channelId, seconds: secs },
          };
        }
        case "lock":
        case "unlock": {
          const locked = req.action === "lock";
          // @everyone's role id equals the guild id; a type-0 overwrite targets it.
          // Deny Send Messages (bit 11) to lock, allow it to unlock.
          const send = (1n << 11n).toString();
          const body = locked ? { type: 0, allow: "0", deny: send } : { type: 0, allow: send, deny: "0" };
          await rest.editChannelPermissions(channelId, req.guildId, body, { reason });
          return {
            ok: true,
            action: req.action,
            summary: locked ? "locked this channel" : "unlocked this channel",
            detail: { channelId },
          };
        }
        default:
          return refuse(req.action, "that channel action is not supported yet");
      }
    } catch (err) {
      return refuse(req.action, discordReason(err));
    }
  }
}

/** clampInt truncates and bounds an integer into [lo, hi]. */
function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.trunc(Number.isFinite(n) ? n : lo);
  return Math.min(Math.max(v, lo), hi);
}

/** humanize renders a seconds count as a compact "1d 2h 3m 4s" string. */
function humanize(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !d) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
}

/** discordReason maps a Discord REST failure to a friendly, non-leaky message. */
function discordReason(err: unknown): string {
  const e = err as { status?: number; message?: string };
  if (e?.status === 403) return "Discord refused — check my role position and permissions";
  if (e?.status === 404) return "that member or channel no longer exists";
  if (e?.status === 429) return "I am being rate limited — try again in a moment";
  if (typeof e?.message === "string" && e.message.length > 0) return e.message.slice(0, 200);
  return "the action failed";
}

