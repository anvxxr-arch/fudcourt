# Final Review — domain restructure

> Independent, current-state review of the `refactor/domain-architecture` branch.
> Every claim below was re-derived from the working tree on 2026-10-01 (commands
> in §7), not carried over from the migration plan. Where a phase is **not**
> complete, it says so and names the blocker; nothing here is marked done on the
> strength of a plan.
>
> Audience: whoever touches FUDCourt next. The point of the restructure is domain
> ownership — "who owns the data, who makes the decision, which service do I
> touch" — and this file records how far that holds today.

Scope note: the objective is a multi-phase restructure (`docs/architecture/migration-plan.md`,
`.ai/restructure-fudcourt.md`). This review covers **Phases 0–12 as they stand** and is
explicit about the two phases that are gated on a money-path cutover and therefore
deliberately not executed (Phase 5 deletion, Phase 7 cleanup).

---

## 1. Final repository tree

> **Corrected 2026-10-01 (docs-reality pass).** This block previously printed the
> **pre-move** tree (`apps/web`, `services/{api,executor,data,sync}`,
> `packages/{contracts,sdk-ts}`) — none of those directories exist on this branch.
> The tree below is `ls`-derived from the working tree; the pre-move snapshot is
> preserved in git history (and in the "Files moved" ledger in §2).

```
fudcourt/
├── frontend/web/               Next.js 16.3.6 + Bun — UI, SSR, thin BFF, Payload blog
│   ├── src/{app,cms,components,features,platform,styles}
│   ├── scripts/{checks,executor,tools}                  # `executor/` carries the DR-043 tombstone only
│   └── tests/                  web-only suites (shaper/auth/rate-limit/db/executor-ui)
├── backend/
│   ├── api/                    Go — primary backend (identity, admin, portfolio,
│   │                           treasury, wallets, transactions, markets, ledger)
│   ├── workers/executor/       Go — execution engine (risk, sizing, planner,
│   │                           strategies, exchange adapters, worker, locks, repo,
│   │                           credentials, cmd/executor service binary)
│   ├── data/                   Go — external data (cryptorank, khala, llama,
│   │                           chainrank, news, cache); the `fudcourt-data`
│   │                           sidecar on :3101
│   └── sync/                   Rust — balance sync + /api/reconcile
├── shared/
│   ├── contracts/              OpenAPI + event catalog + schemas (source of truth)
│   └── sdk/typescript/         generated TS client
├── database/schema/            pg-schema.sql (treasury system of record) ·
│                               executor-schema.sql (execution ledger)
├── tests/{e2e,integration,fixtures,oracle}/   # only `tests/{integration/api,fixtures,oracle/fixtures}` are populated;
│                               # the executor subdirs under e2e/ + integration/ were retired by DR-043
├── deploy/systemd/     10 files: 7 live units (web, api, data, executor,
│                               sync, sync.timer, reconciled) + 3 retired .txt
│                               tombstones (apicalls, blog, executor-worker)
├── scripts/{database,githooks,verify}/  schema drift alarm · pre-push hook ·
│                               verify-all.sh (one-command offline gate)
├── docs/{architecture,operations,prd,product,records}/
├── .github/workflows/          web · go · rust · contracts · integration (path-filtered)
├── go.work · go.work.sum · package.json · README.md
```

Absent vs. the objective's target sketch, and why (all documented, none silent):
`packages/config` (no shared TS config exists to move — DR-018 keeps one tsconfig per app);
`infrastructure/{docker,compose}` (no container config exists — DR-002 self-hosted systemd + Cloudflare
Tunnel); `database/{migrations,seeds,fixtures}` (empty — `migrations/` deliberately not created,
DR-020); `Cargo.toml` at root (single Rust crate lives in `backend/sync`). These are omissions of
*non-existent* things, not missing work.

## 2. Files moved

*Historical ledger* — every row below describes a move that happened in an earlier
commit; the `From` paths no longer exist on disk. Kept as the audit trail, not as
current state.

This session (uncommitted at the time of writing; see §7):
| From | To | Method |
| --- | --- | --- |
| `.github/workflows/ci.yml` (single 6-job workflow) | `.github/workflows/{web,go,rust,contracts,integration}.yml` | `git rm` + 5 new files (Phase 9) |

Already moved in earlier commits on this branch (verified via `git log`):
| From | To | Commit |
| --- | --- | --- |
| `apps/apicalls/` | `backend/data/` | `4e8ba91` (Phase 1) |
| `apps/sync/` | `backend/sync/` | `4e8ba91` (Phase 1) |
| `apps/web/db/*.sql` | `db/schema/*.sql` | `4e8ba91` (Phase 2) |
| `apps/web/infrastructure/*`, `apps/apicalls/infrastructure/*`, `apps/sync/infrastructure/*` (`*.service`, `*.timer`) | `deploy/systemd/` | `94a2ee1` (Phase 10) |

## 3. Files created

- **Phase 3 (contracts):** `contracts/{openapi/fudcourt.yaml, events/{catalog.json,event.schema.json}, schemas/{error,event}-envelope.json, scripts/check-contract.mjs}`; `shared/sdk/typescript/**` (committed `d4d87e7`).
- **Phase 4 (api):** `backend/api/**` — 18 internal packages, 112 test funcs (committed `3702c6c`);
  regrouped 2026-10-01 into bounded contexts (`access/`, `accounts/`, `finance/`, `markets/` —
  `ARCHITECTURE.md` §2a, `domain-map.md` §4). Pure `git mv`: same package count, same 112 test
  funcs, no behavior/route/export change.
