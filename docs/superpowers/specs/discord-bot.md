# Discord bot — architecture spec (as-built + decisions)

Status: living. Decisions that touch shared infra are also recorded as `DR-` entries
in `docs/records/DECISIONS.md` (the repository's own decision log); this file is the
one-place overview the brief asks for.

## 1. Context

The brief describes a standalone private Discord management bot (Go core + Rust
worker + TS dashboard). The actual host is **fudcourt** — a mature Bun/TS + Go
monorepo that already owns the exact primitives the brief lists. Per the brief's own
rule ("preserve good existing conventions; do not blindly follow this tree"), the bot
is built **inside fudcourt**, reusing its data plane, dashboard, database and proxy
rather than standing up a parallel stack.

### Deviations from the brief (documented, deliberate)

| Brief | As-built in fudcourt | Why |
|---|---|---|
| Go core owns Discord gateway | **Bun/TS** `apps/discord-bot` owns the gateway + commands | fudcourt's Go (`apps/api`) is a loopback data plane, not a gateway host; a second Go service would duplicate auth/REST plumbing the bot already has in TS |
| Rust worker for scheduler/feeds | Durable jobs in **Postgres** (`FOR UPDATE SKIP LOCKED`), Bun worker | No workload yet justifies a separate Rust binary; the job-state boundary is DB-backed so extraction stays cheap |
| Standalone TS dashboard | Existing **Next.js** `apps/web` + admin panel | The dashboard already exists, is deployed, and is session-gated |
| Compose + Caddy + TLS from scratch | fudcourt's existing Caddy / Cloudflare tunnel | Already public, already TLS |
| PostgreSQL + Valkey, private | `postgres-hardened` 127.0.0.1:5432 (db `fudcourt`); Valkey :6380 | Loopback-only, never public — satisfies "DB/Valkey not exposed" |

## 2. Component map

- **`apps/discord-bot`** (Bun, zero-dependency framework) — Discord gateway,
  slash/context-menu commands, preconditions, moderation service, case log client.
  Talks to `apps/api` over loopback only; carries **no** Postgres driver.
- **`apps/api`** (Go) — the bot's data plane. Owns `settings` (admin-editable
  config), `moderation_cases`, and every internal route the bot reads/writes.
  Loopback-gated (`127.0.0.1` peer check), so the web tier proxying to it cannot
  defeat the gate.
- **`apps/web`** (Next.js) — public dashboard + BFF. Session-gated (`/api/admin/*`).
- **`postgres-hardened`** — source of truth for all operational config.
- **Valkey :6380** — ephemeral only (rate limits, anti-spam windows, cooldowns).
- **Caddy / Cloudflare tunnel** — the only public edge.

## 3. Domain rule (enforced)

Discord handler → service → domain → repository. Handlers never query Postgres;
the dashboard never implements business logic; Discord and dashboard actions call the
**same** service. The bot reaches data **only** through `apps/api` loopback routes,
so this holds structurally: there is no DB driver in the bot to bypass the service.

## 4. Discord command system

- Framework is hand-rolled (`src/framework/*`): `Gateway` (v10 WS state machine),
  `Rest`, `Command`/`Listener`/`Precondition` stores, `FudzieClient` container.
- Piece loading walks `commands/`, `listeners/`, `preconditions/` at boot — a new
  command is a new file, never a central-list edit.
- **Slash commands**: moderation set (`/ban /kick /timeout /untimeout /warn /lock
  /unlock /nick /purge /slowmode /case /history`) + core/admin/fud sets.
- **Context-menu commands**: user (`Warn/Timeout/Kick/Ban`) and message
  (`Delete Message / Warn Author / Timeout Author`) — registered guild-scoped.
- **Prefix commands**: not yet implemented (plan P3).
- Config (guild id, role tiers) is admin-editable and refreshed every 30 s — a panel
  change lands with no restart.

## 5. Permissions / capabilities

As-built: **precondition** model — `AdminOnly` / `ModOnly` gate commands by Discord
role **id** (`FUDCOURT_ROLE_ADMIN` / `_TEAM` / `_MAGANG`), never by role name, plus
Discord hierarchy checks in `src/moderation/hierarchy.ts` (owner, self, above-actor,
above-bot are all refused). Namespaced **capability** engine
(`moderation.warn`, `feeds.manage`, …) with role→capability mapping in the DB is the
planned generalisation (plan P2/P13); the id-based tiers are the MVP stand-in and the
authorisation is already name-independent.

## 6. Moderation case log (shipped)

A moderation action mints a numbered case in `moderation_cases`; the same case is
what the bot (`/case`, `/history`), the dashboard (`CasesPanel`) and the audit trail
read back. Case numbering is a Postgres sequence; snowflakes are `text` end-to-end
(no JS precision loss). Recording is best-effort — a case-log failure never fails the
moderation action itself.

## 7. Event model

In-process typed listeners bound per gateway event (`Listener` store). No external
broker. Cross-process durability is Postgres job state, not a message bus.

## 8. Security invariants

- DB/Valkey never public; only the proxy edge is.
- Internal bot routes are loopback-only and **must never gain a public Next handler**
  — enforced by `contracts/scripts/check-contract.mjs` (the `internal` segment is
  exempt from the route-handler requirement *and* asserted to have no public handler).
- Capability checks run on the API side, never only by hiding frontend routes.
- Discord hierarchy validation on every destructive action.
