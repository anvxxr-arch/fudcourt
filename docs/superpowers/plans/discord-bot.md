# Discord bot — implementation plan (sequence + status)

Executed in dependency order. A phase is "done" only when its tests/build/lint pass
against the real repo — no green-by-disabling. Status is the truth, not the intent.

## Status board

| # | Phase | Status | Evidence / note |
|---|---|---|---|
| 0 | Repository audit | ✅ done | fudcourt monorepo; bot built in-tree per §28 |
| 1 | Architecture foundation | ✅ done | `src/framework/*` (gateway/rest/stores/client), config from `apps/api` loopback, `/healthz` `/readyz` on the api |
| 2 | Identity / auth / permissions | 🟡 partial | precondition tiers by role **id** + hierarchy checks shipped; DB-backed **capability** engine + Discord OAuth dashboard login pending |
| 3 | Discord core | ✅ done | gateway v10 state machine, slash + context-menu routers, precondition middleware, error responder |
| 4 | Moderation | ✅ done | full case lifecycle, case numbers, `/case` `/history`, hierarchy refusals (commit `c84edde`) |
| 5 | AutoMod / anti-spam | ✅ done | rule engine (13 matchers) + deterministic scoring + window state + service + listeners/intents + `automod_rules` store & loopback read; live E2E proven (commits `15ce98a`,`0c875c7`,`b886fb7`,`5007dcd`) |
| 6 | Logging / audit | ✅ done | per-category activity logs (7 categories → routed channels) + audit trail (before/after JSONB); bot mappers + logger + audit client, api store/routes/internal reads; live E2E proven |
| 7 | Community features | ✅ done | welcome/goodbye + autoroles + reaction/button/select role panels; `welcome_configs`/`autorole_rules`/`role_panels`/`role_panel_options`/`role_assignments` stores, one loopback read + admin routes, bot services + listeners; live PG round-trip proven (commit `23431fe`) |
| 8 | Custom commands | ✅ done | declarative only — no executable scripting. `custom_commands` store (jsonb `responses`, shared name/alias trigger namespace, role/channel allow-lists, cooldown, delete-trigger/reply/DM), one loopback read + admin replace-as-a-unit route, bot `customcommands` service, configurable prefix via `discord.prefix`; live PG round-trip + live loopback read proven |
| 9 | Worker foundation | ✅ done | `apps/discord-worker` (Rust): durable `jobs` + `job_runs` queue, one-statement atomic claim (`FOR UPDATE SKIP LOCKED`), retry/backoff with dead-lettering, `(guild_id, kind, dedupe_key)` idempotency, stale-claim reaper, graceful drain, loopback `/healthz` + `/readyz`; optional Valkey advisory lock (never the durability mechanism); 41 unit + 12 live-PG tests |
| 10 | Scheduler | ⬜ todo | one-time / interval / cron, explicit TZ, restart-safe |
| 11 | Feeds | ⬜ todo | adapter pipeline + dedup + SSRF guard on generic HTTP |
| 12 | API surface | 🟡 partial | settings + moderation cases live; remaining resource groups pending |
| 13 | Dashboard | 🟡 partial | admin panel (config + cases); remaining IA pages pending |
| 14 | Integration testing | 🟡 partial | moderation E2E smoke proven live; cross-feature flows pending |
| 15 | Security hardening | 🟡 partial | hierarchy, loopback gate, contract gate (no public internal proxy); SSRF/CSRF/regex passes pending per new feature |
| 16 | Performance review | ⬜ todo | after AutoMod lands (latency-sensitive hot path) |
| 17 | Deployment | 🟡 partial | fudcourt already deployed (Caddy/CF); bot service unit pending |

## Ordering rule

Each phase must pass its own tests before a dependent phase starts. When a test
fails: diagnose root cause → fix → rerun targeted → rerun affected suite → continue.

## Phase 5 as delivered — AutoMod / anti-spam

1. **Rule model** — `automod_rules` (jsonb `matchers`/`actions`, `text[]` exemptions),
   validated on both sides before use; enabled/priority/event are real columns, one
   composite index covers the bot's "enabled, priority DESC" load.
2. **Matchers** (13) — mentions, duplicate, caps, emoji, invite, url, blocked_domain,
   blocked_word, regex (length-capped + ReDoS-shape rejected), attachment,
   new_account, rapid_join, spam. All pure, all unit-tested.
