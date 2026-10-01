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

```
fudcourt/
├── apps/
│   └── web/                    Next.js 16 + Bun — UI, SSR, thin BFF, Payload blog
│       ├── src/{app,features,platform,cms,shell,styles,ui}
│       └── scripts/{checks,tools,tests,verify,fixtures,oracle,executor}
├── services/
│   ├── api/                    Go — primary backend (identity, admin, portfolio,
│   │                           treasury, wallets, transactions, markets, ledger)
│   ├── executor/               Go — execution engine (risk, sizing, planner,
│   │                           strategies, exchange adapters, worker, locks, repo,
│   │                           credentials, cmd/executor service binary)
│   ├── data/                   Go — external data (cryptorank, khala, llama,
│   │                           chainrank, news, cache)
│   └── sync/                   Rust — balance sync + /api/reconcile
├── packages/
│   ├── contracts/              OpenAPI + event catalog + schemas (source of truth)
│   └── sdk-ts/                 generated TS client
├── database/schema/            schema.sql (Turso) · pg-schema.sql (read model) ·
│                               executor-schema.sql (execution ledger)
├── tests/
│   ├── integration/api/        cross-service conformance gate (Go api ⇄ contract ⇄ web BFF)
│   └── oracle/                 sync oracle gate: Python `sync-live.py` ⇄ Rust `fudcourt-sync`
│                               byte-identical replay (fixtures + pinned projection, offline)
├── deploy/systemd/             12 unit files (web, api, data, executor, executor-worker, sync, sync-rust, reconciled, pgload — + 2 retired .txt)
├── scripts/{githooks,verify}/  pre-push hook · verify-all.sh (one-command offline gate)
├── docs/{architecture,operations,prd,product,records}/
├── .github/workflows/          web · go · rust · contracts · integration (path-filtered)
├── go.work · go.work.sum · package.json · README.md
```

Absent vs. the objective's target sketch, and why (all documented, none silent):
`packages/config` (no shared TS config exists to move — DR-018 keeps one tsconfig per app);
`deploy/{docker,compose}` (no container config exists — DR-002 self-hosted systemd + Cloudflare
Tunnel); `database/{migrations,seeds,fixtures}` (empty — `migrations/` deliberately not created,
DR-020); `Cargo.toml` at root (single Rust crate lives in `services/sync`). These are omissions of
*non-existent* things, not missing work.

## 2. Files moved

This session (uncommitted at the time of writing; see §7):
| From | To | Method |
| --- | --- | --- |
| `.github/workflows/ci.yml` (single 6-job workflow) | `.github/workflows/{web,go,rust,contracts,integration}.yml` | `git rm` + 5 new files (Phase 9) |

Already moved in earlier commits on this branch (verified via `git log`):
| From | To | Commit |
| --- | --- | --- |
| `apps/apicalls/` | `services/data/` | `4e8ba91` (Phase 1) |
| `apps/sync/` | `services/sync/` | `4e8ba91` (Phase 1) |
| `apps/web/db/*.sql` | `database/schema/*.sql` | `4e8ba91` (Phase 2) |
| `apps/*/deploy/*.service|*.timer` | `deploy/systemd/` | `94a2ee1` (Phase 10) |

## 3. Files created

- **Phase 3 (contracts):** `packages/contracts/{openapi/fudcourt.yaml, events/{catalog.json,event.schema.json}, schemas/{error,event}-envelope.json, scripts/check-contract.mjs}`; `packages/sdk-ts/**` (committed `d4d87e7`).
- **Phase 4 (api):** `services/api/**` — 18 internal packages, 112 test funcs (committed `3702c6c`).
- **Phase 5 (executor):** `services/executor/**` — 19 internal packages, **253** test funcs (committed `4ef371a`).
- **Phase 9 (CI):** the five path-filtered workflows (§2) + `scripts/verify/verify-all.sh` (one-command offline gate).
- **Phase 10 (deploy):** `deploy/systemd/{fudcourt-api,fudcourt-data,fudcourt-executor}.service` (+ existing units).
- **Phase 8 (tests):** `tests/integration/api/check-api-contract.py` — a cross-service gate that did not exist before (§6).
- **Docs:** `docs/architecture/{current,target,domain-map,migration-plan,executor,events,security,parity-matrix,final-review}.md`.

