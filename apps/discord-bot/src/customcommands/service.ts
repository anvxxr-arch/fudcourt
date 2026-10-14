// CustomCommandService — turns a prefixed message into a configured response.
//
// A member types `<prefix><name> [args]`; the service finds the command (by name
// or alias), checks the role/channel allow-lists, applies the per-member
// cooldown, renders the response through the shared template engine and sends
// it. The only thing stored is DATA — text and an embed — so a custom command
// can never execute anything: it renders and sends, nothing more.
//
// It returns whether it HANDLED the message so the caller can stop (a matched
// command that is gated off is still "handled" — it must not fall through to a
// different handler that might treat the same text as something else).

import { memberVars, renderEmbed, renderTemplate, type TemplateVars } from "../community/templates.ts";
import type { DiscordMessage } from "../framework/types.ts";
import type { CooldownStore } from "./cooldown.ts";
import type { CommandResponse, CustomCommand } from "./types.ts";

/** One outgoing message the service asks the caller to deliver. */
export interface OutgoingMessage {
  content?: string;
  embeds?: import("../community/templates.ts").TemplateEmbed[];
  /** When set, post as a reply to this message id. */
  replyTo?: string;
}

export interface CustomCommandDeps {
  /** The guild's custom commands (read fresh; the api caches them). */
  commands: () => Promise<CustomCommand[]>;
  /** The current prefix (admin-editable; read per message so a change is live). */
  prefix: () => string;
  /** Send to a channel. */
  send: (channelId: string, data: OutgoingMessage) => Promise<void>;
  /** Send a direct message to a user. */
  directMessage: (userId: string, data: OutgoingMessage) => Promise<void>;
  /** Delete a message (for delete_trigger). */
  deleteMessage: (channelId: string, messageId: string) => Promise<void>;
  /** The guild name / member count for {server} / {member_count}; cached upstream. */
  guildInfo: () => Promise<{ name: string; memberCount?: number }>;
  cooldown: CooldownStore;
  /** Clock (injected for deterministic tests). */
  now?: () => number;
  /** Index picker for a random response (injected for deterministic tests). */
  pick?: (length: number) => number;
  log: (msg: string) => void;
}

/** The parsed trigger of a prefixed message; undefined when it is not one. */
export interface ParsedTrigger {
  name: string;
  args: string;
}

/**
 * parseTrigger pulls the command name and the remaining args out of a message
 * body. Pure and prefix-agnostic: the caller strips the prefix. A body that is
 * only whitespace, or whose first token is empty, yields undefined.
 */
export function parseTrigger(body: string): ParsedTrigger | undefined {
  const trimmed = body.trimStart();
  if (trimmed === "") return undefined;
  const space = trimmed.search(/\s/);
  const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  if (name === "") return undefined;
  const args = space === -1 ? "" : trimmed.slice(space + 1).trim();
  return { name, args };
}

export class CustomCommandService {
  constructor(private readonly deps: CustomCommandDeps) {}

