// REST client — a thin, injectable wrapper over Discord's v10 HTTP API.
//
// Zero dependencies: it uses the global `fetch`. Tests inject a fake fetcher
// (`opts.fetcher`) so request shaping is asserted without a network call, and
// the api base is injectable so a local server can stand in for discord.com.

import type {
  ApplicationCommand,
  DiscordUser,
  GuildMember,
  GuildRole,
  InteractionCallbackData,
} from "./types.ts";

const DEFAULT_API = "https://discord.com/api/v10";

export class DiscordAPIError extends Error {
  readonly status: number;
  readonly code: number | string | undefined;
  readonly path: string;
  constructor(status: number, path: string, message: string, code?: number | string) {
    super(`Discord ${status} ${path}: ${message}`);
    this.name = "DiscordAPIError";
    this.status = status;
    this.path = path;
    this.code = code;
  }
  /** 404 / 403 on a member read means "not in the guild", not a transport fault. */
  get notFound(): boolean {
    return this.status === 404 || this.status === 403;
  }
}

export interface RestOptions {
  apiBase?: string;
  fetcher?: typeof fetch;
  userAgent?: string;
}

export class Rest {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly fetcher: typeof fetch;
  private readonly userAgent: string;

  constructor(token: string, opts: RestOptions = {}) {
    this.token = token;
    this.apiBase = (opts.apiBase ?? DEFAULT_API).replace(/\/+$/, "");
    this.fetcher = opts.fetcher ?? fetch;
    this.userAgent = opts.userAgent ?? "Fudzie (https://fudcourt.my.id, 1.0.0)";
  }