3. **Anti-spam state** — injectable `WindowStore` (in-memory default; a Valkey adapter
   drops in behind the same interface). Deterministic 0–100 score, bounded named terms,
   normal ≤30 / suspicious ≤60 / spam ≤80 / severe >80. No ML.
4. **Actions** — delete, warn, timeout, kick, ban, log_only, notify_mod, add_role,
   remove_role — the four moderation actions route through the **existing
   ModerationService** with `source="automod"`, so the case log and hierarchy checks
   are shared; delete/role go through a narrow `DeliveryPort`.
5. **Exemptions + cooldown** — exempt roles/users/channels short-circuit; per-rule
   cooldown suppresses re-fire and starts after a fire.
6. **Gateway intents** — `INTENTS_BOT = GUILDS|GUILD_MEMBERS|GUILD_MESSAGES|MESSAGE_CONTENT`
   (MESSAGE_CONTENT is privileged — enable it in the app portal).
7. **Tests** — 12 engine + 11 state + 12 service + 16 wiring/listener (bot) and 6 Go
   handler tests; live E2E proven (api row → `{"rules":[…]}` → bot `parseRule`, 0 rejects).

**Still open in phase 5:** a dashboard panel to author/enable rules (the api already
exposes the loopback read; a rule CRUD admin route + panel is the remaining slice),
and swapping the in-memory window store for a Valkey-backed one if a second process
ever needs to share the windows.

## Phase 6 as delivered — Logging / audit

1. **Two trails, deliberately separate.** *Activity* logs mirror Discord events
   (message delete/edit, member join/leave/update, voice, channel); *audit* records
   changes to the bot itself. They share no table and no read path.
2. **Activity routing** — `log_destinations` holds one (guild, category → channel)
   row; categories are a closed set (`message, member, role, voice, channel,
   moderation, automod`). The bot loads the ENABLED map over loopback
   (`GET /api/internal/log-config`) and posts one embed per event; an unrouted
   category no-ops.
3. **Pure mappers** — `src/logging/events.ts` turns a raw gateway payload into
   `{category, embed}` with no client/REST, so the log shape is unit-testable
   (9 mapper tests). `ActivityLogger` (routing) + `AuditLog` (loopback POST) are
   tiny and fully injectable.
4. **Shared action log** — a completed moderation action (Discord **or** dashboard
   **or** AutoMod) mirrors one embed to the `moderation` channel; AutoMod firings
   log to `automod` from the AutoMod service (one embed per firing, not two).
   Best-effort: a log that cannot be delivered never fails the action.
5. **Audit trail** — `audit_logs` (actor, action, resource_type/id, `before`/`after`
   JSONB, source ∈ dashboard|discord|automod|system). Both origins write one row:
   the api records its own mutations (e.g. settings POST captures before/after) and
   the bot POSTs its changes to `POST /api/internal/audit`. Read back newest-first
   via `GET /api/admin/logs/audit` (limit/offset + resource filter).
6. **Tests** — bot: 9 mapper + 4 logger/audit + 4 wiring + 2 moderation-log + 2
   automod-log; api: 12 Go handler tests (loopback gate, admin gate, envelopes,
   validation, round-trip). 186 bot tests pass, `tsc` clean, `go build`/`vet`/`test`
   green. Live E2E: internal read returns the enabled map, an audit POST persists
   with the configured guild id, an unrouted/disabled category is absent.

## Phase 7 as delivered — Community features

1. **Welcome / goodbye** — `welcome_configs` (one row per guild): join and leave
   channels, a plain message or an embed, and a join DM. The bot renders `{user}`,
   `{mention}`, `{server}`, `{member_count}` and `{created_at}` (the snowflake IS
   the creation time, so `<t:…:D>` needs no API call). A join message with no
   channel is forced disabled on write, so a half-configured welcome can never
   silently no-op.
2. **Autoroles** — `autorole_rules` (kind ∈ `on_join|after_duration|
   after_verification`, `appliesTo` ∈ `all|human|bot`, delay ≤ 30 d, priority).
   Grants are hierarchy-guarded and every attempt — **including a failure** — is
   written to `role_assignments`; that is what makes "why didn't this member get
   the role?" answerable after the fact.