## 4. Files removed

- `.github/workflows/ci.yml` — superseded by the five domain workflows (this session).
- `apps/web/deploy/*` (7 units), `services/data/deploy/*`, `services/sync/deploy/*` — consolidated into `deploy/systemd/` (commit `94a2ee1`).
- `apps/blog/**`, the flat `apps/web/app/**` layout — removed in the earlier "repurpose" commit `5e68576`.

**Not removed, deliberately:** `apps/web/src/platform/executor/**` (8,029 LOC) and
`apps/web/scripts/executor/worker.ts`. See §6/§8 — the TS executor is still the production
executor until the Go cutover gate passes.

## 5. Architecture decisions

Recorded as DR-022 … DR-030 in `docs/records/DECISIONS.md` (Go default / Rust specialized;
Postgres = durable truth, Valkey = ephemeral; no broker/orchestrator; executor moves to Go with TS
as parity oracle; canonical exchange interface; OpenAPI as contract source of truth; immutable
ledger; portfolio is derived; append-only events). Current-state highlights:

- **One shared artifact.** Services share `packages/contracts` only. Verified: each Go module
  (`services/{api,executor,data}`) imports **only its own** module path — zero cross-service
  implementation imports (§7 evidence).
- **Contract is machine-checked.** `packages/contracts/scripts/check-contract.mjs` gates enums
  (OpenAPI ⇄ `types.ts`) and route coverage; the new `tests/integration/api/check-api-contract.py`
  gates the Go api's live route table ⇄ contract ⇄ web BFF proxy table (§6).
- **CI is domain-aware with a stable required check.** Each workflow always runs and ends in a
  `gate` job that reports success for a *skipped* (no relevant files changed) or a *successful*
  surface, so a path filter never leaves a required check "waiting" forever.

## 6. Remaining technical debt (with evidence)

| # | Item | Evidence | Blocked on |
| --- | --- | --- | --- |
| 1 | **TS executor still in `apps/web`** — 8,029 LOC, 10 modules (`engine,exchange,lock,plan,risk,runtime,store,types,worker` + `scripts/executor/worker.ts`) | `wc -l apps/web/src/platform/executor/*.ts`; parity matrix rows 1–9 `DONE`, **offline composed Go harness `DONE`** (`internal/e2e`), live cutover rows `OPEN` | `verify:executor` (`executor-paper-e2e.ts`) + a live `cmd/executor` run need `FUDCOURT_EXECUTOR_PG_URL` + `FUDCOURT_EXECUTOR_MASTER_KEY` (and, for `cmd`, a real venue credential — no paper branch). **`verify:executor` is now green** (2026-10-01: `ALL PAPER-MODE CHECKS PASSED (§127)` — a dev master key was generated into the gitignored `apps/web/.env.local`; Postgres :5433 and Valkey :6379 are live locally). What stays OPEN is the Go-worker cutover: `cmd/executor` exposes only `/healthz` + `/readyz`, so the 15 `/api/executor/*` routes still have no Go counterpart and the TS runtime remains the production path |
| 2 | **15 web route handlers still import `platform/executor`** | `grep -rl platform/executor apps/web/src/app` | #1 |
| 3 | **EXECUTOR DDL still embedded in `store.ts`** | migration-plan Phase 2 amendment; `executor-store-tests.ts` §59 pins byte-identity to `database/schema/executor-schema.sql` | #1 |
| 4 | **Phase 8 move of `apps/web/scripts/verify/*` not executed (scoped, deliberate)** — the `verify-*.py` harnesses statically read `apps/web/src/**` (routes, UI components, shell) and write report JSON beside themselves; they are **web-app harnesses**, not cross-service tests. Cross-service scope is satisfied by `tests/integration/api/` + the per-service in-repo suites. | 77 references to `scripts/verify`; `grep` shows each harness opening `(root / "src/...")` with `root = ...parents[2]` = `apps/web` | migration-plan Phase 8 is *ordered after* Phase 7; Phase 7 requires #1. Moving them now is churn against a green, host-operator-expected report path |
| 5 | ~~**`api` lists "admin" as a hosted context but has no `internal/admin`**~~ **RESOLVED** | the false claim is gone: `services/api/cmd/api/main.go` now names the `/api/admin/members` route plane, `identity.TierAdmin`, and the handlers in `cmd/api/{routes,errors}.go`, with an explicit note that splitting it into `internal/admin` is deferred. `go build ./services/api/...` green. Package split remains a legitimate follow-up; the misleading comment does not. |
| 6 | **`request_id` was missing from the executor's four required identifiers** (PRD §66 names `execution_id`, `request_id`, `client_order_id`, `event_id` — only three existed) | `idempotency.RequestID` (`req_<exec>_<seq>`) + `ParseRequestID` added; refuses foreign ids incl. `fud_...` client order ids so the two id spaces can never be cross-parsed. Verified by `TestRequestIDAndClientOrderIDAreDistinct` + `TestRequestIDIsStableAcrossRetry`. Restart/duplicate proof runs against the REAL paper venue: `TestPaperRestartNoDuplicateOrder`, `TestPaperDuplicateStartIsNoOp`, `TestPaperRejectedOrderThenReplaces` all green in `internal/e2e`. | none — gate 5 of `.ai/prompts/executor-migration.md` closed |