  /** request performs one authed call and normalises the error surface.
   * `opts.reason` is sent as X-Audit-Log-Reason (percent-encoded, ≤512 chars),
   * so every moderation action shows the moderator's stated reason in the
   * Discord audit log — the same courtesy Dyno/Sapphire bots give. */
  async request<T>(method: string, path: string, body?: unknown, opts: { reason?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
      "User-Agent": this.userAgent,
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (opts.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(opts.reason.slice(0, 512));
    const res = await this.fetcher(`${this.apiBase}${path}`, {
      method,
      headers,
      body: payload,
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      let message = text.slice(0, 300) || res.statusText;
      let code: number | string | undefined;
      try {
        const parsed = JSON.parse(text) as { message?: string; code?: number | string };
        if (parsed.message) message = parsed.message;
        code = parsed.code;
      } catch {
        /* non-JSON error body — keep the raw text */
      }
      throw new DiscordAPIError(res.status, path, message, code);
    }
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** GET /gateway/bot — the shard URL + recommended shard count. */
  getGatewayBot(): Promise<{ url: string; shards: number; session_start_limit?: { remaining: number } }> {
    return this.request("GET", "/gateway/bot");
  }

  /** GET /users/@me — the bot's own identity. A cheap token-validity probe. */
  getCurrentUser(): Promise<DiscordUser> {
    return this.request("GET", "/users/@me");
  }

  /** GET /applications/@me — the application the token belongs to. */
  getApplication(): Promise<{ id: string; name: string; bot?: DiscordUser; flags?: number }> {
    return this.request("GET", "/applications/@me");
  }

  /** GET /guilds/{id}/roles — every role in the guild (for the admin picker). */
  listGuildRoles(guildId: string): Promise<GuildRole[]> {
    return this.request("GET", `/guilds/${guildId}/roles`);
  }

  /** GET /guilds/{id}/members/{user} — one member (roles + nickname). */
  getGuildMember(guildId: string, userId: string): Promise<GuildMember> {
    return this.request("GET", `/guilds/${guildId}/members/${userId}`);
  }

  /** GET /guilds/{id} — guild metadata (name, owner id, member count). */
  getGuild(guildId: string): Promise<{ id: string; name: string; owner_id?: string; approximate_member_count?: number }> {
    return this.request("GET", `/guilds/${guildId}`);
  }

  /** PUT /applications/{app}/guilds/{guild}/commands — guild-scoped (instant) registration. */
  registerGuildCommands(appId: string, guildId: string, commands: ApplicationCommand[]): Promise<ApplicationCommand[]> {
    return this.request("PUT", `/applications/${appId}/guilds/${guildId}/commands`, commands);
  }

  /** PUT /applications/{app}/commands — global registration (up to 1h to propagate). */
  registerGlobalCommands(appId: string, commands: ApplicationCommand[]): Promise<ApplicationCommand[]> {
    return this.request("PUT", `/applications/${appId}/commands`, commands);
  }

  /** POST /interactions/{id}/{token}/callback — the first response to an interaction.
   * `type` is the interaction callback type (1 Pong, 4 message, 5 deferred). */
  createInteractionResponse(
    interactionId: string,
    interactionToken: string,
    type: number,
    data?: InteractionCallbackData,
  ): Promise<void> {
    const body = data === undefined ? { type } : { type, data };
    return this.request("POST", `/interactions/${interactionId}/${interactionToken}/callback`, body);
  }

  /** POST /webhooks/{app}/{token} — a followup message after a deferred reply. */
  createFollowup(appId: string, interactionToken: string, data: InteractionCallbackData): Promise<unknown> {
    return this.request("POST", `/webhooks/${appId}/${interactionToken}`, data);
  }

  // --- Moderation primitives (the shared surface every mod command drives) ---
  // Each takes an optional audit-log `reason`; the request layer stamps it as
  // X-Audit-Log-Reason. Discord returns 204 (empty) for most of these, which
  // request() already turns into `undefined`.

  /** PUT /guilds/{g}/bans/{u} — ban a member. */
  banMember(
    guildId: string,
    userId: string,
    opts: { deleteMessageSeconds?: number; reason?: string } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts.deleteMessageSeconds) body.delete_message_seconds = opts.deleteMessageSeconds;
    return this.request("PUT", `/guilds/${guildId}/bans/${userId}`, body, { reason: opts.reason });
  }

  /** DELETE /guilds/{g}/bans/{u} — lift a ban. */
  unbanMember(guildId: string, userId: string, opts: { reason?: string } = {}): Promise<void> {
    return this.request("DELETE", `/guilds/${guildId}/bans/${userId}`, undefined, { reason: opts.reason });
  }

  /** DELETE /guilds/{g}/members/{u} — kick a member. */
  kickMember(guildId: string, userId: string, opts: { reason?: string } = {}): Promise<void> {
    return this.request("DELETE", `/guilds/${guildId}/members/${userId}`, undefined, { reason: opts.reason });
  }

  /** PATCH /guilds/{g}/members/{u} — timeout (communication_disabled_until) or nick. */
  modifyMember(
    guildId: string,
    userId: string,
    body: { communication_disabled_until?: string | null; nick?: string | null },
    opts: { reason?: string } = {},
  ): Promise<unknown> {
    return this.request("PATCH", `/guilds/${guildId}/members/${userId}`, body, { reason: opts.reason });
  }

  /** GET /channels/{c}/messages — the most recent messages, newest first (1..100). */
  listMessages(channelId: string, limit: number): Promise<Array<{ id: string; timestamp?: string }>> {
    const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.request("GET", `/channels/${channelId}/messages?limit=${n}`);
  }

  /** POST /channels/{c}/messages/bulk-delete — delete 2..100 messages (204). */
  bulkDeleteMessages(channelId: string, messageIds: string[], opts: { reason?: string } = {}): Promise<void> {
    return this.request(
      "POST",
      `/channels/${channelId}/messages/bulk-delete`,
      { messages: messageIds },
      { reason: opts.reason },
    );
  }

  /** DELETE /channels/{c}/messages/{m} — delete a single message. */
  deleteMessage(channelId: string, messageId: string, opts: { reason?: string } = {}): Promise<void> {
    return this.request("DELETE", `/channels/${channelId}/messages/${messageId}`, undefined, { reason: opts.reason });
  }

  /** PATCH /channels/{c} — modify a channel (rate_limit_per_user is slowmode seconds). */
  modifyChannel(
    channelId: string,
    body: { rate_limit_per_user?: number },
    opts: { reason?: string } = {},
  ): Promise<unknown> {
    return this.request("PATCH", `/channels/${channelId}`, body, { reason: opts.reason });
  }

  /**
   * PUT /channels/{c}/permissions/{overwrite} — write a channel overwrite.
   * `type` 0 is a role overwrite (the @everyone role id equals the guild id),
   * 1 a member. `allow`/`deny` are permission bitfield strings.
   */
  editChannelPermissions(
    channelId: string,
    overwriteId: string,
    body: { allow?: string; deny?: string; type?: number },
    opts: { reason?: string } = {},
  ): Promise<void> {
    return this.request("PUT", `/channels/${channelId}/permissions/${overwriteId}`, body, { reason: opts.reason });
  }
}