3. **Role panels** — `role_panels` + `role_panel_options`, three kinds (reaction,
   button, select) and four modes (toggle, single, multiple, exclusive). A panel
   `id` is an operator slug carried in the Discord custom-id `rp:<id>:<roleId>`, so
   a button/select needs no message lookup; `exclusive_group` on the option makes a
   pick clear its siblings. `GUILD_MESSAGE_REACTIONS` + the two reaction listeners
   cover the reaction kind; `interactionCreate` routes `MessageComponent` to the
   panel handler for the other two.
4. **One loopback read** — the bot carries no Postgres driver, so
   `GET /api/internal/community/config` returns `{autoroles, panels, welcome?}` in
   a single hop; the admin read/write routes sit behind the admin tier. Both
   replace-as-a-unit writes (autoroles, panels) run in one transaction and are
   audited (`welcome.set`, `autoroles.replace`, `role_panels.replace`).
5. **Dashboard** — thin Next proxies for `/api/admin/{welcome,autoroles,
   role-panels,role-assignments}` (Cookie in, upstream response replayed
   verbatim); the phase-6 `/api/admin/logs/{destinations,audit}` proxies the
   contract gate required were added alongside them.
6. **Tests** — 6 bot suites (welcome, autorole, panels, panel, roles, templates;
   241 total pass, `tsc` clean) + Go handler tests + a **live**
   `community_pg_test.go` round-trip against the real schema, skipped unless
   `FUDCOURT_TEST_PG_URL` is set. That live test is the reason two schema↔code
   mismatches (a single welcome-embed column where the code wanted join/leave, and
   `role_panel_options` missing `guild_id`/`exclusive_group`) were caught — the
   fake-store tests could not see them.

## Phase 8 as delivered — Custom commands

1. **Declarative, by construction.** `custom_commands` holds `responses` as a jsonb
   array of `{text, embed}` variants — DATA, never code. There is no shell, JS, Lua,
   SQL or template-expression surface anywhere in the path, so a custom command can
   only render a template and send it. More than one variant is a *random* response
   (one is picked per invocation), so the fixed and randomized cases share one column.
2. **Shared trigger namespace.** `name` (lowercase, `^[a-z0-9][a-z0-9_-]{0,31}$`) is
   unique per guild and `aliases` live in the same namespace: an alias colliding with
   another command's name or alias is refused, so a typed trigger always resolves to
   exactly one command. The whole set is edited as a unit and replaced in one
   transaction (audited `custom-commands.replace`); the api validates names, aliases,
   response shape, allow-list ids and the cooldown range before storing.
3. **Configurable prefix.** `discord.prefix` in `settings` (env seed
   `FUDCOURT_PREFIX`, default `!`) rides the existing `discord-config` loopback read,
   so a prefix change applies without a restart — proven live: DB `?` beat env `!`.
4. **Bot service** (`src/customcommands/`) — pure and fully injectable:
   `parseTrigger` splits `name [args]` without touching Discord, the service gates on
   the role/channel allow-lists (empty = anyone/anywhere), throttles per
   (command, member) via an injectable `CooldownStore` (in-memory default; a Valkey
   adapter drops in behind the same interface), renders `{user} {username}
   {display_name} {server} {member_count} {created_at} {channel} {args} {mention}`
   through the SHARED template engine, then sends (channel reply, plain send, or DM)
   and optionally deletes the trigger. `{server}`/`{member_count}` come from a cached
   guild-info lookup, so the hot path makes no per-message REST call.
5. **Wiring** — `messageCreate` runs AutoMod then custom commands; a message that is
   not a known trigger falls through untouched (returns `false`), and a config-lookup
   or send failure is swallowed so the listener can never break the event loop.
6. **Tests** — 30 bot service/parse tests (`tsc` clean; 282 bot tests pass in total)
   + 13 Go handler tests (loopback gate, admin gate, name/alias/response/allow-list
   validation, method guard) + a **live** `customcommands_pg_test.go` round-trip
   against the real schema (arrays, jsonb responses, boolean flags, the cooldown
   `CHECK`), skipped unless `FUDCOURT_TEST_PG_URL` is set. Live proof: the api served
   `GET /api/internal/custom-commands` from a real row, `discord-config` returned the
   DB prefix, and an unauthenticated admin read was a 401.

