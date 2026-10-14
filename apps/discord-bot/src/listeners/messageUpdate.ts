import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import { messageUpdateEvent, type MessageUpdatePayload } from "../logging/events.ts";

/** MESSAGE_UPDATE → the `message` activity-log channel (edits only). */
export class MessageUpdateListener extends Listener {
  constructor() {
    super({ event: "MESSAGE_UPDATE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    await client.logger.emitEvent(messageUpdateEvent(data as MessageUpdatePayload));
  }
}

export default new MessageUpdateListener();