- **Phase 5 (executor):** `backend/workers/executor/**` — 19 internal packages, **253** test funcs (committed `4ef371a`).
- **Phase 9 (CI):** the five path-filtered workflows (§2) + `scripts/verify/verify-all.sh` (one-command offline gate).
- **Phase 10 (deploy):** `deploy/systemd/{fudcourt-api,fudcourt-data,fudcourt-executor}.service` (+ existing units).
- **Phase 8 (tests):** `tests/integration/api/check-api-contract.py` — a cross-service gate that did not exist before (§6).
- **Docs:** `docs/architecture/{current,target,domain-map,migration-plan,executor,events,security,parity-matrix,final-review}.md`.

## 4. Files removed

- `.github/workflows/ci.yml` — superseded by the five domain workflows (this session).
- `apps/web/infrastructure/*` (7 units), `backend/data/infrastructure/*`, `backend/sync/infrastructure/*` — consolidated into `deploy/systemd/` (commit `94a2ee1`).
- `apps/blog/**`, the flat `apps/web/app/**` layout — removed in the earlier "repurpose" commit `5e68576`.

**Removed in this session (2026-10-05, DR-043):** `apps/web/src/platform/executor/**` (8,024 LOC → 0), `apps/web/scripts/executor/worker.ts` (preserved as a 5-line tombstone in the still-present `scripts/executor/` directory), the 9 TS-runtime test files (`tests/{e2e,integration}/executor/**`, `apps/web/tests/executor-proxy-tests.ts`), and the `fudcourt-executor-worker.service` systemd unit (renamed to `RETIRED-fudcourt-executor-worker.service.txt`). The 15 `/api/executor/*` route handlers are now one-line forwarders through `src/app/(frontend)/api/executor/_proxy.ts`. The wire contract `src/platform/executor/types.ts` is the only TS-side survivor (consumer-facing). The matrix's `TS modules deleted` row closes to **DONE 2026-10-05 (DR-043)**, and §6 rows 1–3 flip to RESOLVED (same date).

## 5. Architecture decisions

Recorded as DR-022 … DR-030 in `docs/records/DECISIONS.md` (Go default / Rust specialized;
Postgres = durable truth, Valkey = ephemeral; no broker/orchestrator; executor moves to Go with TS
as parity oracle; canonical exchange interface; OpenAPI as contract source of truth; immutable
ledger; portfolio is derived; append-only events). Current-state highlights:

- **One shared artifact.** Services share `shared/contracts` only. Verified: each Go module
  (`backend/{api,workers/executor,data}`) imports **only its own** module path — zero cross-service
  implementation imports (§7 evidence).
- **Contract is machine-checked.** `contracts/scripts/check-contract.mjs` gates enums
  (OpenAPI ⇄ `types.ts`) and route coverage; the new `tests/integration/api/check-api-contract.py`
  gates the Go api's live route table ⇄ contract ⇄ web BFF proxy table (§6).
- **CI is domain-aware with a stable required check.** Each workflow always runs and ends in a
  `gate` job that reports success for a *skipped* (no relevant files changed) or a *successful*
  surface, so a path filter never leaves a required check "waiting" forever.

## 6. Remaining technical debt (with evidence)

