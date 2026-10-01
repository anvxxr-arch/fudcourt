# Migration Plan — phased restructure

> Phase 0 planning artifact. Grounded in the audit in `current.md` / `domain-map.md`
> (working tree 2026-10-01). Every phase ends with the same exit gate:
> `go build/vet/test`, `cargo check/test`, `bun run test:shapers`, `bunx tsc --noEmit`,
> `bun run build`, `scripts/checks/{check-contract,check-deploy,check-structure}.py`
> all green (the exact baseline table in `current.md` §2).

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
- `.github/workflows/ci.yml`: Go job `working-directory: backend/data`, Rust job
  `working-directory: backend/sync`; the web job's live-reconcile step builds
  `../../backend/sync/Cargo.toml`.
- No stale `apps/apicalls|apps/sync` strings remain in `*.go`, `*.rs`, `*.ts`, `*.service`,
  `*.timer`, `*.yml`, `*.toml`.

**Remaining for Phase 1 closure:** commit the working tree as one reviewable change
(the `git mv` history is preserved in the rename entries), then run the full exit gate in CI.

- **Risks:** uncommitted 103-file change set mixes the "repurpose" surface changes with the
  moves — splitting into two commits (surface vs moves) keeps `git mv` detection intact and
  reviewable. systemd units must be reloaded on the host after commit
  (`systemctl daemon-reload` + restart `fudcourt-apicalls`/`fudcourt-sync`/`fudcourt-reconciled`).
- **Ordering:** first; everything else assumes the final tree shape.
- **Rollback:** `git checkout -- .` restores paths (renames are tracked); systemd units in
  `infrastructure/` folders are host-deployed copies — re-deploy old units if the host already reloaded.

## Phase 2 — `database/` extraction
> **Amended 2026-10-01 (partially executed):** `frontend/web/db/{schema.sql,pg-schema.sql,
> executor-schema.sql}` are now `database/schema/{schema.sql,pg-schema.sql,executor-schema.sql}`
> (`database/README.md` records the move). `pg-load.ts`, `mirror.ts`, `store.ts`, `dump-schema.mjs`
> path comments updated; `dump-schema.mjs --check` remains the Turso drift gate. **Not done:**
> lifting `EXECUTOR_DDL` content out of `store.ts` (it stays embedded byte-equivalent to
> `database/schema/executor-schema.sql`, pinned by `executor-store-tests.ts` §59 test
> "the embedded DDL matches the tracked database/schema/executor-schema.sql (no silent drift)" —
> PASS). `database/seeds|fixtures/` remain empty; `database/migrations/` deliberately not created
> (DR-020).

- Move `frontend/web/db/{schema.sql,pg-schema.sql,executor-schema.sql}` →
  `database/{schema,seeds,fixtures}/`; keep a generated copy or path update in
  `frontend/web/scripts/tools/pg-load.ts` and `src/platform/executor/store.ts`.
- Lift `EXECUTOR_DDL` out of `store.ts` into `database/schema/executor.sql` (store.ts imports
  the file or a generated constant).
- **Risks:** `pg-load.ts` (60s timer, live) and `ensureExecutorSchema` (boot-time DDL) reference
  the files by path — `check-deploy.py` won't catch a missing `.sql`; add a check or keep
  shims one release.
- **Ordering:** after Phase 1; before Phase 3 (contracts embed the DDL).
- **Rollback:** revert the move; SQL files are static content.

## Phase 3 — `shared/contracts`
> **Amended 2026-10-01 (executor surface EXECUTED, verified):** `shared/contracts`
> (OpenAPI 3.0.3 of the executor surface — 15 paths / 19 operations mirroring
> `types.ts` + `client.ts` + the route handlers; `events/catalog.json` 24 stable ids
> with the 19 TS aliases; event/error JSON Schemas) and `shared/sdk/typescript` (thin typed
> fetch client generated from the contract) exist. Verified: `check-contract.mjs` →
> `CONTRACTS_OK enums=3 openapi_paths=15 route_handlers=39 events=24`, `tsc --noEmit`
> clean, and `bun run generate` is **deterministic** (so the generated-SDK drift gate
> is meaningful). The gate is wired into `ci.yml` (job `contracts`) and
> `scripts/githooks/pre-push`. **In flight:** the data/sync/api HTTP surfaces are
> being added to the same contract + SDK in a follow-up pass (same ground-truth rules).

