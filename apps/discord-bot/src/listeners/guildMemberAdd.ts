import { toIncomingJoin } from "../automod/wiring.ts";
import type { WelcomeMember } from "../community/welcome.ts";
import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import type { MemberAddPayload } from "../framework/types.ts";
import { memberAddEvent } from "../logging/events.ts";

/**
 * GUILD_MEMBER_ADD → the `member` activity log, then AutoMod join rules
 * (new-account, rapid-join / raid), then the welcome message and autoroles.
 *
 * Each step is independent and best-effort: the log never blocks AutoMod, and a
 * welcome that cannot be delivered never stops the autorole grant.
 */
export class GuildMemberAddListener extends Listener {
  constructor() {
    super({ event: "GUILD_MEMBER_ADD" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    const p = data as MemberAddPayload;
    if (!p?.user?.id) return;
    // Activity log first (best-effort, never throws); the rest runs regardless.
    await client.logger.emitEvent(memberAddEvent(p));
    await client.automod.onJoin(toIncomingJoin(p, client.config.guildId));

    const member: WelcomeMember = {
      userId: p.user.id,
      username: p.user.username,
      displayName: p.nick ?? p.user.global_name ?? p.user.username,
      isBot: p.user.bot === true,
      // The account id IS the creation timestamp (snowflake); memberVars turns it
      // into Discord's <t:…:D> markup so {created_at} renders without an API call.
      createdAt: p.user.id,
    };
    await client.welcome.onJoin(member);
    await client.autorole.onJoin(p.user.id, member.isBot);
  }
}

export default new GuildMemberAddListener();