**Note on schema application.** The schema is applied out-of-band AS the app role
(`fudcourt`), which owns the tables; applying it as the superuser leaves the new
table owned by `postgres` and the service then gets `permission denied`. Re-applied
as the app role the round-trip passes, so the deployment step stays "apply
`db/schema/pg-schema.sql` as the database owner".

## Phase 9 as delivered — Worker foundation

**`apps/discord-worker`** (Rust, `fudcourt-discord-worker`; binary `discord-worker`). One
process, one crate, mirroring `apps/reconciler`'s shape (tokio + tokio-postgres + `NoTls`
over loopback, `strip` in release). It is the runtime the scheduler (phase 10) and the feed
pipeline (phase 11) hang their kinds on.

**Storage.** Two tables in `db/schema/pg-schema.sql`:

- `jobs` — the durable queue. `(guild_id, kind, dedupe_key)` is **UNIQUE**, so idempotency is
  a database constraint and not an application check; `attempts`/`max_attempts` carry a
  `CHECK (attempts <= max_attempts)` so a job can never be claimed more times than it is
  allowed to run. Partial indexes cover the only two scans that exist: `pending` ordered by
  `run_at`, and `running` by `locked_at` for the reaper.
- `job_runs` — one row per attempt, `outcome` NULL while in flight. A worker that dies
  mid-job leaves the row open and the reaper closes it as `crashed`, which is what makes
  "worker crashed after claiming" visible instead of silent.

**Claiming is one statement.** A data-modifying CTE does
`UPDATE jobs ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)` and inserts the
`job_runs` row in the same statement. Atomic by itself — there is no explicit
`BEGIN`/`COMMIT` to get wrong and no transaction held across a network call. Proven by
`concurrent_workers_never_claim_the_same_job` (8 workers, 8 jobs, zero duplicates).

**Retry policy** (`jobs::next_status`, pure and unit-tested): `Done` is terminal; a
`Permanent` failure dead-letters immediately even with attempts left; a `Retryable` failure
returns to `pending` with exponential backoff (base 5s, ×2, capped 1h) until
`attempts >= max_attempts`, then dead-letters. A dead job is parked, never spun on.

**Crash recovery.** The reaper reclaims `running` jobs whose `locked_at` is older than
`WORKER_STALE_CLAIM_SECS`, closing the orphaned run as `crashed` and returning the job to
`pending` — or straight to `dead` when it cannot afford another attempt. Fencing is enforced
in SQL (`WHERE id = $1 AND locked_by = $2`), so a resurrected worker cannot finish a job that
has since been reclaimed.

**Graceful shutdown.** SIGTERM/SIGINT flip a `watch` channel; the loop stops claiming, waits
for the in-flight permits to come back inside `WORKER_SHUTDOWN_GRACE_SECS`, then aborts
whatever is left. Verified live: `SIGTERM received` → `worker stopped` → exit 0.

**Valkey is optional and advisory.** `FUDCOURT_VALKEY_URL` unset means the lock is a no-op
and Postgres alone provides correctness. When set, it guards the reaper with a
compare-and-delete `SET NX PX` so two workers do not sweep the same instant; if the lock
cannot be taken the sweep is skipped, and if Valkey errors the sweep proceeds anyway because
Postgres is authoritative. The lock is never the only durability mechanism.

**Observability.** One JSON object per line (`level`, `msg`, `ts_unix`, plus fields).
`/healthz` answers from process state; `/readyz` does one `SELECT 1`, which is cheap enough to
run per request and is the only check that can actually say "this worker can work". Loopback
only, default `127.0.0.1:8110`.

**Verification (all actually run).**
- `cargo build --release` clean; `cargo fmt --check` exit 0; `cargo clippy --all-targets
  --all-features -- -D warnings` no errors.
- `cargo test --release`: **41 passed**, 0 failed.
- `FUDCOURT_TEST_PG_URL=… cargo test --test jobs_live`: **12 passed**, 0 failed, against the
  real database — exclusive claim, attempts bumped at claim time, a future `run_at` not
  claimable, permanent-dies-immediately, retryable-returns-with-delay, concurrent workers
  never colliding, idempotent enqueue, exhausted-attempts-dead, claim fencing, terminal
  success recorded in history, and three reaper cases.