| # | Item | Evidence | Blocked on |
| --- | --- | --- | --- |
| 1 | ~~**TS executor still in `frontend/web`** — 8,024 LOC, 10 modules~~ **RESOLVED 2026-10-05 (DR-043)** | `find frontend/web/src/platform/executor -type f` → exactly one file: `types.ts` (the wire contract); the 9 runtime modules + the worker entry + 9 TS-runtime test files are deleted; `apps/web/scripts/executor/worker.ts` is preserved as a tombstone; the systemd unit renamed to `deploy/systemd/RETIRED-fudcourt-executor-worker.service.txt` (3-line header). | none — DR-043 closed this. Web↔Go route parity proven (`diff <(curl :3100/api/executor/executions) <(curl :3105/api/executor/executions)` empty for a minted team session); `fudcourt-executor.service` active on :3104+:3105; `bun run verify:executor` is `go test -count=1 -race ./backend/workers/executor/internal/tests/e2e/...` (12 tests, hermetic, <1 s). |
| 2 | ~~**15 web route handlers still import `platform/executor`**~~ **RESOLVED 2026-10-05 (DR-043)** | the 15 handlers are now 4-line shells forwarding to `src/app/(frontend)/api/executor/_proxy.ts`; the only `@/platform/executor` imports in `apps/web/src` are the 5 consumer-side type imports of the wire contract (`trade/{client,intent,ui/composer}.ts` + `features/executor/{client,ui}.tsx`). The single mention of the old path left in the tree is a doc comment inside `src/platform/executor/types.ts` (the renamed home) that explains the move — it is text, not an import. | none |
| 3 | ~~**EXECUTOR DDL still embedded in `store.ts`**~~ **RESOLVED 2026-10-05 (DR-043)** | the TS `store.ts` is gone (see row 1). The Go runtime applies the tracked DDL at startup (`apps/executor/internal/repository.EnsureSchema`, `internal/repository/schema.go`), and its `embed` copy is pinned BYTE-EXACT by `TestEmbeddedSchemaMatchesTracked`. The test that previously pinned the TS half is gone with the file. | none |
| 4 | **Phase 8 move of `apps/web/scripts/verify/*` — ~~not executed~~ EXECUTED** | the relocation landed in one commit: repo-wide gates → `scripts/verify/`, executor E2E → `tests/e2e/executor/` (later retired by DR-043), fixtures → `tests/fixtures/`, oracle → `tests/oracle/`, database tooling → `scripts/database/`, web-only suites → `apps/web/tests/`. Every invoker repointed (verify-all, pre-push, integration.yml, check-contract, root README, package.json); `test:shapers` is now **213/213** across 11 shaper files (was 20 files / 240 tests pre-DR-043; the 9 deleted TS-runtime suites' assertions are covered by the named Go counterparts in `parity-matrix.md` rows 1–9). The `verify-*.py` harnesses remain repo tools (their UI-wiring checks read `apps/web/src/**`), not web-app-only — `git ls-files`; `scripts/verify/{verify-*,monitor}.py`; `tests/{oracle,integration/api,fixtures}/` (the executor subdirs under `tests/e2e/` and `tests/integration/` are gone); `bun run test:shapers` | none |
| 5 | ~~**`api` lists "admin" as a hosted context but has no `internal/admin`**~~ **RESOLVED** | the false claim is gone: `apps/api/main.go` now names the `/api/admin/members` route plane, `identity.TierAdmin`, and the handlers in `cmd/api/{routes,errors}.go`, with an explicit note that splitting it into `internal/admin` is deferred. `go build ./backend/api/...` green. Package split remains a legitimate follow-up; the misleading comment does not. |
| 6 | **`request_id` was missing from the executor's four required identifiers** (PRD §66 names `execution_id`, `request_id`, `client_order_id`, `event_id` — only three existed) | `idempotency.RequestID` (`req_<exec>_<seq>`) + `ParseRequestID` added; refuses foreign ids incl. `fud_...` client order ids so the two id spaces can never be cross-parsed. Verified by `TestRequestIDAndClientOrderIDAreDistinct` + `TestRequestIDIsStableAcrossRetry`. Restart/duplicate proof runs against the REAL paper venue: `TestPaperRestartNoDuplicateOrder`, `TestPaperDuplicateStartIsNoOp`, `TestPaperRejectedOrderThenReplaces` all green in `internal/tests/e2e`. | none — gate 5 of `.ai/prompts/executor-migration.md` closed |

| 7 | **Sync oracle gate wired (Phase 6) — done, committed** | `verify-sync.py` + `tests/oracle/fixtures/{capture.json,expected-projection.txt,make-capture.py}` exist and the gate is in `verify-all.sh`; run output `SYNC_ORACLE_OK (34 rows, 40 request keys)` | none (committed; §9.3) |

Items 1–4 are now RESOLVED. The executor cutover is closed (DR-043, 2026-10-05): the TS executor tree is gone, the 15 web route handlers are forwarders, the EXECUTOR DDL is owned by the Go runtime, and the offline move was already EXECUTED.

### Definition-of-Done map (objective → current-state evidence)

| # | Objective "done when" | Status | Evidence (this tree, 2026-10-01) |
| --- | --- | --- | --- |
| 1 | `frontend/web` no longer owns executor runtime | **MET (DR-043, 2026-10-05)** | `find frontend/web/src/platform/executor -type f` → exactly one file: `types.ts` (the wire contract — consumer-facing only, no runtime path, no imports out, no executables, no DB, no HTTP). `apps/web/scripts/executor/worker.ts` is preserved as a 5-line tombstone. The 9 TS-runtime test files are gone. `verify:executor` is the Go hermetic e2e. Web↔Go route parity proven on every `/api/executor/*` URL with a minted team session. |
| 2 | `frontend/web` no longer owns DB schema | MET | `find frontend/web -name '*.sql'` → none; DDL lives in `db/schema/{schema,pg-schema,executor-schema}.sql` |
| 3 | `apps/apicalls` → `backend/data` | MET | `apps/apicalls` absent; `backend/data/{cmd/data,internal/*}`, module path rewritten |
| 4 | Rust sync under `backend/sync` | MET | `backend/sync/{src,tests,Cargo.toml}`; `cargo test --release` green |
| 5 | `backend/api` is the primary Go API | MET | 18 internal packages, 112 test funcs; 4 routes live; conformance-gated vs contract |
| 6 | `backend/workers/executor` owns executor logic | **MET (DR-043, 2026-10-05)** | the Go runtime is the sole owner. 19 internal packages + 21 `internal/api` funcs (route surface) + 12 composed hermetic e2e tests + 8 paper/worker gate tests; the TS tree is gone; the systemd unit is retired to `RETIRED-fudcourt-executor-worker.service.txt`. |
| 7 | exchange adapters use a common abstraction | MET | `internal/exchanges/{interface,types,symbols,classify}.go` + `binance/bybit/mexc/paper`; no venue branching outside the package |
| 8 | PostgreSQL is the durable execution truth | MET | `db/schema/executor-schema.sql` (10 tables) + `internal/repository`; **proven live this session** — the DSN-gated `TestStoreEndToEnd`/`TestStoreNewFailLoud` run green against a throwaway local Postgres with that schema applied (`4959f8f`) |
| 9 | Valkey only ephemeral coordination | MET | `internal/platform/lock/{valkey,memory}.go`; durable state is Postgres |
| 10 | API contracts centralized | MET | `contracts/{openapi,events,schemas}`; `CONTRACTS_OK` gate |
| 11 | cross-service tests outside `frontend/web` | MET | `tests/integration/api/check-api-contract.py`, `tests/oracle/fixtures/` |
| 12 | each deployable has clear ownership | MET | `deploy/systemd/` 12 units; `check-deploy` OK |
| 13 | CI is domain-aware | MET | `.github/workflows/{web,go,rust,contracts,integration}.yml` |
| 14 | services do not import each other's impl | MET | each Go module imports only its own path (§5) |
| 15 | existing product behavior compatible | MET | `verify-all.sh` green; host units active |
| 16 | migrated executor has parity tests | **MET (DR-043, 2026-10-05)** | every row of `parity-matrix.md` is `DONE`; `tsc --noEmit` clean; `bun run test:shapers` 213/213; `go build/vet/test ./backend/workers/executor/...` green (21 pkgs); `bash scripts/verify/verify-all.sh` → `VERIFY_ALL_OK`; `find frontend/web/src/platform/executor -type f` → 1 (only `types.ts`); `grep -rln "from '@/platform/executor" frontend/web/src frontend/web/tests tests` → only the 5 consumer-side type imports of the wire contract. |
| 17 | build/test status documented | MET | §7 + `scripts/verify/verify-all.sh` |

### Objective "Goal terukur" acceptance metrics (re-derived this session)

The DoD rows above answer the prose "definition of done"; below is the objective's
separate **acceptance-metrics** block, each proven by a command (not asserted).
The "0 executor logic in `frontend/web`" metric is now MET (DR-043, 2026-10-05) —
the executor tree is gone, the wire contract has no runtime, and the tombstone is
the only vestige.

| Metric | Required | Evidence (current tree) |
| --- | --- | --- |
| DB schema files inside `frontend/web` | 0 | `find frontend/web -name '*.sql'` → **0** |
| exchange credentials / signing handled by frontend | 0 | **MET (DR-043, 2026-10-05)** — the only `node:crypto` calls remaining in `frontend/web` are the session-cookie HMAC in `apps/web/src/platform/auth/session.ts` (the only secret that was ever at the web tier, and stays there because the web tier is its only issuer/verifier). The exchange-credential vault is in the Go service (`apps/executor/internal/platform/credentials`, AES-256-GCM sealed per field under `FUDCOURT_EXECUTOR_MASTER_KEY`); no request signing happens in the web tier; no `sealSecret`/`openSecret` in the web tier; `node:crypto` is no longer imported by the executor path. The Go `apps/executor/internal/platform/credentials` package is the canonical owner of the exchange credentials. |
| cross-service implementation imports | 0 | `grep` for `backend/{api,workers/executor,data}/` imports inside the Go services → **none**; `backend/data` mentions `executor` nowhere; `backend/sync` only names TS files in *provenance comments* (`src/{main,chains,reconcile}.rs`), not imports |
| canonical risk engine | 1 | exactly one `risk.go` → `apps/executor/internal/risk/risk.go` (+31 test funcs) |
| canonical sizing implementation | 1 | exactly one `sizing.go` → `apps/executor/internal/sizing/sizing.go` (+16 test funcs) |
| canonical exchange abstraction | 1 | `apps/executor/internal/exchanges/{interface,types,symbols,classify}.go` + `binance/bybit/mexc/paper`; no venue branching outside the package (85 test funcs) |
| contract source of truth | 1 | `contracts/`: `openapi/fudcourt.yaml`, `events/{catalog,event.schema}.json`, `schemas/{error,event}-envelope.json`, gated by `CONTRACTS_OK` |
| core executor logic inside `frontend/web` | 0 | **MET (DR-043, 2026-10-05)** — `find frontend/web/src/platform/executor -type f` → 1 (only `types.ts`; the wire contract has no runtime path: types only, no imports, no executables, no DB, no HTTP). The 9 deleted TS-runtime test files' assertions are covered by the named Go counterparts per `parity-matrix.md` rows 1–9 (253+ test funcs across 19 internal packages). |
| independently deployable: web / api / data / executor / sync | 5 | `deploy/systemd/fudcourt-{web,api,data,executor,sync}.service` all present; `check-deploy` OK; `/api` independently built (`go build ./...` OK) |
| ownership discoverable | — | gate `check-structure.py` OK (DR-018 layers), i.e. a stray cross-boundary file fails CI |

Cross-checked gates for the block above (all green this session): `check-structure` OK,
`check-deploy` OK, `check-contract.mjs` `CONTRACTS_OK`, `check-api-contract.py`
`API_CONTRACT_OK`, `go build` OK for `backend/api` and `backend/data`.

## 7. Test / build results (current working tree, 2026-10-01)

One command: `bash scripts/verify/verify-all.sh` → **`VERIFY_ALL_OK`** (exit 0). Per gate:

| Gate | Result |
| --- | --- |
| structure (DR-018 layers) | PASS |
| web contract (CR_MODES + llama/news parity + khala/chainrank sidecar-only rows + mutation guards) | PASS |
| deploy-unit guard (12 units: ExecStart paths, absolute, timer pairs) | PASS |
| contracts drift (enums, 36 OpenAPI paths, 39 route handlers, 28 events) | `CONTRACTS_OK` |
| sdk-ts generated-SDK drift + typecheck | PASS |
| **cross-service api conformance** | `API_CONTRACT_OK go_paths=4 documented=36 web_proxies=4` |
| Go build/vet/test ×3 modules | PASS (api **112**, executor **253**, data **178** test funcs at HEAD) |
| Rust build/test | PASS (17 test fns) |
| **sync oracle gate** (`verify-sync.py`) | PASS — 9 checks, `SYNC_ORACLE_OK (34 rows, 40 request keys)` |
| **composed Go paper E2E** (`internal/tests/e2e`) | PASS (**12** tests, hermetic) |
| pre-push hook syntax | PASS |
| web typecheck + shaper fixtures | PASS (**213** tests, 11 files) |

**Committed HEAD is green — verified on the live tree, not in a worktree.**
`bash scripts/verify/verify-all.sh` returns `VERIFY_ALL_OK` (exit 0) against the current
working tree with **no uncommitted edits** (`git status --short` → clean). Every gate above
was re-derived this session from the committed state: `check-structure` OK (139 files),
`check-deploy` OK, `check-contract.mjs` `CONTRACTS_OK enums=3 openapi_paths=36
route_handlers=39 events=28 client_endpoints=17`, `check-api-contract.py`
`API_CONTRACT_OK go_paths=4 documented=36 web_proxies=4`, `go build/vet/test` OK for all
The executor module now carries **253** test functions across 19 internal packages plus the
composed harness in `internal/tests/e2e` (12 tests).
composed harness in `internal/tests/e2e` (12 tests).

The harness is the first executor test to drive the **real** worker + **real** `exchange/paper` venue + **real** `lock.MemoryLock`
composed harness in `internal/tests/e2e` (12 tests). The harness is the first executor test to
drive the **real** worker + **real** `exchange/paper` venue + **real** `lock.MemoryLock`
over a `worker.MemoryStore` with a hand-advanced `FixedClock` — no Postgres, no Valkey,
no credentials, no sleeping, so it runs in plain `go test` on any machine. It covers
create→start→recovery→place→fill→complete, lease contention (§65/§127.4), restart
without duplicate (§66/§127.5), cancel a resting entry (§127.6), duplicate-start no-op
(§23), simulated disconnect degrade-then-recover (§76), plan + risk-based sizing
(§127.1), and **TWAP slice scheduling** (§8.15/§28 — the plan releases as multiple
children over the window, each sized from the remainder, and closes fully released
even when no slice ever filled).
**The tree is clean and green.** `bash scripts/verify/verify-all.sh` returns
`VERIFY_ALL_OK` (exit 0) against the current tree, and `git status` is **empty** — the large
uncommitted wave that was present earlier in the session (§10) has since been committed. During the
session the `apps/executor/internal/platform/lock` package did flap while a concurrent writer held an
in-progress edit of it (`valkey.go` + `valkey_test.go`, plus `zz_probe*_test.go` scratch files);
observed states included a missing `fakeValkey` type, literal CR bytes inside string literals, a
scripted server that never served its steps, and a syntax error at `valkey_test.go:649`. That
writer has since landed their work (with garbage-collection for the handshake error, below), so the
package is green. Every gate is now stable and verified individually:
`check-deploy` OK, `check-structure` OK (139 files), `check-contract` OK (28 CR modes + 5 family
parities), `check-contract.mjs` CONTRACTS_OK, `check-api-contract.py` API_CONTRACT_OK,
`go build/vet/test` OK for all three Go modules, `cargo build/test` OK for `backend/sync`,
`bash -n pre-push` OK.

Verification of the two fixes made this session (each proven, not asserted):
- **Deploy gate** (`check-deploy.py`): simulated a fresh clone by deleting
  `services/{data,executor}/bin/*` → gate still PASS; then pointed one unit at a
  non-existent binary → gate FAILS (exit 1). Both directions confirmed.
- **Cross-service gate** (`tests/integration/api/check-api-contract.py`): added a web
  proxy route with no Go counterpart → gate FAILS naming the 502-in-production path;
  removed it → gate PASSES.
- **Valkey AUTH handshake** (`internal/platform/lock/valkey.go`): the handshake created a *second*
  `bufio.Reader` for the AUTH reply, which could buffer past `+OK` and swallow the command
  reply — a lock that looks unavailable (fail-closed) on a healthy Valkey. Fixed by sharing one
  reader across both replies on the connection; the scripted fake server was fixed in the same
  pass (an AUTH step now also serves its command over the same connection, mirroring `do`).
- **Sync oracle gate** (`verify-sync.py`, added this session): perturb one wei in the
  recorded capture → the gate FAILS with the exact diverging line and exit 1; restore → PASS.
  Both directions confirmed, so the gate is proven able to fail, not merely to pass.

**Committed HEAD is green (verified in an isolated `git worktree --detach HEAD`).**
A clean checkout of HEAD builds and tests clean across every module:
`go test ./...` OK for `backend/workers/executor`, `backend/api`, `backend/data`;
`cargo test --release` OK for `backend/sync`. Doing this in a worktree (not the
shared tree) is what makes the claim about *committed* state — the shared tree
carries the writer's uncommitted edits above.

**Re-audit (later same day).** HEAD advanced to `0feb6e2` (+ this doc commit). Committed HEAD
is still fully green — re-verified on a clean `git worktree --detach HEAD`: `go vet`/`go test
./...` clean for `backend/workers/executor`, and `verify-all.sh`'s non-Go steps (structure, contract,
api-contract, sync-oracle, deploy, contracts, web typecheck, sync, data) all pass. The only
shared-tree red is the concurrent writer's untracked, mid-edit `apps/executor/executor/
health.go` + `health_test.go` (observed states: `undefined: errInvalidProbeTimeout`, then
`fakeLock redeclared` against the tracked `main_test.go`) — an in-flight edit, not a committed
regression; the writer has landed the symbol and the production `go build` returns clean between
edits.

**Re-audit 2 (later same day).** HEAD advanced further (`98afa1f`, `2207f80`, `7b090e1` — the
writer closing parity gates 5/6: `RequestID` idempotency ids, and the `internal/admin` debt
comment). Every count in §1–§7 was re-derived from committed HEAD with `git grep '^func Test'
HEAD -- services/<m>`: executor **266+** (moving — the writer keeps adding tests, so cols cite a
floor), api 112, data 178, three modules 550+; internal packages 19 (executor) / 18 (api) /
8 (data); deploy units 12. Numbers stated as *exact* are stable; numbers stated as *N+* are
floors that will only grow. Committed HEAD remains green; the shared tree's only red is still
the writer's in-flight `cmd/executor/health*.go`.

## 8. Known regressions

**None outstanding.** Eight failures were found and fixed; all were pre-existing in the
working tree or in the branch's committed history (none caused by this session's changes — checked
against the baseline and against `94a2ee1`/`642e7ef`):
1. `apps/api/main.go:5` — a comment line missing its `//` (`notifications, jobs.`),
   a Go **syntax error** that failed `go build ./backend/api/...`. Fixed (line is a comment again).
