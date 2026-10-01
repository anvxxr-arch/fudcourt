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
│   │                           strategies, exchange adapters, worker, locks, repo)
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
│   └── oracle/                 reserved for oracle assets (not yet populated)
├── deploy/systemd/             13 unit files (web, api, data, executor, sync×2, reconciled, pgload, web)
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
- **Phase 4 (api):** `services/api/**` — 17 internal packages, 112 test funcs (committed `3702c6c`).
- **Phase 5 (executor):** `services/executor/**` — 17 internal packages, 240 test funcs (committed `4ef371a`).
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
| 1 | **TS executor still in `apps/web`** — 8,029 LOC, 10 modules (`engine,exchange,lock,plan,risk,runtime,store,types,worker` + `scripts/executor/worker.ts`) | `wc -l apps/web/src/platform/executor/*.ts`; parity matrix rows 1–9 `DONE`, cutover rows `OPEN` | `verify:executor` (`executor-paper-e2e.ts`) needs `FUDCOURT_EXECUTOR_PG_URL` + `FUDCOURT_EXECUTOR_MASTER_KEY` — **not in the repo** (`apps/web/.env.local` lacks the master key; host `.env` has only `ALCHEMY_KEY`,`TURSO_AUTH_TOKEN`) |
| 2 | **16 web route handlers still import `platform/executor`** | `grep -rl platform/executor apps/web/src/app` | #1 |
| 3 | **EXECUTOR DDL still embedded in `store.ts`** | migration-plan Phase 2 amendment; `executor-store-tests.ts` §59 pins byte-identity to `database/schema/executor-schema.sql` | #1 |
| 4 | **Phase 8 move of `apps/web/scripts/verify/*` not executed (scoped, deliberate)** — the `verify-*.py` harnesses statically read `apps/web/src/**` (routes, UI components, shell) and write report JSON beside themselves; they are **web-app harnesses**, not cross-service tests. Cross-service scope is satisfied by `tests/integration/api/` + the per-service in-repo suites. | 77 references to `scripts/verify`; `grep` shows each harness opening `(root / "src/...")` with `root = ...parents[2]` = `apps/web` | migration-plan Phase 8 is *ordered after* Phase 7; Phase 7 requires #1. Moving them now is churn against a green, host-operator-expected report path |
| 5 | **`api` lists "admin" as a hosted context but has no `internal/admin`** | `services/api/internal/` has no `admin/`; admin logic lives in `cmd/api/routes.go` | documentation-only fix (comment corrected this session; package split deferred) |
| 6 | **`tests/oracle/` is empty** | `ls tests/oracle/fixtures` | sync oracle gate (`verify-sync.py`) not yet wired into `verify-all.sh` |

Items 1–4 are the *same* dependency: the executor cutover. They are a single decision, not four.

## 7. Test / build results (current working tree, 2026-10-01)

One command: `bash scripts/verify/verify-all.sh` → **`VERIFY_ALL_OK`** (exit 0). Per gate:

| Gate | Result |
| --- | --- |
| structure (DR-018 layers) | PASS |
| web contract (CR_MODES + khala/llama/news/chainrank parity + mutation guards) | PASS |
| deploy-unit guard (13 units: ExecStart paths, absolute, timer pairs) | PASS |
| contracts drift (enums, 36 OpenAPI paths, 39 route handlers, 28 events) | `CONTRACTS_OK` |
| sdk-ts generated-SDK drift + typecheck | PASS |
| **cross-service api conformance** | `API_CONTRACT_OK go_paths=4 documented=36 web_proxies=4` |
| Go build/vet/test ×3 modules | PASS (api **112**, executor **240**, data **178** test funcs) |
| Rust build/test | PASS (17 test fns) |
| pre-push hook syntax | PASS |
| web typecheck + shaper fixtures | PASS (**188** tests) |

Verification of the two fixes made this session (each proven, not asserted):
- **Deploy gate** (`check-deploy.py`): simulated a fresh clone by deleting
  `services/{data,executor}/bin/*` → gate still PASS; then pointed one unit at a
  non-existent binary → gate FAILS (exit 1). Both directions confirmed.
- **Cross-service gate** (`tests/integration/api/check-api-contract.py`): added a web
  proxy route with no Go counterpart → gate FAILS naming the 502-in-production path;
  removed it → gate PASSES.

## 8. Known regressions

**None.** Two failures existed in the working tree before this session and are now fixed:
1. `services/api/cmd/api/main.go:5` — a comment line missing its `//` (`notifications, jobs.`),
   a Go **syntax error** that failed `go build ./services/api/...`. Fixed (line is a comment again).
2. `packages/contracts/openapi/fudcourt.yaml` — referenced **29 undefined components**
   (`RateLimited`, `MutationUnauthorized`, and 27 data-surface schemas), so `bun run generate`
   failed and the whole SDK/contract gate was red. Fixed by defining every referenced component.

The tree is green after both fixes; `git status` at the time of writing showed
42 modified / 13 deleted / 9 untracked, all of which are this branch's in-flight work (§9).

## 9. Recommended next steps

1. **Close the executor cutover (the one unblocker).** Provision `FUDCOURT_EXECUTOR_PG_URL`
   and `FUDCOURT_EXECUTOR_MASTER_KEY` (64 hex), run `executor-paper-e2e.ts` against the Go
   worker, then delete the TS executor + re-point the 16 route handlers (Phase 5/7). This
   unblocks debt items 1–4 at once.
2. **Then** execute the Phase 8 move (`apps/web/scripts/verify/*` → `tests/{integration,e2e,fixtures,oracle}`),
   repointing the 77 references in one commit.
3. **Wire the sync oracle gate** (`verify-sync.py --fixtures`) into `verify-all.sh` and populate
   `tests/oracle/`.
4. **Commit per phase** before stacking more change (see §10).
5. **Optional perf work** (only on measurement): executor exchange-metadata caching, connection
   pooling — none attempted here because no benchmark showed a problem (objective: "Do not
   optimize blindly").

## 10. Working-tree state at review time

This branch carries a large uncommitted wave that is **not** part of this review's own edits:
the earlier actor's `services/executor` refactor across ~20 Go files, the `services/sync` Rust
changes, the auth/transactions/wallets web-route rewrites, the `deploy/systemd` consolidation,
and doc updates. Those were present when this session started (see `docs/architecture/current.md`
§0, which records the same observation) and are **left intact** — the objective's rule is
"do not discard unrelated local changes". They must be committed in reviewable per-phase
increments before the next phase begins (migration-plan "Standing risks").