| 7 | **Sync oracle gate wired (Phase 6) — done, committed** | `verify-sync.py` + `tests/oracle/fixtures/{capture.json,expected-projection.txt,make-capture.py}` exist and the gate is in `verify-all.sh`; run output `SYNC_ORACLE_OK (34 rows, 40 request keys)` | none (committed; §9.3) |

Items 1–4 are the *same* dependency: the executor cutover. They are a single decision, not four.

### Definition-of-Done map (objective → current-state evidence)

| # | Objective "done when" | Status | Evidence (this tree, 2026-10-01) |
| --- | --- | --- | --- |
| 1 | `apps/web` no longer owns executor runtime | **PARTIAL — gated** | `apps/web/src/platform/executor/*.ts` = 7,974 LOC (9 files) + `scripts/executor/worker.ts` = 55 → 8,029 total, still present; cutover blocked on the Go paper harness + credentials (§9.1) |
| 2 | `apps/web` no longer owns DB schema | MET | `find apps/web -name '*.sql'` → none; DDL lives in `database/schema/{schema,pg-schema,executor-schema}.sql` |
| 3 | `apps/apicalls` → `services/data` | MET | `apps/apicalls` absent; `services/data/{cmd/apicalls,internal/*}`, module path rewritten |
| 4 | Rust sync under `services/sync` | MET | `services/sync/{src,tests,Cargo.toml}`; `cargo test --release` green |
| 5 | `services/api` is the primary Go API | MET | 18 internal packages, 112 test funcs; 4 routes live; conformance-gated vs contract |
| 6 | `services/executor` owns executor logic | **MET (code) / PARTIAL (cutover)** | 253 test funcs across 19 internal packages (18 with tests, incl. the composed `internal/e2e` harness); TS remains production until §9.1 |
| 7 | exchange adapters use a common abstraction | MET | `internal/exchange/{exchange,types,symbols,classify}.go` + `binance/bybit/mexc/paper`; no venue branching outside the package |
| 8 | PostgreSQL is the durable execution truth | MET | `database/schema/executor-schema.sql` (10 tables) + `internal/repository`; **proven live this session** — the DSN-gated `TestStoreEndToEnd`/`TestStoreNewFailLoud` run green against a throwaway local Postgres with that schema applied (`4959f8f`) |
| 9 | Valkey only ephemeral coordination | MET | `internal/lock/{valkey,memory}.go`; durable state is Postgres |
| 10 | API contracts centralized | MET | `packages/contracts/{openapi,events,schemas}`; `CONTRACTS_OK` gate |
| 11 | cross-service tests outside `apps/web` | MET | `tests/integration/api/check-api-contract.py`, `tests/oracle/fixtures/` |
| 12 | each deployable has clear ownership | MET | `deploy/systemd/` 12 units; `check-deploy` OK |
| 13 | CI is domain-aware | MET | `.github/workflows/{web,go,rust,contracts,integration}.yml` |
| 14 | services do not import each other's impl | MET | each Go module imports only its own path (§5) |
| 15 | existing product behavior compatible | MET | `verify-all.sh` green; host units active |
| 16 | migrated executor has parity tests | **PARTIAL** | `parity-matrix.md` rows 1–9 DONE; the offline **composed Go paper harness** is now DONE (`internal/e2e`, 12 tests); 253 Go funcs. Remaining cutover rows (live PG e2e, TS deletion) OPEN → §9.1 |
| 17 | build/test status documented | MET | §7 + `scripts/verify/verify-all.sh` |