2. `contracts/openapi/fudcourt.yaml` — referenced **29 undefined components**
   (`RateLimited`, `MutationUnauthorized`, and 27 data-surface schemas), so `bun run generate`
   failed and the whole SDK/contract gate was red. Fixed by defining every referenced component.
3. **`apps/executor/executor` test did not compile at HEAD** — commit `642e7ef` landed
   `main_test.go` ahead of its `main.go`/`Acquire` implementation (`undefined: loadConfigFrom`);
   production `go build ./...` still passed, so only the *test* target was red. The writer's working
   tree held the coherent completion; this session landed it (`befd141`, `25cd532`) and verified HEAD
   in an isolated worktree. The "split by 7d90520" wording in `befd141`'s message is wrong and is
   corrected here: `git show --stat 7d90520 -- backend/workers/executor/cmd/executor/` is empty.
4. **`internal/runtime/worker` clobbered a terminal landing with the stale status** — `drive()` re-saved
   the execution record *after* `runActions`, so any pass that landed a terminal/paused status
   (`StrategyComplete`→`FILLED`, cancel→`CANCELLED`, risk-stop) had that status overwritten by the
   pre-action `RUNNING`: a fully filled execution was silently resurrected and re-driven every tick
   forever. Found by the new composed harness (`internal/tests/e2e`), which is the first test to reach the
   completion path; existing worker tests never did. Proven red at the prior HEAD
   (`git worktree --detach HEAD` + the harness → `TestPaperMarketLifecycle` and
   `TestPaperRestartNoDuplicateOrder` fail there), fixed (`9688722`) by persisting the engine state
   **before** acting, green after (`5f8a8ba` adds the harness).
