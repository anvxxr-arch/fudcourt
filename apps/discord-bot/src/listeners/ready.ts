import { Listener } from "../framework/listener.ts";
import type { FudzieClient } from "../framework/client.ts";
import type { ReadyPayload } from "../framework/types.ts";

/**
 * On READY: announce the identity, then publish the command set. Guild-scoped
 * registration (when FUDCOURT_GUILD_ID is set) is instant, so a deploy needs no
 * up-to-1h propagation wait; global registration is the fallback.
 */
export class ReadyListener extends Listener {
  constructor() {
    super({ event: "READY", once: true });
  }

  async run(client: FudzieClient, data: unknown): Promise<void> {
    const ready = data as ReadyPayload;
    client.log(`logged in as ${ready.user?.username ?? "?"} (${ready.user?.id ?? "?"}) in ${ready.guilds?.length ?? 0} guild(s)`);
    try {
      const n = await client.registerCommands();
      const scope = client.config.guildId ? `guild ${client.config.guildId}` : "globally";
      client.log(`registered ${n} commands ${scope}`);
    } catch (err) {
      client.log(`command registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export default new ReadyListener();
