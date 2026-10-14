// FudzieClient — the container the whole bot hangs off (Sapphire's "container").
//
// It owns the config, the REST client, the three stores, and the gateway. Piece
// loading walks the source tree once at boot (commands/, listeners/,
// preconditions/), exactly the way a store-based framework discovers modules —
// a new command is a new file, never an edit to a central list.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { applyRemoteConfig, fetchRemoteConfig, type BotConfig } from "../config.ts";
import type { AutomodService } from "../automod/service.ts";
import { buildAutomod } from "../automod/wiring.ts";
import { CaseLog, type CaseLogLike } from "../lib/cases.ts";
import { Command, parseOptions, type CommandContext, type ParsedOptions } from "./command.ts";
import { Gateway, INTENTS_BOT } from "./gateway.ts";
import { Listener } from "./listener.ts";
import { Precondition } from "./precondition.ts";
import { Rest } from "./rest.ts";
import { CommandStore, ListenerStore, PreconditionStore } from "./store.ts";
import {
  EPHEMERAL_FLAG,
  InteractionType,
  type APIEmbed,
  type DiscordUser,
  type GuildMember,
  type Interaction,
  type InteractionCallbackData,
} from "./types.ts";

export interface ClientOptions {
  config: BotConfig;
  rest?: Rest;
  log?: (msg: string) => void;
  /** Injectable case store (tests); defaults to a loopback CaseLog on config.apiUrl. */
  cases?: CaseLogLike;
  /** Injectable AutoMod service (tests); defaults to the loopback-backed builder. */
  automod?: AutomodService;
  /** Injectable gateway factory for tests. */
  gatewayFactory?: (token: string, onEvent: (event: string, data: unknown) => void) => Gateway;
}

export class FudzieClient {
  private readonly envConfig: BotConfig;
  private currentConfig: BotConfig;
  private configTimer: ReturnType<typeof setInterval> | null = null;
  readonly rest: Rest;
  /** The moderation-case store the api owns; the bot only talks to it over loopback. */
  readonly cases: CaseLogLike;
  /** AutoMod: rule evaluation + anti-spam windows + action delivery. */
  readonly automod: AutomodService;
  readonly commands = new CommandStore();
  readonly listeners = new ListenerStore();
  readonly preconditions = new PreconditionStore();

  private gateway: Gateway | null = null;
  private readonly logFn: (msg: string) => void;
  private readonly gatewayFactory: ClientOptions["gatewayFactory"];
  private startedAt = Date.now();
  private me: DiscordUser | null = null;

  constructor(opts: ClientOptions) {
    this.envConfig = opts.config;
    this.currentConfig = opts.config;
    this.rest = opts.rest ?? new Rest(opts.config.token);
    this.logFn = opts.log ?? ((m) => console.log(m));
    this.cases = opts.cases ?? new CaseLog(opts.config.apiUrl, this.logFn);
    this.automod = opts.automod ?? buildAutomod(this);
    this.gatewayFactory = opts.gatewayFactory;
  }

  /**
   * config is the EFFECTIVE config: the env baseline with the admin-editable
   * values (from the api, over loopback) overlaid. It is read fresh on every
   * access, so a refresh lands mid-flight — a panel change needs no restart.
   */
  get config(): BotConfig {
    return this.currentConfig;
  }

  log(msg: string): void {
    this.logFn(`[fudzie] ${msg}`);
  }

  get identity(): DiscordUser | null {
    return this.me;
  }

  get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /** loadPieces walks <root>/commands, <root>/listeners, <root>/preconditions. */
  async loadPieces(root: string): Promise<{ commands: number; listeners: number; preconditions: number }> {
    for (const file of walk(join(root, "commands"))) {
      const mod = await import(pathToFileURL(file).href);
      const piece = mod.default;
      if (piece instanceof Command) this.commands.add(piece);
    }
    for (const file of walk(join(root, "listeners"))) {
      const mod = await import(pathToFileURL(file).href);
      const piece = mod.default;
      if (piece instanceof Listener) this.listeners.add(piece);
    }
    for (const file of walk(join(root, "preconditions"))) {
      const mod = await import(pathToFileURL(file).href);
      const piece = mod.default;
      if (piece instanceof Precondition) this.preconditions.add(piece);
    }
    this.log(
      `loaded ${this.commands.size} commands, ${this.listeners.size} listeners, ${this.preconditions.size} preconditions`,
    );
    return { commands: this.commands.size, listeners: this.listeners.size, preconditions: this.preconditions.size };
  }

  /** registerCommands publishes the command set (guild-scoped when a guild is set). */
  async registerCommands(): Promise<number> {
    const payload = this.commands.all().map((c) => c.toJSON());
    if (this.config.guildId) {
      await this.rest.registerGuildCommands(this.config.applicationId, this.config.guildId, payload);
    } else {
      await this.rest.registerGlobalCommands(this.config.applicationId, payload);
    }
    return payload.length;
  }

  /** buildContext turns a raw interaction into the context a command receives. */
  buildContext(interaction: Interaction): CommandContext {
    const options: ParsedOptions = parseOptions(interaction.data);
    const user: DiscordUser = interaction.member?.user ?? interaction.user ?? { id: "0", username: "unknown" };
    const reply = async (data: { content?: string; embeds?: APIEmbed[]; ephemeral?: boolean }): Promise<void> => {
      const payload: InteractionCallbackData = {};
      if (data.content !== undefined) payload.content = data.content;
      if (data.embeds !== undefined) payload.embeds = data.embeds;
      if (data.ephemeral) payload.flags = EPHEMERAL_FLAG;
      await this.rest.createInteractionResponse(interaction.id, interaction.token, 4, payload);
    };
    const defer = async (): Promise<void> => {
      await this.rest.createInteractionResponse(interaction.id, interaction.token, 5, { flags: EPHEMERAL_FLAG });
    };
    const followUp = async (data: { content?: string; embeds?: APIEmbed[] }): Promise<void> => {
      await this.rest.createFollowup(this.config.applicationId, interaction.token, {
        content: data.content,
        embeds: data.embeds,
      });
    };
    return {
      client: this,
      interaction,
      guildId: interaction.guild_id,
      channelId: interaction.channel_id,
      member: interaction.member,
      user,
      options,
      targetId: interaction.data?.target_id,
      reply,
      defer,
      followUp,
    };
  }