5. **`ValkeyLock.do` AUTH handshake surfaced as a bare `io: read/write on closed pipe`** — the
   `TestValkeyLockAuthHandshake` wire test failed intermittently (5s ctx timeout on the SET write)
   because every dial/transport/protocol error returned through `Acquire`'s `ErrUnavailable` wrapper
   with no label, so the failing phase was invisible. Root cause was NOT in the test: the harness
   (`fakeValkey`) was already correct — `Dial` reserves both steps for a `multi` AUTH step and
   `serve` replays step idx+1 on the same connection. Fixed in production code (`024fadd`): each
   write/read in `do` now wraps its error with a context label (`lock: AUTH write/read`,
   `lock: command write/read`). Verified: `go test -race ./internal/platform/lock/` green 3× consecutively,
   and `TestValkeyLockAuthHandshake`/`TestValkeyLockAuthRejected` both pass. No behavior change —
   the fail-closed contract is untouched; only the error string carries more information.
6. **`internal/runtime/worker.isRetryable` misclassified every venue error as retryable** — it looked for a
   `Retryable() bool` *method* by unwrapping the error chain, but adapters and the `paper` simulator
   put retryability in `exchange.VenueError.Class.Retryable`, a **field**; nothing implements the
   method, so the lookup always fell through to the fail-safe default `true`. Consequence: a
   *rejected* order (`invalid_order` / `permission_error` / `insufficient_balance`) never landed
   `REJECTED` — it stayed `SUBMITTING` forever, never freeing its clamp room (§107) and never
   pausing the strategy. Found by the composed harness's rejection scenario (no existing worker test
   covered a non-retryable placement failure). Proven red at the prior HEAD
   (`TestPaperRejectedOrderThenReplaces`), fixed (`83b62b6`) by routing through
   `exchange.Classify` (resolves `VenueError.Class`, an explicit `Retryable()` signal, and
   deadlines) — only an explicit non-retryable class rejects, and an *unclassifiable* error still
   keeps `SUBMITTING` so reconciliation decides (§66).

