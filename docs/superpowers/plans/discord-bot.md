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
| 10 | Scheduler | ✅ done | `scheduled_jobs` definitions materialized into ordinary `jobs` (one mechanism, not two); once/interval/cron with an EXPLICIT IANA zone and a stated DST policy; 5-field crontabs accepted; restart-safe via a DB `(definition_id, occurrence_at)` ledger plus the `jobs` unique key; self-scheduling tick chain with a deterministic successor key; 61 unit + 12 live (worker) + 9 live (scheduler) tests |
| 11 | Feeds | ✅ done | adapter pipeline + dedup + SSRF guard on generic HTTP |
| 12 | API surface | 🟡 partial | settings + moderation cases + the feeds and scheduler panels live; remaining resource groups pending |
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

## Phase 11 as delivered — Feeds

_Landed as part of `e774d2b` ("feat(data,discord-bot): DEX data platform foundation"): a
concurrent session committed the working tree while this phase was finishing, so the feeds
files described below were swept into that commit's message. The files themselves are
exactly the ones named in this section._

`apps/discord-worker/src/feeds/`: `guard` → `fetch` → `parse` → `store`, with `poll` and
`deliver` as the two job handlers. A poll is an ordinary `scheduled_jobs` definition
(`job_kind = 'feed.poll'`, payload `{"source_id": N}`) and an announcement is an ordinary
job (`feed.deliver`, per-item `dedupe_key`) — there is no second scheduling mechanism:
the interval lives in `feed_sources.poll_interval_secs`, and the existing scheduler
materializes it.

**The SSRF guard is a rule table, not a URL check.** `guard::vet` refuses anything that is
not `http`/`https` (so no `file:`, `gopher:`, `data:`), anything with credentials in the
URL, a percent-encoded host, a non-default port, a **single-label host** (a name like
`rss` can resolve through a search domain into the LAN — `url` normalises `http:///rss`
into exactly that), and any address in `BLOCKED_V4` / `BLOCKED_V6` (loopback, private,
link-local, CGNAT, benchmarking, documentation, multicast, unspecified, plus v6
ULA/link-local/multicast/6to4/NAT64). A v6 address that *carries* a v4 one is judged by
that v4 (`judged()`), which is both the right check and the readable log line:
`[::ffff:127.0.0.1]` is refused as `127.0.0.1`. **Every address a name resolves to must
pass** — one private answer among public ones is a refusal, which is the only shape that
cannot be raced.

**The address that was vetted is the address dialled.** After vetting, the client is built
with `resolve_to_addrs(host, &vetted_addrs)`, so a name whose DNS answer changes between
the check and the connect cannot move the request; `no_proxy()` keeps an ambient
`HTTP_PROXY` from bypassing the pin; redirects are manual, one hop at a time, each hop
re-vetted before the next client is built (a redirect into `169.254.169.254` is refused
like any other). The body is read as a stream with a 2 MiB cap, and `304` is handled
*before* the 3xx branch because it sits inside the 3xx range while not being a redirect.

**Deduplication is a database constraint, not a promise.** `feed_items` carries
`UNIQUE (source_id, item_key)` where `item_key` is the feed's own stable identity
(`id` → link → title+date, hashed with SHA-256 — `DefaultHasher` is not stable across Rust
versions and this value is *persisted*). A second guard suppresses an item whose **link**
was already delivered even when the feed rewrote its id. Polling the same feed again
inserts nothing, so a restart cannot re-announce; items recorded but never queued (a crash
between the insert and the enqueue) are picked up by the next poll, which queues the whole
`pending` backlog. The first poll of a new source **absorbs the existing backlog silently**
(`primed`), so adding a feed does not dump its twenty most recent posts into the channel.

**Feed text cannot ping anyone.** Summaries are stripped of HTML, decoded, whitespace-
collapsed and capped by *characters*; `@everyone`, `@here`, `<@id>` and `<@&id>` in
feed-derived text are broken with a zero-width space, and the delivery payload sets
`allowed_mentions.parse = []` (or `["roles"]` plus the one configured role id) so even a
missed case cannot ping. Delivery posts to Discord REST directly — the worker's own
`reqwest` client and one env var — rather than growing an outbox poller in the bot.
Delivery is **at-least-once** and says so: the window between Discord accepting a message
and the ledger recording it is unavoidable without a Discord-side nonce, and the retry
path checks `delivery_state = 'delivered'` first, so a retry after a successful mark is a
no-op.

**Four real defects were caught by the tests, not by reading code.** `304` taken as a
redirect (`is_redirection()` is true for 3xx) meant a conditional poll could never report
"unchanged"; `truncate_chars` popped twice, so a truncated string was `cap - 1`
characters; `delivery_by_item` selected `last_error` where the column is `delivery_error`;
and `owed_count` counted `pending + failed` while `pending_item_ids` — the query that
actually queues work — counted `pending` only, so the dashboard would have disagreed with
the worker about what was owed.

