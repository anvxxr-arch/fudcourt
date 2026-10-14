// Config — the bot's whole environment surface, resolved ONCE at boot.
//
// The credential keys are the SAME ones the Go api already reads (see
// .env.example / docs/operations/SECRETS.md): FUDCOURT_BOT_TOKEN and
// FUDCOURT_CLIENT_ID. Nothing new is invented — the Discord app "Fudzie |
// FUD Court" already owns this bot user, so the gateway bot authenticates with
// the credential that is already in the tree.
//
// A missing token or application id is FATAL for the gateway path and the
// caller decides what to do (see index.ts). `doctor` needs only the token.

export interface BotConfig {
  /** Bot token (FUDCOURT_BOT_TOKEN) — the `Bot <token>` credential. */
  readonly token: string;
  /** Application id (FUDCOURT_CLIENT_ID) — the snowflake slash commands register under. */
  readonly applicationId: string;
  /** Home guild id (FUDCOURT_GUILD_ID) — commands register guild-scoped here when set. */
  readonly guildId: string;
  /** Role ids that grant the admin precondition (FUDCOURT_ROLE_ADMIN). */
  readonly adminRoleIds: readonly string[];
  /** Role ids that grant the team precondition (FUDCOURT_ROLE_TEAM). */
  readonly teamRoleIds: readonly string[];
  /** Role ids that grant the intern tier (FUDCOURT_ROLE_MAGANG). */
  readonly magangRoleIds: readonly string[];
  /** Loopback base of the Go data sidecar (:3101) for /status probes. */
  readonly dataUrl: string;
  /** Loopback base of the Go api (:3103) — the admin-editable config source. */
  readonly apiUrl: string;
  /** Public origin (FUDCOURT_PUBLIC_ORIGIN) — linked from /status and /help. */
  readonly publicOrigin: string;
  /** Optional guild id that the member/role commands should read (defaults to guildId). */
  readonly memberGuildId: string;
  /** FUD wallets from FUD_WALLETS=label:0xaddr,label:0xaddr (same key the Telegram bot reads). */
  readonly wallets: readonly { label: string; address: string }[];
  /** EVM JSON-RPC endpoint (EVM_RPC_URL) for /balance; empty disables it. */
  readonly evmRpc: string;
}

function parseWallets(raw: string | undefined): { label: string; address: string }[] {
  if (!raw) return [];
  const out: { label: string; address: string }[] = [];
  for (const pair of raw.split(",")) {
    const [label, address] = pair.split(":");
    if (label && address) out.push({ label: label.trim(), address: address.trim() });
  }
  return out;
}

function splitIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * loadConfig reads the process environment. It does NOT throw on a missing
 * token — `doctor` and unit tests build a config from an explicit object — but
 * `requireToken` lets the gateway path fail loudly instead of half-starting.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): BotConfig {
  return {
    token: env.FUDCOURT_BOT_TOKEN ?? "",
    applicationId: env.FUDCOURT_CLIENT_ID ?? "",
    guildId: env.FUDCOURT_GUILD_ID ?? "",
    adminRoleIds: splitIds(env.FUDCOURT_ROLE_ADMIN),
    teamRoleIds: splitIds(env.FUDCOURT_ROLE_TEAM),
    magangRoleIds: splitIds(env.FUDCOURT_ROLE_MAGANG),
    dataUrl: (env.FUDCOURT_DATA_URL ?? "http://127.0.0.1:3101").replace(/\/+$/, ""),
    apiUrl: (env.FUDCOURT_API_URL ?? "http://127.0.0.1:3103").replace(/\/+$/, ""),
    publicOrigin: (env.FUDCOURT_PUBLIC_ORIGIN ?? "https://fudcourt.my.id").replace(/\/+$/, ""),
    memberGuildId: env.FUDCOURT_GUILD_ID ?? "",
    wallets: parseWallets(env.FUD_WALLETS ?? env.FUDCOURT_WALLETS),
    evmRpc: env.EVM_RPC_URL ?? "",
  };
}

/** The gateway needs a token; the registration path additionally needs the app id. */
export function missingForGateway(cfg: BotConfig): string[] {
  const miss: string[] = [];
  if (!cfg.token) miss.push("FUDCOURT_BOT_TOKEN");
  if (!cfg.applicationId) miss.push("FUDCOURT_CLIENT_ID");
  return miss;
}

// --- Admin-editable config (Postgres `settings`, read over the api loopback) ---

/** The subset of config the admin panel owns. Blank/absent fields keep the env value. */
export interface RemoteDiscordConfig {
  guildId?: string;
  roleAdmin?: string;
  roleTeam?: string;
  roleMagang?: string;
}

/**
 * applyRemoteConfig overlays the admin-editable config (served by the api from
 * the `settings` table) on the env baseline. A blank/absent remote field keeps
 * the env value, so the bot resolves the right tiers before the panel is ever
 * used AND keeps working through an api outage.
 *
 * It is a pure function of (baseline, remote) — NEVER of the running config —
 * so clearing a role in the panel actually clears it here instead of the
 * previously fetched remote value sticking forever.
 */
export function applyRemoteConfig(base: BotConfig, remote: RemoteDiscordConfig | null): BotConfig {
  if (!remote) return base;
  const pick = (raw: string | undefined, fallback: readonly string[]): readonly string[] => {
    const ids = splitIds(raw);
    return ids.length > 0 ? ids : fallback;
  };
  const guildId = remote.guildId?.trim() || base.guildId;
  return {
    ...base,
    guildId,
    memberGuildId: guildId,
    adminRoleIds: pick(remote.roleAdmin, base.adminRoleIds),
    teamRoleIds: pick(remote.roleTeam, base.teamRoleIds),
    magangRoleIds: pick(remote.roleMagang, base.magangRoleIds),
  };
}

/**
 * fetchRemoteConfig reads the api's loopback config endpoint. It never throws:
 * an unreachable, slow, or garbage api yields null and the caller keeps the env
 * baseline. The timeout stops a hung api from stalling the refresh loop.
 */
export async function fetchRemoteConfig(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<RemoteDiscordConfig | null> {
  if (!apiUrl) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiUrl}/api/internal/discord-config`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") return null;
    return body as RemoteDiscordConfig;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
