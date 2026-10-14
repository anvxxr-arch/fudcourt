import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import { memberUpdateEvent, type MemberUpdatePayload } from "../logging/events.ts";

/** GUILD_MEMBER_UPDATE → the `role`/`member` activity-log channel (roles/nick). */
export class GuildMemberUpdateListener extends Listener {
  constructor() {
    super({ event: "GUILD_MEMBER_UPDATE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    await client.logger.emitEvent(memberUpdateEvent(data as MemberUpdatePayload));
  }
}

export default new GuildMemberUpdateListener();
