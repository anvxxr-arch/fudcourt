import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import { memberRemoveEvent, type MemberRemovePayload } from "../logging/events.ts";

/** GUILD_MEMBER_REMOVE → the `member` activity-log channel (a member left). */
export class GuildMemberRemoveListener extends Listener {
  constructor() {
    super({ event: "GUILD_MEMBER_REMOVE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    await client.logger.emitEvent(memberRemoveEvent(data as MemberRemovePayload));
  }
}

export default new GuildMemberRemoveListener();
