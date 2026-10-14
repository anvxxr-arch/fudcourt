// Logging wiring — the one place the pure logger is bound to the live bot: the
// destination map is read from the api over loopback, the embeds are posted
// through the shared REST client, and the bot records its own audit entries.

import type { FudzieClient } from "../framework/client.ts";
import { AuditLog } from "./audit.ts";
import { ActivityLogger } from "./service.ts";
import type { DestinationMap } from "./types.ts";

/** The loopback route the Go api serves the activity-log routing map from. */
export const LOG_CONFIG_PATH = "/api/internal/log-config";

/**
 * fetchLogConfig reads the enabled category → channel map from the api. An
 * unreachable api (or a malformed body) yields an empty map, so logging simply
 * does nothing rather than throwing into an event handler.
 */
export async function fetchLogConfig(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
  log: (m: string) => void = () => {},
): Promise<DestinationMap> {
  if (!apiUrl) return {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiUrl}${LOG_CONFIG_PATH}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return {};
    const body = (await res.json()) as { destinations?: unknown };
    const raw = body?.destinations;
    if (!raw || typeof raw !== "object") return {};
    const out: DestinationMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * buildLogger assembles the ActivityLogger from a live client. The destination
 * loader is re-read per event (the api caches the rows), so an operator
 * re-pointing a category at another channel lands without a restart.
 */
export function buildLogger(client: FudzieClient): ActivityLogger {
  return new ActivityLogger({
    destinations: () => fetchLogConfig(client.config.apiUrl, fetch, 3000, (m) => client.log(m)),
    send: (channelId, embed) => client.rest.createMessage(channelId, { embeds: [embed] }).then(() => undefined),
    log: (m) => client.log(m),
  });
}

/** buildAuditLog assembles the bot's audit client on the same loopback hop. */
export function buildAuditLog(client: FudzieClient): AuditLog {
  return new AuditLog(client.config.apiUrl, (m) => client.log(m));
}