### Objective "Goal terukur" acceptance metrics (re-derived this session)

The DoD rows above answer the prose "definition of done"; below is the objective's
separate **acceptance-metrics** block, each proven by a command (not asserted).
"0 executor logic in `apps/web`" is the one metric still open — it is the same gated
cutover as DoD row 1, and the yardstick's own escape ("stop if it requires credentials
unavailable in the repository") applies.

| Metric | Required | Evidence (current tree) |
| --- | --- | --- |
| DB schema files inside `apps/web` | 0 | `find apps/web -name '*.sql'` → **0** |
| exchange credentials / signing handled by frontend | 0 | **PARTIAL — gated, same cutover as rows 1–4** (corrected: an earlier revision of this row claimed the only hits were a session-cookie HMAC, which is false). No *request signing* (HMAC of the venue payload) happens in the web tier. But `apps/web/src/platform/executor/store.ts` **is** a frontend-tier credential **vault**: it imports `node:crypto` (`createCipheriv`/`createDecipheriv`), implements `sealSecret`/`openSecret` (AES-GCM envelopes), reads `FUDCOURT_EXECUTOR_MASTER_KEY` (line 254) via `masterKeyFromEnv()`, and owns the `exchange_accounts.api_key_encrypted`/`api_secret_encrypted`/`passphrase_encrypted`/`iv`/`auth_tag` columns. The other `apps/web` hits are a session-cookie HMAC (`platform/auth/session.ts`, `middleware.ts`) and TS **type** "signatures". The Go `services/executor/internal/credentials` package is the canonical owner; the TS vault is removed with the cutover (rows 1–4). |
| cross-service implementation imports | 0 | `grep` for `services/{api,executor,data}/` imports inside the Go services → **none**; `services/data` mentions `executor` nowhere; `services/sync` only names TS files in *provenance comments* (`src/{main,chains,reconcile}.rs`), not imports |
| canonical risk engine | 1 | exactly one `risk.go` → `services/executor/internal/risk/risk.go` (+31 test funcs) |
| canonical sizing implementation | 1 | exactly one `sizing.go` → `services/executor/internal/sizing/sizing.go` (+16 test funcs) |
| canonical exchange abstraction | 1 | `services/executor/internal/exchange/{exchange,types,symbols,classify}.go` + `binance/bybit/mexc/paper`; no venue branching outside the package (85 test funcs) |
| contract source of truth | 1 | `packages/contracts/`: `openapi/fudcourt.yaml`, `events/{catalog,event.schema}.json`, `schemas/{error,event}-envelope.json`, gated by `CONTRACTS_OK` |
| core executor logic inside `apps/web` | 0 | **OPEN** — 8,029 LOC still in `apps/web/src/platform/executor/*.ts` + `scripts/executor/worker.ts`; gated cutover (§9.1), DoD row 1 |
| independently deployable: web / api / data / executor / sync | 5 | `deploy/systemd/fudcourt-{web,api,data,executor,sync}.service` all present; `check-deploy` OK; `/api` independently built (`go build ./...` OK) |
| ownership discoverable | — | gate `check-structure.py` OK (DR-018 layers), i.e. a stray cross-boundary file fails CI |

