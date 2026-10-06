# Target Architecture — domain-oriented monorepo
> Phase 0 design artifact, **reconciled against the working tree 2026-10-01 (docs-reality pass)**.
> This file is the intended end-state for the restructure planned in `migration-plan.md`.
> Its §1 sketch was written before any move; since then **most of it has landed** under
> different directory names, so each section below now states **landed / pending** explicitly —
> a section with neither marker is still design-only. Ground rules come from the
> product scope in `docs/prd/cex-executor.md` (CEX executor: planner, risk, sizing, strategies
> market/limit/TWAP/adaptive-TWAP/iceberg/chase-limit/scale — note the objective's sketch also
> names VWAP and smart-limit, which have no TS oracle and are not ported, exchange adapters
> binance/bybit/mexc, worker, state machine) and the current inventory in `current.md`.
## 1. Layout — *target names (left) vs what landed (right)*
```
target sketch            as-built on the working tree 2026-10-01
apps/web/                frontend/web/                       LANDED
services/api/            backend/api/                        LANDED
services/executor/       backend/workers/executor/           LANDED (exchanges/, not exchanges)
services/data/           backend/data/                       LANDED (moved from apps/apicalls)
services/sync/           backend/sync/                       LANDED
packages/contracts/      shared/contracts/                   LANDED
packages/sdk-ts/         shared/sdk/typescript/              LANDED
packages/config/         —                                   NOT LANDED (DR-018 keeps one tsconfig per app; no shared config exists to move)
database/{schema}        database/schema/                    LANDED (pg-schema.sql, executor-schema.sql)
database/{migrations,seeds,fixtures}  —                       NOT CREATED (empty; migrations/ deliberately not created, DR-020)
tests/{integration,e2e,fixtures,oracle}  tests/{integration,e2e,fixtures,oracle}  LANDED
infrastructure/systemd/  infrastructure/systemd/             LANDED (14 files: 12 live units + 2 retired tombstones)
infrastructure/{docker,compose}  —                          NOT LANDED (no container config exists — DR-002 self-hosted systemd + Cloudflare Tunnel)
scripts/{dev,verify,database,release}  scripts/{verify,database,githooks}  PARTIAL (no dev/ or release/; a githooks/ dir was added instead)
```
The rule that produced this shape: one directory per service, a domain name per service, and
exactly one shared artifact tree. Where the tree deviates from the sketch, the deviation is a
**deliberate omission of something that does not exist** (see the `NOT LANDED / NOT CREATED`
rows), not unfinished work. As-built tree: `docs/architecture/final-review.md` §1,
`docs/README.md` "One-line map of the repo".
## 2. Domain → service — LANDED
| Domain | Owns | Service |
|---|---|---|
| auth, accounts, members | users, sessions, roles | `backend/api` |
| portfolio, wallets, transactions, treasury | balances, ledger, reconciliation queries | `backend/api` |
| markets | venues, assets, prices (read side) | `backend/api` |
| executor orchestration | execution commands (create/start/pause/resume/cancel/emergency), authz, audit | `backend/api` *(pending: the orchestration plane is still the TS routes — see §3.2)* |
| execution engine | planner, risk, sizing, strategies, adapters, worker, FSM, `executor.*` writes | `backend/workers/executor` *(Go engine landed; TS still the production runtime until cutover)* |
| data acquisition | llama, cryptorank, khala, chainrank, news | `backend/data` |
| streams & reconciliation | websocket ingestion, event normalization, reconcile maths | `backend/sync` |
## 3. Dependency rules (allowed / forbidden)
RFC 2119. These rules are the acceptance criteria for later phases. **Enforcement status
(2026-10-01):** the Go layering is enforced by `contracts/scripts/check-contract.mjs` +
`tests/integration/api/check-api-contract.py` + CI; the web layering is enforced by
`apps/web/scripts/checks/check-structure.py`. The rules below marked **OPEN** are the ones
the checks do not yet cover.
### 3.1 Allowed — LANDED
- `frontend/web` MAY import `shared/sdk/typescript`, `shared/contracts` (types only). *(no `packages/config` exists to import)*
- Every service MAY import `shared/contracts`.
- `backend/api` MAY call `backend/workers/executor`, `backend/data`, `backend/sync` over HTTP/contracts.
- `backend/data`, `backend/sync` MAY share `database/schema` definitions via `shared/contracts`
  (SQL/DDL versions), never via source imports.
### 3.2 Forbidden — status per rule
- `frontend/web` MUST NOT own or contain: executor runtime, risk, sizing, strategy logic, exchange
  signing/keys, workers, locks, or execution persistence. — **OPEN.** `apps/web/src/platform/executor/`
  and `apps/web/scripts/executor/` are still present and are still the production executor;
  the Go counterpart (`backend/workers/executor`) is built and parity-tested, and the deletion is
  the gated Phase 5 cutover (see `parity-matrix.md`, `final-review.md` §6).
