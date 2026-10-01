# Current Architecture — Phase 0 Baseline (audit-only)

> Captured 2026-10-01 from the working tree of `/home/dwizzy/fudcourt`. Audit-only phase:
> no production code, config, script, or doc outside `docs/architecture/{current,target,domain-map,migration-plan}.md`
> was modified. Pre-existing docs (`ARCHITECTURE.md`, `TECH-STACK.md`, `SCHEMA.md`) were read only.
>
> Sources cross-checked read-only (2026-10-01) against: `ARCHITECTURE.md` §2 (System picture),
> §4 (Data families), §8b (CEX Executor runtime); `TECH-STACK.md` §2 (Frameworks & runtimes),
> §4 (Infrastructure), §5 (Market-data acquisition stack), §6 (External data sources),
> “frontend/web layout (DR-018)”, “Data layer (DR-019)”; `SCHEMA.md` §1 (Turso), §2 (Neon/Payload),
> §3 (API envelope contract). Cited inline where used; no factual divergence found.

## 0. Working-tree state (reported, never discarded)

> **Amended 2026-10-01 (timeline):** the two observations below are historical. During the audit
> the tree was mid-restructure and fully uncommitted (observation 2 records the 103-change
> wave seen mid-audit); the external actor subsequently committed that wave as
> `6184d84 baseline: capture working tree before domain restructure (Phases 0+)` and
> `4e8ba91 phase 1-2: services/{data,sync} + database/ ownership (domain restructure)`, both
> ancestors of the current branch `refactor/domain-architecture`.
> As of this amendment, the tree is committed through 4e8ba91; remaining untracked work
> (`packages/`, `backend/api/`, `backend/workers/executor/`, `go.work`) belongs to the concurrent
> Phase 3-5 actor and is out of scope for this audit.
> Recount 2026-10-01T07:28:31Z (single instant; the tree was actively mutating during this
> amendment round): 29 pending changes (23 tracked modifications/renames) + 6 untracked —
> `docs/architecture/{current,domain-map}.md` (this audit's deliverables) plus `packages/`,
> `backend/api/`, `backend/workers/executor/`, `go.work`. Note: the prompt-pack directory `.ai/` (10 files: `restructure-fudcourt.md` + 9 under `prompts/`)
> exists on disk and is tracked — committed in `6184d84`'s baseline snapshot (verified:
> `git log -- .ai/` → 6184d84; `git ls-files .ai/` = 10) — which is why it is absent from the
> untracked list above. The earlier "No `.ai/` directory exists" statement was an incorrect
> inference from that list and is retracted (as is this note's interim "11 files" count and its
> "tracked or ignored" hedge).

Two observations, in order (historical snapshot from before the commits above):

1. **At audit start** `git status` showed a large uncommitted "repurpose" surface: modified
   `.github/workflows/ci.yml`, `.gitignore`, `README.md`; the old `apps/blog/*` (Payload) tree
   deleted from `frontend/web`'s sibling position; the old flat `frontend/web/app/api/*` layout deleted;
   an untracked new layout `frontend/web/src/*` (app/, cms/, features/, platform/, shell/, styles/, ui/),
   untracked `frontend/web/scripts/{tools,verify}/`, `frontend/web/tsconfig.shaper-tests.json`, and untracked
   `docs/{architecture,operations,prd,product,records}/`. HEAD was
   `5e68576 repurpose: re-align every surface + ARCHITECTURE map`.
2. **During the audit** a concurrent actor executed the Phase-1 directory moves in the working tree:
   `apps/apicalls` → `backend/data`, `apps/sync` → `backend/sync`. Observed via `git status`:
   103 pending changes (48 pure renames `R`, 20 rename+modify `RM`, 35 modified `M`).
   The `RM` set includes path rewrites inside code/config: `go.mod` module is now
   `github.com/anvxxr-arch/fudcourt/backend/data`; systemd `WorkingDirectory`/`ExecStart`
   for the moved services now point at `services/...`; CI working-directory for the Go/Rust jobs
   now points at `backend/data` / `backend/sync`. No stale `apps/apicalls|apps/sync`
   references remain in `*.go`, `*.rs`, `*.ts`, `*.service`, `*.timer`, `*.yml`, `*.toml`.

