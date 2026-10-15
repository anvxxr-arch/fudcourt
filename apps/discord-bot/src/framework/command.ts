// Command — the base every slash command extends (the Sapphire "Command" piece).
//
// A command declares itself once (name, description, options, preconditions)
// and the client derives BOTH the Discord registration payload and the dispatch
// target from that single declaration — no central switch to edit.

import type { FudzieClient } from "./client.ts";
import type {
  ApplicationCommand,
  ApplicationCommandOption,
  APIEmbed,
  GuildMember,
  Interaction,
  InteractionData,
  DiscordUser,
} from "./types.ts";
import { ApplicationCommandType, EPHEMERAL_FLAG } from "./types.ts";

/** One parsed option value from the interaction, flattened for handlers. */
export interface ParsedOptions {
  get(name: string): string | number | boolean | undefined;
  string(name: string): string | undefined;
  integer(name: string): number | undefined;
  bool(name: string): boolean | undefined;
  user(name: string): string | undefined;
  raw: InteractionData["options"];
}

export function parseOptions(data: InteractionData | undefined): ParsedOptions {
  const map = new Map<string, string | number | boolean>();
  const walk = (opts: InteractionData["options"]): void => {
    for (const o of opts ?? []) {
      if (o.value !== undefined) map.set(o.name, o.value);
      if (o.options) walk(o.options);
    }
  };
  walk(data?.options);
  return {
    get: (n) => map.get(n),
    string: (n) => {
      const v = map.get(n);
      return typeof v === "string" ? v : undefined;
    },
    integer: (n) => {
      const v = map.get(n);
      return typeof v === "number" ? Math.trunc(v) : undefined;
    },
    bool: (n) => {
      const v = map.get(n);
      return typeof v === "boolean" ? v : undefined;
    },
    user: (n) => {
      const v = map.get(n);
      return typeof v === "string" ? v : undefined;
    },
    raw: data?.options,
  };
}

/** Everything one command invocation needs. */
export interface CommandContext {
  readonly client: FudzieClient;
  readonly interaction: Interaction;
  readonly guildId: string | undefined;
  readonly channelId: string | undefined;
  readonly member: GuildMember | undefined;
  readonly user: DiscordUser;
  readonly options: ParsedOptions;
  /** The target of a USER/MESSAGE context command (data.target_id). */
  readonly targetId: string | undefined;
  /** Reply to the interaction (ephemeral by default, like the Telegram bot's direct replies). */
  reply(data: { content?: string; embeds?: APIEmbed[]; ephemeral?: boolean }): Promise<void>;
  /** Acknowledge with a "thinking…" state for a slow command, then followUp. */
  defer(): Promise<void>;
  /** Send a followup message after a defer(). */
  followUp(data: { content?: string; embeds?: APIEmbed[] }): Promise<void>;
}

export interface CommandOptions {
  name: string;
  description: string;
  options?: ApplicationCommandOption[];
  /** Named preconditions resolved against the PreconditionStore. */
  preconditions?: string[];
  /**
   * The capability this command requires, checked against the role mapping the dashboard edits.
   * Omitted = the command is not capability-gated. It is enforced AFTER the preconditions, so an
   * unmapped guild (or an api that cannot answer) keeps the gate above in charge — see
   * src/lib/capabilities.ts for why that order is the safe one.
   */
  capability?: string;
  /** Convenience: registers the "AdminOnly" precondition. */
  adminOnly?: boolean;
  /** DM-only or guild-only visibility for the registered command. */
  guildOnly?: boolean;
  /** Command kind: 1 ChatInput (default), 2 User, 3 Message. */
  type?: number;
}

export abstract class Command {
  readonly name: string;
  readonly description: string;
  readonly options: ApplicationCommandOption[];
  readonly preconditions: string[];
  readonly guildOnly: boolean;
  readonly type: number;
  /** The capability required to run this command; undefined = not capability-gated. */
  readonly capability: string | undefined;

  constructor(opts: CommandOptions) {
    this.name = opts.name;
    this.description = opts.description;
    this.options = opts.options ?? [];
    this.capability = opts.capability?.trim() || undefined;
    this.guildOnly = opts.guildOnly ?? true;
    this.type = opts.type ?? ApplicationCommandType.ChatInput;
    const pre = [...(opts.preconditions ?? [])];
    if (opts.adminOnly && !pre.includes("AdminOnly")) pre.push("AdminOnly");
    this.preconditions = pre;
  }

  /** toJSON renders the Discord registration payload.
   * A chat-input command carries its description/options; a USER/MESSAGE
   * context command carries only { name, type } — Discord rejects extra fields
   * (and a description is meaningless) for context-menu commands. */
  toJSON(): ApplicationCommand {
    if (this.type !== ApplicationCommandType.ChatInput) {
      return { name: this.name, description: "", type: this.type };
    }
    const cmd: ApplicationCommand = { name: this.name, description: this.description };
    if (this.options.length > 0) cmd.options = this.options;
    cmd.dm_permission = !this.guildOnly;
    return cmd;
  }

  abstract run(ctx: CommandContext): Promise<void> | void;
}

/** Helper: a reply payload that only the invoking user sees. */
export function ephemeral(content: string, embeds?: APIEmbed[]): { content: string; embeds?: APIEmbed[]; flags: number } {
  return embeds ? { content, embeds, flags: EPHEMERAL_FLAG } : { content, flags: EPHEMERAL_FLAG };
}
