// Listener — the Sapphire "Listener" piece: an event name, an optional `once`
// flag, and a run function the client invokes for each gateway event.

import type { FudzieClient } from "./client.ts";

export interface ListenerOptions {
  event: string;
  once?: boolean;
}

export abstract class Listener {
  readonly event: string;
  readonly once: boolean;

  constructor(opts: ListenerOptions) {
    this.event = opts.event;
    this.once = opts.once ?? false;
  }

  abstract run(client: FudzieClient, data: unknown): Promise<void> | void;
}
