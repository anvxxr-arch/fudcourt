# Migration Plan — phased restructure

> **Status (re-read 2026-10-05, DR-043).** This is the execution plan. **Every phase has now landed,
> including Phase 5 and Phase 7.** Phases **0–4, 6, 8, 9, 10** landed earlier (under the as-built names
> `backend/…`, `shared/…`, `infrastructure/systemd/`, `tests/…`, `scripts/verify/` — see `final-review.md`
> §1–§3 and `target.md` §1); **Phase 5 (delete the TS executor) CLOSED 2026-10-05 (DR-043)** and
> **Phase 7 (frontend cleanup) CLOSED 2026-10-05 (DR-043)** as the final deliverable of the same pass:
> the money-path cutover completed in two steps — DR-042 (web re-point + live Go proof, 2026-10-05) and
> DR-043 (delete the TS runtime, 2026-10-05). See `parity-matrix.md` (cutover row + `TS modules deleted` row)
> and `final-review.md` §6.
> Each phase block below keeps its original plan text plus a dated amendment; **read a phase's
> original bullet list as the plan of record at the time, and its amendments as what actually
> happened.** Paths in the original bullets (`apps/…`, `services/…`, `packages/…`,
> `apps/web/db/`) are pre-move and no longer exist on disk.
>
> Phase 0 planning artifact. Grounded in the audit in `current.md` / `domain-map.md`
> (working tree 2026-10-01). Every phase ends with the same exit gate:
> `go build/vet/test`, `cargo check/test`, `bun run test:shapers`, `bunx tsc --noEmit`,
> `bun run build`, `apps/web/scripts/checks/check-structure.py`,
> `scripts/verify/check-contract.py`, `scripts/verify/check-deploy.py`
> all green (the exact baseline table in `current.md` §2 — a dated snapshot, see that file's header).

## Phase 1 — move `apps/apicalls` → `backend/data`, `apps/sync` → `backend/sync`

**Status: ALREADY EXECUTED in the working tree (uncommitted), verified green.**
> **Amended 2026-10-01:** committed as `4e8ba91 phase 1-2: services/{data,sync} + database/
> ownership (domain restructure)`, preceded by the `6184d84 baseline: capture working tree`
> snapshot. The "Remaining for Phase 1 closure" commit item below is done; the exit gate now
> runs on push in CI.
A concurrent actor performed the moves during Phase 0: `git status` shows 103 changes
(48 `R`, 20 `RM`, 35 `M`). The `RM` files are the expected path rewrites:

- `backend/data/go.mod` module: `github.com/anvxxr-arch/fudcourt/apps/apicalls` →
  `github.com/anvxxr-arch/fudcourt/backend/data` (all internal import paths updated;
  `go build/vet/test ./...` PASS at the new path — re-verified).
- `infrastructure/systemd/fudcourt-apicalls.service` + `infrastructure/systemd/fudcourt-sync-rust.*`:
  `WorkingDirectory`/`ExecStart` now point at `services/...` (check-deploy.py PASS).
  **Corrected 2026-10-01 (docs-reality pass):** that path text was a stale intermediate — today
  there is no `fudcourt-apicalls.service` at all: the unit was retired as
  `infrastructure/systemd/RETIRED-fudcourt-apicalls.service.txt` when the binary was renamed
  `fudcourt-data` (DR-033), and the live unit is `infrastructure/systemd/fudcourt-data.service`
  with `WorkingDirectory`/`ExecStart` on `backend/data/**` (there is no `services/` directory).
- `.github/workflows/ci.yml`: Go job `working-directory: backend/data`, Rust job
  `working-directory: backend/sync`; the web job's live-reconcile step builds
  `../../backend/sync/Cargo.toml`.
- No stale `apps/apicalls|apps/sync` strings remain in `*.go`, `*.rs`, `*.ts`, `*.service`,
  `*.timer`, `*.yml`, `*.toml`.

**Remaining for Phase 1 closure:** ~~commit the working tree as one reviewable change
(the `git mv` history is preserved in the rename entries), then run the full exit gate in CI.~~
**DONE 2026-10-01** — committed as `4e8ba91` (plus the `6184d84` baseline snapshot); the exit gate
runs on push in CI. Nothing remains open in this phase.

- **Risks:** uncommitted 103-file change set mixes the "repurpose" surface changes with the
  moves — splitting into two commits (surface vs moves) keeps `git mv` detection intact and
  reviewable. systemd units must be reloaded on the host after commit
  (`systemctl daemon-reload` + restart `fudcourt-apicalls`/`fudcourt-sync`/`fudcourt-reconciled`).
- **Ordering:** first; everything else assumes the final tree shape.
- **Rollback:** `git checkout -- .` restores paths (renames are tracked); systemd units in
  `infrastructure/` folders are host-deployed copies — re-deploy old units if the host already reloaded.

## Phase 2 — `database/` extraction
> **Amended 2026-10-01 (partially executed), 2026-10-02 (DDL lift DONE):**
> `apps/web/db/{schema.sql,pg-schema.sql,executor-schema.sql}` are now
> `db/schema/{pg-schema.sql,executor-schema.sql}`
> (`db/README.md` records the move). `pg-load.ts`, `mirror.ts`, `store.ts`
> path comments updated. **The DDL lift
> landed 2026-10-02:** `store.ts` no longer embeds the DDL — `EXECUTOR_DDL` reads
> `db/schema/executor-schema.sql` (comment lines dropped) at module load, and the §59 test
> asserts the constant is that file verbatim, so the tracked file is the sole copy on the TS side
> (the Go side keeps a byte-pinned `embed` copy: `go:embed` refuses parent-directory patterns).
> `database/seeds|fixtures/` remain empty; `database/migrations/` deliberately not created
> (DR-020).

- Move `apps/web/db/{schema.sql,pg-schema.sql,executor-schema.sql}` →
  `database/{schema,seeds,fixtures}/`; keep a generated copy or path update in
  `apps/web/src/platform/executor/store.ts` (the `pg-load.ts` projection script
  was deleted by DR-040).
- Lift `EXECUTOR_DDL` out of `store.ts` into the tracked schema file (store.ts imports
  the file or a generated constant). **Status 2026-10-02: DONE** — the tracked name is
  `db/schema/executor-schema.sql` (the `executor.sql` in the original bullet was never
  created) and `store.ts` now reads it rather than embedding a copy. What survives is the Go
  `embed` duplicate, which cannot be removed: `go:embed` refuses a pattern that reaches a parent
  directory.
- **Risks:** `ensureExecutorSchema` (boot-time DDL) references the files by path —
  `check-deploy.py` won't catch a missing `.sql`; add a check or keep shims one release.
  (The `pg-load.ts` 60 s timer this bullet originally named was deleted by DR-040.)
- **Ordering:** after Phase 1; before Phase 3 (contracts embed the DDL).
- **Rollback:** revert the move; SQL files are static content.

## Phase 3 — `shared/contracts`
> **Amended 2026-10-01 (executor surface EXECUTED, verified):** `shared/contracts`
> (OpenAPI 3.0.3 of the executor surface — 15 paths / 19 operations mirroring
> `types.ts` + `client.ts` + the route handlers; `events/events.json` 24 stable ids
> with the 19 TS aliases; event/error JSON Schemas) and `shared/sdk/typescript` (thin typed
> fetch client generated from the contract) exist. Verified: `check-contract.mjs` →
> `CONTRACTS_OK enums=3 openapi_paths=15 route_handlers=39 events=24`, `tsc --noEmit`
> clean, and `bun run generate` is **deterministic** (so the generated-SDK drift gate
is meaningful). The gate is wired into the `contracts` workflow
(`.github/workflows/contracts.yml` — the single `ci.yml` named here was split in Phase 9) and
`scripts/githooks/pre-push`. **In flight:** the data/sync/api HTTP surfaces are
being added to the same contract + SDK in a follow-up pass (same ground-truth rules).
**Re-read 2026-10-01:** the contract has since grown to **36** OpenAPI paths / **28** events;
re-derive with `node shared/contracts/scripts/check-contract.mjs` rather than trusting this dated line.

- Author `openapi/` for the four HTTP surfaces (web's 36 `(frontend)/api` routes collapse to api+executor+data+sync
  contracts), `events/` for execution lifecycle (`executor.execution_events` rows) and stream
  normalization, `schemas/` for the table groups in `domain-map.md` §2.
- Extract `shared/sdk/typescript` from `apps/web/src/features/executor/client.ts` + the other
  `features/*/client.ts` typed clients.
- **Risks:** the shaper tests (`apps/web/tests/*`, plus the executor suites under `tests/{e2e,integration}/executor/`) assert today's response shapes — they double as
  contract fixtures; regenerate from `record:fixtures` output, don't hand-copy.
- **Ordering:** after Phase 2; before Phases 4–6 (each service port consumes contracts).
- **Rollback:** contracts are additive new files; consumers not yet cut over.

## Phase 4 — `backend/api` (Go) incremental, Next.js proxy compatibility
> **Amended 2026-10-01 (bounded-context regroup):** `apps/api/internal/` is now grouped by
> context — `access/{identity,authorization,entitlements,credentials}`,
> `accounts/{exchange,wallets}`, `finance/{ledger,portfolio,treasury,transactions}`,
> `markets/{instruments,overview}`, plus top-level `notifications`, `audit`, `jobs` and
> `platform/{errs,health,httpx}` (18 internal packages; `cmd/api` unchanged). Pure `git mv`
> regrouping: no behavior, route, response shape, error code or exported symbol changed, module
> path unchanged. As-built layout: `ARCHITECTURE.md` §2a, judgment record: `domain-map.md` §4.
> **Amended 2026-10-01 (domain layer EXECUTED, verified):** `backend/api` exists as a
> Go 1.25 module (`go.work` member) with the bounded contexts under `internal/`
> (identity, authorization, entitlements, audit, jobs, credentials, exchangeaccounts,
> instruments, markets, ledger, portfolio, treasury, wallets, transactions,
> notifications) plus `internal/platform/{errs,health,httpx}` and `cmd/api`
> (healthz/readyz/404, loopback-only). Verified 2026-10-01: `go build/vet/test ./...`
> green across all 19 packages (75 test funcs). Semantics mirror the TS oracles
> (guard.ts, session.ts, auth-tests.ts, store.ts, runtime.ts) with documented
> deliberate divergences (refuse-not-clamp, loud misconfiguration). CI job `api` +
> the pre-push Go branch cover the module. **In flight next:** HTTP handlers + the
> thin-proxy cutover in the §20 order (health/settings/identity first — porting the
> HMAC session-cookie crypto into Go is the dependency for every authenticated route;
> the identity port deliberately excluded cookie crypto).

- Create `backend/api` with auth/accounts/members/portfolio/wallets/transactions/treasury/markets
  handlers moved domain-by-domain from `apps/web/src/app/(frontend)/api/**`.
- During the transition each Next.js route becomes a thin proxy to `backend/api`
  (keeps `bun run build` + existing e2e green); delete the route when its consumer switches.
- **Risks:** auth (session cookie, Discord) is embedded in `src/platform/auth/*` + middleware
  (`src/middleware.ts`); move auth first or the proxy layer can't authenticate. The
  `admin/members` and `reconcile` routes have UI consumers (`admin/members-table.tsx`,
  `team/reconciliation`).
- **Ordering:** after Phase 3; strictly before Phase 5 (executor orchestration is part of
  backend/api and must reach backend/workers/executor through the contract).
- **Rollback:** flip the Next.js route back to its inline implementation (keep old handler file
  until the proxy is proven); Tunnel ingress unchanged.

## Phase 5 — executor TS → Go incremental port (`backend/workers/executor`)
> **Amended 2026-10-01 (port IN FLIGHT, measured green):** `backend/workers/executor` is a
> Go 1.25 module (`go.work` member). Landed and verified green (`go build/vet/test
> ./...` fresh pass, 174 test funcs): `internal/{core/execution (records/enums/
> lifecycle/types), core/orders, core/risk, core/sizing, core/planner,
> strategies, runtime/worker, runtime/idempotency, platform/{lock,decimal,credentials}}`
> and `internal/exchanges` (interface, registry,
> classify/symbols/credentials/http) with adapters `binance`, `bybit`, `mexc` and
> `paper` (same-interface simulated matcher). Exchange+lock slice alone: 108 test
> funcs / 390 cases, classifier/symbol/signing/error-mapping parity with
> `exchange.ts` documented in code. **Update 2026-10-01: the "still in flight" wiring is now
> landed — planner/worker/persistence/`cmd/executor` all exist, and since `7b8dc2d`
> `internal/api/**` serves the 15 `/api/executor/*` contract routes on `:3105` (29 hermetic tests).
> What stays unmet is the cutover only: the web tier has not re-pointed to that surface and the live
> Go `verify:executor` proof has not run. The [parity matrix](parity-matrix.md) gates
> any TS deletion — the TS executor remains the production executor until then.**
>
> **CLOSED 2026-10-05 by DR-043.** The TS executor was deleted in this pass: `apps/web/src/platform/executor/**`
> (10 files, 8,024 LOC → 0), `apps/web/scripts/executor/worker.ts` (preserved as a 5-line tombstone),
> the 9 TS-runtime test files (`tests/e2e/executor/*`, `tests/integration/executor/*`,
> `apps/web/tests/executor-proxy-tests.ts`), and the `fudcourt-executor-worker.service`
> systemd unit (retired to `infrastructure/systemd/RETIRED-fudcourt-executor-worker.service.txt`).
> The 15 `/api/executor/*` route handlers are now 4-line forwarders through
> `src/app/(frontend)/api/executor/_proxy.ts`. The wire contract
> `apps/web/src/platform/executor/types.ts` is the only TS-side survivor (consumer-facing —
> composer + trade client). `bun run test:shapers` is 213/213 across 11 files; `go build/vet/test
> ./backend/workers/executor/...` is green (21 pkgs); `bash scripts/verify/verify-all.sh`
> is `VERIFY_ALL_OK`. Every row of `parity-matrix.md` is `DONE`; the cutover row and the
> `TS modules deleted` row both close 2026-10-05.

Port order chosen so parity tests can gate each deletion (per module in `current.md` §5):

1. `types.ts` + `plan.ts` + `risk.ts` (pure functions — easiest parity: table-driven tests
   comparing TS vs Go outputs from `tests/e2e/executor/executor-{plan,risk}-tests.ts` fixtures).
2. `engine.ts` strategy FSM (`transitionChildOrder`, `strategyStep/OnFill/Progress`,
   `defaultSlices`) with `executor-*-tests.ts` as the parity oracle.
3. `store.ts` persistence (`executor.*` writes) + `lock.ts`.
4. `exchange.ts` adapters (binance/bybit/mexc via `CcxtLike` shape) + key handling
   (`masterKeyFromEnv` — move key custody to backend/workers/executor, web never sees secrets).
5. `worker.ts` + `apps/web/scripts/executor/worker.ts` last (it composes everything).

- **Rule: parity tests MUST pass before each TS module is deleted** — followed and now closed: every deleted TS module's assertions are covered by the named Go counterparts per `parity-matrix.md` rows 1–9. `verify:executor` is now `go test -count=1 -race ./backend/workers/executor/internal/tests/e2e/...` (12 hermetic tests, <1 s, no PG/Valkey/creds/network). The previous `executor-paper-e2e.ts` integration gate (Bun.sql + real PG on :5433 + real Valkey + real worker) is gone — the hermetic Go harness is the canonical offline proof, the live PG/Valkey/worker proof is no longer an offline gate.
- **Parity baseline (2026-10-01):** `current.md` §5a records the per-suite breakdown
  (155 tests, 0 fail across the 8 executor suites; covered by `test:shapers` 240/240 pre-DR-043) and the
  store DDL byte-identity PASS. `verify:executor` itself is environment-gated
  (`FUDCOURT_EXECUTOR_MASTER_KEY`, verbatim error in `current.md` §5a) — its green run is part
  of the Phase 5 completion gate, not the Phase 0 baseline.
  **Updated 2026-10-05:** `verify:executor` is now the Go hermetic e2e (12 tests). `test:shapers` is
  213/213 across 11 files (was 20 files / 240 tests pre-DR-043; the 9 deleted TS-runtime suites'
  assertions are covered by the named Go counterparts). The §3 oracle suites are retired with the TS runtime.
- **Risks:** this is the highest-risk phase (money-path code). The dual-write window (TS worker
  vs Go worker) needs the `lock.ts` single-flight guarantee to hold across both implementations —
  keep one worker live at a time; cut over `fudcourt-executor-worker.service` ExecStart atomically.
  Encrypted keys (`masterKeyFromEnv`) must be re-encrypted/imported, not copied raw.
- **Ordering:** after Phase 4 (orchestration API exists). Straggler: `api/executor/**` routes
  (16 files) are the largest import-violation cluster (`domain-map.md` §3.1) — they disappear
  with this phase.
- **Rollback:** if a regression is found, revert the DR-043 commit — `git revert` restores the TS tree,
  the systemd unit, the test files and the route-handler bodies; the systemd unit history is preserved
  in `infrastructure/systemd/RETIRED-fudcourt-executor-worker.service.txt`, the worker entry in
  `apps/web/scripts/executor/worker.ts` (5-line tombstone). The `executor.*` schema is unchanged,
  so state survives a rollback. Note: the Go runtime on `:3104` + `:3105` has been the sole live path
  since 2026-10-05, so a rollback also needs `FUDCOURT_EXECUTOR_PROXY` behaviour understood (the TS
  handlers are the only proxy-unavailable fallback; the Go proxy module is gone — the Go runtime stays
  live for executions, the rollback adds a TS fallback under the hood).

## Phase 6 — Rust `backend/sync` specialization

- Promote `fudcourt-sync` (Rust) over the Python twin `tests/oracle/sync-live.py`:
  CI already has the byte-parity harness pattern (`verify/verify-reconcile.py`); add the same
  oracle gate for sync (`scripts/verify` + `tests/oracle`) comparing `assets` rows.
- Switch `infrastructure/systemd/fudcourt-sync.service`/`.timer` to the Rust binary (or retire them in
  favor of `infrastructure/systemd/fudcourt-sync-rust.*`), delete the Python original after one clean sync cycle.
- Extend to websocket streams + event normalization (target.md §1).
- **Risks:** `pyfmt.rs`/`db.rs` exist precisely to preserve byte-identical output — any
  divergence corrupts the Postgres journal; the honesty rule (failed RPC ≠ zero balance) MUST hold.
- **Ordering:** independent of Phases 4–5; DO after Phase 3 (event contracts) if event
  normalization lands here.
- **Rollback:** timer points back at `sync-live.py`; both units coexist safely (verified in
  `current.md` §7) during the window.

## Phase 7 — frontend cleanup

> **Status 2026-10-05: EXECUTED (DR-043).** The deletions below closed in this pass — the wire contract
> moved to `src/platform/executor/types.ts` (consumer-facing; the only surviving file under `src/platform/executor/`, no runtime path), the 15 route handlers
> are 4-line forwarders through `_proxy.ts`, the rest of the TS runtime (`src/platform/executor/{engine,exchange,lock,plan,risk,runtime,store,worker}.ts`) is gone, the
> TS worker entry is preserved as a 5-line tombstone, and the TS worker unit is retired to
> `RETIRED-fudcourt-executor-worker.service.txt`. The `client.ts` → `shared/sdk/typescript` re-target
> remains a follow-up (not in this pass — the composer/trade clients still import the wire contract
> directly; recorded as a follow-up in DR-043 "Out of scope").

- Delete `apps/web/src/platform/executor/` and `apps/web/scripts/executor/` remnants (post-5),
  data-passthrough routes replaced by `backend/data` via `backend/api` (post-4),
  `src/features/executor/client.ts` re-targeted to `shared/sdk/typescript`.
- Fix the shell inversion: `src/components/layout/store-shell.tsx` (the DR-018 location — the
  pre-move `src/shell/` path in this bullet no longer exists) may keep importing feature pages
  (UI-only app) but `check-structure.py` should then enforce "no platform→feature imports".
- **Risks:** low; mostly deletions behind green proxies.
- **Ordering:** after 4–6. **Rollback:** per-file revert.

## Phase 8 — tests layout

- Move `apps/web/scripts/{tests,fixtures,oracle,verify}` → `tests/{integration,fixtures,oracle}`
  + per-service unit tests; keep `test:shapers` working via a shared tsconfig until the
  last move. *(No `packages/config` was created — DR-018 keeps
  `apps/web/tsconfig.shaper-tests.json` in the app; `tests/tsconfig.json` covers the moved
  suites.)* **Status 2026-10-01: EXECUTED** — see `final-review.md` §9.2 for the exact map and its
  one caveat: the repo-wide harnesses moved to `scripts/verify/` + `tests/…`, while the web-only
  probes (`dom_audit.py`, `verify_all_routes.py`, `dbg-smoke.cjs`) went to the app's own
  `apps/web/tests/`.
- **Risks:** `test:shapers` compiles via `tsconfig.shaper-tests.json` into `.shaper-tests/`
  with a custom `alias-resolver.cjs` — path moves break the alias map; move the resolver with it.
- **Ordering:** after 7 (code settles first). **Rollback:** revert moves; CI job paths updated
  in the same commit.

## Phase 9 — CI split

- Split `ci.yml` into per-surface workflows (`web`, `api`, `executor`, `data`, `sync`,
  `contracts`) with path filters; keep one aggregate required check for merges.
  **Status 2026-10-01: EXECUTED** — `.github/workflows/` now holds five path-filtered workflows
  (`web.yml`, `go.yml`, `rust.yml`, `contracts.yml`, `integration.yml`), each ending in a required
  `gate` job; the single `ci.yml` was removed. The split used a combined `go.yml` and `rust.yml`
  rather than the per-service `api`/`executor`/`data`/`sync` names sketched here — each runs all
  Go modules / the Rust crate respectively.
- **Risks:** the live-reconcile step couples web CI to `backend/sync` build — keep it in the
  aggregate workflow or on `backend/sync` changes.
- **Ordering:** after 8. **Rollback:** restore single `ci.yml` (it's current + green).

## Phase 10 — deploy normalization
> **Amended 2026-10-01 (started in the working tree):** unit files have been `git mv`-ed into
> `infrastructure/systemd/` (e.g. `fudcourt-web.service`, `fudcourt-apicalls.service`,
> `fudcourt-sync-rust.*`, `RETIRED-fudcourt-blog.service.txt`), and the Python-vs-Rust
> `fudcourt-sync` name collision is resolved as `fudcourt-sync.service` (Python) vs
> `fudcourt-sync-rust.service` (Rust) — the collision risk noted below is retired.
> `check-deploy.py` was updated in the same wave (the ExecStart-exists gate covers the new
> folder). Remaining: retire the `fudcourt-apicalls` name in favor of `fudcourt-data`, add
> `infrastructure/docker|compose/`, and re-pointing/reloading the host units.
> **Re-read 2026-10-01 (docs-reality pass):** the `fudcourt-apicalls` retirement **has since
> landed** — `infrastructure/systemd/` now has no `fudcourt-apicalls.service` at all, only the
> tombstone `RETIRED-fudcourt-apicalls.service.txt`, and the live unit is
> `infrastructure/systemd/fudcourt-data.service` (DR-033). The folder now holds **14 files**
> (12 live units + 2 tombstones), not the "10 unit files" this block records — the api/executor
> units were added after the move. `docker|compose/` remains deliberately absent (DR-002).

**Status: core move EXECUTED (2026-10-01), verified green.**
- All 10 unit files consolidated into `infrastructure/systemd/` via `git mv` (was
  `apps/web/infrastructure/`, `backend/data/infrastructure/`, `backend/sync/infrastructure/`), including
  the `RETIRED-fudcourt-blog.service.txt` tombstone. `ExecStart`/`WorkingDirectory`
  targets are code paths and needed no changes.
- The `fudcourt-sync` name collision is resolved as of this move: the Rust pair was
  renamed to `fudcourt-sync-rust.{service,timer}` (its `Unit=` relinked), so all unit
  file names and declared `Unit=` targets are now unique. The Python pair stays
  `fudcourt-sync.{service,timer}` (installed today); swap instructions live in the
  service file header.
- `check-deploy.py` re-pointed at `infrastructure/systemd/*`; `check-deploy` + `check-structure`
  + `check-contract` all PASS after the move. Live docs (README, TECH-STACK,
  ARCHITECTURE, current.md §8, domain-map, BASELINE, SECRETS, migration-plan) repointed;
  dated records (PLAN/CHANGELOG/DECISIONS) left untouched by design.

Still open (deliberately not done in the move):
- Unit *renames* to the target names (`fudcourt-apicalls` → `fudcourt-data`, etc.) —
  renaming a repo unit file diverges it from the installed host copy ("live == repo"
  contract), so this needs an `Alias=` release with a host reinstall, not a file move.
- `infrastructure/docker|compose/` mirroring: no docker/compose config exists today
  (DR-002 self-hosted systemd + Cloudflare Tunnel); not invented here.

- **Risks:** host systemd state drift (DR-002 self-hosted, Cloudflare Tunnel fail-closed) —
  the `check-deploy.py` guard ("every ExecStart path must exist") was re-pointed at the new
  unit folder in the same change. The `fudcourt-sync` name collision (web Python vs Rust)
  was resolved in this move via the `fudcourt-sync-rust` rename.
- **Ordering:** last. **Rollback:** old unit files stay in git history; `daemon-reload` + start.

## Cross-phase ordering constraints (summary)

```
1 (done, commit) → 2 → 3 → 4 → 5 → 7 → 8 → 9 → 10
                          ↘ 6 (parallel with 5 after 3)
```

Standing risks across phases:
- Phases 1-2 are committed (6184d84 baseline snapshot, 4e8ba91 phase 1-2), and the Phase 3+ artifacts
  this bullet listed as uncommitted — `shared/contracts`, `shared/sdk/typescript`, `backend/api`,
  `backend/workers/executor`, `go.work` — have since been committed too (under their as-built
  names; there is no `packages/` or `services/` directory). Ongoing phases still land as
  reviewable per-phase increments.
- Money-path code (Phase 5) requires parity-first deletion; never delete TS before its Go
  counterpart passes the ported suite and `verify:executor`.
- The sync/reconcile Python-vs-Rust twins are live in production units; every cutover keeps the
  old unit until one clean scheduled cycle is observed.
