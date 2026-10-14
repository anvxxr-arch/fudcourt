import type { WelcomeMember } from "../community/welcome.ts";
import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import { memberRemoveEvent, type MemberRemovePayload } from "../logging/events.ts";

/** GUILD_MEMBER_REMOVE → the `member` activity log, then the goodbye message. */
export class GuildMemberRemoveListener extends Listener {
  constructor() {
    super({ event: "GUILD_MEMBER_REMOVE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    const p = data as MemberRemovePayload;
    await client.logger.emitEvent(memberRemoveEvent(p));
    if (!p?.user?.id) return;
    const member: WelcomeMember = {
      userId: p.user.id,
      username: p.user.username,
      displayName: p.nick ?? p.user.global_name ?? p.user.username,
      isBot: p.user.bot === true,
      createdAt: p.user.id,
    };
    await client.welcome.onLeave(member);
  }
}

export default new GuildMemberRemoveListener();