  /** handleInteraction is the command router: resolve → preconditions → run. */
  async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.type === InteractionType.Ping) {
      await this.rest.createInteractionResponse(interaction.id, interaction.token, 1);
      return;
    }
    if (interaction.type !== InteractionType.ApplicationCommand) return;

    const name = interaction.data?.name ?? "";
    const kind = interaction.data?.type ?? 1;
    const cmd = this.commands.get(name, kind);
    if (!cmd) {
      const ctx = this.buildContext(interaction);
      await ctx.reply({ content: `Unknown command \`/${name}\`.`, ephemeral: true });
      return;
    }

    const ctx = this.buildContext(interaction);
    for (const pname of cmd.preconditions) {
      const pre = this.preconditions.get(pname);
      if (!pre || !pre.runsFor(cmd.name)) continue;
      const result = await pre.check(ctx);
      if (!result.ok) {
        await ctx.reply({ content: result.message ?? "Refused.", ephemeral: true });
        return;
      }
    }

    try {
      await cmd.run(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`command /${name} failed: ${msg}`);
      try {
        await ctx.reply({ content: `⚠️ \`/${name}\` failed: ${msg}`, ephemeral: true });
      } catch {
        /* the interaction may already be answered */
      }
    }
  }

  /** login opens the gateway and wires every listener to its event. */
  async login(): Promise<void> {
    const gw = await this.rest.getGatewayBot();
    this.startedAt = Date.now();

    const gateway =
      this.gatewayFactory?.(this.config.token, (event, data) => this.dispatch(event, data)) ??
      new Gateway({
        token: this.config.token,
        intents: INTENTS_BOT,
        gatewayUrl: gw.url,
        log: (m) => this.log(m),
      });

    gateway.on("READY", (data: unknown) => {
      const d = data as { user?: DiscordUser };
      if (d.user) this.me = d.user;
      this.dispatch("READY", data);
    });
    gateway.on("error", (err: unknown) => this.log(`gateway error: ${String(err)}`));
    gateway.on("fatal", (code: unknown) => this.log(`gateway fatal close ${String(code)} — token or intents`));
    gateway.on("disconnect", (code: unknown) => this.log(`gateway disconnect ${String(code)}`));
    for (const l of this.listeners.all()) {
      if (l.event === "READY" || l.event === "error") continue;
      gateway.on(l.event, (data: unknown) => this.dispatch(l.event, data));
    }
    this.gateway = gateway;
    gateway.connect();
  }

  /** dispatch runs the listeners bound to one event. */
  async dispatch(event: string, data: unknown): Promise<void> {
    for (const l of this.listeners.forEvent(event)) {
      try {
        await l.run(this, data);
      } catch (err) {
        this.log(`listener ${event} threw: ${String(err)}`);
      }
    }
  }

  /**
   * refreshConfig re-reads the admin-editable config from the api and overlays
   * it on the env baseline. It never throws: an unreachable api keeps the last
   * good values, so the bot degrades to its env config instead of dying.
   *
   * A change is logged once (not every poll) so an operator can see the panel
   * take effect live without tailing the api.
   */
  async refreshConfig(): Promise<void> {
    const remote = await fetchRemoteConfig(this.currentConfig.apiUrl);
    if (!remote) return;
    const next = applyRemoteConfig(this.envConfig, remote);
    if (!sameWiring(this.currentConfig, next)) {
      this.log(
        `config changed from the admin panel — guild=${next.guildId || "—"} ` +
          `admin=[${next.adminRoleIds.join(",")}] team=[${next.teamRoleIds.join(",")}] magang=[${next.magangRoleIds.join(",")}]`,
      );
    }
    this.currentConfig = next;
  }

  /**
   * startConfigRefresh polls the api so an admin panel change reaches the bot
   * with no .env edit and no restart. The first refresh runs immediately; the
   * interval is unref'd so it never keeps the process alive on its own.
   */
  startConfigRefresh(intervalMs = 30_000): void {
    if (this.configTimer) return;
    void this.refreshConfig();
    this.configTimer = setInterval(() => void this.refreshConfig(), intervalMs);
    // Bun/Node timers expose unref(); the DOM lib types setInterval as number.
    (this.configTimer as unknown as { unref?: () => void }).unref?.();
  }

  destroy(): void {
    if (this.configTimer) {
      clearInterval(this.configTimer);
      this.configTimer = null;
    }
    this.gateway?.destroy();
    this.gateway = null;
  }
}

/** sameWiring reports whether two configs resolve to the same guild + role tiers. */
function sameWiring(a: BotConfig, b: BotConfig): boolean {
  const eq = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  return (
    a.guildId === b.guildId &&
    eq(a.adminRoleIds, b.adminRoleIds) &&
    eq(a.teamRoleIds, b.teamRoleIds) &&
    eq(a.magangRoleIds, b.magangRoleIds)
  );
}

/** walk returns every .ts file under a directory, recursively (sorted). */
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}
