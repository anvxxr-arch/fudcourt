// Community wiring — binds the pure welcome/autorole/role services to the live
// bot: the config is read from the api over loopback (like every other config),
// role grants go through the shared REST client, and each assignment is recorded
// back over loopback so the dashboard can show what the bot did.

import type { FudzieClient } from "../framework/client.ts";
import { topPosition } from "../moderation/hierarchy.ts";
import { AutoroleService } from "./autorole.ts";
import { PanelService } from "./panels.ts";
import { RoleService, type RoleAssignment } from "./roles.ts";
import { parseAutoroleRules, parseRolePanels, parseWelcomeConfig, type AutoroleRule, type RolePanel, type WelcomeConfig } from "./types.ts";
import { WelcomeService } from "./welcome.ts";

/** The loopback route the Go api serves the community config from. */
export const COMMUNITY_CONFIG_PATH = "/api/internal/community/config";
/** The loopback route the api stores role-assignment records on. */
export const ROLE_ASSIGNMENT_PATH = "/api/internal/role-assignments";

export interface CommunityConfig {
  welcome?: WelcomeConfig;
  autoroles: AutoroleRule[];
  panels: RolePanel[];
}

/**
 * fetchCommunityConfig reads welcome/autoroles/panels from the api. An
 * unreachable api or a malformed body yields an empty config, so the community
 * features simply do nothing rather than throwing into an event handler.
 */
export async function fetchCommunityConfig(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
  log: (m: string) => void = () => {},
): Promise<CommunityConfig> {
  const empty: CommunityConfig = { autoroles: [], panels: [] };
  if (!apiUrl) return empty;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiUrl}${COMMUNITY_CONFIG_PATH}`, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) return empty;
    const body = (await res.json()) as { welcome?: unknown; autoroles?: unknown; panels?: unknown };
    return {
      welcome: parseWelcomeConfig(body?.welcome),
      autoroles: parseAutoroleRules(body?.autoroles),
      panels: parseRolePanels(body?.panels),
    };
  } catch (err) {
    log(`community config fetch failed: ${errText(err)}`);
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * recordAssignment POSTs one role-assignment row to the api over loopback.
 *
 * Recording is BEST-EFFORT by design — the grant already happened, so a failure
 * here must never surface as a failed grant — but "best-effort" is not the same as
 * "silent". The response is inspected for exactly that reason: a 4xx means this
 * attempt is now missing from role_assignments, which is the only record that
 * answers "why didn't this member get the role?", and the log line is the one
 * place it can still be noticed. (A refused source went unnoticed for long enough
 * that reaction-role grants were never recorded at all.)
 */
export async function recordAssignment(
  apiUrl: string,
  a: RoleAssignment,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
  log?: (msg: string) => void,
): Promise<void> {
  if (!apiUrl) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiUrl}${ROLE_ASSIGNMENT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a),
      signal: ctrl.signal,
    });
    if (!res.ok) log?.(`role assignment record refused: ${res.status} ${await refusalText(res)}`);
  } catch (err) {
    log?.(`role assignment record failed: ${errText(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * refusalText reads the api's own sentence out of a refusal — the same `detail`
 * the dashboard shows — and falls back to a bounded slice of the raw body when it
 * is not the envelope we expect.
 */
async function refusalText(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const body = parsed as { detail?: unknown; error?: unknown };
      if (typeof body.detail === "string" && body.detail) return body.detail;
      if (typeof body.error === "string" && body.error) return body.error;
    }
  } catch {
    /* not json: fall through to the raw text */
  }
  return text.slice(0, 200);
}

/** buildWelcome assembles the welcome/goodbye service on the loopback config. */
export function buildWelcome(client: FudzieClient): WelcomeService {
  const apiUrl = client.config.apiUrl;
  return new WelcomeService({
    config: async () => (await fetchCommunityConfig(apiUrl, fetch, 3000, (m) => client.log(m))).welcome,
    send: (channelId, data) => client.rest.createMessage(channelId, data).then(() => undefined),
    dm: (userId, data) => client.rest.sendDirectMessage(userId, data).then(() => undefined),
    log: (m) => client.log(m),
  });
}

/** buildRoleService assembles the hierarchy-checked role granter. */
export function buildRoleService(client: FudzieClient): RoleService {
  const guildId = client.config.guildId;
  return new RoleService({
    listRoles: () => client.rest.listGuildRoles(guildId),
    botTop: async () => {
      const botId = client.identity?.id;
      if (!botId) return 0;
      const [member, roles] = await Promise.all([client.rest.getGuildMember(guildId, botId), client.rest.listGuildRoles(guildId)]);
      return topPosition(member.roles ?? [], roles);
    },
    addRole: (userId, roleId, reason) => client.rest.addGuildMemberRole(guildId, userId, roleId, { reason }),
    removeRole: (userId, roleId, reason) => client.rest.removeGuildMemberRole(guildId, userId, roleId, { reason }),
    record: (a) => recordAssignment(client.config.apiUrl, a, fetch, 3000, (m) => client.log(m)),
    log: (m) => client.log(m),
  });
}

/** buildAutorole assembles the autorole service (immediate + delayed + deferred grants). */
export function buildAutorole(client: FudzieClient): AutoroleService {
  const apiUrl = client.config.apiUrl;
  return new AutoroleService({
    rules: async () => (await fetchCommunityConfig(apiUrl, fetch, 3000, (m) => client.log(m))).autoroles,
    roles: buildRoleService(client),
    schedule: (delaySeconds, fn) => {
      const t = setTimeout(() => void fn(), delaySeconds * 1000);
      (t as unknown as { unref?: () => void }).unref?.();
    },
    log: (m) => client.log(m),
  });
}

/** buildPanels assembles the role-panel interaction handler. */
export function buildPanels(client: FudzieClient): PanelService {
  const apiUrl = client.config.apiUrl;
  const guildId = client.config.guildId;
  return new PanelService({
    panels: async () => (await fetchCommunityConfig(apiUrl, fetch, 3000, (m) => client.log(m))).panels,
    roles: buildRoleService(client),
    memberRoles: async (userId) => (await client.rest.getGuildMember(guildId, userId)).roles ?? [],
    reply: (content, ephemeral) => client.respondComponent(content, ephemeral),
    log: (m) => client.log(m),
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