**Verification (all actually run).**

- `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`: clean.
- `cargo test --release --lib`: **102 passed / 0 failed** — the SSRF rule matrix, the legacy
  IPv4 spellings, the v6 forms including `[::ffff:127.0.0.1]` and 6to4, a name resolving to
  one private address among public ones refused, RSS/Atom/JSON Feed parsing, key stability
  and fallback, HTML + entity cleaning, mention neutralisation, character-count truncation,
  newest-first ordering, and 10 fetch cases against a real loopback HTTP server (validators
  sent and `304` honoured, redirect chains followed, loops stopped, a redirect with no
  `Location`, non-2xx, an oversized body, and the request landing on the **vetted** address
  even when the URL's host does not resolve).
- Live PostgreSQL, `--test-threads=1`: **feeds_live 8 passed**, **jobs_live 12 passed**,
  **scheduler_live 9 passed** — dedupe across polls, the same-link guard, the silent prime,
  the pending backlog and its join, a second mark being harmless, a failure recorded with
  its reason and its FK to a real `jobs` row, validators round-tripping with the failure
  streak, and `ON DELETE CASCADE` taking the ledger with the source.
- `bash scripts/verify/verify-all.sh`: **VERIFY_ALL_OK**. The live suites self-skip inside
  the gate (it is deliberately database-free), but `--all-targets` compiles and lints them,
  so the real-DB evidence above is the separate explicit run.
- The feed tables were applied to the live database as the owning role (`feed_sources`,
  `feed_items`, three indexes; owner `fudcourt`).

**Environment finding (not a defect).** The live suites failed to connect for three
attempts with `pool: "DB connect: db error"`: the instance was at **108 connections against
`max_connections = 100`**, 71 of them idle and held by Hindsight. The same binaries passed
on the fourth attempt (8 + 12 + 9). Raising `max_connections` or shrinking Hindsight's idle
pool is an infrastructure decision, not a worker one.

**IMPLEMENTED, unit-tested, not verifiable here.** The actual Discord REST call needs
`FUDCOURT_BOT_TOKEN` and a real channel: the request body, headers and status handling are
covered by unit tests and the store path around it by live-PG tests, but no message has
been posted to a real channel. Without the token the worker does not register the feeds
kinds at all and says so in the log, so a queued job fails loudly as an unknown kind
instead of sitting silently.

## Phase 12 as delivered (part 1) — the feeds panel

`apps/api/feeds.go`: `GET|POST /api/admin/feeds`, in the house shape (`methodGuard` →
`requireAdmin` → store-nil 503 → GET list / POST replace), with `pgFeedStore` on the same
`pgxpool` as every other panel, attached in `settings.go`. A nil store answers
`503 feeds_unavailable`, never an empty list — an empty list would be a lie.

Two deliberate differences from its siblings:

- **`replace` is keyed on `name` and never writes the worker's columns** (`etag`, `primed`,
  `last_*`, `consecutive_failures`, the ledger): resetting them would re-announce a feed's
  backlog on every save. The delete half is real — a source absent from the list goes, with
  its schedule and, by cascade, its ledger.
- **A source and its schedule are written in ONE transaction.** Creating a feed inserts its
  `scheduled_jobs` `feed.poll` definition (interval cadence, `payload.source_id`,
  `next_run_at=now()` on insert ONLY, so an edit keeps the poll rhythm) in the same
  transaction: a feed can never exist unpolled, and a schedule can never outlive its source.
  The cadence shown to the panel is that definition's `schedule_expr`, joined on
  `payload->>'source_id'` so a rename does not detach it.

Refused with 400 and the field named: a name over 64 chars or a duplicate, a url that is not
http(s) / carries credentials / uses a non-default port / is a single-label host / is a
private-address literal, an unknown adapter (absent means `auto` — the worker sniffs the
format, this column is documentation), a non-snowflake channel or role id, a cadence outside
60..604800 seconds, a message over 512 chars, a filter over 128, more than 50 feeds. These
URL rules are the PANEL's and deliberately narrow: the authority is the worker's guard,
which vets every hop of every poll, and this API never resolves a host, so it cannot become
an internal resolver.

**Verification (all actually run).** `gofmt` clean on the new files, `go build ./...` and
`go vet ./...` clean, `go test ./...` green for the whole api module. `feeds_test.go`
proves: an unconfigured store answers 503 rather than an empty list; a lower tier is refused
on both verbs without reaching the store (401 is this API's house answer for an insufficient
tier); a round trip returns the STORED row, not an echo of the request; nine refused inputs
each come back 400 naming the field; and a body asserting `id`/`primed`/`owed`/
`consecutiveFailures`/`lastError` is stripped before the store sees it.
`scripts/verify/verify-all.sh` → `VERIFY_ALL_OK`, `API_CONTRACT_OK go_paths=22
documented=66`.