Everything below reflects the tree **after** the moves. Baseline commands were run both before
the moves (original paths) and after (new paths) — both PASS; results recorded from the
verified post-move runs.

## 1. Repository shape

```
frontend/web/        Next.js 15 + Bun 1.4.2 + TypeScript — frontend, all HTTP API routes,
                 the in-frontend executor runtime, the Payload blog CMS (DB schema DDL
                 moved out to `database/schema/` in the Phase-2 wave, see §4)
backend/data/   Go sidecar ("fudcourt-data") — upstream data acquisition (was apps/apicalls)
backend/sync/   Rust crate "fudcourt-sync" — balance sync + reconcile service (was apps/sync)
docs/            architecture/, operations/, prd/, product/, records/
scripts/githooks pre-push hook
.github/workflows ci.yml (single workflow, 4 jobs)
```

Toolchain: Bun 1.4.2 (installer, task runner, server runtime), Node 22 (build-script runtime),
Go 1.24.1, Rust stable. `frontend/web` is independently installable (`bun.lock` authoritative);
root `package.json` has no workspaces field.

## 2. Build & test commands (discovered + verified)

| Command | Scope | Result | Notes |
|---|---|---|---|
| `go build ./...` | backend/data (GOWORK=off) | **PASS** | exit 0 |
| `go vet ./...` | backend/data | **PASS** | exit 0 |
| `go test ./...` | backend/data | **PASS** | `cmd/data`, `internal/research/{chainrank,cryptorank,khala,llama,news,paritytest}` all `ok`; `platform/{cache,httpx}` report `[no test files]` |
| `cargo check --all-targets` | backend/sync | **PASS** | finished clean |
| `cargo test` | backend/sync | **PASS** | 17 tests: 3 + 2 + 12 across lib/bins/integration, 0 failed |
| `bun run test:shapers` | frontend/web | **PASS** | 240 tests, 0 fail (tsc → node --test over 12 compiled suites). Executor parity subset (Phase 5 oracle): 155 tests, 0 fail across the 8 `executor-*-tests` suites — engine 20, exchange 1, plan 25, risk 39, runtime 12, store 41, worker 9, ui 8 (per-suite runs, all exit 0); the remaining 85 tests are the shaper/auth/rate-limit/db suites |
| `bunx tsc --noEmit` | frontend/web | **PASS** | exit 0 |
| `bun run build` | frontend/web | **PASS** | `next build` completed; full route table emitted |
| `python3 scripts/checks/check-contract.py` | frontend/web | **PASS** | CR_MODES consistency + mutation-auth guards |
| `python3 scripts/checks/check-deploy.py` | frontend/web | **PASS** | every ExecStart path must exist |
| `python3 scripts/checks/check-structure.py` | frontend/web | **PASS** | DR-018 layer gate |

Exact commands as (re-)run 2026-10-01 with their exit codes (captured `cmd; echo "EXIT: $?"`;
post-Phase-1/2 tree, i.e. after the `database/` move — pre-move runs at the old paths also passed):

| Exact command line (cwd) | Exit code |
|---|---|
| `go build ./...` (backend/data, GOWORK=off) | 0 |
| `go vet ./...` (backend/data, GOWORK=off) | 0 |
| `go test ./...` (backend/data, GOWORK=off) | 0 |
| `cargo check --all-targets` (backend/sync) | 0 |
| `cargo test` (backend/sync) | 0 |
| `bunx tsc --noEmit` (frontend/web) | 0 |
| `bun run test:shapers` (frontend/web) | 0 |
| `bun run build` (frontend/web) | 0 |
| `python3 scripts/checks/check-contract.py` (frontend/web) | 0 (`CONTRACT_OK`) |
| `python3 scripts/checks/check-deploy.py` (frontend/web) | 0 (`check-deploy: OK (10 unit files: paths exist, ExecStart absolute, timer pairs present)`) |
| `python3 scripts/checks/check-structure.py` (frontend/web) | 0 (`STRUCTURE_OK (139 files across (src root)(1), app(74), cms(9), features(32), platform(21), shell(1), styles(1), ui(1))`) |
| `bunx tsc -p tsconfig.shaper-tests.json` (frontend/web; the tsc compile step of `test:shapers`) | 0 |
| `node --require ./scripts/tests/alias-resolver.cjs --test .shaper-tests/scripts/tests/executor-<suite>-tests.js` × 8 suites (frontend/web; per-suite parity breakdown in §5) | 0 each |
| `bun run verify:executor` (frontend/web) | **0 — `ALL PAPER-MODE CHECKS PASSED (§127)`** against the real stack (2026-10-01: Bun.sql + real `executor` schema on :5433 + real Valkey lock + real worker). Gate: `FUDCOURT_EXECUTOR_MASTER_KEY` (64 hex, fail-closed §128.23) |

