import { toIncomingMessage } from "../automod/wiring.ts";
import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import type { DiscordMessage } from "../framework/types.ts";

/**
 * MESSAGE_CREATE → AutoMod, then custom commands. Guild messages only (a DM has
 * no guild to moderate in), and bots are ignored here as well as in the service,
 * so a bot's own output can never feed the anti-spam windows or trigger a custom
 * command. The two are independent: a custom command runs whether or not AutoMod
 * took an action.
 */
export class MessageCreateListener extends Listener {
  constructor() {
    super({ event: "MESSAGE_CREATE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    const m = data as DiscordMessage;
    if (!m?.guild_id || !m.author?.id || m.author.bot) return;
    await client.automod.onMessage(toIncomingMessage(m));
    await client.customCommands.handleMessage(m);
  }
}

export default new MessageCreateListener();