- Live end-to-end against the real binary: `/healthz` 200 `{"status":"ok"}`, `/readyz` 200
  `{"status":"ready"}`, unknown path 404; three claimable jobs ran to `done`/`done`/`dead`
  (the unregistered kind dead-lettered with the exact reason) while a `run_at = now() + 1
  hour` job correctly stayed `pending attempts=0`; history recorded
  `succeeded`/`succeeded`/`permanent`; SIGTERM drained to exit 0.

- The optional Valkey lock was verified **live** against the running Valkey at
  `127.0.0.1:6379`, not just compiled: with `FUDCOURT_VALKEY_URL` set the startup log
  reports `valkey_lock:true`; with the reap lock held externally the sweep was correctly
  skipped (a stale `running` job stayed `running`, no closed run); after releasing it the
  sweep ran and the job was reclaimed and re-executed; and the worker's own release deleted
  only its token — the key was gone afterwards and an `NX` re-take succeeded, so nothing
  leaks. The `crashed` run row for an interrupted attempt is asserted by
  `the_reaper_reclaims_a_job_whose_worker_vanished` (a raw synthetic stale row has no run
  row to close, which is why the Valkey probe alone shows none).

**Note on the gate.** `scripts/verify/verify-all.sh` gains a
`cargo fmt/clippy/test (apps/discord-worker)` step after the reconciler step. The file also
carried a pre-existing uncommitted `check-schema-bootstrap` step (whose script is already
committed); that hunk was left untouched and is not part of this phase.

**Note on schema application.** Same deploy rule as phase 8 — the new tables must be applied
AS the app role `fudcourt`, not the superuser, or the service gets `permission denied`.

## Phase 10 as delivered — Scheduler

**One mechanism, not two.** A definition is *materialized* into an ordinary `jobs` row.
That single decision is why restart-safety falls out for free: the claim path is already
atomic, retry/backoff already exists, a dead job is already parked, and `job_runs` is
already the execution log. The scheduler adds no second delivery path and no second source
of truth for status.

**Storage** (`db/schema/pg-schema.sql`), two tables:

- `scheduled_jobs` — one row per schedule the dashboard manages: `schedule_kind`
  (`once`/`interval`/`cron`, CHECK-constrained), `schedule_expr`, an **explicit IANA
  `timezone`**, `job_kind`, `payload`, `enabled`, `next_run_at`, `attempts`/`max_attempts`,
  `last_status`/`last_error`, `UNIQUE (guild_id, name)`. A partial index
  (`WHERE enabled AND next_run_at IS NOT NULL`) is the entire due scan.
- `scheduled_job_runs` — the occurrence **ledger**: `(definition_id, occurrence_at)` is
  **UNIQUE**, which is the outer idempotency backstop. `jobs.(guild_id, kind, dedupe_key)`
  is the inner guard; the ledger is the one that survives a partial failure.

`last_status`/`last_error` describe the **scheduler's** health (did materialization work),
not the delivery's. Delivery health is in `job_runs`, reachable via
`scheduled_job_runs.job_id`. Two counters for one concept is how they drift apart, so each
level owns exactly one.

**Schedule arithmetic is timezone-first** (`scheduler::schedule`, pure and unit-tested).
Every definition carries an IANA zone, and the answer is computed *in* that zone: the cron
path reads the current wall-clock in the zone, feeds it to the parser as though it were UTC,
takes the next match, then resolves that naive wall-clock back into the zone. Computing in
UTC and labelling the result would fire `0 9 * * *` at 09:00 UTC — seven hours late for WIB.

DST is a boundary decision, not an accident (`resolve_local`): an unambiguous wall-clock is
used as-is; an **ambiguous** one (fall-back, the same wall-clock twice) takes the
**earliest** instant, so the choice is deterministic; a **nonexistent** one (spring-forward
gap) advances to the first instant at which it exists, so the occurrence is neither dropped
nor invented.

Cron expressions are accepted in the **5-field crontab form** the dashboard and every
crontab on the box use (`0 9 * * *`); the seconds field the parser requires is supplied
internally. A field count that is neither 5 nor 6/7 is rejected by name.

**No backfill, by decision.** `next_after` always returns the next occurrence *strictly
after* `now`, so a worker that was down for an hour resumes at the next scheduled time
instead of dumping every missed occurrence at once. For a bot that posts reminders and
digests, a burst of stale messages is a worse failure than a skipped one.