**Pre-existing failures: none.** Every documented baseline command passes on this tree, including the live paper E2E above. The skips below are environmental, not failures.

Environmental limitations (recorded as environmental, NOT failures — each blocked by its own gate):
- `backend/data` live-fetch tests: exact gate `FUDCOURT_DATA_LIVE=1` (unset ⇒ the live fetch tests
  skip themselves; offline they consume recorded fixtures via `FUDCOURT_DATA_FIXTURES_DIR`).
  Parity tests (`internal/research/paritytest`, `internal/research/cryptorank/{parity,slice_semantics}_test.go`)
  run offline against golden envelopes and are included in the `go test ./...` PASS above.
- CI's "Reconcile contract vs the Rust service" job step: exact gate `TURSO_AUTH_TOKEN` set
  (unset ⇒ the step warns and skips; the live gate was not exercised locally).
- ~~`bun run verify:executor`: exact gate `FUDCOURT_EXECUTOR_MASTER_KEY` = 64 hex chars~~
  **RESOLVED 2026-10-01** — a dev key was generated into the gitignored
  `frontend/web/.env.local` and the gate now runs: **`ALL PAPER-MODE CHECKS PASSED (§127)`**
  (exit 0) against real Postgres :5433 + real Valkey + the real worker. The gate is
  listed in the passing table above; it is no longer an environmental skip. Its value
  is that the TS runtime is proven against the live data layer, not that the Go
  worker is — the Go cutover row stays `OPEN` in `parity-matrix.md` by design.

### 2a. Independent cross-check vs `4e8ba91` commit-message claims (added 2026-10-01)
The `4e8ba91 phase 1-2` commit message claims full verification. Our own re-runs (the
exact-commands table above, executed on the working-tree content that `4e8ba91` later
committed) **AGREE with every offline claim**:

| Commit-message claim | Our evidence | Verdict |
|---|---|---|
| `tsc` clean | `bunx tsc --noEmit` exit 0 | **AGREE** |
| `test:shapers` 240/240 | `bun run test:shapers` exit 0, 240/240 | **AGREE** |
| `CONTRACT_OK` | `check-contract.py` exit 0, `CONTRACT_OK` banner | **AGREE** |
| `STRUCTURE_OK` | `check-structure.py` exit 0, `STRUCTURE_OK (139 files …)` | **AGREE** |
| `check-deploy` OK | `check-deploy.py` exit 0, `check-deploy: OK (10 unit files …)` | **AGREE** |
| Go ok (build/vet/test) | `go build/vet/test ./...` exit 0/0/0 (backend/data) | **AGREE** |
| Cargo ok (check/test) | `cargo check --all-targets`/`cargo test` exit 0/0 (17 tests) | **AGREE** |
| systemd units reinstalled | NOT covered by our offline run — live read-only check below | **CONFIRMED** (live) |
| healthz green `:3101` | NOT covered by our offline run — curl below | **CONFIRMED** (live) |
| healthz green `:3102` | NOT covered by our offline run — curl below | **CONFIRMED** (live) |

Two commit-message claims were **NOT covered** by our web-gate re-run because they are
live-host claims: **"units reinstalled"** and **"healthz green :3101/:3102"**. Both were
verified read-only afterwards (no restart/reload/install performed):

