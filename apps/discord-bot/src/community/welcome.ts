// WelcomeService — renders and sends the welcome (join) and goodbye (leave)
// messages. It is I/O-light and fully injectable: the config loader, the channel
// sender and the DM sender are all ports, so the render-and-send decision is
// unit-tested without a gateway.
//
// A join can produce up to two sends: a channel post (if join_enabled and a
// channel is set) and a DM (if join_dm). Each is independent — a failed DM must
// not stop the channel post and vice versa. Everything is best-effort: a
// welcome that cannot be delivered never breaks the join.

import type { APIEmbed } from "../framework/types.ts";
import type { WelcomeConfig } from "./types.ts";
import { memberVars, renderEmbed, renderTemplate, type MemberVarInput } from "./templates.ts";

/** A member's facts as the join/leave handler can supply them. */
export interface WelcomeMember extends MemberVarInput {
  isBot: boolean;
}

export interface WelcomeDeps {
  /** The guild's welcome config (read fresh; the api caches it). */
  config: () => Promise<WelcomeConfig | undefined>;
  /** Post a channel message. */
  send: (channelId: string, data: { content?: string; embeds?: APIEmbed[] }) => Promise<void>;
  /** DM a member. */
  dm: (userId: string, data: { content?: string; embeds?: APIEmbed[] }) => Promise<void>;
  log: (msg: string) => void;
}

export class WelcomeService {
  constructor(private readonly deps: WelcomeDeps) {}

  /** onJoin sends the welcome message(s). Best-effort; never throws. */
  async onJoin(member: WelcomeMember): Promise<void> {
    const cfg = await this.safeConfig();
    if (!cfg || !cfg.joinEnabled) return;
    const vars = memberVars(member);
    await this.sendChannel(cfg.joinChannelId, cfg.joinMessage, cfg.joinEmbed, vars);
    if (cfg.joinDm) await this.sendDm(member.userId, cfg.joinDmMessage, cfg.joinEmbed, vars);
  }

  /** onLeave sends the goodbye message (channel only — a member who left cannot be DMed). */
  async onLeave(member: WelcomeMember): Promise<void> {
    const cfg = await this.safeConfig();
    if (!cfg || !cfg.leaveEnabled) return;
    const vars = memberVars(member);
    await this.sendChannel(cfg.leaveChannelId, cfg.leaveMessage, cfg.leaveEmbed, vars);
  }

  private async safeConfig(): Promise<WelcomeConfig | undefined> {
    try {
      return await this.deps.config();
    } catch (err) {
      this.deps.log(`welcome: config lookup failed: ${errText(err)}`);
      return undefined;
    }
  }

  private async sendChannel(channelId: string, message: string, embed: WelcomeConfig["joinEmbed"], vars: ReturnType<typeof memberVars>): Promise<void> {
    if (!channelId) return;
    const payload = buildPayload(message, embed, vars);
    if (!payload) return;
    try {
      await this.deps.send(channelId, payload);
    } catch (err) {
      this.deps.log(`welcome: channel send to ${channelId} failed: ${errText(err)}`);
    }
  }

  private async sendDm(userId: string, message: string, embed: WelcomeConfig["joinEmbed"], vars: ReturnType<typeof memberVars>): Promise<void> {
    const payload = buildPayload(message, embed, vars);
    if (!payload) return;
    try {
      await this.deps.dm(userId, payload);
    } catch (err) {
      this.deps.log(`welcome: DM to ${userId} failed: ${errText(err)}`);
    }
  }
}

/** buildPayload templates the content + embed; returns undefined when both are empty. */
export function buildPayload(
  message: string,
  embed: WelcomeConfig["joinEmbed"],
  vars: ReturnType<typeof memberVars>,
): { content?: string; embeds?: APIEmbed[] } | undefined {
  const content = renderTemplate(message, vars).trim();
  const rendered = renderEmbed(embed, vars);
  const payload: { content?: string; embeds?: APIEmbed[] } = {};
  if (content) payload.content = content;
  if (rendered && Object.keys(rendered).length > 0) payload.embeds = [rendered as APIEmbed];
  return payload.content || payload.embeds ? payload : undefined;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