  /**
   * handleMessage processes one guild message. Returns true when a custom
   * command matched (whether or not it produced output — a gated or cooled-down
   * command is still consumed), false when the message is not one.
   */
  async handleMessage(m: DiscordMessage): Promise<boolean> {
    const prefix = this.deps.prefix();
    const content = m.content ?? "";
    // A bot's own output must never trigger a custom command (the listener also
    // drops bot authors; this keeps the service safe when called directly).
    if (!m.guild_id || !m.author?.id || m.author.bot || !prefix || !content.startsWith(prefix)) return false;

    const parsed = parseTrigger(content.slice(prefix.length));
    if (!parsed) return false;

    let commands: CustomCommand[];
    try {
      commands = await this.deps.commands();
    } catch (err) {
      this.deps.log(`custom commands: lookup failed: ${errText(err)}`);
      return false;
    }
    const cmd = commands.find(
      (c) => c.enabled && (c.name === parsed.name || c.aliases.includes(parsed.name)),
    );
    if (!cmd) return false;

    if (cmd.allowedChannels.length > 0 && !cmd.allowedChannels.includes(m.channel_id)) return true;

    const roles = m.member?.roles ?? [];
    if (cmd.allowedRoles.length > 0 && !cmd.allowedRoles.some((r) => roles.includes(r))) return true;

    const userId = m.author.id;
    const now = this.deps.now?.() ?? Date.now();
    if (cmd.cooldownSeconds > 0) {
      const key = `cc:${m.guild_id}:${cmd.name}:${userId}`;
      let remaining = 0;
      try {
        remaining = await this.deps.cooldown.remainingMs(key, now);
      } catch (err) {
        this.deps.log(`custom commands: cooldown read failed: ${errText(err)}`);
      }
      if (remaining > 0) return true;
      try {
        await this.deps.cooldown.mark(key, cmd.cooldownSeconds, now);
      } catch (err) {
        this.deps.log(`custom commands: cooldown write failed: ${errText(err)}`);
      }
    }

    const response = pickResponse(cmd.responses, this.deps.pick);
    if (!response) return true;

    const guild = await this.safeGuildInfo();
    const vars = this.vars(m, parsed.args, guild);
    const rendered = this.render(response, vars);
    if (rendered.content === undefined && rendered.embeds === undefined) return true;

    try {
      if (cmd.dm) {
        // A DM cannot carry a reply reference, so `reply` only applies in-channel.
        await this.deps.directMessage(userId, { content: rendered.content, embeds: rendered.embeds });
      } else {
        await this.deps.send(m.channel_id, {
          content: rendered.content,
          embeds: rendered.embeds,
          replyTo: cmd.reply ? m.id : undefined,
        });
      }
    } catch (err) {
      this.deps.log(`custom commands: send failed for ${cmd.name}: ${errText(err)}`);
    }

    if (cmd.deleteTrigger) {
      try {
        await this.deps.deleteMessage(m.channel_id, m.id);
      } catch (err) {
        this.deps.log(`custom commands: delete trigger failed for ${cmd.name}: ${errText(err)}`);
      }
    }
    return true;
  }

  /** render templates the response; text and embed are independent. */
  private render(r: CommandResponse, vars: TemplateVars): { content?: string; embeds?: import("../community/templates.ts").TemplateEmbed[] } {
    const content = r.text === undefined ? undefined : renderTemplate(r.text, vars);
    const embed = r.embed ? renderEmbed(r.embed, vars) : undefined;
    return { content, embeds: embed ? [embed] : undefined };
  }

  /** vars is the shared member set plus the custom-command extras. */
  private vars(m: DiscordMessage, args: string, guild: { name: string; memberCount?: number }): TemplateVars {
    const author = m.author!;
    const base = memberVars({
      userId: author.id,
      username: author.username,
      displayName: author.global_name ?? author.username,
      guildName: guild.name,
      memberCount: guild.memberCount,
      // The account id is the creation time; memberVars renders <t:…:D> without
      // an API call.
      createdAt: author.id,
    });
    // {mention} is the first user the message pinged, falling back to the
    // invoker — so `!hug @someone` renders `@someone` and a bare `!hug` renders
    // the author, never an empty string.
    const first = m.mentions?.find((u) => u.id && u.id !== author.id) ?? m.mentions?.[0];
    const mention = first?.id ? `<@${first.id}>` : `<@${author.id}>`;
    return { ...base, channel: `<#${m.channel_id}>`, args, mention };
  }

  private async safeGuildInfo(): Promise<{ name: string; memberCount?: number }> {
    try {
      return await this.deps.guildInfo();
    } catch (err) {
      this.deps.log(`custom commands: guild info failed: ${errText(err)}`);
      return { name: "" };
    }
  }
}

/** pickResponse chooses one response; a single entry is deterministic. */
function pickResponse(responses: readonly CommandResponse[], pick?: (n: number) => number): CommandResponse | undefined {
  if (responses.length === 0) return undefined;
  if (responses.length === 1) return responses[0];
  const idx = pick ? pick(responses.length) : Math.floor(Math.random() * responses.length);
  return responses[Math.min(Math.max(idx, 0), responses.length - 1)];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
