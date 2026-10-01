# Target Architecture — domain-oriented monorepo

> Phase 0 design artifact. This is the intended end-state for the restructure planned in
> `migration-plan.md`; nothing here exists yet except where noted. Ground rules come from the
> product scope in `docs/prd/cex-executor.md` (CEX executor: planner, risk, sizing, strategies
> market/limit/TWAP/adaptive-TWAP/iceberg/chase-limit/scale — note the objective's sketch also
> names VWAP and smart-limit, which have no TS oracle and are not ported, exchange adapters
> binance/bybit/mexc, worker, state machine) and the current inventory in `current.md`.

## 1. Layout

```
apps/
  web/                    Next.js + Bun — FRONTEND ONLY (pages, UI, typed API client)
services/
  api/                    Go — auth, accounts, members, portfolio, wallets, transactions,
                          treasury, markets, executor orchestration (command API)
  executor/               Go — planner, risk, sizing, strategies (market, limit, TWAP,
                          adaptive TWAP, iceberg, chase-limit, scale in/out — VWAP/smart-limit
                          are not implemented in the TS oracle and are out of scope), exchange
                          adapters (binance, bybit, mexc), worker, execution state machine,
                          persistence (executor.* schema)
  data/                   Go — upstream acquisition, moved from apps/apicalls:
                          llama, cryptorank, khala, chainrank, news (+ cache, httpx)
  sync/                   Rust — websocket streams, reconciliation, event normalization
                          (today's fudcourt-sync + fudcourt-reconciled, specialized further)
packages/
  contracts/              openapi/, events/, schemas/ — the ONLY shared artifacts
  sdk-ts/                 generated/hand-maintained TS client over contracts (consumed by frontend/web)
  config/                 shared toolchain/lint/tsconfig/env schema
database/
  migrations/  schema/  seeds/  fixtures/
tests/
  integration/  e2e/  fixtures/  oracle/
infrastructure/
  systemd/  docker/  compose/
scripts/
  dev/  verify/  database/  release/
```

## 2. Domain → service

| Domain | Owns | Service |
|---|---|---|
| auth, accounts, members | users, sessions, roles | backend/api |
| portfolio, wallets, transactions, treasury | balances, ledger, reconciliation queries | backend/api |
| markets | venues, assets, prices (read side) | backend/api |
| executor orchestration | execution commands (create/start/pause/resume/cancel/emergency), authz, audit | backend/api |
| execution engine | planner, risk, sizing, strategies, adapters, worker, FSM, `executor.*` writes | backend/workers/executor |
| data acquisition | llama, cryptorank, khala, chainrank, news | backend/data |
| streams & reconciliation | websocket ingestion, event normalization, reconcile maths | backend/sync |

## 3. Dependency rules (allowed / forbidden)

RFC 2119. These rules are the acceptance criteria for later phases and SHOULD be enforced by
`scripts/checks` + CI once the phases land.

### 3.1 Allowed

- `frontend/web` MAY import `shared/sdk/typescript`, `packages/config`, `shared/contracts` (types only).
- Every service MAY import `shared/contracts` and `packages/config`.
- `backend/api` MAY call `backend/workers/executor`, `backend/data`, `backend/sync` over HTTP/contracts.
- `backend/data`, `backend/sync` MAY share `database/schema` definitions via `shared/contracts`
  (SQL/DDL versions), never via source imports.

### 3.2 Forbidden

- `frontend/web` MUST NOT own or contain: executor runtime, risk, sizing, strategy logic, exchange
  signing/keys, workers, locks, or execution persistence. (Today `src/platform/executor/` and
  `scripts/executor/` violate this — Phase 5 removes them.)
- Services MUST NOT import each other's implementation — contracts only. No shared Go/Rust/TS
  source across service boundaries.
- `backend/api` MUST NOT reach into `executor.*` tables directly; it commands `backend/workers/executor`
  through the orchestration contract. (Today the web routes write `executor.*` via
  `src/platform/executor/store.ts` — Phase 5 changes the owner to backend/workers/executor.)
- `frontend/web` MUST NOT talk to exchanges or hold API keys/secrets beyond session cookies.
  (Today `exchange.ts` + `store.ts` `masterKeyFromEnv` live in web — Phase 5.)
- UI/shell layers MUST NOT be imported by platform/feature layers below them (today
  `src/shell/store-shell.tsx` imports feature pages; acceptable inside `frontend/web` as long as it
  stays a UI-only app, but platform code MUST NOT import features — see domain-map.md).
- `database/*` is owned by migrations tooling only; services MUST NOT embed DDL strings once
  Phase 2 lands (today `store.ts` carries `EXECUTOR_DDL` — Phase 2/5 move it to
  `database/schema/executor.sql` + generated migrations).

## 4. Contracts (`shared/contracts`)

- `openapi/` — HTTP surfaces: api (auth/accounts/portfolio/markets/executor commands),
  executor (internal), data, sync.
- `events/` — execution lifecycle events (execution_events), stream normalization envelopes.
- `schemas/` — DDL + JSON schemas for `users/members/wallets/portfolio`, `execution*`, `analytics`.
Compatibility rule: additive changes only per release; breaking changes REQUIRE a versioned path.

## 5. Persistence ownership

| Tables | Owner |
|---|---|
| users, members, wallets, portfolio (+accounts, trades, journal, ledger, transactions) | backend/api |
| execution, execution_orders, execution_fills, execution_events (today `executor.executions`, `executor.child_orders`, `executor.fills`, `executor.execution_events` + plans/snapshots/risk_profiles/audit_logs) | backend/workers/executor |
| analytics (today `assets`, `asset_history`, `price_history` written by sync, projected by pg-load) | backend/data + backend/sync |

SQLite/Turso remains the source of truth for balances; Postgres remains the read model
(DR-019). That split is unchanged by the restructure — only the code owning each write path moves.

## 6. Deploy target

- `infrastructure/systemd/` — one unit set per service: `fudcourt-api`, `fudcourt-executor`,
  `fudcourt-data`, `fudcourt-sync`, `fudcourt-web`, plus timers (`pgload`, `sync`).
  The dual Python/Rust sync units collapse to the Rust service after Phase 6 parity is proven.
- `infrastructure/docker|compose/` — local dev orchestration mirroring the systemd topology.
- Ingress unchanged: Cloudflare Tunnel → loopback origin (DR-002), fail-closed.

## 7. Tests target

- `tests/integration` — cross-service contract tests (generated from `shared/contracts`).
- `tests/e2e` — browser/user journeys (executor wizard paper-trade path included).
- `tests/fixtures` + `tests/oracle` — recorded upstream envelopes and the Python-oracle
  parity harness currently under `frontend/web/scripts/{fixtures,oracle,verify}`.
- Unit tests live next to their service (Go `*_test.go`, Rust `tests/`, web vitest/node --test).