```text
$ curl -sS -m 5 http://127.0.0.1:3101/healthz          # exit 0
{"build":"28 modes","chainrank":"2 modes","khala":"3 modes","llama":"3 modes","news":"1 feeds","ok":true}

$ curl -sS -m 5 http://127.0.0.1:3102/healthz          # exit 0
{"ok":true,"service":"reconcile","rows":18}

$ systemctl --user list-unit-files 'fudcourt-*' --no-pager --no-legend   # exit 0
fudcourt-data.service   enabled  enabled
fudcourt-pgload.service     static   -
fudcourt-reconciled.service enabled  enabled
fudcourt-sync.service       disabled enabled
fudcourt-web.service        enabled  enabled
fudcourt-pgload.timer       enabled  enabled
fudcourt-sync.timer         enabled  enabled

$ systemctl --user list-units 'fudcourt-*' --no-pager --no-legend        # exit 0
  fudcourt-data.service   loaded active running FUD Court fudcourt-data (Go acquisition sidecar: CryptoRank) :3101
  fudcourt-reconciled.service loaded active running FUD Court reconcile (Rust /api/reconcile service) :3102
  fudcourt-web.service        loaded active running FUD Court web (Next.js portfolio OS) :3100
  fudcourt-pgload.timer       loaded active waiting Project Turso into the local Postgres read model every 60s (DR-019)
  fudcourt-sync.timer         loaded active waiting Run FUD Court live balance sync every 5 minutes

$ systemctl list-unit-files 'fudcourt-*' --no-pager --no-legend          # system scope: no output, exit 1
```
Verdict per live claim: **"units reinstalled" — CONFIRMED** (7 user-scope units installed;
web/data/reconciled `active running`, both timers `active waiting`; caveat: the
`fudcourt-sync-rust.*` and `fudcourt-executor-worker.service` names from `infrastructure/systemd/`
are NOT installed in this user scope, and the Python `fudcourt-sync.service` is installed but
`disabled`); **"healthz green :3101/:3102" — CONFIRMED** (both returned `{"ok":true,…}`,
curl exit 0). Every command above exited 0 on the observed tree; nothing failed under
concurrent modification, so no indeterminate results this round (`bun run build` was not
re-run — its exit-0 result in the table above stands).

`frontend/web` package scripts (source of truth): `dev`, `build`, `start` (`bun --bun next start -p 3000`),
`test:shapers` (see above), `verify:executor` (`scripts/verify/executor-paper-e2e.ts`),
`record:fixtures`, `dump:envelopes`, `generate:types` / `migrate` / `payload` (Payload CMS).

## 3. frontend/web — Next.js routes & pages

Route groups: `(frontend)` (store/admin surface) and `blog/(payload)` (Payload CMS admin + GraphQL).

### API routes (`src/app/(frontend)/api/**/route.ts`) — 35 routes

- **auth/admin**: `auth/{login,logout,callback}`, `admin/members`
- **data acquisition passthroughs**: `all`, `chainrank`, `coins`, `cryptorank`, `dex`, `khala`,
  `llama`, `markets`, `news`, `signals`, `ticker`, `ticker/instrument`, `ticker/instruments`
- **treasury**: `wallets`, `transactions`, `transactions/[id]`, `reconcile`
- **executor** (in-frontend execution runtime API): `executor/accounts` (list/create),
  `executor/accounts/[id]` (detail), `executor/accounts/[id]/test` (connectivity test),
  `executor/executions` (list/create), `executor/executions/[id]` (detail),
  `[id]/{start,pause,resume,cancel}`, `[id]/orders`, `[id]/fills`, `[id]/events`,
  `executor/preview` (plan dry-run), `executor/settings`, `executor/emergency` (kill-switch)

### Pages (`src/app/(frontend)/**/page.tsx`)

`/` (home), `login`, `member`, `admin` (+`admin/members-table.tsx` component),
team: `team/{balance,portfolio,reconciliation,transactions,wallets}`,
markets: `ticker`, `ticker/[ticker]`, `tracker`, `trench`, `dex`, `scoreboard`, `signals`,
data: `llama`, `khala`, `news`, `chainrank`, `cryptorank`,
executor: `executor`, `executor/new`, `executor/[id]`, `executor/accounts`, `executor/history`,
`executor/settings`.
Plus `sitemap.ts`, `robots.ts`, `globals.css`, root `layout.tsx`.

### Blog CMS (`src/app/blog/**`)

`(payload)/cms/admin/[[...segments]]`, `(payload)/cms/api/[...slug]`,
`(payload)/cms/api/graphql`, `(payload)/cms/api/graphql-playground`,
`blog/page.tsx`, `blog/[slug]/page.tsx`. Collections live in `src/cms/collections/`
(Posts, Users, Categories, Media) + `src/cms/migrations/`.

