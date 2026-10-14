import type { FudzieClient } from "../framework/client.ts";
import { Listener } from "../framework/listener.ts";
import { voiceStateEvent, type VoiceStatePayload } from "../logging/events.ts";

/** VOICE_STATE_UPDATE → the `voice` activity-log channel (join/leave/move). */
export class VoiceStateUpdateListener extends Listener {
  constructor() {
    super({ event: "VOICE_STATE_UPDATE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    await client.logger.emitEvent(voiceStateEvent(data as VoiceStatePayload));
  }
}

export default new VoiceStateUpdateListener();
