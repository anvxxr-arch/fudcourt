import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import { channelEvent, type ChannelPayload } from "../logging/events.ts";

/** CHANNEL_DELETE → the `channel` activity-log channel. */
export class ChannelDeleteListener extends Listener {
  constructor() {
    super({ event: "CHANNEL_DELETE" });
  }
  async run(client: FudzieClient, data: unknown): Promise<void> {
    await client.logger.emitEvent(channelEvent("delete", data as ChannelPayload));
  }
}

export default new ChannelDeleteListener();
