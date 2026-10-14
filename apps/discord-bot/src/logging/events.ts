// Activity-log event mappers — pure functions from a raw gateway payload to the
// {category, embed} the ActivityLogger posts.
//
// Keeping these pure (no client, no REST) is what makes the log shapes
// unit-testable: a payload in, an embed out, no gateway and no network. The
// listener files are then one line each.
//
// Discord only sends what it sends: a MESSAGE_DELETE carries no author or
// content unless the message was cached, and a GUILD_MEMBER_UPDATE carries no
// "before" roles. The mappers therefore render what the payload holds and never
// invent the rest — a log line that says "message 123 deleted in #456" is
// honest; one that fabricates the author would not be.

import type { APIEmbed, DiscordUser } from "../framework/types.ts";
import { DANGER, WARN } from "../lib/embed.ts";
import type { ActivityEvent, LogCategory } from "./types.ts";

/** MESSAGE_DELETE — the fields the gateway actually sends (content/author only
 * when the message was cached). */
export interface MessageDeletePayload {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  author?: DiscordUser;
}

/** MESSAGE_UPDATE — a partial message: the fields that changed. */
export interface MessageUpdatePayload {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  author?: DiscordUser;
  edited_timestamp?: string | null;
}

/** GUILD_MEMBER_REMOVE — the leaving user. */
export interface MemberRemovePayload {
  guild_id?: string;
  user?: DiscordUser;
  nick?: string | null;
}

/** GUILD_MEMBER_UPDATE — the member's new roles/nick (no "before" set). */
export interface MemberUpdatePayload {
  guild_id?: string;
  user?: DiscordUser;
  roles?: string[];
  nick?: string | null;
}

/** VOICE_STATE_UPDATE — a join/leave/move in a voice channel. */
export interface VoiceStatePayload {
  guild_id?: string;
  user_id?: string;
  channel_id?: string | null;
  session_id?: string;
}

/** GUILD_CHANNEL_CREATE/UPDATE/DELETE — a channel change. */
export interface ChannelPayload {
  id?: string;
  guild_id?: string;
  name?: string;
  type?: number;
  parent_id?: string | null;
}

/** channelMention renders a channel id as a Discord channel mention. */
function channelMention(id: string | undefined): string {
  return id ? `<#${id}>` : "unknown channel";
}

/** userLabel renders a user as "name (id)", falling back to the id alone. */
function userLabel(u: DiscordUser | undefined, fallbackId?: string): string {
  if (u?.id) return `${u.username ?? "user"} (${u.id})`;
  return fallbackId ? fallbackId : "unknown user";
}

function messageEmbed(title: string, payload: { id?: string; channel_id?: string; content?: string; author?: DiscordUser }): APIEmbed {
  const fields = [{ name: "Channel", value: channelMention(payload.channel_id), inline: true }];
  if (payload.author?.id) fields.push({ name: "Author", value: userLabel(payload.author), inline: true });
  if (payload.id) fields.push({ name: "Message", value: payload.id, inline: true });
  const e: APIEmbed = { title, color: DANGER, fields };
  if (payload.content) e.description = truncate(payload.content, 1024);
  return e;
}

export function messageDeleteEvent(p: MessageDeletePayload): ActivityEvent | null {
  if (!p?.id || !p.channel_id) return null;
  return { category: "message", embed: messageEmbed("Message deleted", p) };
}

export function messageUpdateEvent(p: MessageUpdatePayload): ActivityEvent | null {
  // MESSAGE_UPDATE also fires for embed-only changes with no content; only a
  // content-bearing update is an edit worth logging.
  if (!p?.id || !p.channel_id || p.content === undefined) return null;
  return { category: "message", embed: messageEmbed("Message edited", p) };
}

export function memberAddEvent(p: { user?: DiscordUser; guild_id?: string }): ActivityEvent | null {
  if (!p?.user?.id) return null;
  return {
    category: "member",
    embed: {
      title: "Member joined",
      color: 0x22c55e,
      fields: [
        { name: "User", value: userLabel(p.user), inline: true },
        { name: "ID", value: p.user.id, inline: true },
      ],
    },
  };
}