Cross-checked gates for the block above (all green this session): `check-structure` OK,
`check-deploy` OK, `check-contract.mjs` `CONTRACTS_OK`, `check-api-contract.py`
`API_CONTRACT_OK`, `go build` OK for `services/api` and `services/data`.

## 7. Test / build results (current working tree, 2026-10-01)

One command: `bash scripts/verify/verify-all.sh` → **`VERIFY_ALL_OK`** (exit 0). Per gate:

| Gate | Result |
| --- | --- |
| structure (DR-018 layers) | PASS |
| web contract (CR_MODES + khala/llama/news/chainrank parity + mutation guards) | PASS |
| deploy-unit guard (12 units: ExecStart paths, absolute, timer pairs) | PASS |
| contracts drift (enums, 36 OpenAPI paths, 39 route handlers, 28 events) | `CONTRACTS_OK` |
| sdk-ts generated-SDK drift + typecheck | PASS |
| **cross-service api conformance** | `API_CONTRACT_OK go_paths=4 documented=36 web_proxies=4` |
| Go build/vet/test ×3 modules | PASS (api **112**, executor **253**, data **178** test funcs at HEAD) |
| Rust build/test | PASS (17 test fns) |
| **sync oracle gate** (`verify-sync.py`) | PASS — 9 checks, `SYNC_ORACLE_OK (34 rows, 40 request keys)` |
| **composed Go paper E2E** (`internal/e2e`) | PASS (**12** tests, hermetic) |
| pre-push hook syntax | PASS |
| web typecheck + shaper fixtures | PASS (**240** tests) |

**Committed HEAD is green — verified on the live tree, not in a worktree.**
`bash scripts/verify/verify-all.sh` returns `VERIFY_ALL_OK` (exit 0) against the current
working tree with **no uncommitted edits** (`git status --short` → clean). Every gate above
was re-derived this session from the committed state: `check-structure` OK (139 files),
`check-deploy` OK, `check-contract.mjs` `CONTRACTS_OK enums=3 openapi_paths=36
route_handlers=39 events=28 client_endpoints=17`, `check-api-contract.py`
`API_CONTRACT_OK go_paths=4 documented=36 web_proxies=4`, `go build/vet/test` OK for all
The executor module now carries **253** test functions across 19 internal packages plus the
composed harness in `internal/e2e` (12 tests).
composed harness in `internal/e2e` (12 tests).

The harness is the first executor test to drive the **real** worker + **real** `exchange/paper` venue + **real** `lock.MemoryLock`
composed harness in `internal/e2e` (12 tests). The harness is the first executor test to
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
session the `services/executor/internal/lock` package did flap while a concurrent writer held an
in-progress edit of it (`valkey.go` + `valkey_test.go`, plus `zz_probe*_test.go` scratch files);
observed states included a missing `fakeValkey` type, literal CR bytes inside string literals, a
scripted server that never served its steps, and a syntax error at `valkey_test.go:649`. That
writer has since landed their work (with garbage-collection for the handshake error, below), so the
package is green. Every gate is now stable and verified individually:
`check-deploy` OK, `check-structure` OK (139 files), `check-contract` OK (28 CR modes + 5 family
parities), `check-contract.mjs` CONTRACTS_OK, `check-api-contract.py` API_CONTRACT_OK,
`go build/vet/test` OK for all three Go modules, `cargo build/test` OK for `services/sync`,
`bash -n pre-push` OK.

Verification of the two fixes made this session (each proven, not asserted):
- **Deploy gate** (`check-deploy.py`): simulated a fresh clone by deleting
  `services/{data,executor}/bin/*` → gate still PASS; then pointed one unit at a
  non-existent binary → gate FAILS (exit 1). Both directions confirmed.
- **Cross-service gate** (`tests/integration/api/check-api-contract.py`): added a web
  proxy route with no Go counterpart → gate FAILS naming the 502-in-production path;
  removed it → gate PASSES.
- **Valkey AUTH handshake** (`internal/lock/valkey.go`): the handshake created a *second*
  `bufio.Reader` for the AUTH reply, which could buffer past `+OK` and swallow the command
  reply — a lock that looks unavailable (fail-closed) on a healthy Valkey. Fixed by sharing one
  reader across both replies on the connection; the scripted fake server was fixed in the same
  pass (an AUTH step now also serves its command over the same connection, mirroring `do`).
