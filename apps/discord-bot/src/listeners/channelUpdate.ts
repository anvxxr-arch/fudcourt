import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import { channelEvent, type ChannelPayload } from "../logging/events.ts";

/** CHANNEL_UPDATE → the `channel` activity-log channel. */
export class ChannelUpdateListener extends Listener {
  constructor() {
    super({ event: "CHANNEL_UPDATE" });
  }
  async run(client: FudzieClient, data: unknown): Promise<void> {
    await client.logger.emitEvent(channelEvent("update", data as ChannelPayload));
  }
}

export default new ChannelUpdateListener();
