import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import { messageDeleteEvent, type MessageDeletePayload } from "../logging/events.ts";

/** MESSAGE_DELETE → the `message` activity-log channel (when routed). */
export class MessageDeleteListener extends Listener {
  constructor() {
    super({ event: "MESSAGE_DELETE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    await client.logger.emitEvent(messageDeleteEvent(data as MessageDeletePayload));
  }
}

export default new MessageDeleteListener();
