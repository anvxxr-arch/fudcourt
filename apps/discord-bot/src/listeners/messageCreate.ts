import { toIncomingMessage } from "../automod/wiring.ts";
import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import type { DiscordMessage } from "../framework/types.ts";

/**
 * MESSAGE_CREATE → AutoMod. Guild messages only (a DM has no guild to moderate in),
 * and bots are ignored here as well as in the service, so a bot's own output can
 * never feed the anti-spam windows.
 */
export class MessageCreateListener extends Listener {
  constructor() {
    super({ event: "MESSAGE_CREATE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    const m = data as DiscordMessage;
    if (!m?.guild_id || !m.author?.id || m.author.bot) return;
    await client.automod.onMessage(toIncomingMessage(m));
  }
}

export default new MessageCreateListener();