**Cross-workstream finding.** `apps/web/src/app/(frontend)/api/admin/feeds/route.ts`
(untracked, a concurrent session's thin proxy) documents a contract that does not exist —
response key `{sources}` instead of `{feeds}`, a `feed_schedules` table instead of
`scheduled_jobs`, cron validation instead of an interval. It passes the gate only because
the gate checks that a proxied path exists in the Go api. The wire contract is the OpenAPI
entry, which matches the schema and the live-PG tests.

## Phase 12 as delivered (part 2) — the scheduler panel

`apps/api/scheduler.go`: `GET /api/admin/scheduler`, in the house shape, over
`scheduled_jobs` — every definition with its schedule, its next occurrence and the health of
its last run (`lastRunAt`, `lastStatus`, `lastError`, `attempts`), ordered with the
operator's own rows first. It is the same durable queue the worker's tick materializes into
`jobs`, so this reports the scheduler rather than being a second one.

**It is READ-ONLY, and that is the point of this part.** `scheduled_jobs` is SHARED: the
feeds panel writes its `feed.poll` definitions inside the same transaction as the source row
(a feed can never exist unpolled), and this panel reports them. So ownership is DERIVED from
`job_kind` — `ownedBy` maps the kind, `annotate` fills `owner` + `readOnly`, and the panel
never has to be told who owns what. The write path is deliberately deferred: it must carry
`ON CONFLICT (guild_id, name) DO UPDATE ... WHERE scheduled_jobs.job_kind <> 'feed.poll'`
so a name collision cannot hijack another panel's row. Without that predicate a wholesale
replace here would delete every feed's poll on a save and the symptom would not be an error:
the feeds panel's `LEFT JOIN` falls back to its default cadence, so the operator sees "my
feed stopped updating hours ago" long after the save that did it.

**Verification (all actually run).** `gofmt` clean, `go build ./...` and `go vet ./...`
clean, `go test ./...` green, and `scheduler_test.go` covers: the ownership table as a pure
unit test — `feed.poll` → `feeds`/read-only, `discord.message` and the empty kind →
`scheduler`/writable, and `feed.polls` (a near-miss) NOT treated as a feed; an unconfigured
store answers 503 rather than an empty list; a lower tier is refused without reaching the
store; and a write is refused with 405 BEFORE the admin gate, so the write path cannot be
reached by accident while it does not exist.
`scripts/verify/verify-all.sh` → `VERIFY_ALL_OK`, `API_CONTRACT_OK go_paths=23
documented=67`. Contract: `/api/admin/scheduler` with `ScheduleDefinition`/`ScheduleConfig`.

**Remaining in this phase.** The scheduler panel's write path (with the ownership predicate
above), the rest of the resource groups, and the `/api/v1` prefix question. Note the planes
this API actually has — `/api/admin/*` (dashboard), `/api/internal/*` (loopback, bot +
worker) and `/api/auth/*` — so a `/api/v1` prefix would be a migration of the existing 23
paths, not a new surface, and is worth deciding before the dashboard depends on it further.
The web proxy for scheduler belongs with the dashboard phase (14 exist today, scheduler not
among them).

## Phase 12 (cont.) — a scheduled message could not actually be delivered

The panel writes definitions; the worker materializes them. The gap between those two
sentences was the whole feature: `scheduled_jobs.job_kind` defaults to `discord.message`, the
tick copies the definition's kind and payload straight onto the materialized job, and NO
handler was registered for that kind — so every scheduled message would have been parked as a
permanent `no handler registered` failure. The operator's reward for saving a scheduled message
would have been a dashboard line saying it was saved, while the messages died one by one. So
the handler landed first: `apps/discord-worker/src/scheduler/message.rs`.

**Payload contract, two fields wide on purpose.** `{"channel_id": "<snowflake>", "content":
"..."}`. Everything else a scheduled message could grow (embeds, files, thread targets) is new
surface in a payload a dashboard writes, and each one is a field an operator can be tricked
into filling. Validation refuses BY NAME: no `channel_id`, a `channel_id` that is not a 17–20
digit snowflake, empty or whitespace `content`, and content past 1900 characters each produce
a PERMANENT failure that says which one — a payload that does not name a channel will not start
naming one on the third attempt, so retrying it only delays the operator finding out. Unknown
fields are ignored rather than refused, so the dashboard can write one before the worker learns
to read it.

**A scheduled message can never ping.** The body goes out with
`allowed_mentions: {"parse": []}`, so a stored `@everyone` renders as text. That is a property
of the SENDER, not of the text: stored content outlives whoever wrote it, and a message that
pings the server at 03:00 is a moderation incident, not a typo.