- Services MUST NOT import each other's implementation — contracts only. No shared Go/Rust/TS
  source across service boundaries. — **ENFORCED** (zero cross-module imports; `final-review.md` §5).
- `backend/api` MUST NOT reach into `executor.*` tables directly; it commands `backend/workers/executor`
  through the orchestration contract. — **OPEN.** The web routes write `executor.*` through
  `apps/web/src/platform/executor/store.ts`; ownership moves to `backend/workers/executor`
  with the cutover.
- `frontend/web` MUST NOT talk to exchanges or hold API keys/secrets beyond session cookies. —
  **OPEN.** `exchange.ts` + `store.ts` `masterKeyFromEnv` are still in web (cutover).
- UI/shell layers MUST NOT be imported by platform/feature layers below them — **ENFORCED** by
  `check-structure.py` (the shell may import feature pages; `platform/` must not import a feature).
- `database/*` is owned by migrations tooling only; services MUST NOT embed DDL strings. —
  **CLOSED 2026-10-02.** `store.ts` no longer embeds the DDL: `EXECUTOR_DDL` reads
  `db/schema/executor-schema.sql` at module load (comment lines dropped), so the tracked
  file is the only copy on the TS side; `tests/integration/executor/executor-store-tests.ts` §59
  pins the constant to that file verbatim and reads the file directly for its structural
  assertions, so a re-derivation cannot slip through. The Go side keeps its `embed` copy
  (`TestEmbeddedSchemaMatchesTracked`, byte-exact) because `go:embed` refuses parent-directory
  patterns. Not adopted: a migration tool (DR-020's rationale is unchanged).
## 4. Contracts (`shared/contracts`) — LANDED (partial)
- `openapi/` — HTTP surfaces. Present: `contracts/openapi/fudcourt.yaml` (`CONTRACTS_OK`,
  36 paths). The api/executor/data/sync surfaces are being folded into the one document.
- `events/` — `contracts/events/{catalog.json,event.schema.json}` (28 stable ids), execution
  lifecycle events + stream normalization envelopes.
- `schemas/` — `contracts/schemas/**` (56 files) + `contracts/data/reference.json`.
Compatibility rule: additive changes only per release; breaking changes REQUIRE a versioned path.
Consumers: `shared/sdk/typescript` (generated), gated by `contracts/scripts/check-contract.mjs`
and `check-schemas.mjs`.
## 5. Persistence ownership — LANDED (as targets)
| Tables | Owner |
|---|---|
| users, members, wallets, portfolio (+accounts, trades, journal, ledger, transactions) | `backend/api` |
| execution, execution_orders, execution_fills, execution_events (today `executor.executions`, `executor.child_orders`, `executor.fills`, `executor.execution_events` + plans/snapshots/risk_profiles/audit_logs) | `backend/workers/executor` |
| analytics (today `assets`, `asset_history`, `price_history` written by sync; `asset_history` appended by the `assets_snapshot` trigger) | `backend/data` + `backend/sync` |
Postgres is the single system of record for balances (DR-040, superseding DR-019's
SQLite/Turso source-of-truth + Postgres read-model split; Postgres as durable truth for the
executor is DR-023). The restructure changed only the code owning each write path.
## 6. Deploy target — LANDED
- `infrastructure/systemd/` — one unit set per service (`fudcourt-api`, `fudcourt-executor`,
  `fudcourt-executor-worker`, `fudcourt-data`, `fudcourt-sync`, `fudcourt-sync-rust`,
  `fudcourt-reconciled`, `fudcourt-web`) plus the `pgload`/`sync` timers; 12 live units and
  2 `RETIRED-*.service.txt` tombstones.
  The dual Python/Rust sync units are expected to collapse to the Rust service after Phase 6 parity is proven.
- `infrastructure/{docker,compose}/` — **NOT LANDED**; no container config exists (DR-002
  self-hosted systemd + Cloudflare Tunnel). Recorded as an omission, not planned work.
- Ingress unchanged: Cloudflare Tunnel → loopback origin (DR-002), fail-closed.
## 7. Tests target — LANDED
- `tests/integration` — cross-service contract tests (`api/check-api-contract.py`, `executor/*-tests.ts`).
- `tests/e2e` — executor journeys (`executor/executor-paper-e2e.ts` + the per-module suites).
- `tests/fixtures` + `tests/oracle` — recorded upstream envelopes and the Python-oracle
  parity harness.
- `scripts/verify` — the repo-wide harnesses (`check-contract.py`, `check-deploy.py`,
  `verify-<family>.py`, `monitor.py`, `verify-all.sh`, `parity-*`); the app-only probes
  (`dom_audit.py`, `verify_all_routes.py`, `dbg-smoke.cjs`) and the web suites live at
  `apps/web/tests/`.
- Unit tests live next to their service (Go `*_test.go`, Rust `tests/`, web vitest/node --test).
