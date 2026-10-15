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

## Phase 13 (cont.) — the scheduler panel writes, and the WORKER anchors the cron

**Two commits, and the split is the point: the panel was not allowed to compute a cron's first
occurrence.**

**`3c6bc58` — `fix(discord-worker): anchor an unanchored definition instead of never running
it`.** `store::due` required `next_run_at IS NOT NULL`, so a definition written without an anchor
was enabled, visible in the dashboard, and PERMANENTLY DEAD — nothing would ever set its first
occurrence. That is exactly the shape the dashboard has to write: the Go api owns neither a cron
parser nor a timezone database, and computing the first occurrence there would mean a second
implementation of "next occurrence" that can disagree with the one that fires. So the tick owns
it — a NULL `next_run_at` is now DUE, and the tick anchors it with the same parser it will use
forever after. The outcome is a separate `Materialized::Anchored`, counted apart from
`materialized`, because an ANCHOR IS NOT A RUN: `store::anchor` sets the anchor, clears a stale
error and resets the failure counter, and deliberately does NOT touch `last_run_at` (`advance`
does), so the panel cannot claim a run that never happened. An unanchored `once` whose instant
has already passed is skipped WITH A REASON rather than fired late — the same no-backfill policy
the tick applies to a due definition — and it retries and parks like any other broken schedule.
scheduler_live 9 → 11: anchor-then-fire in two ticks, and the past-`once` skip.

**`c08e0da` — `feat(api,scheduler): the write path, guarded by job_kind ownership`.** `POST
/api/admin/scheduler` replaces this panel's rows in one transaction, keyed on `name`. The
ownership rule IS the write path: the upsert carries `WHERE scheduled_jobs.job_kind <>
'feed.poll'` and the delete carries `AND job_kind <> 'feed.poll'`. A wholesale replace without
them would delete the feeds' polls, and the symptom would not be an error — the feeds panel's
LEFT JOIN falls back to its default cadence — so the operator would see "my feed stopped
updating hours ago" long after the save that did it. When the predicate swallows a row nothing is
returned, and `pgx.ErrNoRows` becomes a **409** naming the definition and its owner: "saved" and
"did not save" must never look the same.

**Anchoring, restated for the write path.** `once` is its own instant and `interval` is
arithmetic, so the panel anchors both — `once` AT the instant, `interval` one interval AHEAD
(deliberately the opposite of the feeds path, which writes `now()`: a feed wants its first poll
immediately, an operator writing "every 24h" does not expect a message the second they save).
`cron` is stored NULL and the tick anchors it. Editing the SCHEDULE re-anchors a definition (the
stored occurrence was computed for the old expression); editing only the payload or `enabled`
leaves the next occurrence alone.