7. **Composed Go paper harness gained the TWAP vector** (`994e5aa`) — `TestPaperTwapSlices`
   proves a TWAP execution releases its plan as multiple children over the window, each slice
   sized from the remaining plan, and the window closes with the plan fully released even when
   no slice ever filled. Hermetic; green.
8. **The DSN-gated repository test could never have passed against real Postgres** — skipped by
   default (no `FUDCOURT_EXECUTOR_PG_URL`), `TestStoreEndToEnd` had drifted three ways from the live
   schema: non-UUID `user-1`/`acc-1` ids (the store now refuses non-UUIDs), no
   `executor.exchange_accounts` row for the `executions.account_id` FK, and a `DRAFT` fixture status
   that `LoadRecoverable` (like `worker.MemoryStore`) excludes. Proven by running it for real this
   session against a throwaway local Postgres + `db/schema/executor-schema.sql`; fixed
   (`4959f8f`). Both store tests now pass live.

## 9. Recommended next steps

1. **Close the executor cutover (the one unblocker).** ~~Two~~ **Three** preconditions, in order:
   ~~(a) build the Go HTTP surface for the 16 `/api/executor/*` endpoints (neither `backend/api` nor
   `cmd/executor` serves them today)~~ → **(a) DONE (`7b8dc2d`)** — the Go surface is served by
   `apps/executor/internal/api` on `cmd/executor`'s `:3105`; what remains is the web
   re-point to it, then **(b)** provision `FUDCOURT_SESSION_SECRET` + `FUDCOURT_EXECUTOR_PG_URL`
   (the unit cannot start without them) and `FUDCOURT_EXECUTOR_MASTER_KEY` (64 hex) and run the gate
   against the Go worker; only then
   delete the TS executor + re-point the 15 route handlers still importing
   `platform/executor` (Phase 5/7). This unblocks debt items 1–4 at once.
   **(b) precision (`8d87df1`):** provisioning `FUDCOURT_EXECUTOR_PG_URL` no longer implies applying
   the schema out-of-band — `cmd/executor` now applies the tracked `db/schema/executor-schema.sql`
   at startup (`repository.EnsureSchema`), so the Go worker self-bootstraps an empty database exactly
   as the TS path does; the remaining prerequisites are exactly env provisioning + the live
   `verify:executor` run against the Go worker.
   **Precision (verified this session):** `tests/e2e/executor/executor-paper-e2e.ts`
   imports `@/platform/executor/{store,worker,plan,runtime,lock}` — it exercises the **TS**
   runtime against the real Postgres/Valkey, so it is *not yet* the "against the Go worker" gate
   the parity matrix names. **The Go offline half of that gate is now proven**: the composed
   harness in `apps/executor/internal/tests/e2e` (12 tests, hermetic) drives the **real** worker +
   **real** `exchange/paper` venue + **real** `lock.MemoryLock` over a `worker.MemoryStore` with a
   hand-advanced `FixedClock`, covering create→start→recovery→place→fill→complete, lease
   contention (§65/§127.4), restart without duplicate (§66/§127.5), cancel a resting entry (§127.6),
   duplicate-start no-op (§23), simulated disconnect degrade-then-recover (§76), plan + risk-based
   sizing (§127.1), and **TWAP slice scheduling** (§8.15/§28 — the plan releases as multiple
   children over the window, each sized from the remainder, closing fully released even when no
   slice ever filled). It immediately found and pinned two real bugs (§8.4, §8.5). What is *still*
   gated is only the **live** proof, and this session pinned exactly *why* it is credential-gated:
   verified by reading `apps/executor/executor/main.go` — its `resolver.adapterFor` maps only
   `ExchangeBinance`/`ExchangeBybit`/`ExchangeMEXC` and has **no `paper` branch**, so a live run needs
   a real venue credential; and the credential is a sealed envelope (`exchange_accounts
   .api_key_encrypted`) that only `FUDCOURT_EXECUTOR_MASTER_KEY` can open, which the repo does not
   carry. A throwaway Postgres + Valkey can be provisioned locally, but not a venue key.
   **Update (`8ed4dba`, later same day):** the writer made `executor-paper-e2e.ts` pass
   end-to-end against the real Postgres + Valkey. That is a **TS-runtime** proof, not Go
   parity — the harness imports `@/platform/executor/{store,lock,worker,plan,runtime}` and
   its own header says so.
   **The larger, structural blocker (found this audit):** the cutover is not only
   credential-gated, it is **surface-gated**. The 16 `/api/executor/*` endpoints exist
   *only* in the TS route handlers — `backend/api` exposes no `executor` domain (its live
   routes are auth/admin/oauth/discord only) and `cmd/executor` "is not a request server"
   (`/healthz` + `/readyz` only). So there is no Go HTTP surface for those 16 routes, and a
   TS-only deletion would break production (the objective forbids that: "behavior tetap
   jalan selama restrukturisasi"). Closing the cutover therefore requires **building the Go
   executor/API surface first**, then re-pointing the handlers, then deleting TS — in that
   order. This is a code task, not a credentials task, but it is owned by the concurrent
   writer's `backend/workers/executor`/`backend/api` lane; doing it from here would collide with
   their in-flight commits.
   **UPDATE (`7b8dc2d`, same day) — the "surface-gated" half is RETIRED.** The Go surface this
   paragraph says must be built first **now exists**: `apps/executor/internal/api/**`
   serves all **15** `/api/executor/*` contract routes, mounted by `cmd/executor` on its own
   loopback listener `FUDCOURT_EXECUTOR_API_ADDR` (default `127.0.0.1:3105`, pinned by
   `deploy/systemd/fudcourt-executor.service`), with TS-handler envelope fidelity pinned by
   **29 hermetic tests** (`internal/api/{routes,harness}_test.go`; memory store + in-repo paper venue
   + pinned clock, no PG/Valkey/network). What remains is **not** a code-surface task — it is the
   three-item checklist: **(a)** thin-proxy the web `/api/executor/*` handlers to
   `127.0.0.1:3105` — **coded 2026-10-02, not switched on:** all 15 handlers delegate to
   `apps/web/src/platform/executor/executor-proxy.ts`, and the forward happens only when
   `FUDCOURT_EXECUTOR_PROXY=go` (default OFF, so the TS handlers are still the live path); **(b)**
   `FUDCOURT_SESSION_SECRET` + `FUDCOURT_EXECUTOR_PG_URL` must be provisioned in
   `apps/web/.env.local` before the unit can start (provisioning the DSN no longer implies
   applying the schema by hand — since `8d87df1` `cmd/executor` applies the tracked
   `db/schema/executor-schema.sql` at startup, `repository.EnsureSchema`); **(c)** provision
   `FUDCOURT_EXECUTOR_MASTER_KEY` and run `verify:executor` against the **Go** worker. The TS
   executor stays **production** until all three land — the TS deletion is still OPEN.
2. ~~**Then** execute the Phase 8 move (`apps/web/scripts/verify/*` → `tests/{integration,e2e,fixtures,oracle}`),
   repointing the 77 references in one commit.~~ **DONE** — the move landed in one commit
   (`apps/web/scripts/verify/*` → `scripts/verify/`, executor E2E → `tests/e2e/executor/`,
   executor integration → `tests/integration/executor/`, fixtures → `tests/fixtures/`,
   oracle → `tests/oracle/`, database tooling → `scripts/database/`, web-only suites →
   `apps/web/tests/`), with the invokers repointed and `test:shapers` still 240/240.
   **Update (DR-040, 2026-10-03):** `scripts/database/` (the schema dumper) and the
   `scripts/verify/parity-*` Postgres projection harness were deleted with the Turso store,
   so the `scripts/database/` half of this move no longer exists on disk.
   **Correction (docs-reality pass, 2026-10-01):** the *repo-wide* harnesses and the executor E2E
   probe moved; the **web-only probes went to the app's own tests dir**, not to `tests/`.
   As settled on disk: `scripts/verify/{check-contract.py,check-deploy.py,verify-<family>.py,monitor.py,verify-all.sh,parity-*}`,
   `tests/oracle/{cr_fetch.py,record-fixtures.ts,dump-envelopes.ts}`, `tests/e2e/executor/probe-sizing.cjs`,
   and the web-only set (`dom_audit.py`, `verify_all_routes.py`, `dbg-smoke.cjs`) plus the suites
   under `apps/web/tests/`. `apps/web/scripts/` retains only `checks/check-structure.py`,
   `executor/worker.ts` and `tools/`.
3. **Sync oracle gate — DONE and committed.** `scripts/verify/verify-sync.py`
   (fixture replay, no `--fixtures` flag needed) is wired into `verify-all.sh` and passes:
   `SYNC_ORACLE_OK (34 rows, 40 request keys)` — Python oracle and Rust `fudcourt-sync` produce
   **byte-identical** `assets` projections from `tests/oracle/fixtures/capture.json` (40 recorded
   responses across rpc/hl/prices), and no database write is issued. The gate and its `oracle.rs`
   seam are the writer's Phase 6 work and are **committed and clean** (re-verified this session:
   `git ls-files` lists both `verify-sync.py` and `apps/reconciler/src/oracle.rs`; the gate emits
   `SYNC_ORACLE_OK`).