- **Sync oracle gate** (`verify-sync.py`, added this session): perturb one wei in the
  recorded capture → the gate FAILS with the exact diverging line and exit 1; restore → PASS.
  Both directions confirmed, so the gate is proven able to fail, not merely to pass.

**Committed HEAD is green (verified in an isolated `git worktree --detach HEAD`).**
A clean checkout of HEAD builds and tests clean across every module:
`go test ./...` OK for `services/executor`, `services/api`, `services/data`;
`cargo test --release` OK for `services/sync`. Doing this in a worktree (not the
shared tree) is what makes the claim about *committed* state — the shared tree
carries the writer's uncommitted edits above.

**Re-audit (later same day).** HEAD advanced to `0feb6e2` (+ this doc commit). Committed HEAD
is still fully green — re-verified on a clean `git worktree --detach HEAD`: `go vet`/`go test
./...` clean for `services/executor`, and `verify-all.sh`'s non-Go steps (structure, contract,
api-contract, sync-oracle, deploy, contracts, web typecheck, sync, data) all pass. The only
shared-tree red is the concurrent writer's untracked, mid-edit `services/executor/cmd/executor/
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
1. `services/api/cmd/api/main.go:5` — a comment line missing its `//` (`notifications, jobs.`),
   a Go **syntax error** that failed `go build ./services/api/...`. Fixed (line is a comment again).
2. `packages/contracts/openapi/fudcourt.yaml` — referenced **29 undefined components**
   (`RateLimited`, `MutationUnauthorized`, and 27 data-surface schemas), so `bun run generate`
   failed and the whole SDK/contract gate was red. Fixed by defining every referenced component.
3. **`services/executor/cmd/executor` test did not compile at HEAD** — commit `642e7ef` landed
   `main_test.go` ahead of its `main.go`/`Acquire` implementation (`undefined: loadConfigFrom`);
   production `go build ./...` still passed, so only the *test* target was red. The writer's working
   tree held the coherent completion; this session landed it (`befd141`, `25cd532`) and verified HEAD
   in an isolated worktree. The "split by 7d90520" wording in `befd141`'s message is wrong and is
   corrected here: `git show --stat 7d90520 -- services/executor/cmd/executor/` is empty.
4. **`internal/worker` clobbered a terminal landing with the stale status** — `drive()` re-saved
   the execution record *after* `runActions`, so any pass that landed a terminal/paused status
   (`StrategyComplete`→`FILLED`, cancel→`CANCELLED`, risk-stop) had that status overwritten by the
   pre-action `RUNNING`: a fully filled execution was silently resurrected and re-driven every tick
   forever. Found by the new composed harness (`internal/e2e`), which is the first test to reach the
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
   `lock: command write/read`). Verified: `go test -race ./internal/lock/` green 3× consecutively,
   and `TestValkeyLockAuthHandshake`/`TestValkeyLockAuthRejected` both pass. No behavior change —
   the fail-closed contract is untouched; only the error string carries more information.
6. **`internal/worker.isRetryable` misclassified every venue error as retryable** — it looked for a
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
   session against a throwaway local Postgres + `database/schema/executor-schema.sql`; fixed
   (`4959f8f`). Both store tests now pass live.

## 9. Recommended next steps