## 4. Database schemas (`database/schema/*.sql` — moved here from `frontend/web/db/`, Phase 2 of the domain restructure, 2026-10-01)
> Amended 2026-10-01: `frontend/web/db/` no longer exists; the schemas live at `database/schema/`
> per `database/README.md`. File semantics unchanged (table/DDL ownership is documented at
> top level in `docs/architecture/SCHEMA.md` §1–§2; `schema.sql` remains the Turso
> source-of-truth dump, DR-019).

| File | Dialect / role | Objects |
|---|---|---|
| `schema.sql` | SQLite (Turso) source-of-truth | `accounts`, `assets`, `journal`, `ledger`, `trades`, `transactions`, `venues`, `wallets` (+ `sqlite_sequence`) |
| `pg-schema.sql` | Postgres read model (projected from Turso by `scripts/tools/pg-load.ts`, DR-019) | same 8 tables + `asset_history` (indexes `asset_history_asset_ts`, unique snapshot), `price_history` (unique `price_history_symbol_ts_source`) |
| `executor-schema.sql` | Postgres `executor` schema (owned by the executor runtime; DDL mirrored in `src/platform/executor/store.ts` `EXECUTOR_DDL`, applied via `ensureExecutorSchema`) | `executor.exchange_accounts`, `executor.executions`, `executor.execution_plans`, `executor.child_orders`, `executor.fills`, `executor.execution_events`, `executor.balance_snapshots`, `executor.positions_snapshots`, `executor.risk_profiles`, `executor.audit_logs` (each with the indexes named in the file) |

Ownership today (feature → tables):

- **treasury/portfolio** (web `src/features/treasury/*`): `accounts`, `wallets`, `transactions`,
  `trades`, `journal`, `ledger`
- **markets/ticker** (web `src/features/ticker|markets/*`): `assets`, `venues`, `asset_history`, `price_history`
- **executor** (web `src/platform/executor/*`): all `executor.*`
- **analytics/sync pipeline**: `assets` rows are written by `backend/sync` (Turso), then
  projected to Postgres by `pg-load.ts` (web scripts) — ownership is split across two apps today.
- **DDL byte-identity (Phase-5 anchor): PASS** — `store.ts` `EXECUTOR_DDL` is asserted
  byte-identical (normalized) to `database/schema/executor-schema.sql` by
  `scripts/tests/executor-store-tests.ts` §59 ("no silent drift"); suite 41/41 green 2026-10-01
  (details in §5a).

## 5. Executor runtime (`frontend/web/src/platform/executor/`) — in-frontend execution engine

| Module | Responsibility (from its exports) |
|---|---|
| `types.ts` | Shared domain types: `MarketType` (`spot`/`linear_perp`), `Side`, `Intent`, `ExchangeId` (`binance`/`bybit`/`mexc`), `TimeInForce`, order/fill/execution records |
| `plan.ts` | Order planning & sizing: `validatePlanInputs`, `sizePosition`, `resolveEstimatedEntry`, `DEFAULT_SLIPPAGE_MODEL` |
| `risk.ts` | Risk math: `calculateRiskPosition`, `calculateProfitPosition`, `estimateNetProfit`, `resolveBalanceBasis`, price/qty rounding to instrument precision |
| `engine.ts` | Strategy engine: `createStrategy`, `defaultSlices` (TWAP-style slicing), child-order state machine `transitionChildOrder`, `strategyStep`/`strategyOnFill`/`strategyProgress` (strategy lifecycle for the strategies actually implemented — market, limit, TWAP, adaptive TWAP, iceberg, chase-limit, scale in/out; **no VWAP and no smart-limit exist in the TS oracle or the Go port**) |
| `exchange.ts` | Venue adapters: `CcxtLike` interface, `CreateAdapterOptions`, venue symbol mapping (`toVenueSymbol`/`fromVenueSymbol`), error sanitization/`mapError` |
| `worker.ts` | Execution worker: `createWorker` → `ExecutorWorkerApi`, child clamping (`clampChild`), fill summaries, live-adapter factory (`setLiveAdapterFactory`) |
| `lock.ts` | Distributed execution lock: `LockClient`, `lockKey(executionId)`, `executionLock` |
| `store.ts` | Postgres persistence for `executor.*` (`pg()`, `ensureExecutorSchema`, `EXECUTOR_DDL`), key handling (`masterKeyFromEnv` — encrypted exchange credentials) |
| `runtime.ts` | Bootstrap & request auth: `bootstrapExecutor`, `requireExecutorUser`, plan-adapter factory, runtime caches |

