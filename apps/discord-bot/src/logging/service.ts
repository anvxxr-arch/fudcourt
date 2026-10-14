// ActivityLogger — posts one embed to the channel an operator routed a category
// to. It is deliberately tiny and fully injectable (destinations + send + log),
// so the routing decision is unit-tested without a gateway or a REST call.
//
// Best-effort by contract: a logging failure must NEVER break the action that
// triggered it (a moderation action already happened in Discord; an activity
// log that cannot be delivered must not turn it into an error). Every method
// swallows failures and returns a boolean instead of throwing.

import type { APIEmbed } from "../framework/types.ts";
import type { ActivityEvent, DestinationMap, LogCategory } from "./types.ts";

export interface ActivityLoggerDeps {
  /** The enabled category → channel map, read fresh (the api caches it). */
  destinations: () => Promise<DestinationMap>;
  /** Post an embed to a channel. */
  send: (channelId: string, embed: APIEmbed) => Promise<void>;
  log: (msg: string) => void;
}

export class ActivityLogger {
  constructor(private readonly deps: ActivityLoggerDeps) {}

  /**
   * emit routes one embed to the channel for `category`. Returns true when the
   * embed was delivered, false when the category is unrouted (the common case —
   * an operator opts a category in by pointing it at a channel) or the send
   * failed. Never throws.
   */
  async emit(category: LogCategory, embed: APIEmbed): Promise<boolean> {
    let channel: string | undefined;
    try {
      channel = (await this.deps.destinations())[category];
    } catch (err) {
      this.deps.log(`activity log: destination lookup failed: ${errText(err)}`);
      return false;
    }
    if (!channel) return false;
    try {
      await this.deps.send(channel, embed);
      return true;
    } catch (err) {
      this.deps.log(`activity log: send to ${channel} (${category}) failed: ${errText(err)}`);
      return false;
    }
  }

  /** emitEvent routes a mapped {category, embed}; null is a no-op. */
  async emitEvent(ev: ActivityEvent | null): Promise<boolean> {
    if (!ev) return false;
    return this.emit(ev.category, ev.embed);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
