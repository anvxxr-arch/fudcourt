import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import { channelEvent, type ChannelPayload } from "../logging/events.ts";

/** CHANNEL_CREATE → the `channel` activity-log channel. */
export class ChannelCreateListener extends Listener {
  constructor() {
    super({ event: "CHANNEL_CREATE" });
  }
  async run(client: FudzieClient, data: unknown): Promise<void> {
    await client.logger.emitEvent(channelEvent("create", data as ChannelPayload));
  }
}

export default new ChannelCreateListener();
