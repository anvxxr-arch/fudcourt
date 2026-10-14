import { toIncomingJoin } from "../automod/wiring.ts";
import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import type { MemberAddPayload } from "../framework/types.ts";
import { memberAddEvent } from "../logging/events.ts";

/**
 * GUILD_MEMBER_ADD → the `member` activity log, then AutoMod join rules
 * (new-account, rapid-join / raid). The account's age is derived from its
 * snowflake, so no privileged member data beyond the join itself is required.
 */
export class GuildMemberAddListener extends Listener {
  constructor() {
    super({ event: "GUILD_MEMBER_ADD" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    const p = data as MemberAddPayload;
    if (!p?.user?.id) return;
    // Activity log first (best-effort, never throws); AutoMod runs regardless.
    await client.logger.emitEvent(memberAddEvent(p));
    await client.automod.onJoin(toIncomingJoin(p, client.config.guildId));
  }
}

export default new GuildMemberAddListener();
