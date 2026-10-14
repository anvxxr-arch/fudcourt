// Custom-command wiring — binds the pure CustomCommandService to the live bot:
// the command set is read from the api over loopback (like every other config),
// responses are sent through the shared REST client, and the guild name/count
// for {server}/{member_count} is fetched ONCE and cached (a per-message REST call
// on the hot path is exactly what this project avoids).

import type { FudzieClient } from "../framework/client.ts";
import { InMemoryCooldownStore } from "./cooldown.ts";
import { CustomCommandService, type OutgoingMessage } from "./service.ts";
import { parseCustomCommands, type CustomCommand } from "./types.ts";

/** The loopback route the Go api serves the custom-command set from. */
export const CUSTOM_COMMANDS_PATH = "/api/internal/custom-commands";

/**
 * fetchCustomCommands reads the command set from the api. An unreachable api or
 * a malformed body yields an empty set, so custom commands simply do nothing
 * rather than throwing into a message handler.
 */
export async function fetchCustomCommands(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
  log: (m: string) => void = () => {},
): Promise<CustomCommand[]> {
  if (!apiUrl) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiUrl}${CUSTOM_COMMANDS_PATH}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { commands?: unknown };
    return parseCustomCommands(body?.commands);
  } catch (err) {
    log(`custom commands fetch failed: ${errText(err)}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** buildCustomCommands assembles the service on the loopback config. */
export function buildCustomCommands(client: FudzieClient): CustomCommandService {
  const apiUrl = client.config.apiUrl;
  return new CustomCommandService({
    commands: () => fetchCustomCommands(apiUrl, fetch, 3000, (m) => client.log(m)),
    prefix: () => client.config.prefix,
    send: (channelId, data) => client.rest.createMessage(channelId, toPayload(data)).then(() => undefined),
    directMessage: (userId, data) => client.rest.sendDirectMessage(userId, toPayload(data)).then(() => undefined),
    deleteMessage: (channelId, messageId) => client.rest.deleteMessage(channelId, messageId, { reason: "custom command (delete trigger)" }),
    guildInfo: guildInfoCache(client),
    cooldown: new InMemoryCooldownStore(),
    log: (m) => client.log(m),
  });
}

/** toPayload maps an OutgoingMessage onto the REST message body. */
function toPayload(data: OutgoingMessage): import("../framework/types.ts").InteractionCallbackData {
  const payload: import("../framework/types.ts").InteractionCallbackData = {};
  if (data.content !== undefined) payload.content = data.content;
  if (data.embeds !== undefined) payload.embeds = data.embeds as import("../framework/types.ts").APIEmbed[];
  if (data.replyTo) payload.message_reference = { message_id: data.replyTo };
  return payload;
}

/**
 * guildInfoCache returns a memoised guild name/count reader. The first call
 * fetches once; later calls reuse it for `ttlMs`. A failed fetch keeps the last
 * good value (or an empty name) — it never throws into the message path.
 */
export function guildInfoCache(
  client: FudzieClient,
  ttlMs = 10 * 60 * 1000,
): () => Promise<{ name: string; memberCount?: number }> {
  let cached: { name: string; memberCount?: number } | null = null;
  let at = 0;
  return async () => {
    const now = Date.now();
    if (cached && now - at < ttlMs) return cached;
    const guildId = client.config.guildId;
    if (!guildId) return cached ?? { name: "" };
    try {
      const g = await client.rest.getGuild(guildId);
      cached = { name: g.name, memberCount: g.approximate_member_count };
      at = now;
    } catch (err) {
      client.log(`custom commands: guild info fetch failed: ${errText(err)}`);
    }
    return cached ?? { name: "" };
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