export function memberRemoveEvent(p: MemberRemovePayload): ActivityEvent | null {
  if (!p?.user?.id) return null;
  return {
    category: "member",
    embed: {
      title: "Member left",
      color: WARN,
      fields: [
        { name: "User", value: userLabel(p.user), inline: true },
        { name: "ID", value: p.user.id, inline: true },
      ],
    },
  };
}

/**
 * memberUpdateEvent routes a member change to the `role` category when roles are
 * present, else `member` (a nickname/profile change). Discord sends no "before"
 * set, so the embed lists the member's current roles rather than a diff.
 */
export function memberUpdateEvent(p: MemberUpdatePayload): ActivityEvent | null {
  if (!p?.user?.id) return null;
  const roles = p.roles ?? [];
  const category: LogCategory = roles.length > 0 ? "role" : "member";
  const fields = [
    { name: "User", value: userLabel(p.user), inline: true },
    { name: "Roles", value: roles.length ? roles.map((r) => `<@&${r}>`).join(" ").slice(0, 1024) : "—", inline: false },
  ];
  if (p.nick !== undefined && p.nick !== null) fields.push({ name: "Nickname", value: p.nick || "—", inline: true });
  return { category, embed: { title: "Member updated", color: WARN, fields } };
}

export function voiceStateEvent(p: VoiceStatePayload): ActivityEvent | null {
  if (!p?.guild_id || !p.user_id) return null;
  const joined = p.channel_id != null;
  return {
    category: "voice",
    embed: {
      title: joined ? "Voice channel joined" : "Voice channel left",
      color: WARN,
      fields: [
        { name: "User", value: `<@${p.user_id}>`, inline: true },
        { name: "Channel", value: joined ? channelMention(p.channel_id ?? undefined) : "—", inline: true },
      ],
    },
  };
}

/** channelEvent builds the embed for a channel create/update/delete. */
export function channelEvent(kind: "create" | "update" | "delete", p: ChannelPayload): ActivityEvent | null {
  if (!p?.id) return null;
  const title = kind === "create" ? "Channel created" : kind === "update" ? "Channel updated" : "Channel deleted";
  const color = kind === "delete" ? DANGER : WARN;
  return {
    category: "channel",
    embed: {
      title,
      color,
      fields: [
        { name: "Channel", value: p.name ? `#${p.name} (${p.id})` : p.id, inline: true },
      ],
    },
  };
}

/**
 * moderationEvent renders a completed moderation action for the `moderation`
 * channel. `source` picks the category: an AutoMod-originated action belongs in
 * `automod`, everything else in `moderation`.
 */
export function moderationEvent(opts: {
  action: string;
  actorId: string;
  targetId?: string;
  reason?: string;
  source?: string;
  caseNumber?: number;
}): ActivityEvent {
  const isAutomod = opts.source === "automod";
  const fields = [
    { name: "Action", value: opts.action, inline: true },
    { name: "Moderator", value: opts.actorId ? `<@${opts.actorId}>` : "system", inline: true },
  ];
  if (opts.targetId) fields.push({ name: "Target", value: `<@${opts.targetId}>`, inline: true });
  if (opts.reason) fields.push({ name: "Reason", value: truncate(opts.reason, 1024), inline: false });
  if (opts.caseNumber) fields.push({ name: "Case", value: `#${opts.caseNumber}`, inline: true });
  return {
    category: isAutomod ? "automod" : "moderation",
    embed: { title: isAutomod ? "AutoMod action" : "Moderation action", color: DANGER, fields },
  };
}

/**
 * automodEvent renders an AutoMod rule firing (including delete/log_only, which
 * never reach the moderation service) for the `automod` channel.
 */
export function automodEvent(opts: {
  ruleName: string;
  targetId: string;
  channelId?: string;
  results: string[];
}): ActivityEvent {
  const fields = [
    { name: "Rule", value: opts.ruleName, inline: true },
    { name: "Target", value: `<@${opts.targetId}>`, inline: true },
  ];
  if (opts.channelId) fields.push({ name: "Channel", value: channelMention(opts.channelId), inline: true });
  if (opts.results.length) fields.push({ name: "Actions", value: truncate(opts.results.join("\n"), 1024), inline: false });
  return { category: "automod", embed: { title: "AutoMod triggered", color: WARN, fields } };
}

/** truncate clips a string to `max` chars with an ellipsis (embed field bound). */
export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
