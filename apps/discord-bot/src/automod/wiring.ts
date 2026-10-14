// AutoMod wiring — the one place the pure engine is bound to the live bot: rules
// are read from the api over loopback, the tracker runs on ephemeral windows, the
// moderation actions go through the shared ModerationService, and the bot is the
// actor (its permissions ORed from its own roles, so AutoMod can never exceed what
// the bot itself may do).

import type { FudzieClient } from "../framework/client.ts";
import type { DiscordMessage, GuildRole, MemberAddPayload } from "../framework/types.ts";
import { snowflakeToMs } from "../lib/snowflake.ts";
import { ModerationService } from "../moderation/service.ts";
import type { AutomodRule } from "./matchers.ts";
import { parseRule } from "./rules.ts";
import {
  AutomodService,
  type ActorIdentity,
  type AutomodDeps,
  type IncomingJoin,
  type IncomingMessage,
} from "./service.ts";
import { InMemoryWindowStore, SpamTracker } from "./state.ts";

/** The loopback route the Go api serves the validated rules from. */
export const AUTOMOD_RULES_PATH = "/api/internal/automod/rules";

/**
 * fetchRules reads the rule rows from the api and validates them. A row that fails
 * validation is skipped (and logged), never fatal: a bad operator edit must not take
 * AutoMod — or the bot — down. An unreachable api yields an empty rule set.
 */
export async function fetchRules(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
  log: (m: string) => void = () => {},
): Promise<AutomodRule[]> {
  if (!apiUrl) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiUrl}${AUTOMOD_RULES_PATH}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body) ? body : ((body as { rules?: unknown[] })?.rules ?? []);
    const out: AutomodRule[] = [];
    for (const [i, row] of rows.entries()) {
      try {
        out.push(parseRule(row));
      } catch (err) {
        log(`automod rule #${i} rejected: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** orPermissions ORs the permission bitfields of the roles the member holds. */
export function orPermissions(memberRoles: readonly string[], roles: readonly GuildRole[]): string {
  const want = new Set(memberRoles);
  let acc = 0n;
  for (const r of roles) {
    if (want.has(r.id) && r.permissions) {
      try {
        acc |= BigInt(r.permissions);
      } catch {
        /* an unparseable bitfield is ignored, not fatal */
      }
    }
  }
  return acc.toString();
}

/** makeBotActor resolves the bot's own id, roles and ORed permissions in the guild. */
export function makeBotActor(client: FudzieClient): () => Promise<ActorIdentity> {
  return async () => {
    const me = await client.rest.getCurrentUser();
    const guildId = client.config.guildId;
    if (!guildId) return { id: me.id, roles: [], permissions: "0" };
    try {
      const [member, roles] = await Promise.all([
        client.rest.getGuildMember(guildId, me.id),
        client.rest.listGuildRoles(guildId),
      ]);
      return { id: me.id, roles: member.roles ?? [], permissions: orPermissions(member.roles ?? [], roles) };
    } catch {
      return { id: me.id, roles: [], permissions: "0" };
    }
  };
}

/** toIncomingMessage maps a MESSAGE_CREATE payload to the service's input. */
export function toIncomingMessage(m: DiscordMessage): IncomingMessage {
  const authorId = m.author?.id ?? "";
  const created = authorId ? snowflakeToMs(authorId) : null;
  return {
    guildId: m.guild_id ?? "",
    channelId: m.channel_id,
    messageId: m.id,
    authorId,
    authorIsBot: m.author?.bot === true,
    content: m.content ?? "",
    mentionIds: (m.mentions ?? []).map((u) => u.id),
    roleIds: m.member?.roles ?? [],
    attachments: (m.attachments ?? []).length,
    ...(created !== null ? { accountCreatedAt: created } : {}),
  };
}

/** toIncomingJoin maps a GUILD_MEMBER_ADD payload to the service's input. */
export function toIncomingJoin(p: MemberAddPayload, fallbackGuildId: string): IncomingJoin {
  const userId = p.user?.id ?? "";
  const created = userId ? snowflakeToMs(userId) : null;
  return {
    guildId: p.guild_id ?? fallbackGuildId,
    userId,
    ...(created !== null ? { accountCreatedAt: created } : {}),
  };
}

/**
 * buildAutomod assembles the AutoMod service from a live client. It is called once
 * at boot; the rule loader is re-read per event so an operator edit lands without a
 * restart (the loader is cheap and the api caches the rows).
 */
export function buildAutomod(client: FudzieClient): AutomodService {
  const tracker = new SpamTracker(new InMemoryWindowStore());
  const moderation = new ModerationService(client);
  const deps: AutomodDeps = {
    rules: () => fetchRules(client.config.apiUrl, fetch, 3000, (m) => client.log(m)),
    tracker,
    moderation: { run: (r) => moderation.run(r) },
    delivery: {
      deleteMessage: (c, m) => client.rest.deleteMessage(c, m, { reason: "automod" }),
      addRole: (g, u, r) => client.rest.addGuildMemberRole(g, u, r, { reason: "automod" }),
      removeRole: (g, u, r) => client.rest.removeGuildMemberRole(g, u, r, { reason: "automod" }),
    },
    actor: makeBotActor(client),
    activity: client.logger,
    log: (m) => client.log(m),
  };
  return new AutomodService(deps);
}
