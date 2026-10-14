import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";

/** The subset of MESSAGE_REACTION_ADD / _REMOVE a reaction-role panel reads. */
export interface ReactionPayload {
  user_id?: string;
  channel_id?: string;
  message_id?: string;
  guild_id?: string;
  emoji?: { id?: string | null; name?: string | null };
}

/** MESSAGE_REACTION_ADD → a reaction-role panel grants the mapped role. */
export class MessageReactionAddListener extends Listener {
  constructor() {
    super({ event: "MESSAGE_REACTION_ADD" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    const p = data as ReactionPayload;
    // Ignore the bot's own reactions (it seeds panel reactions on setup).
    if (!p?.message_id || !p.user_id || p.user_id === client.identity?.id) return;
    await client.panels.handleReaction(p.message_id, p.emoji, p.user_id, true);
  }
}

export default new MessageReactionAddListener();