Adjacent:
- `src/features/executor/` — UI layer: `client.ts` (typed API client: Preview/Create/Lifecycle/List
  response types), `ui.tsx` (`ExecutorComposer`, `ExecutorProgress`, `ExecutorFrame`, `buildExecution`),
  `shapers.ts` (display formatting).
- `scripts/executor/worker.ts` — headless worker entry run by systemd
  `fudcourt-executor-worker.service` (Bun).
- Tests: `scripts/tests/executor-{engine,exchange,plan,risk,runtime,store,worker,ui}-tests.ts`
  (compiled by `tsconfig.shaper-tests.json` into `.shaper-tests/`, run offline via `node --test`).
- `scripts/verify/executor-paper-e2e.ts` — paper-trading end-to-end verifier (`verify:executor`).

### 5a. Phase 5 parity baseline (per-suite, 2026-10-01)
The 8 `executor-*-tests` suites are the deletion gate for the TS→Go port (migration-plan Phase 5).
Per compiled suite (`bunx tsc -p tsconfig.shaper-tests.json` exit 0, then
`node --require ./scripts/tests/alias-resolver.cjs --test .shaper-tests/scripts/tests/<suite>.js`):

| Suite | tests | pass | fail | exit |
|---|---|---|---|---|
| executor-engine-tests | 20 | 20 | 0 | 0 |
| executor-exchange-tests | 1 | 1 | 0 | 0 |
| executor-plan-tests | 25 | 25 | 0 | 0 |
| executor-risk-tests | 39 | 39 | 0 | 0 |
| executor-runtime-tests | 12 | 12 | 0 | 0 |
| executor-store-tests | 41 | 41 | 0 | 0 |
| executor-worker-tests | 9 | 9 | 0 | 0 |
| executor-ui-tests | 8 | 8 | 0 | 0 |
| **total** | **155** | **155** | **0** | — |

Coverage proof: `bun run test:shapers` (240/240, exit 0) runs exactly these 8 suites plus the
shaper/auth/rate-limit/db suites (85 tests) in one `node --test` invocation — the 155 executor
tests are a strict subset of the 240, so `test:shapers` already covers the executor parity surface.

**Executor-store-tests DDL byte-identity: PASS** (Phase-5 "no silent drift" anchor):
`ok 15 - §59: the embedded DDL matches the tracked database/schema/executor-schema.sql
(no silent drift)`; assert text on drift: "store.ts EXECUTOR_DDL and
database/schema/executor-schema.sql drifted apart".

`bun run verify:executor` — exit **1, environmental (not a code failure)**: the paper e2e needs
the credential master key; this environment has no `FUDCOURT_EXECUTOR_MASTER_KEY` (gate: 64 hex
chars; credential ops fail closed by design). It reached `-- schema + account` (schema ensured)
before failing at `createCredential`. Verbatim error:
```
error: FUDCOURT_EXECUTOR_MASTER_KEY missing or malformed (64 hex chars = 32 bytes required) - credential operations are fail-closed
at masterKeyFromEnv (/home/dwizzy/fudcourt/frontend/web/src/platform/executor/store.ts:256:15)
at createCredential (/home/dwizzy/fudcourt/frontend/web/src/platform/executor/store.ts:555:20)
at /home/dwizzy/fudcourt/frontend/web/scripts/verify/executor-paper-e2e.ts:100:29
```
**Go-side parity (2026-10-01, measured on this tree):** `backend/workers/executor` is a Go 1.25 module —
`go build ./... && go vet ./... && go test ./...` green, 19 internal packages + `cmd/executor`,
266+ test funcs (all three Go
modules together: 550+ test funcs). Row-by-row TS↔Go status lives in
[`parity-matrix.md`](parity-matrix.md) §cutover; every `DONE` row cites the Go suite that pins it.
The offline composed artifact of that matrix is `backend/workers/executor/internal/tests/e2e/` — 12 hermetic
scenarios (create→place→fill→complete, TWAP multi-child schedule with the §107 sum bound, lease
contention, restart-no-duplicate-order, cancel-resting, duplicate-start-noop,
disconnect-degrade-then-recover, rejected-order-then-replaces, partial-fill-then-complete,
plan/risk sizing) driving `worker` + `paper` + `MemoryLock` + `MemoryStore` together with no
Postgres/Valkey/credentials/network (stable under `-race -count=3`). That harness is the Go half of
the cutover gate; `verify:executor` above remains the live half and stays environment-gated.

