# apps/discord-bot — Fudzie

The FUD Court **Discord bot**. It opens the Discord gateway, receives
slash-command interactions and answers them from the same loopback FUDCourt
services the site and the Telegram bot read.

It is a **zero-dependency** TypeScript program on the **Bun** runtime (DR-007 /
DR-008): no `discord.js`, no framework package. The framework pieces are
hand-rolled here, shaped after [Sapphire](https://sapphirejs.dev) — a client
that owns stores, a directory-scanned command/listener/precondition set, and a
gateway + REST driver underneath.

## Why not discord.js / Sapphire

The repo's house rule is "no dependency we can write". Discord's gateway and
REST surface used here is small and stable (v10), and the runtime already ships
`fetch` and `WebSocket`, so the whole bot is ~15 small files with no lockfile to
audit. The *architecture* is Sapphire's; the *dependency* is not.

## Layout

```
src/
  index.ts                 entry — subcommands: run | doctor | register | list
  config.ts                env resolution (FUDCOURT_BOT_TOKEN, _CLIENT_ID, …)
  globals.d.ts             ambient node/bun decls (keeps the tree dependency-free)
  framework/
    client.ts              FudzieClient — config + stores + gateway; loads pieces
    gateway.ts             Discord gateway (WebSocket v10) state machine
    rest.ts                Discord REST v10 client (injectable fetch)
    command.ts             Command base + parseOptions + CommandContext
    listener.ts            Listener base
    precondition.ts        Precondition base (gate semantics)
    store.ts               CommandStore / ListenerStore / PreconditionStore
    types.ts               minimal Discord API shapes
  commands/
    core/{ping,help,version,id}.ts
    fud/{status,wallets,balance}.ts
    admin/whoami.ts        (AdminOnly precondition)
  listeners/
    ready.ts               on READY: announce + re-publish the command set
    interactionCreate.ts   route every interaction to the client
  preconditions/
    AdminOnly.ts           fail-closed admin gate
  lib/
    embed.ts               embed helper + accent colours
    probe.ts               loopback service probes for /status
    rpc.ts                 eth_getBalance + weiToEther for /balance
```

A new command is **one file** that exports `default new XCommand()` — the client
discovers it by walking `commands/`, exactly the way a store-based framework
does. There is no central switch to edit.

## Commands

| Command | Gate | What |
| --- | --- | --- |
| `/ping` | — | liveness + uptime |
| `/help` | — | list the commands |
| `/version` | — | bot identity + uptime |
| `/id` | — | guild / channel / user ids (ephemeral) |
| `/status` | — | probe the four loopback services on `/healthz` |
| `/wallets` | — | the configured FUD wallets |
| `/balance` | — | native balance of those wallets (needs `EVM_RPC_URL`) |
| `/whoami` | AdminOnly | the caller's resolved tier (admin > team > magang > member) |

## Config from the admin panel (not just .env)

The guild id and the three tier role ids are **admin-editable at runtime**. The
web dashboard writes them to the Postgres `settings` table
(`discord.guild_id`, `discord.role_admin`, `discord.role_team`,
`discord.role_magang`); the Go api serves the effective values (env defaults
overlaid with the stored rows) on the loopback-only
`GET /api/internal/discord-config`; the bot polls that endpoint every 30s and
re-derives its config, so a panel change reaches the bot with **no `.env` edit
and no restart**.

The env vars below are the **boot defaults** — an unset/blank panel field keeps
them, and the bot keeps working through an api outage (it falls back to the last
good config, then to env). A change is logged once when it lands:

```
[fudzie] config changed from the admin panel — guild=… admin=[…] team=[…] magang=[…]
```

## Environment (all already in the repo `.env`)

- `FUDCOURT_BOT_TOKEN` — the bot token (shared with the Go api's OAuth flow)
- `FUDCOURT_CLIENT_ID` — the application id slash commands register under
- `FUDCOURT_GUILD_ID` — the guild; commands register **guild-scoped** (instant)
- `FUDCOURT_ROLE_ADMIN` / `FUDCOURT_ROLE_TEAM` / `FUDCOURT_ROLE_MAGANG` — boot
  defaults for the tier resolve (overridden by the panel, see above)
- `FUD_WALLETS`, `EVM_RPC_URL` — optional, for `/wallets` and `/balance`
- `FUDCOURT_DATA_URL` — the data sidecar base (default `http://127.0.0.1:3101`)
- `FUDCOURT_API_URL` — the api base the bot polls for the panel config
  (default `http://127.0.0.1:3103`)

## Run

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/discord-bot
bun run src/index.ts list        # offline: print the loaded pieces
bun run src/index.ts doctor      # live: validate token/app/guild/roles (read-only)
bun run src/index.ts register    # publish the command set, no gateway
bun run src/index.ts run         # open the gateway and serve (default)
```

`bun test` runs the framework unit suite (stores, gateway opcode machine, REST
shaping, preconditions, routing). `bunx tsc --noEmit` typechecks with zero
`@types` packages.

## Deploy

`deploy/systemd/fudcourt-discord.service` — a `systemctl --user` unit that runs
`bun run src/index.ts run` with `EnvironmentFile=/home/dwizzy/fudcourt/.env`.
The command set is re-published on every `READY`, so a restart is the whole
deploy.
