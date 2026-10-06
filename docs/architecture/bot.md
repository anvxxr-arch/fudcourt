# The Telegram bot (`apps/bot`)

**What it is.** The *receiving* half of the notification channel. `fudcourt` already
had a sending half — the executor's `internal/notify/telegram.go` pushes
an execution outcome at Telegram; nothing ever read a reply or answered a question.
`apps/bot` is that other half: a long-polling command surface, in the same repo,
same language, same house rules.

It is **not** a web surface. It opens no port, registers no route, and is invisible
to `check-contract.py` and the route sweeps — its only outbound path is the Bot API
and the one used-from-inside path is exactly one HTTP call to grow the service map
(`/status`, below).

## 1. Where it lives

| | |
|---|---|
| Module | `github.com/anvxxr-arch/fudcourt/apps/bot` (root `go.mod`, Go 1.25.0) |
| Dependencies | **stdlib only** (root `go.mod` has no `require` entry for it — the floor every Go service here stands on) |
| In the module | yes — one repository-wide module, so `go build ./...` from the root covers it |
| LOC | **1,572** across **12** `.go` files — 9 production (1,202) + 3 test files (370) |
| Binary | `apps/bot/bin/fudcourt-bot` — git-ignored (`apps/bot/bin/`) |

```
apps/bot/
  cmd/bot/main.go                 config load → getMe → setMyCommands → drain → poll loop, graceful shutdown
  internal/config/config.go       env-only config; fail-visible on a missing token
  internal/telegram/{types,client}.go   the Bot API client (getMe / getUpdates / sendMessage / answerCallbackQuery)
  internal/handlers/{handlers,register}.go   the registry, the one admin gate, menu rendering, command parsing
  internal/handlers/{core,admin,fud}.go      the handlers themselves
```

## 2. Runtime shape

- **Long poll, no webhook.** `getUpdates` with an explicit timeout; the bot holds the
  poll itself, which is why a second concurrent `getUpdates` from the same token
  answers `409 Conflict` — that conflict *is* the liveness proof (see §6).
- **`allowed_updates` is sent explicitly** rather than left to the server default, so
  the set the bot drains cannot silently widen or narrow with a Bot API change.
- **Startup drains pending updates** before the poll loop starts, so a restart does
  not replay a backlog of stale `/commands` from hours ago.
- **Fail-visible startup.** A missing or malformed token stops the process at
  `config.Load`, not on the first message — the unit cannot come up half-alive.
- **Graceful shutdown** on `SIGINT`/`SIGTERM`: the in-flight poll returns, then the
  loop exits.
- **Admin gate is enforced in exactly one place** — `Registry.Dispatch`
  (`internal/handlers/register.go`) — so no handler body re-checks the allowlist and
  none can forget to.

## 3. Command surface

11 handlers; **8 are public** (and are exactly the 8 Telegram's `getMyCommands`
returns), **3 are admin-only**.

| Command | Answers | Tier |
|---|---|---|
| `/start` | welcome card + command list | public |
| `/help` | the command list | public |
| `/ping` | liveness + uptime | public |
| `/id` | this chat's id and your user id | public |
| `/version` | bot and Go runtime version | public |
| `/status` | fudcourt service health (see §5) | public |
| `/wallets` | the configured FUD wallets | public |
| `/balance` | native balance of those wallets | public |
| `/admin` | list the admin commands | admin |
| `/whoami` | your user and chat identity | admin |
| `/stats` | runtime and configuration stats | admin |

The menu Telegram shows is `Registry.Menu()` → `Public()` only; the admin trio is
deliberately absent from it (they are still reachable by name).

## 4. Configuration (names only — never values)

| Name | Meaning | Required |
|---|---|---|
| `FUDCOURT_TELEGRAM_BOT_TOKEN` | the bot token — the **same key** the executor's `notify` sends with | yes (fail-visible) |
| `FUDCOURT_BOT_ADMIN_IDS` | comma-separated user ids allowed the admin tier | no (empty ⇒ no admin) |
| `FUDCOURT_DATA_URL` | base of the Go data sidecar, for `/wallets` + `/balance` | no (code default `http://127.0.0.1:3101`) |
| `FUD_WALLETS` | the wallet list `/wallets` + `/balance` read | no |
| `EVM_RPC_URL` | EVM RPC used by `/balance` | no |
| `FUDCOURT_BOT_API` | **additive seam**: overrides the Bot API root, which is what makes the offline E2E run possible (the same shape `FUDCOURT_DISCORD_API` gives the api) | no (default `https://api.telegram.org`) |

`FUDCOURT_TELEGRAM_BOT_TOKEN` is a secret and is inventoried in
[SECRETS.md](../operations/SECRETS.md) §1 (`./.env`, git-ignored, 0600). The rest are
configuration, not credentials.

## 5. The unit, and what `/status` checks

Versioned at `deploy/systemd/fudcourt-bot.service`, installed as a
`systemd --user` unit. `EnvironmentFile` is the repo-root `.env` — the same file the
executor reads, which is why the token has one home instead of two.

`/status` probes each fudcourt surface over loopback and reports per-service lines.
**Every service answers on `/healthz`** — `web` on `:3100` is the one exception (it
answers `/`); `data` `:3101`, `reconciled` `:3102`, `api` `:3103`, and the bot reports
itself. (An earlier revision probed `/api/health` and `/health`, which 404'd and made
`/status` look red while every unit was green; `/healthz` is the real path.)

## 6. How it is verified

```bash
gofmt -l apps/bot && go build ./... && go vet ./apps/bot/... && go test ./apps/bot/...
```

- **14 unit tests** across `internal/config` (3), `internal/telegram` (5) and
  `internal/handlers` (6).
- **Offline E2E** — a stub Bot API behind `FUDCOURT_BOT_API` drives the real flow
  (config → `getMe` → `setMyCommands` → startup drain → `getUpdates` long poll),
  **8/8 checks**. This is the gate that proves the wiring without touching Telegram.
- **Live proof** (the two calls that cannot be faked offline):
  `getMe` → `@fudbase_bot` "FUDZIE"; `getMyCommands` → the 8 public commands above.
- The module is in `scripts/verify/verify-all.sh`, `scripts/githooks/pre-push` and the
  `go.yml` CI matrix, so it cannot be skipped by a green local run.

## 7. Relationship to `notify` (the sending half)

The executor's `internal/notify/telegram.go` and this service are two ends
of one channel and share **one** credential, `FUDCOURT_TELEGRAM_BOT_TOKEN`. Rotating
that token therefore restarts *both* units — see SECRETS.md §5 R7. Nothing else is
shared: the sender is fire-and-forget inside the executor's process, the receiver is
its own unit, and neither imports the other.