- Author `openapi/` for the four HTTP surfaces (web's 35 routes collapse to api+executor+data+sync
  contracts), `events/` for execution lifecycle (`executor.execution_events` rows) and stream
  normalization, `schemas/` for the table groups in `domain-map.md` §2.
- Extract `shared/sdk/typescript` from `frontend/web/src/features/executor/client.ts` + the other
  `features/*/client.ts` typed clients.
- **Risks:** the shaper tests (`scripts/tests/*`) assert today's response shapes — they double as
  contract fixtures; regenerate from `record:fixtures` output, don't hand-copy.
- **Ordering:** after Phase 2; before Phases 4–6 (each service port consumes contracts).
- **Rollback:** contracts are additive new files; consumers not yet cut over.

## Phase 4 — `backend/api` (Go) incremental, Next.js proxy compatibility
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
  handlers moved domain-by-domain from `frontend/web/src/app/(frontend)/api/**`.
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
> ./...` fresh pass, 174 test funcs): `internal/{executor (records/enums/lifecycle/
> types), decimal, execution, idempotency, orders, risk, sizing, strategy, worker,
> planner (pkg present), lock}` and `internal/exchange` (interface, registry,
> classify/symbols/credentials/http) with adapters `binance`, `bybit`, `mexc` and
> `paper` (same-interface simulated matcher). Exchange+lock slice alone: 108 test
> funcs / 390 cases, classifier/symbol/signing/error-mapping parity with
> `exchange.ts` documented in code. **Still in flight:** planner/worker/
> persistence/cmd/executor wiring per the slice queue. **The [parity matrix](parity-matrix.md) gates
> any TS deletion — the TS executor remains the production executor until then.**

Port order chosen so parity tests can gate each deletion (per module in `current.md` §5):

1. `types.ts` + `plan.ts` + `risk.ts` (pure functions — easiest parity: table-driven tests
   comparing TS vs Go outputs from `scripts/tests/executor-{plan,risk}-tests.ts` fixtures).
2. `engine.ts` strategy FSM (`transitionChildOrder`, `strategyStep/OnFill/Progress`,
   `defaultSlices`) with `executor-*-tests.ts` as the parity oracle.
3. `store.ts` persistence (`executor.*` writes) + `lock.ts`.
4. `exchange.ts` adapters (binance/bybit/mexc via `CcxtLike` shape) + key handling
   (`masterKeyFromEnv` — move key custody to backend/workers/executor, web never sees secrets).
5. `worker.ts` + `scripts/executor/worker.ts` last (it composes everything).

- **Rule: parity tests MUST pass before each TS module is deleted** (the existing
  `scripts/tests/executor-*-tests.ts` suites are the seed). Keep the TS runtime until
  `verify:executor` (`executor-paper-e2e.ts`) passes against the Go worker.
- **Parity baseline (2026-10-01):** `current.md` §5a records the per-suite breakdown
  (155 tests, 0 fail across the 8 executor suites; covered by `test:shapers` 240/240) and the
  store DDL byte-identity PASS. `verify:executor` itself is environment-gated
  (`FUDCOURT_EXECUTOR_MASTER_KEY`, verbatim error in `current.md` §5a) — its green run is part
  of the Phase 5 completion gate, not the Phase 0 baseline.
- **Risks:** this is the highest-risk phase (money-path code). The dual-write window (TS worker
  vs Go worker) needs the `lock.ts` single-flight guarantee to hold across both implementations —
  keep one worker live at a time; cut over `fudcourt-executor-worker.service` ExecStart atomically.
  Encrypted keys (`masterKeyFromEnv`) must be re-encrypted/imported, not copied raw.
- **Ordering:** after Phase 4 (orchestration API exists). Straggler: `api/executor/**` routes
  (16 files) are the largest import-violation cluster (`domain-map.md` §3.1) — they disappear
  with this phase.
- **Rollback:** systemd worker unit points back at `frontend/web/scripts/executor/worker.ts`;
  `executor.*` schema unchanged during the port (Phase 2 kept DDL stable), so state survives.

## Phase 6 — Rust `backend/sync` specialization

- Promote `fudcourt-sync` (Rust) over the Python twin `frontend/web/scripts/tools/sync-live.py`:
  CI already has the byte-parity harness pattern (`verify/verify-reconcile.py`); add the same
  oracle gate for sync (`scripts/verify` + `tests/oracle`) comparing `assets` rows.
- Switch `infrastructure/systemd/fudcourt-sync.service`/`.timer` to the Rust binary (or retire them in
  favor of `infrastructure/systemd/fudcourt-sync-rust.*`), delete the Python original after one clean sync cycle.
- Extend to websocket streams + event normalization (target.md §1).
- **Risks:** `pyfmt.rs`/`db.rs` exist precisely to preserve byte-identical output — any
  divergence corrupts the Turso journal; the honesty rule (failed RPC ≠ zero balance) MUST hold.
- **Ordering:** independent of Phases 4–5; DO after Phase 3 (event contracts) if event
  normalization lands here.
- **Rollback:** timer points back at `sync-live.py`; both units coexist safely (verified in
  `current.md` §7) during the window.

## Phase 7 — frontend cleanup

- Delete `frontend/web/src/platform/executor/` and `frontend/web/scripts/executor/` remnants (post-5),
  data-passthrough routes replaced by `backend/data` via `backend/api` (post-4),
  `src/features/executor/client.ts` re-targeted to `shared/sdk/typescript`.
- Fix the shell inversion: `src/shell/store-shell.tsx` may keep importing feature pages
  (UI-only app) but `check-structure.py` should then enforce "no platform→feature imports".
- **Risks:** low; mostly deletions behind green proxies.
- **Ordering:** after 4–6. **Rollback:** per-file revert.

## Phase 8 — tests layout

- Move `frontend/web/scripts/{tests,fixtures,oracle,verify}` → `tests/{integration,fixtures,oracle}`
  + per-service unit tests; keep `test:shapers` working via `packages/config` tsconfig until the
  last move.
- **Risks:** `test:shapers` compiles via `tsconfig.shaper-tests.json` into `.shaper-tests/`
  with a custom `alias-resolver.cjs` — path moves break the alias map; move the resolver with it.
- **Ordering:** after 7 (code settles first). **Rollback:** revert moves; CI job paths updated
  in the same commit.

## Phase 9 — CI split

- Split `ci.yml` into per-surface workflows (`web`, `api`, `executor`, `data`, `sync`,
  `contracts`) with path filters; keep one aggregate required check for merges.
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
> `infrastructure/docker|compose/`, and re-infrastructure/reload the host units.

**Status: core move EXECUTED (2026-10-01), verified green.**
- All 10 unit files consolidated into `infrastructure/systemd/` via `git mv` (was
  `frontend/web/infrastructure/`, `backend/data/infrastructure/`, `backend/sync/infrastructure/`), including
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
- Phases 1-2 are committed (6184d84 baseline snapshot, 4e8ba91 phase 1-2). New uncommitted
  waves (Phase 3+ artifacts: `packages/`, `services/{api,executor}`, `go.work`) must be
  committed in reviewable per-phase increments before the next phase starts.
- Money-path code (Phase 5) requires parity-first deletion; never delete TS before its Go
  counterpart passes the ported suite and `verify:executor`.
- The sync/reconcile Python-vs-Rust twins are live in production units; every cutover keeps the
  old unit until one clean scheduled cycle is observed.