**One poster, not two.** The feeds delivery already knew the shape of Discord's answer — 429
and 5xx mean "later", every other 4xx means the request itself is wrong so a retry burns
attempts until the job is parked — and a second copy of that rule is how one of the two ends up
wrong. `apps/discord-worker/src/discord.rs` now owns it: the endpoint, the `Bot` header, the 20s
budget, the bounded error text and the classification. `feeds::deliver` posts through it and
re-exports `DeliveryError`/`API_BASE`, so the feeds surface reads exactly as it did. The base
URL stays PINNED rather than configurable: there is no deployment in which pointing the bot
token at another host is correct, and a redirectable base is a way to leak it.

**Registered where the token is.** `main.rs` registers the kind in the same match arm as the
feeds kinds, so a worker without a token leaves it UNREGISTERED and a queued message fails
loudly as an unknown kind instead of quietly never sending. The handler also refuses a job whose
guild is not the configured one, so a foreign job cannot become a post here.

**Verification (all actually run).** `cargo fmt --check` clean; `cargo clippy --all-targets
--all-features -- -D warnings` clean; `cargo test --lib` → **119 passed** (102 → 119: +6 in
`discord.rs`, +11 in `scheduler/message.rs`) covering the classification table, the
`Bot`-header/path/body actually on the wire against a loopback stub, a 403 carrying Discord's
own text, a 429 retryable, an unreachable host retryable, the mention policy, every malformed
payload naming its fault, and the guild guard; the release binary builds. The three live suites
stayed green against `fudcourt_test` (feeds 8, jobs 12, scheduler 9 = **29/29** with
`--test-threads=1`) — that is the part that proves the poster extraction did not change
delivery behaviour.

**Committed as `3795759`** (`feat(discord-worker): deliver feed items through the Discord
client`). The message describes the feeds half; the commit is the six files of this slice
verbatim — `src/discord.rs`, `src/scheduler/message.rs` and the four edits that wire them.

**Also `f1c9d7f`.** `KINDS` in `main.rs` read as "every kind this build implements" while
listing the two phase-9 smoke kinds; the registry adds six more, conditionally. Anyone who
"fixed" that list would register a real kind against the no-op handler and the job would report
success while doing nothing. Renamed `NOOP_KINDS`, trap written down.

**Remaining.** (1) The scheduler panel's write path — requirement unchanged: `ON CONFLICT
(guild_id, name) DO UPDATE ... WHERE scheduled_jobs.job_kind <> 'feed.poll'`, and the write must
409 when that predicate swallows a name the feeds panel owns, rather than reporting a save that
did not happen. Now that the kind has a handler, a saved definition is a message that can
actually be delivered. (2) The `/api/v1` prefix question over the existing 23 paths. (3) The
"web proxy for scheduler" note above is STALE: the proxy exists (`/api/admin/scheduler` is one
of the `web_proxies=15` the gate prints), so that first sliver of phase 13 shipped with the
panel.

**Plus `734ef4d` — the gate was not hermetic, and that turned it red.** `verify-all.sh` is
OFFLINE by contract and says so in its own header, but its worker step inherited
`FUDCOURT_TEST_PG_URL` from the caller's shell, so following the repo's own instructions
(`set -a; . ./.env; set +a`) turned that step into a PARALLEL run of the three live suites. They
share global state — `store::due` scans EVERY definition, and the feeds suite shares one feed
space — so the gate went red with five db tests failed in 1.08s and a log that named no code
defect. Two fixes: the step strips the variable itself (`env -u`, with a note printed when the
caller had it set), and the db suites got their own entry point,
`scripts/verify/verify-live.sh`, which sets `--test-threads=1` (the flag they require) and
REFUSES a DSN that does not name a `_test` database: `/fudcourt` is one segment away from
`/fudcourt_test` and the price of getting it wrong is the live rows. Three guards verified by
running them — unset → exit 2, production DSN → exit 2, non-`_test` name → exit 2 — then the
real run → **`LIVE_SUITES_OK`, 29/29**. Gate re-run with the variable deliberately still
exported: **`VERIFY_ALL_OK`**, worker lib 119, the live suites at 0.00s (skipped),
`go_paths=23 documented=67 web_proxies=15`.

**And a trap written down at the step itself.** A SKIPPED live suite still reports "8 passed" —
an early return counts as a pass — and its `skipping:` notice is captured by libtest and printed
only for a FAILING test. So the only thing in a gate log that separates a real run from a skip
is the DURATION: 0.00s is the skip, while a real feeds run takes ~1s and the three suites take
seconds together. Reading "8 passed" as coverage is exactly how the db suites spent a day
believed-green.