**Materialization is one statement.** A data-modifying CTE inserts the ledger row, the job
row, and the link between them. `ON CONFLICT DO NOTHING` on the ledger makes a re-tick, a
race, or a restart re-materialize nothing, and the tick advances the definition anyway —
which is exactly what has to happen, so "already done" is a success, not an error.

**The tick schedules its own successor first.** The next tick's identity is derived from
this tick's own `scheduled_at` (+ interval), **not** from `now`, so a retry produces the same
key and collides instead of forking a chain. Enqueueing before doing any work means a tick
that panics, hangs or dead-letters cannot break the chain: the next tick is already queued
and is claimed as soon as a worker is up. The tick is registered as a handler like any
other, so it is claimed, retried and dead-lettered by the same runtime.

**A broken schedule is parked, not spun.** A cron the evaluator rejects (or one with no
future occurrence) leaves `next_run_at` untouched, records `last_error`, and climbs
`attempts`; at `max_attempts` the definition is set `enabled = false` for a human. Cost is
one evaluation per tick, not a hot loop. A `once` that has fired retires itself
(`enabled = false`, `next_run_at = NULL`).

**Configuration is bootstrap-only.** The guild id (`FUDCOURT_GUILD_ID`) and the heartbeat
(`SCHEDULER_TICK_SECS`, default 60, guarded against 0 so it cannot spin) read the
environment. Which jobs exist, when they run, in which zone, with which payload — all
Postgres rows, so changing them never needs a restart. Without a guild id the scheduler is
left unregistered and says so, rather than registering a tick that cannot work.

**Verification (all actually run).**
- `cargo build --release` clean; `cargo fmt --check` exit 0;
  `cargo clippy --all-targets --all-features -- -D warnings` no errors (which is what forced
  `store::upsert` from eleven positional arguments into a `NewDefinition` struct — at that
  width a caller can swap two adjacent strings and the compiler cannot tell).
- `cargo test --release`: **61 passed**, 0 failed (20 new: schedule arithmetic, zone
  handling, DST boundaries, cron parsing, `ScheduleKind`, the config knobs).
- `cargo test --test jobs_live`: **12 passed** — unchanged, so phase 9's guarantees still hold
  on the extended schema.
- `cargo test --test scheduler_live`: **9 passed**, against the real database — a due
  definition becoming exactly one job with the definition advanced by one interval; forcing
  the same occurrence back and re-ticking materializing **nothing new** (the ledger refusing
  it, and reporting `already_done`); a not-yet-due definition left completely alone; the
  materialized job carrying the occurrence in `dedupe_key`, the payload, and `run_at`; a
  `once` retiring itself and staying retired; a cron advancing to **09:00 WIB stored as
  02:00 UTC**; a disabled definition never even scanned; a broken cron recorded, retried,
  then parked at `max_attempts` with the reason readable; and the same tick instant
  enqueued twice queueing once.
- `bash scripts/verify/verify-all.sh`: **VERIFY_ALL_OK**, with both live suites running
  inside the gate (12 + 9 passing) alongside the deploy-unit, API-contract, sync-oracle and
  signal-pipeline checks.
- DST behaviour is asserted at the exact boundaries: `30 2 * * *` on the 2026-03-08
  New York spring-forward resolves to the gap end (07:00 UTC), and `30 1 * * *` on the
  2026-11-01 fall-back takes the first occurrence (05:30 UTC, EDT) rather than the second.

**Environment finding (not a defect).** One scheduler_live run failed with
`pool: "DB connect: db error"`: the instance was at **103 connections against
`max_connections = 100`**, 66 of them held by Hindsight — not by these tests. A retry with
the same code passed 9/9. Worth knowing before blaming the worker when a live DB test
cannot connect.

## Guardrails carried through every phase

- No secret in logs; no committed secret; `.env.example` stays the only env contract.
- Internal bot routes stay loopback-only and public-proxy-free (contract gate).
- No per-message DB query on the hot path — config/rules cached, refreshed on change.

## Next phase — 11, Feeds

The Rust worker's remaining responsibility: external feed polling, deduplication, and
Discord delivery of what survives it. It hangs on the same `Registry` and the same
`scheduled_jobs` definitions this phase delivered — a feed poll is an interval or cron
definition, and its dedupe is the same `jobs` unique key.