## 6. backend/data (Go, was apps/apicalls) — data acquisition sidecar

Module `github.com/anvxxr-arch/fudcourt/backend/data`; entrypoint `cmd/data` (serves :3101,
"acquisition sidecar: CryptoRank" per its unit; also exposes the other fetchers).

| Package | Upstream | Role |
|---|---|---|
| `internal/research/llama` | `https://api.llama.fi` | DefiLlama fetch/parse/shape (protocols, TVL) |
| `internal/research/news` | `https://cointelegraph.com` | News fetch/parse/shape (RSS-style, author validation) |
| `internal/research/chainrank` | `https://www.chainrank.fyi` | ChainRank fetch/modes/shape |
| `internal/research/cryptorank` | `https://cryptorank.io` | CryptoRank fetch + envelope/marshal/shapers/types/value; parity & slice-semantics tests |
| `internal/research/khala` | `https://www.khala.io` | Khala research fetch/parse/shape |
| `backend/workers/executor` env | `FUDCOURT_EXECUTOR_MASTER_KEY` (64 hex, REQUIRED, fail-closed §128.23), `FUDCOURT_EXECUTOR_PG_URL`, `VALKEY_ADDR` (empty ⇒ in-process locks), `VALKEY_PASSWORD` (empty ⇒ no AUTH; a backend that REQUIRES a password fails startup, it does not run degraded), `FUDCOURT_EXECUTOR_HEALTH_ADDR` (127.0.0.1:3104), `FUDCOURT_EXECUTOR_QUANTITY_STEP`, `FUDCOURT_EXECUTOR_MAX_IN_FLIGHT`, `FUDCOURT_EXECUTOR_READY_TIMEOUT_MS` | startup refuses a missing/weak key, a missing DSN, a nonpositive budget or an unparseable timeout |
| `platform/cache` | filesystem (`FUDCOURT_DATA_CACHE_DIR`, `FUDCOURT_DATA_KHALA_CACHE_DIR`) + Valkey (`FUDCOURT_DATA_VALKEY_ADDR`, `FUDCOURT_DATA_VALKEY_PASSWORD`), TTL envs per source | shared response cache |
| `platform/httpx` | — | JSON/HTTP helpers |
| `internal/research/paritytest` | — | shared parity/golden-envelope test harness |

Config: per-source TTLs (`FUDCOURT_DATA_{LLAMA,NEWS,CHAINRANK}_TTL`), `FUDCOURT_DATA_CACHE=off` switch,
live tests behind `FUDCOURT_DATA_LIVE=1`. `bin/fudcourt-data` is the built binary referenced by the unit file.

## 7. backend/sync (Rust crate `fudcourt-sync`, was apps/sync)

Two binaries sharing `src/lib.rs`:

- `src/main.rs` → **`fudcourt-sync`**: live multi-chain balance sync → Turso `assets` table.
  Pipeline `src/sync.rs` (prices → balances → Hyperliquid → print → Turso), ported from
  `frontend/web/scripts/sync-live.py` with byte-identical output rules (`pyfmt.rs` Python-identical
  number formatting; `db.rs` Turso HTTP pipeline client with the same wire protocol;
  `jsonrpc.rs` retry/honesty rules — a failed RPC call never becomes a zero balance;
  `chains.rs` chain/wallet/price-oracle registry transcribed from the Python original).
  Scheduled by `fudcourt-sync.timer` (every 5 min).
- `src/bin/fudcourt-reconciled.rs` → **`fudcourt-reconciled`**: bounded HTTP/1.1 service
  (`src/server.rs`) serving `/api/reconcile` (:3102) — Rust port of
  `frontend/web/app/api/reconcile/route.ts` (DR-014); reconciliation math in `src/reconcile.rs`.