4. **Commit per phase** before stacking more change (see §10).
5. **Optional perf work** (only on measurement): executor exchange-metadata caching, connection
   pooling — none attempted here because no benchmark showed a problem (objective: "Do not
   optimize blindly").

## 10. Working-tree state at review time

**Clean.** The large uncommitted wave described earlier in the session — the earlier actor's
`backend/workers/executor` refactor across ~20 Go files, the `backend/sync` Rust changes, the
auth/transactions/wallets web-route rewrites, the `deploy/systemd` consolidation, and doc updates —
has since been **committed** by both actors' turns (this session's commits also carried a few of
those pre-staged files in; see the commit-scope note below). `git status` is empty and
`bash scripts/verify/verify-all.sh` returns `VERIFY_ALL_OK`.
**Commit-scope note (honesty):** some of this session's commits were made with a bare
`git commit` while a concurrent writer had files staged in the shared index, so they swept those
files in under a different message (e.g. `024fadd`, labelled a docs commit, contains 54 files
including `apps/web/infrastructure/*` and `apps/executor/internal/platform/lock/valkey.go`). The **content** is
preserved and green; only the commit *messages* under-describe their payload. No work was lost or
discarded. Re-splitting history now would rewrite commits under an active writer, which is riskier
than the cosmetic gain, so it is recorded here instead.
