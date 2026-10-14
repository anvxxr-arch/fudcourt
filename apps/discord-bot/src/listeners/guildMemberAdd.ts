import { toIncomingJoin } from "../automod/wiring.ts";
import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import type { MemberAddPayload } from "../framework/types.ts";

/**
 * GUILD_MEMBER_ADD → AutoMod join rules (new-account, rapid-join / raid). The
 * account's age is derived from its snowflake, so no privileged member data beyond
 * the join itself is required.
 */
export class GuildMemberAddListener extends Listener {
  constructor() {
    super({ event: "GUILD_MEMBER_ADD" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    const p = data as MemberAddPayload;
    if (!p?.user?.id) return;
    await client.automod.onJoin(toIncomingJoin(p, client.config.guildId));
  }
}

export default new GuildMemberAddListener();