**What the panel refuses, and what it deliberately does not decide.** `jobKind` is an allow-list
— `discord.message`, plus `health.ping`, which the worker registers without any configuration
and which is therefore how you prove schedule → tick → claim → run → history before Discord is
even reachable — with an explicit refusal of `feed.poll` that names the feeds panel. Names are
stored trimmed (so `"news "` and `"news"` cannot become two rows under the UNIQUE constraint),
`interval` is bounded 60..604800 (the feeds' own bounds: both answer "how often may this bot
act"), and a `discord.message` payload is checked for a snowflake channel and 1..1900 characters.
Cron is checked for SHAPE only — 5/6/7 fields of `[0-9*,-/]` — because its MEANING is the
worker's `cron` crate and this server does not grow a parser to have an opinion; an expression
that passes here and is refused there is recorded against the definition by the tick that
evaluates it, where the panel shows it. The shape check is strict and the refusal is named
(`"must be numbers"` for `JAN`) rather than accepted into a definition that could not be anchored
here. Go: the scheduler's test functions go 5 → 11 — 29 cases once the validation table's subtests
are counted, against 146 passing cases in the package — and the write path's SQL gets a live
Postgres round-trip of its own (`scheduler_pg_test.go`, skipped without `FUDCOURT_TEST_PG_URL`),
because a fake cannot check a WHERE clause inside an upsert: it pins that a feed's name is
refused and the feed's row keeps its anchor, that a refusal on the SECOND definition writes
nothing (the rollback, not an empty transaction), and that dropping a definition removes ours
while sparing the feed's poll.

**`eb4a649` — the contract and the proxy.** `POST` on `/api/admin/scheduler` in
`contracts/openapi/fudcourt.yaml` (the refusals, the 409, and why a cron is unanchored), and
`POST` plus a body pass-through on the web proxy. The proxy stays rule-free on purpose: a proxy
that decided which names were writable would be a second place the ownership rule could drift
from the SQL that enforces it.

**Remaining, revised.** Item (1) above is DONE. Item (3) — the "proxy is GET-only" note — is
resolved by `eb4a649`. What is left in phase 13 is the dashboard UI for this panel (the editor
that sends this body) and the other resource groups.

## Phase 13 (cont.) — the panel that writes it

**The scheduler proxy shipped with the api slice and had no consumer.** Precisely: the other admin
panels (members, settings, cases) read their proxies through `features/admin/client.ts` — a `.ts`
module, which is why grepping for `api/admin` under `*.tsx` finds nothing and reads like the whole
admin surface is unwired. The scheduler was nevertheless the only panel you could not touch from
the dashboard: the Go side could write definitions, the worker could run them, and the operator had
no UI. This is the UI.

**`c750420` — the client.** `ScheduleDefinition` mirrors the Go struct on the wire (camelCase,
snowflakes as strings, the worker's columns optional because `omitempty` means absent), plus
`writableDefinitions`: the write body's rule in ONE place — only this panel's rows (`readOnly` is
the server saying a feed owns it, and sending one back is a guaranteed 409) and only an operator's
fields. Posting a worker column back would describe an edit this panel cannot make, so it is
dropped here rather than left for the server to ignore: a body containing a field the server
ignores is a lie about what the save does. Names and expressions are trimmed because the stored
name is trimmed, so "news " and "news" must not collide on the next save.

**`15d490b` — the panel, and the error that made it useful.** A REPLACE editor, because the endpoint
is a replace: one transaction keyed on name, so the panel holds drafts and Save is the only writer.
The feeds' poll definitions are SHOWN read-only with the reason — an operator who cannot see them
cannot understand why a feed is polling — and are never sent. A kind whose payload the panel does
not edit keeps the payload it read, so a save cannot delete what it cannot display.

The rules the panel does NOT own are the point: snowflake shape, interval bounds, cron fields,
timezone validity and the ownership predicate stay the server's, and the panel shows its sentence
instead of keeping a second copy that could drift from the one that stores the row. The cron case
is the sharpest — the shape is checked server-side and the MEANING is the worker's parser, so a
third opinion in the browser would be a third thing to keep in sync.

That sentence needed the body, and `getJSON` was throwing it away: every panel showed
`<url> HTTP 409` where the api had sent "the name "news" is owned by the feeds panel". `HttpError`
now carries `status` and `detail` (from the api's `detail`, the proxy's `error`, or the raw body if
it is not JSON at all), the old prefix is kept so `/HTTP 500/` matchers still match, and the panel
turns a 409 into "rename it, or manage it in the panel that owns it" — a 409 is not a bug and not a
typo in a field, and that difference decides whether the operator renames a definition or files a
report.

**`7d88e12` — what the tests pin, and the trap one of them found.** The helpers are covered
(draft↔wire round-trip, the read-only filter, payload pass-through, anchoring hints, the report
line), and the WIRE is covered by running the api client against a stubbed fetch — the only place
"the panel never sends a read-only row" and "a refusal never looks like a save" are provable.
Asserted on the body after `JSON.stringify`, and across all three refusal shapes (api `{detail}`,
proxy `{error}`, an HTML body from something that is not the api at all). The first draft of the
fixture found a real one: `1234567890123456789` held as a JS number is `1234567890123456800`, so a
numeric `channel_id` round-trips to a channel that does not exist. That is the spec's "never use JS
numeric types for snowflakes" demonstrated on the panel's own payload field. The panel stringifies
rather than coercing — it shows what was stored and lets the server refuse what it cannot accept —
and the test now says so out loud.

**Remaining, revised (again).** The scheduler panel is DONE, DB → worker → api → a control an
operator can use. Eight of the twelve admin proxies still have no consumer:
`autoroles`, `custom-commands`, `feeds`, `logs/audit`, `logs/destinations`, `role-assignments`,
`role-panels`, `welcome`. (Members, settings, moderation cases and now scheduler are wired.) Feeds
is the next one worth building, and it is the pair of this panel: its definitions are the
`readOnly` rows shown here, and its own panel owns them.

**The panel needs one deployment step before it works on the homeserver, and it is NOT a code gap.**
`apps/api/bin/fudcourt-api` is from `2026-10-14 04:09` while `apps/api/scheduler.go` is from
`21:29` — the running `fudcourt-api.service` therefore serves a binary that predates the route, and
`GET /api/admin/scheduler` answers the api's own `404 {"error":{"code":"NOT_FOUND"}}` (not the panel's
404, and not a 401): a route that exists in the source and 404s from the process is a stale binary, not
a routing bug. Rebuild the binary and restart the unit
(`systemctl --user restart fudcourt-api`), and rebuild the web app for the panel page itself
(`fudcourt-web.service`). Until then the panel reads a 404 through its proxy — which it reports as a
read failure, loudly, which is the behaviour it was built for.

## Phase 13 (cont.) — the feeds panel, and the pair it forms with the scheduler

**`39878f7` — the second panel, built second on purpose.** The `feed.poll` definitions the scheduler
panel shows read-only as "owned by the feeds panel" are written HERE, by the panel that owns the
source they belong to. Same two-table shape as the scheduler (a source and its schedule) read from
the other end, so the scheduler panel's read-only row now has a home instead of a dead end.

A REPLACE editor for the same reason: the endpoint is one transaction that makes the source set
match the list — upsert by name, delete the rest — and it writes each source's poll definition in
that same transaction, so a feed can never exist unpolled. `next_run_at` is set only on insert, so
editing a cadence does not reset the feed's rhythm or stampede every feed at once.

**`writableFeeds` is a projection, not a filter, and the difference is the whole ownership story.**
There is no `readOnly` row in this panel: it owns the entire feed set, where the scheduler's
read-only rows are `feed.poll` DEFINITIONS (a different table) rather than sources. What the body
does drop is the poller's report — `primed`, `owed`, `lastStatus`, `lastError`,
`consecutiveFailures` — plus the row `id`, because the store keys the list on `name`: an id in the
body would name a row this save does not address. The two write rules now sit next to each other in
one file with the same reasoning, which is how they stay the same rule.

**The url guard is where the panel's restraint actually matters.** It has two owners already: the
api's `validateFeedSource` shapes the refusal an operator sees at the point of entry, and the
worker's `feeds::guard` vets EVERY hop of EVERY poll, including a name that resolves into private
space — and the api deliberately resolves nothing, so it never becomes an internal-network
resolver. A third copy in the browser could pass what the worker then blocks, so the panel offers
the shape as a placeholder and shows the server's sentence. Same for the name bound and the cadence
bounds.

**Two readings the panel owes an operator**, both pure functions in `feeds-draft.ts`:
`intervalLabel` (900 is a number nobody should have to divide — it reads "every 15 minutes") and
`healthLine`, including the line that reads like a bug when it is not: until the first successful
poll has absorbed the pre-existing backlog, a WORKING feed announces nothing. Feed health is not
readable anywhere else in the system, so the panel shows it and never sends it back.

**One limitation inherited from the wire, documented rather than papered over**: a source whose
`feed.poll` row carries a CRON expression instead of an interval — reachable only by hand-editing
the database, since both panels write intervals — is reported by the api as 900 seconds. Its SQL
guards the cast so one hand-made row cannot break the panel's load, and that guard is right; the
cost is that the panel cannot tell that 900 from a real one, so a save would make it real. The
scheduler panel shows the truth about that definition (it is owned by this panel and read-only
there), which is the only place the discrepant row is visible.

**`3ba8106` — the refusal mechanism, shared at the second call site.** `describeSaveFailure` was
born in the scheduler's draft module carrying the scheduler's 409 wording; this endpoint has no 409
at all (400/500/503), so a copy would have put a dead branch in one panel and a second place to fix
the other. It moved to `save-error.ts` and now takes the conflict wording as an argument: the
mechanism is shared, the words stay with the panel that knows what its refusals mean. The evidence
that no sentence changed is that the scheduler's tests needed only their second argument added —
they pass with every assertion untouched, including the wire-level 409 test.

**`9335c4b` — twelve more tests.** The draft round-trip; the body's exact key set with the poller's
columns named one by one (so a future field cannot silently join it); the per-field trimming rule
(name and url trimmed because the api trims them, the message template verbatim because whitespace
in it may be deliberate); the nullable optionals mapping to the wire's own `null`; the cadence
sentence; the health line; the client over a stubbed fetch (GET cache-busting, POST sending the
whole set, the api's `detail` arriving as a typed `HttpError`). Two are drift guards: the adapter
list must equal the contract's `enum: [auto, rss, atom, json]`, and this endpoint passing no
conflict hint must not turn a stray 409 into "rename it".

**Remaining.** Five of the twelve admin proxies now have a consumer (members, settings, moderation
cases, scheduler, feeds); seven do not: `autoroles`, `custom-commands`, `logs/audit`,
`logs/destinations`, `role-assignments`, `role-panels`, `welcome`. Verification this slice:
`tsc --noEmit` clean, 511 web tests pass / 0 fail, and the full gate `VERIFY_ALL_OK` — with the same
deployment caveat as the scheduler panel: the dashboard's api binary is stale until it is rebuilt
and `fudcourt-api.service` restarted.

## Phase 13 (cont.) — the welcome panel, a preview, and two api defects it found

**`d7935cc` — the api, fixed first, because the panel would have mirrored the bug.** Reading the
welcome write path to build its editor turned up two real defects:

1. `len()` counts BYTES, and the three welcome messages were checked with it. The contract declares
   `maxLength: 2000` — code points, per JSON Schema — and Discord counts characters, so a
   2000-character message of emoji (8000 bytes) was refused at a quarter of the limit the operator
   was reading off the form. Now `utf8.RuneCountInString`; boundedness is unchanged because
   `MaxBytesReader` already caps the body at 32 KiB.
2. The embed check asked only whether the jsonb was an object. But `renderEmbed`
   (`apps/discord-bot/src/community/templates.ts`) calls `renderTemplate` on every string field, and
   `renderTemplate` calls `.replace` on its argument — so `{"title":5}` saved cleanly and then made
   the welcome path THROW at a member's join, the worst possible place to discover a typo. §12/§31's
   "validate JSON structures before storing them" was the requirement that had been read as "valid
   JSON"; `validateEmbed` now constrains the fields the renderer touches to the types it assumes
   (strings-or-null, a 24-bit integer for `color`, objects for footer/author/thumbnail/image, at most
   25 fields with string name/value), and deliberately still accepts unknown keys and `null`, because
   the renderer ignores the former and its falsy guard turns the latter into an empty string.

**`fd15021` — the panel.** The first panel whose subject is a TEMPLATE, which is what makes §16's
"preview before saving" load-bearing rather than decorative: a schedule and a feed mean something
when you read the row, and `"Welcome {user}, you are member #{member_count}"` means nothing until a
member is substituted into it.

`welcome-template.ts` MIRRORS the bot's renderer — `templates.ts` plus `buildPayload` in
`welcome.ts` — because the engine lives in the bot's bundle and the dashboard ships its own. A
mirror is a real drift risk, so it is pinned instead of hoped away: the tests replay the BOT'S OWN
fixtures (same member, same inputs, same strings), and two guards read the other files and fail if
either moves (the token grammar and the six variable names in `templates.ts`; the refusal sentences,
the `validateEmbed` function and the `utf8.RuneCountInString` count in `community_handlers.go`).

What the preview says that the form cannot:

- a blank message plus an embed that rendered to nothing posts NOTHING — the bot skips an empty
  payload, so "I set a welcome and nothing happened" now has a visible cause;
- a join DM carries the SAME embed as the channel post (the bot passes one embed to both sends), and
  a leave has no DM path at all (a member who left cannot be reached);
- a placeholder with no value stays VERBATIM: `{oops}` stays `{oops}`. That is the bot's own choice,
  made so a preview shows the typo instead of shipping a silent hole.

The sample member is editable — `{display_name}` behaves differently for a long nickname, and a
template that only looks right for a two-letter name is one that will ship broken. `{created_at}` is
derived from the sample's id, which is how the bot does it with no API call: a snowflake carries its
creation time in its high bits.

Two ownership rules, kept deliberately narrow: the panel validates NOTHING the api validates (the
one local refusal is JSON syntax, which cannot be sent at all), and Save ADOPTS the config the server
returns, because the api normalises `joinEnabled` off when the channel is blank. That normalisation
is a mutation the operator did not perform — `adoptedNote` says so in one sentence rather than
leaving a checkbox that flips itself off on the next reload.

**`0226da3` — eighteen tests.** The parity group, the trailer cases (an embed keeps only the fields
the bot renders: `url` and `timestamp` are dropped there, so the preview drops them), the message
that is only whitespace, the embed that rendered to nothing, the DM sharing the post's embed object,
and a hand-edited row with a number where a string belongs. Two guards read OTHER files: the bot's
grammar and variable set, and the api's refusals — including the rune count, so a regression to
`len(` fails in the dashboard's suite instead of shipping a counter that lies about emoji.

**Two traps worth remembering, both hit here.** The web app's TypeScript target predates BigInt
LITERALS, so the mirror writes `BigInt(22)` where the bot writes `22n` (raising the app's target for
a preview would change how the whole dashboard compiles). And the design-token gate is HARD on
`fontWeight: 600`, `fontFamily: 'monospace'` and `lineHeight: 1.5` — they must be
`fontWeight.semibold`, `fontFamily.mono`, `lineHeight.normal`; the repo's own fixer rewrites them if
you forget, and the gate's remaining "soft" report is informational.

**Verification.** `tsc --noEmit` clean; 529 web tests pass / 0 fail (511 → 529); `go vet` +
the api package green (11 welcome tests); the full gate `VERIFY_ALL_OK`; and `bun run build`
`EXIT=0` with `/admin` and `/api/admin/welcome` in the route table. Deployment caveat unchanged: the
api binary is stale until rebuilt and `fudcourt-api.service` restarted — and this slice's api change
is one the bot does not need to re-read, since the config reaches it over the same loopback hop.

**Remaining.** Six of the twelve admin proxies now have a consumer (members, settings, moderation
cases, scheduler, feeds, welcome); six do not: `autoroles`, `custom-commands`, `logs/audit`,
`logs/destinations`, `role-assignments`, `role-panels`.

## Phase 13 (cont.) — the autorole panel, and what a replace does to an id

**`7fa4ac5` + `fb0f0c3` — the panel.** The fourth one, and the second whose subject is a DECISION
rather than a value. What these rules describe is not readable off the rows: priority decides the
order, a wait of zero collapses into "immediate", `appliesTo` drops whole rules depending on whether
the joiner is a bot, and one of the three kinds never fires at all. So the panel states the buckets
the bot will compute — `autorole-select.ts` mirrors `selectAutoroles`, the tests replay the bot's own
fixtures, and a guard reads the bot's source for the comparator and the `<= 0` zero-wait rule.

Three wire truths the panel is built around, all found by reading the code rather than the schema:

1. **The row id is output-only, and the array order is not.** `replaceAutoroles`
   (`apps/api/community.go`) deletes every rule for the guild and re-inserts them in the order it
   received, letting the identity column hand out new ids. The panel keeps the loaded id for exactly
   one purpose — the bot's tiebreak for equal priorities is `Number(a.id) - Number(b.id)` — and never
   sends it, so the write shape is `Omit<AutoroleRule,'id'>` (the contract already calls the field
   read-only). The consequence is the interesting part: **the array order IS the tiebreak**, because
   the row ids are assigned in that order, which is why the rules have ↑ ↓ buttons and why
   `ORDER_NOTE` says what they are for. It also makes the preview agree with the bot before AND after
   a save: with no id yet `Number("")` is 0, the comparator ties, and a stable sort preserves the
   operator's arrangement — the same order the api then persists.
2. `after_verification` never fires. `AutoroleService.onVerified` is implemented and tested and called
   by NOTHING, so an operator picking that kind would wait for a role that is never coming, with
   nothing anywhere to say why. `DEFERRED_NOTE` says it — and a test scans the whole bot and FAILS if
   a caller ever appears, because the note turning into a lie has to be louder than a stale comment.
3. The api is stricter than its own table on duplicates: it refuses the same role twice whatever the
   kind (`duplicateRoleId`), while the unique index is per `(guild_id, role_id, kind)`. The panel
   surfaces that as a note in the api's words before the save, and still sends the request — one
   authority for what a valid rule is beats two.

**`1e03129` — fourteen tests.** The bot's fixtures replayed (including the two that surprise people:
a zero or NEGATIVE wait is immediate, and `appliesTo` filters the joiner rather than the rule set),
the ordering with the numeric id comparison asserted alongside `'10' < '2'` so the lexicographic bug
has a named opponent, the tie-before-the-first-save case, `delayLabel` across every unit boundary,
and the write shape pinned by key set with `'id' in body[0] === false`.

**Two of my own mistakes, caught by the suite rather than by review.** `new URL(file, dir)` with a
base that has no trailing slash silently drops the last path segment — the verification-flow scan
tried to read `apps/discord-bot/globals.d.ts` instead of `src/globals.d.ts` and failed with ENOENT.
And `compareAutoroles(id 2, id 10)` is `-8`, not `+8`: I asserted the magnitude and forgot the sign.

**Verification.** `tsc --noEmit` clean; **543 web tests pass / 0 fail** (529 → 543); the design-token
checker `DESIGN_TOKENS_OK`; the full gate `VERIFY_ALL_OK`; `bun run build` `EXIT=0` with `/admin` in
the route table. No api or bot change was needed this slice — the panel reads what they already
expose.

**A note for whoever reads the history.** `7fa4ac5` ("the autoroles panel's draft and role picker")
contains MY in-progress files and a message I did not write: a repo-side auto-committer (authored
under the repository identity) swept four of them while the slice was mid-flight, and `.omp/` appears
as an untracked directory of the same origin. The content is intact — `git status` is clean for those
paths and the tests above run against exactly what is committed — but the slice is therefore split
across three commits instead of two, and one of the messages describes work it did not perform.

**Remaining.** Five admin proxies still have no consumer: `custom-commands`, `logs/audit`,
`logs/destinations`, `role-assignments`, `role-panels`.

## Phase 13 (cont.) — the role-assignment log, and the bug the recon found first

**`b85ab24` — reaction-role assignments were never recorded.** Reading the api's
`validateAssignment` to learn the wire is what surfaced it: the bot sends `source: "panel-reaction"`
(`src/community/panels.ts`) and the api accepted only `autorole | panel | verification | manual`, so
every reaction grant and revoke was refused with a 400 and never written to `role_assignments` — the
one table that answers "why didn't this member get the role?". Two things made it silent, and both
are the interesting part:

- `recordAssignment` never inspected the response. It awaited the fetch and its `catch` covered
  network errors only, so a 400 was indistinguishable from a 201 **by construction**. Best-effort is
  the right policy for a record written after the grant already happened (a grant must not fail
  because the audit trail did) but best-effort must not mean invisible: it now reads the response,
  logs a refusal with the api's own unwrapped sentence, and the wiring passes the client's logger.
- The accepted sources were an inline `switch` with a hand-written sentence, so set and text could
  disagree with nothing to catch it. Now one `assignmentSources` slice, a set built from it, and a
  sentence GENERATED from it — with a test asserting the sentence names every accepted source (the
  half that would drift the other way, since adding a source and forgetting the text leaves an
  operator reading an incomplete list).

The guard that would have caught it is a contract with the two languages on opposite ends:
`apps/api/community_sources_test.go` scans the bot's source for the source argument of every
`roles.grant|revoke|apply` call and fails when the api would refuse one. It self-checks first — if the
extraction stops matching, it FAILS rather than passing on an empty set. The same file pins the other
vocabulary the bot writes into (`caseSources` must keep accepting `automod`), which is the identical
bug waiting to happen. `recordAssignment` had no tests at all; it has six now.

**`a31c72b` — the panel.** The sixth and the first read-only one (the api exposes a GET and nothing
else: this table is evidence the bot writes as it acts, not configuration). It makes the failures
findable and answers the one question a flat list cannot — whether the **same role keeps failing**,
because the bot refuses an impossible assignment on every attempt rather than giving up, so a role
above its own position fails once per join, forever. Failure groups come first, newest reason per
role with a count, next to what the fix actually is (the role order, or the rule).

Faithful-reading details: the window is the newest `limit` of 25/50/100/200 (the api caps at 200 and
silently falls back to 50 for anything else, so the selector only offers what the api honours); a
missing `error` (omitempty) renders as an em dash, not an empty string; an unparseable timestamp is
shown VERBATIM rather than as "Invalid Date". Row ids appear here **because they are stable** — this
table is append-only, the exact opposite of an autorole rule's id — and the note says so.

**Verification.** `tsc --noEmit` clean in web and bot; **552 web tests pass / 0 fail** (543 → 552);
**6 bot tests pass** for the new `community-wiring` file; the api's `go vet` clean, `gofmt -l` clean on
the touched files, **8/8 targeted Go tests pass** and the full `go test ./...` green; `DESIGN_TOKENS_OK`;
the full gate **`VERIFY_ALL_OK`**; `bun run build` `EXIT=0`.

**Two of my own mistakes, again caught by the suite.** `isSnowflake` checks LENGTH, not just
"digits only" — a Go test written with `UserID: "1"` fails with "must be a Discord id (digits only)",
so fixtures need realistic 18-digit snowflakes. And the design-token checker rejects `lineHeight: 1.5`
and a raw font stack (`fontFamily: 'ui-monospace, …'`) with `file:line`; the tokens are
`lineHeight.normal` and `fontFamily.mono`.

**Remaining.** Three admin proxies still have no consumer: `custom-commands`, `logs/destinations`,
`role-panels`.

## Phase 13 (cont.) — the UTC timestamp defect, and the audit log

**`31eaa17` — the panel was lying about the time, and the test agreed with it.** Reading
`db/schema/pg-schema.sql` for the audit panel is what exposed it: every `created_at` in this database
is `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')` — UTC **with no zone marker**.
`new Date('2026-10-14 23:10:00')` is implementation-defined and every engine reads it as LOCAL, so the
role-assignment panel's clock was seven hours off for a reader in WIB (and a day off across midnight).
The homeserver's own clock is UTC, which is exactly why nothing looked wrong: the digits matched there.
Proved in three zones before touching anything — `TZ=Asia/Jakarta` put the naive reading at
23:10 against a true 06:10 the next morning, same string.

The old test passed because its fixture (`2026-10-14T23:10:00Z`) was an **invented** RFC3339 string the
api never sends: the fixture told a different story than the wire. `wire-time.ts` is now the one place
that reads both the api's format (explicitly as UTC) and a zoned value (as written), renders through
`toISOString` so the output cannot move with the reader's clock, and says `UTC` out loud. The test with
teeth runs the real module in a **child process under four zones**, one of them east of UTC — it passes
on a UTC box either way, which is the entire point. The cases panel was printing the same unlabelled
UTC string raw and now goes through the same renderer.

**`7c402ed` — the audit log panel** (committed by the sibling session, see below). The second read-only
panel, and the interesting column is the diff: `before`/`after` are jsonb snapshots, either side may be
absent (a create has no before, a delete no after), and a configuration replacement (join roles, role
panels, custom commands) arrives as **two whole arrays** — one change to read, not a synthetic
element-wise diff, because what an operator needs is that the set was replaced and with what.

Two things the panel refuses to imply, both read out of the api: that the trail is complete
(`recordAudit` runs after the mutation stands and only logs a failure, so a gap is a lost write as
easily as a change that never happened), and that the resource-type filter validates anything — unlike
the audit **source**, which is a closed validated set (`dashboard|discord|automod|system`),
`resource_type` is free-form (≤64 chars), so the labels are a convenience, an unknown type renders as
itself, and an unknown filter name returns an empty list that looks like silence. The filter options are
built from types that actually appeared, accumulated across loads (a filtered page only contains its own
type). Window selector offers the api's real 25 default / 100 ceiling; the test reads both out of
`logging.go`, along with the source vocabulary the label table must cover exactly.

**Coordination hazard hit for real.** My `git commit` reported "nothing to commit" while the log showed
a new commit — another profile in this repo had run a broad `git add` and swept my uncommitted files
into its own commit. Verified rather than assumed: `git show --stat 7c402ed` (exactly my five files),
`git status` clean, `git diff HEAD` empty, and the line counts matching what I wrote — so the content
was byte-identical and nothing was lost. The lesson is to commit promptly and to verify with
`git show --stat`/`git diff HEAD` when a commit seems to vanish. Never `git add -A` in this repo.

**Verification.** `tsc --noEmit` clean; **574 web tests pass / 0 fail** (552 → 574: 6 wire-time + 16
audit); `DESIGN_TOKENS_OK (files=490)`; gate **`VERIFY_ALL_OK`**; `bun run build` `EXIT=0`.

## Phase 13 (cont.) — custom commands, and the guard that keeps a mirror honest

**`60a7b40` / `b053489` — the custom-commands editor** (MVP §19, the one requirement in the plan phrased
negatively: no code execution). The panel's real job is to make the property visible where an operator
will read it. It is a property of the runtime, not a rule the dashboard enforces: the bot renders a
response through the same pure template engine as welcome messages, and there is no JavaScript/Lua/
shell/SQL path, no expression evaluation, no function call. Nothing between braces is executed.

The grammar is what makes that provable rather than reassuring: the engine's token is `{name}` with a
name of `[a-z_]+`, so `{Evil}`, `{a-b}` and a stray `{` are not tokens at all, and an unknown token is
left exactly as written. The panel copies that grammar verbatim (guarded, below) and flags the tokens
the bot will send as typed — the TYPOS — rather than implying a threat where there is none. A nested
`{a{b}}` still yields the inner token `b` because the regex is not brace-aware; the panel sees what the
engine sees, corner included, and the test says so.

The editor posts the WHOLE set (that is what the api replaces) and adopts the answer, because the api
normalises: names lowercased, aliases trimmed/lowercased/de-duplicated, two commands answering one word
refused. A response carrying an embed is preserved byte-for-byte and rendered read-only — an editor
that cannot read a field must not replace it, and a whole-set replace turns that into a data-loss bug.

**Three guards read the other side of the wire**, so every mirrored fact fails loudly when it drifts:
the variable table against the bot's `memberVars` keys plus the extras its `vars()` spreads; the token
grammar against the engine's own `TOKEN` pattern; the limits and the trigger grammar against the api's
constants and `nameRe`. **Each asserts it extracted something before comparing** — a guard whose anchor
moved must fail, not pass on an empty set.

**Four mistakes of my own, all caught by these tests.** (1) `triggerProblem` rejected a duplicate alias
*within* one command, which the api normalises away rather than refusing — a local pre-check stricter
than the authority it mirrors blocks a save the api accepts. (2) `fromDraft` de-duplicated aliases
before lowercasing, so `RULE` and `rule` both survived. (3) Two extraction guards used a regex to find
a regex literal: `/\{` matches the character `{`, not the two characters `\{` the file contains, so the
match silently failed — extraction is index-of now, with a line-bounded slice because a template
literal on the same line (`<#${m.channel_id}>`) contains a `}` that truncates a naive cut. (4) The
schema guard's relative path was one directory short — an ENOENT, not a silent pass, which is the good
failure mode.

**Verification.** `tsc --noEmit` clean; **585 web tests pass / 0 fail** (574 → 585: +11);
`DESIGN_TOKENS_OK (files=492)`; gate `VERIFY_ALL_OK`; `bun run build` `EXIT=0`.

**Remaining.** One admin proxy still has no consumer: `logs/destinations`.

## Phase 13 (cont.) — the panel poster: the half of §18 that did not exist

**The gap, and why it was structural.** The role-panels editor, the api's validator, the bot's
interaction handler and its exclusivity rules were all in place — and no panel could ever be posted.
`customId()` was called by NOTHING, and the reason was one missing field: `InteractionCallbackData` had
no `components`, so the bot's REST layer could only ever send text. A button/select panel had no way to
reach Discord at all, and a reaction panel needed a human to post the message by hand and paste its id
into the config. §18 was half a feature and it looked finished.

**`/panel id:<id> [channel] [force]`** (bot) + `POST /api/internal/role-panels/posted` (api) close it.
The bot posts the message — the body, the buttons or select menu, and for a reaction panel the reactions
themselves — then reports the message id over the same loopback hop every other bot fact uses. The api
stores it against the panel, and from then on a reaction panel is matchable by the message its reaction
landed on.

**The pieces.** `community/poster.ts` is PURE: it turns a stored panel into `{content, components,
reactions}` and states why a panel cannot be posted (a Discord limit the api does not know) versus what
merely makes it bad (a dead option, an invisible button, a switched-off panel — posted anyway, with the
note). `community/posting.ts` is the service: post, react, replace, record, and report every partial
failure by its consequence. `commands/admin/panel.ts` is the thin command. `Rest.addReaction` is new, and
the component types now live in `framework/types.ts` as the single authority for the wire numbers.

**Four decisions the code makes explicitly.** The previous message is deleted only AFTER the new one is
live, so a refused post never leaves the channel with no panel. A reaction that will not land is reported
as "those options cannot be picked" rather than swallowed — the panel is live and not as configured. A
record the api refuses is reported by what was lost, which differs by kind: a reaction panel cannot be
matched at all, a button panel is simply missing from the dashboard. And an unknown stored button style
falls back to `secondary` rather than posting a style Discord would reject — the api does not validate
`style`, so the DB CHECK is the only authority.

**A contract gate caught the api change, exactly as designed.** `check-api-contract.py` failed with
"apps/api registers paths the contract does not document" — the new route had to be documented in
`contracts/openapi/fudcourt.yaml`, with its two schemas. Reading the neighbour entry surfaced a real drift
at the same time: the contract's `RoleAssignmentInput.source` enum listed `[autorole, panel, verification,
manual]` while the api's closed set has accepted `panel-reaction` since the reaction-role fix — a client
reading the contract could not produce a value the api takes. Both fixed.

**Verification.** Bot: `tsc --noEmit` clean, **321 tests pass / 0 fail** (304 → 321: +17); api: `go test`
green with **5 new handler tests** (store update, trim parity with the admin plane, snowflake refusals,
the 404 for a deleted panel, loopback-only, store-less 503), `gofmt` clean on every file touched; web:
`tsc` clean, **600 pass / 0 fail**; contract gates: `API_CONTRACT_OK go_paths=24 documented=68`,
`CONTRACTS_OK`, `SCHEMAS_OK`, `DOCS_OK`, `MDTABLES_OK`; full gate `VERIFY_ALL_OK`.

**Remaining.** One admin proxy still has no consumer: `logs/destinations`.

**`e677bfe` / `ee07b0a` — the role-panels editor** (MVP §18). The wiring was routine; the interesting
part is that a role panel's behaviour is decided somewhere else entirely, so an editor that just mirrors
the wire would be confidently wrong. The panel's copy is taken from the bot's code, and guarded.

**1. What a mode does.** `toggle`/`single`/`multiple`/`exclusive` are decided by the bot's pure
`pickOption`, and the names do not give it away: `single` revokes every OTHER option in the panel,
`exclusive` revokes only the options sharing the pick's `exclusive_group`, and an empty group is the
group `""` — not "no group". The editor names the groups and says which of the two it is looking at. A
select submission is a third behaviour again: `applySelect` makes the chosen set exactly what the member
holds FOR THIS PANEL, so deselecting revokes. Each claim is asserted against a real branch, so the copy
cannot drift from the runtime.

**2. What a dead option is.** A reaction panel matches an option by `emojiKey` with an EXACT string
compare, and `emojiKey` is `${name}:${id}` for a custom emoji — while Discord's clipboard hands you
`<:name:id>`. So an option with no emoji never fires, and one pasted from Discord never fires either.
The api's validator is happy with both; the editor flags them and shows the key the bot will use.

**3. Who owns a field.** `position` is inserted verbatim — the api never renumbers — so the array order
IS the stored order and the client must send the index. `style` is not validated by the api at all; the
DB CHECK is the only authority, so `""` is a 500 and an unrecognised value is saved as `secondary`.
`message_id` belongs to the message the bot listens on, not to the editor.

**A real gap, found while reading the runtime:** nothing calls the bot's `customId()` builder. `PanelService`
handles panel interactions and is wired live, but no command or dashboard action ever posts a panel
message — so a button/select panel configured here cannot reach Discord yet, and only reaction panels
work end to end (post the message and its reactions yourself, paste the message id and the emoji keys).
The panel says so instead of pretending, and posting a panel is the next slice.

**One real bug of mine, caught by these tests:** `panelProblem` compared `p.channelId !== ''`, and
`undefined !== ''` is TRUE — so a panel read off the wire with the optional fields absent reached
`isSnowflake(undefined)` and threw instead of answering. Every optional wire field is now normalised
once, and the regression is locked in.

**Verification.** `tsc --noEmit` clean; **600 web tests pass / 0 fail** (585 → 600: +15);
`DESIGN_TOKENS_OK (files=494)`; gate `VERIFY_ALL_OK`.

**Remaining.** One admin proxy still has no consumer: `logs/destinations`.