- Tests: `tests/reconcile.rs` + inline tests (17 total, all passing).

Note: the Python originals (`frontend/web/scripts/tools/sync-live.py`, web `api/reconcile`) still exist
and are still wired to the **web** `fudcourt-sync.service`/`.timer` in `infrastructure/systemd/`; the Rust
variants in `infrastructure/systemd/` (`fudcourt-sync-rust.*`) are the parallel "Rust" pair. Both are live in the tree.

## 8. Systemd units (WorkingDirectory / ExecStart)

| Unit | WorkingDirectory | ExecStart | Purpose |
|---|---|---|---|
| `infrastructure/systemd/fudcourt-web.service` | `/home/dwizzy/fudcourt/frontend/web` | `bun --bun …/next start -p 3100` | Next.js web :3100 |
| `infrastructure/systemd/fudcourt-executor-worker.service` | `…/frontend/web` | `bun …/frontend/web/scripts/executor/worker.ts` | in-frontend executor worker |
| `infrastructure/systemd/fudcourt-pgload.service` (+ `.timer`, 60s) | `…/frontend/web` | `bun run …/scripts/tools/pg-load.ts` | Turso → Postgres read model (DR-019) |
| `infrastructure/systemd/fudcourt-sync.service` (+ `.timer`, 5 min) | `…/frontend/web` | `python3 …/scripts/tools/sync-live.py`, `ExecStopPost: bun run pg-load.ts` | **Python** balance sync → Turso |
| `infrastructure/systemd/fudcourt-data.service` | `…/backend/data` | `…/backend/data/bin/fudcourt-data` | Go acquisition sidecar :3101 |
| `infrastructure/systemd/fudcourt-sync-rust.service` (+ `.timer`, 5 min) | `…/backend/sync` | `…/backend/sync/target/release/fudcourt-sync` | **Rust** balance sync → Turso |
| `infrastructure/systemd/fudcourt-reconciled.service` | `…/backend/sync` | `…/backend/sync/target/release/fudcourt-reconciled` | Rust reconcile service :3102 |

Ingress: `fc.dwirijal.my.id` via Cloudflare Tunnel to the loopback origin (DR-002, fail-closed).

## 9. CI (`.github/workflows/ci.yml` — single workflow, 4 jobs)

| Job | Working dir | Steps |
|---|---|---|
| `web` | `frontend/web` | bun install --frozen-lockfile → check-contract → check-deploy → check-structure → `tsc --noEmit` → `test:shapers` → live reconcile harness vs Rust `fudcourt-reconciled` (needs `TURSO_AUTH_TOKEN`, warns+skips otherwise; builds `backend/sync` from the same commit) → `bun run build` |
| `fudcourt-data` | `backend/data` | `go build ./...` → `go vet ./...` → `go test ./...` (Go 1.24.1) |
| `sync` | `backend/sync` | `cargo build --release --bins` → `cargo test --release` (stable) |
| `hooks` | repo root | `bash -n scripts/githooks/pre-push` |

Toolchain pins: Node 22 runtime, Bun 1.4.2, Go 1.24.1, Rust stable.

## 10. Cross-boundary imports (see domain-map.md for the full list)

- **Executor internals reach deep into web**: production files outside
  `src/platform/executor/` import its internals — 15 `api/executor/**` route handlers,
  `scripts/executor/worker.ts`, `scripts/verify/executor-paper-e2e.ts`, and
  `src/features/executor/{client,ui}`. Of these, all 15 routes + worker + paper-e2e
  import the **sensitive** modules directly (`risk`, `exchange`, `lock`, `store`, `plan`, `engine`).
- **Shell depends on features** (upward): `src/components/layout/store-shell.tsx` imports 16+
  feature pages (`@/features/{dashboard,portfolio,wallets,transactions,treasury,dex,signals,scoreboard,chainrank,…}`)
  — the layout component wires the whole store UI.
- **Web owns execution concerns** that the target architecture assigns to Go services:
  risk sizing, exchange adapters/signing (`exchange.ts` `CcxtLike`, `masterKeyFromEnv` encrypted
  keys in `store.ts`), the worker loop, distributed lock, and `executor.*` persistence.
- No cross-service source imports exist (Go ↔ Rust ↔ TS are coupled only through HTTP, Turso,
  and the shared `.sql` files).