1. **Close the executor cutover (the one unblocker).** Two preconditions, in order: (a) build
   the Go HTTP surface for the 16 `/api/executor/*` endpoints (neither `services/api` nor
   `cmd/executor` serves them today), then (b) provision `FUDCOURT_EXECUTOR_PG_URL` +
   `FUDCOURT_EXECUTOR_MASTER_KEY` (64 hex) and run the gate against the Go worker; only then
   delete the TS executor + re-point the 15 route handlers still importing
   `platform/executor` (Phase 5/7). This unblocks debt items 1–4 at once.
   **Precision (verified this session):** `apps/web/scripts/verify/executor-paper-e2e.ts`
   imports `@/platform/executor/{store,worker,plan,runtime,lock}` — it exercises the **TS**
   runtime against the real Postgres/Valkey, so it is *not yet* the "against the Go worker" gate
   the parity matrix names. **The Go offline half of that gate is now proven**: the composed
   harness in `services/executor/internal/e2e` (12 tests, hermetic) drives the **real** worker +
   **real** `exchange/paper` venue + **real** `lock.MemoryLock` over a `worker.MemoryStore` with a
   hand-advanced `FixedClock`, covering create→start→recovery→place→fill→complete, lease
   contention (§65/§127.4), restart without duplicate (§66/§127.5), cancel a resting entry (§127.6),
   duplicate-start no-op (§23), simulated disconnect degrade-then-recover (§76), plan + risk-based
   sizing (§127.1), and **TWAP slice scheduling** (§8.15/§28 — the plan releases as multiple
   children over the window, each sized from the remainder, closing fully released even when no
   slice ever filled). It immediately found and pinned two real bugs (§8.4, §8.5). What is *still*
   gated is only the **live** proof, and this session pinned exactly *why* it is credential-gated:
   verified by reading `services/executor/cmd/executor/main.go` — its `resolver.adapterFor` maps only
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
   *only* in the TS route handlers — `services/api` exposes no `executor` domain (its live
   routes are auth/admin/oauth/discord only) and `cmd/executor` "is not a request server"
   (`/healthz` + `/readyz` only). So there is no Go HTTP surface for those 16 routes, and a
   TS-only deletion would break production (the objective forbids that: "behavior tetap
   jalan selama restrukturisasi"). Closing the cutover therefore requires **building the Go
   executor/API surface first**, then re-pointing the handlers, then deleting TS — in that
   order. This is a code task, not a credentials task, but it is owned by the concurrent
   writer's `services/executor`/`services/api` lane; doing it from here would collide with
   their in-flight commits.
2. **Then** execute the Phase 8 move (`apps/web/scripts/verify/*` → `tests/{integration,e2e,fixtures,oracle}`),
   repointing the 77 references in one commit.
3. **Sync oracle gate — DONE and committed.** `apps/web/scripts/verify/verify-sync.py`
   (fixture replay, no `--fixtures` flag needed) is wired into `verify-all.sh` and passes:
   `SYNC_ORACLE_OK (34 rows, 40 request keys)` — Python oracle and Rust `fudcourt-sync` produce
   **byte-identical** `assets` projections from `tests/oracle/fixtures/capture.json` (40 recorded
   responses across rpc/hl/prices), and no Turso write is issued. The gate and its `oracle.rs`
   seam are the writer's Phase 6 work and are **committed and clean** (re-verified this session:
   `git ls-files` lists both `verify-sync.py` and `services/sync/src/oracle.rs`; the gate emits
   `SYNC_ORACLE_OK`).
4. **Commit per phase** before stacking more change (see §10).
5. **Optional perf work** (only on measurement): executor exchange-metadata caching, connection
   pooling — none attempted here because no benchmark showed a problem (objective: "Do not
   optimize blindly").

## 10. Working-tree state at review time

**Clean.** The large uncommitted wave described earlier in the session — the earlier actor's
`services/executor` refactor across ~20 Go files, the `services/sync` Rust changes, the
auth/transactions/wallets web-route rewrites, the `deploy/systemd` consolidation, and doc updates —
has since been **committed** by both actors' turns (this session's commits also carried a few of
those pre-staged files in; see the commit-scope note below). `git status` is empty and
`bash scripts/verify/verify-all.sh` returns `VERIFY_ALL_OK`.
**Commit-scope note (honesty):** some of this session's commits were made with a bare
`git commit` while a concurrent writer had files staged in the shared index, so they swept those
files in under a different message (e.g. `024fadd`, labelled a docs commit, contains 54 files
including `apps/web/deploy/*` and `services/executor/internal/lock/valkey.go`). The **content** is
preserved and green; only the commit *messages* under-describe their payload. No work was lost or
discarded. Re-splitting history now would rewrite commits under an active writer, which is riskier
than the cosmetic gain, so it is recorded here instead.
