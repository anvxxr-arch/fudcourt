import { Listener } from "../framework/listener.ts";
import type { FudzieClient } from "../framework/client.ts";
import type { Interaction } from "../framework/types.ts";

/** Every gateway INTERACTION_CREATE lands here and is routed by the client. */
export class InteractionCreateListener extends Listener {
  constructor() {
    super({ event: "INTERACTION_CREATE" });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    await client.handleInteraction(data as Interaction);
  }
}

export default new InteractionCreateListener();
