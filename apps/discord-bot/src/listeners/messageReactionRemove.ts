import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import type { ReactionPayload } from "./messageReactionAdd.ts";

/** MESSAGE_REACTION_REMOVE → a reaction-role panel revokes the mapped role. */
export class MessageReactionRemoveListener extends Listener {
  constructor() {
    super({ event: "MESSAGE_REACTION_REMOVE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    const p = data as ReactionPayload;
    if (!p?.message_id || !p.user_id || p.user_id === client.identity?.id) return;
    await client.panels.handleReaction(p.message_id, p.emoji, p.user_id, false);
  }
}

export default new MessageReactionRemoveListener();
