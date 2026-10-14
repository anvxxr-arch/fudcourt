// Logging types — the shared vocabulary for the bot's Discord ACTIVITY logs and
// its AUDIT trail.
//
// Activity logs mirror what happens in Discord (a message deleted, a member
// joined, a role changed) to an operator-chosen channel per category. Audit
// logs record what changed about the BOT ITSELF (a setting, a rule), with a
// structured before/after. They are different concerns with different stores
// (db/schema/pg-schema.sql: `log_destinations` vs `audit_logs`), so the types
// live together here but the writers stay separate.

import type { APIEmbed } from "../framework/types.ts";

/** The activity classes the bot can route to a channel. Mirrors the api's
 * closed set (apps/api/logging.go: logCategories). */
export type LogCategory =
  | "message"
  | "member"
  | "role"
  | "voice"
  | "channel"
  | "moderation"
  | "automod";

/** One category → channel routing row (as the api serves it). */
export interface LogDestination {
  category: string;
  channelId: string;
  enabled: boolean;
}

/** The resolved map the router switches on: category → channel id (enabled only). */
export type DestinationMap = Record<string, string>;

/** A pending activity log: the category it belongs to and the embed to post. */
export interface ActivityEvent {
  category: LogCategory;
  embed: APIEmbed;
}

/** One audit entry the bot records (a change it originated). */
export interface AuditInput {
  actorId?: string;
  actorName?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  /** Structured snapshots; omitted when absent (a create has no before). */
  before?: unknown;
  after?: unknown;
  /** dashboard | discord | automod | system */
  source?: string;
}
