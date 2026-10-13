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

  /** request performs one authed call and normalises the error surface. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
      "User-Agent": this.userAgent,
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
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

  /** GET /guilds/{id} — guild metadata (name, owner, member count). */
  getGuild(guildId: string): Promise<{ id: string; name: string; approximate_member_count?: number }> {
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
}
